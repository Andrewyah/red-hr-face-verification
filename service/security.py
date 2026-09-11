"""Authentication of the HR backend, not authentication of an employee."""
import hashlib
import hmac
import re
import threading
import time


class RequestAuthenticator:
    def __init__(self, key: bytes, window: int = 60, capacity: int = 10000):
        if len(key) < 32:
            raise ValueError("FACE_SERVICE_HMAC_KEY must contain at least 32 bytes")
        self.key, self.window, self.capacity = key, window, capacity
        self.seen = {}
        self.lock = threading.Lock()

    def verify(self, method, path, body, timestamp, nonce, signature, now=None):
        now = time.time() if now is None else now
        if not re.fullmatch(r"[0-9]{10}", timestamp or ""):
            return False
        if not re.fullmatch(r"[a-zA-Z0-9_-]{24,80}", nonce or ""):
            return False
        if abs(now - int(timestamp)) > self.window:
            return False
        if not re.fullmatch(r"[a-f0-9]{64}", signature or ""):
            return False
        digest = hashlib.sha256(body).hexdigest()
        message = "\n".join([method, path, timestamp, nonce, digest]).encode()
        expected = hmac.new(self.key, message, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return False
        with self.lock:
            self.seen = {k: expiry for k, expiry in self.seen.items() if expiry >= now}
            if nonce in self.seen or len(self.seen) >= self.capacity:
                return False
            self.seen[nonce] = int(timestamp) + self.window
        return True
