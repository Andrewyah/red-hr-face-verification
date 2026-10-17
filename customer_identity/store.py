"""Bounded encrypted evaluation sessions; no raw image persistence."""
import hashlib
import json
import os
import secrets
import sqlite3
import threading
from contextlib import contextmanager

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from customer_identity.protocol import Rejected, SESSION_SECONDS, digest, scrub


class Store:
    def __init__(self, path, key, clock):
        self.clock = clock
        self.lock = threading.Lock()
        self.cipher = AESGCM(hashlib.sha256(b"red-customer-evaluation-v1\0" + key.encode()).digest())
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        if path != ":memory:":
            os.chmod(path, 0o600)
        self.db.execute("PRAGMA secure_delete=ON")
        self.db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, attempt TEXT UNIQUE, token TEXT UNIQUE, expires REAL, payload BLOB)")
        self.db.execute("CREATE TABLE IF NOT EXISTS attempts (hash TEXT PRIMARY KEY, expires REAL)")

    def close(self):
        self.db.close()

    def seal(self, session):
        nonce = secrets.token_bytes(12)
        return nonce + self.cipher.encrypt(nonce, json.dumps(session, separators=(",", ":")).encode(), session["id"].encode())

    def open(self, row):
        return json.loads(self.cipher.decrypt(row[1][:12], row[1][12:], row[0].encode()))

    @contextmanager
    def transaction(self):
        # Do not queue expensive Customer work ahead of HR inference requests.
        if not self.lock.acquire(blocking=False):
            raise Rejected("service_busy", 503)
        try:
            self.db.execute("BEGIN IMMEDIATE")
            # Short expiry is an evaluation limitation, not durable evidence.
            self.db.execute("DELETE FROM sessions WHERE expires < ?", (self.clock(),))
            self.db.execute("DELETE FROM attempts WHERE expires < ?", (self.clock(),))
            yield
            self.db.execute("COMMIT")
        except Exception:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            raise
        finally:
            self.lock.release()

    def create(self, payload):
        binding = digest(json.dumps(payload, sort_keys=True, separators=(",", ":")))
        with self.transaction():
            row = self.db.execute("SELECT id,payload FROM sessions WHERE attempt=?", (payload["attemptId"],)).fetchone()
            if row:
                session = self.open(row)
                if session["binding"] != binding:
                    raise Rejected("idempotency_conflict", 409)
                return session
            if self.db.execute("SELECT 1 FROM attempts WHERE hash=?", (digest(payload["attemptId"]),)).fetchone():
                raise Rejected("attempt_expired", 410)
            if self.db.execute("SELECT count(*) FROM sessions").fetchone()[0] >= 200:
                raise Rejected("capacity_reached", 503)
            now = self.clock()
            session = {**payload, "id": secrets.token_urlsafe(24), "captureToken": secrets.token_urlsafe(32),
                       "expires": now + SESSION_SECONDS, "state": "pending", "binding": binding}
            self.db.execute("INSERT INTO sessions VALUES (?,?,?,?,?)", (session["id"], session["attemptId"],
                digest(session["captureToken"]), session["expires"], self.seal(session)))
            # A non-reversible attempt tombstone prevents retrying an expired
            # registration from silently obtaining a different capture session.
            self.db.execute("INSERT INTO attempts VALUES (?,?)", (digest(session["attemptId"]), now + 86400))
            return session

    def read(self, identity, capture=False, operation=None):
        with self.transaction():
            column = "token" if capture else "id"
            row = self.db.execute(f"SELECT id,payload FROM sessions WHERE {column}=?", (digest(identity) if capture else identity,)).fetchone()
            if not row:
                raise Rejected("session_expired", 410)
            session = self.open(row)
            if operation:
                if session["state"] != "pending":
                    raise Rejected("session_finished", 409)
                operation(session, self.clock())
                if self.clock() >= session["expires"]:
                    scrub(session, "expired", self.clock(), "session_expired")
                self.db.execute("UPDATE sessions SET payload=? WHERE id=?", (self.seal(session), session["id"]))
            return session

    def purge(self):
        with self.transaction():
            pass
