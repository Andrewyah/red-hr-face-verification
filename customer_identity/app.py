"""Private provider API plus token-bound, same-origin Customer capture UI."""
import asyncio
import hmac
import json
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from customer_identity.protocol import (POLICY, Rejected, accept_frame, backend_state,
                                        public_state, scrub, start_capture)
from customer_identity.store import Store

STATIC = Path(__file__).parent / "static"
PREFIX = "/customer-identity"
MAX_BODY = 550_000
ID = re.compile(r"[A-Za-z0-9_-]{1,160}\Z")
CAPTURE = re.compile(r"[A-Za-z0-9_-]{43}\Z")


def create_app(analyzer=None, key=None, origin=None, path=":memory:", clock=time.time):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = None
    if key and len(key) >= 43 and origin:
        parsed = urlsplit(origin)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise ValueError("Customer origin must be an exact HTTPS origin")
        app.state.store = Store(path, key, clock)
    app.state.ready = analyzer is not None and app.state.store is not None

    def secure(response):
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
            "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src 'self' blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"})
        return response

    @app.middleware("http")
    async def boundary(request, call_next):
        route = request.scope["path"].removeprefix(PREFIX)
        public = {"/readyz", "/verify", "/capture.js", "/capture.css"}
        if route in public and request.method == "GET":
            return secure(await call_next(request))
        if not app.state.ready:
            return secure(JSONResponse({"error": "customer_verification_unavailable"}, 503))
        header = request.headers.get("authorization", "")
        if route.startswith("/v1/sessions"):
            valid = hmac.compare_digest(header.encode(), ("Bearer " + key).encode())
        elif route.startswith("/capture/"):
            token = header.removeprefix("Bearer ") if header.startswith("Bearer ") else ""
            valid = bool(CAPTURE.fullmatch(token))
            request.state.capture_token = token
            if request.method == "POST" and request.headers.get("origin") != origin:
                return secure(JSONResponse({"error": "origin_not_allowed"}, 403))
        else:
            return secure(JSONResponse({"error": "not_found"}, 404))
        if not valid:
            return secure(JSONResponse({"error": "unauthorized"}, 401))
        if request.method == "POST":
            if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
                return secure(JSONResponse({"error": "json_required"}, 415))
            raw = bytearray()
            try:
                async with asyncio.timeout(12):
                    async for chunk in request.stream():
                        raw.extend(chunk)
                        if len(raw) > MAX_BODY:
                            return secure(JSONResponse({"error": "request_too_large"}, 413))
                request.state.payload = json.loads(raw)
                if not isinstance(request.state.payload, dict):
                    raise ValueError()
            except TimeoutError:
                return secure(JSONResponse({"error": "request_timeout"}, 408))
            except (ValueError, UnicodeDecodeError):
                return secure(JSONResponse({"error": "invalid_request"}, 400))
        try:
            response = await call_next(request)
        except Exception:
            # No exception text, OCR text, documents, tokens or names in logs.
            response = JSONResponse({"error": "verification_unavailable"}, 503)
        return secure(response)

    @app.exception_handler(Rejected)
    async def rejection(request, error):
        return JSONResponse({"error": error.code}, error.status)

    @app.get("/readyz")
    def ready():
        return JSONResponse({"ready": app.state.ready, "mode": "evaluation", "activationAllowed": False,
                             "documentScope": "portrait_and_name_only"}, 200 if app.state.ready else 503)

    @app.get("/verify")
    def page():
        return FileResponse(STATIC / "capture.html", media_type="text/html")

    @app.get("/capture.js")
    def script():
        return FileResponse(STATIC / "capture.js", media_type="text/javascript")

    @app.get("/capture.css")
    def style():
        return FileResponse(STATIC / "capture.css", media_type="text/css")

    @app.post("/v1/sessions")
    def create(request: Request):
        data = request.state.payload
        if set(data) != {"registrationId", "attemptId", "expectedName", "policy", "checks", "returnUrl"}:
            raise Rejected("invalid_request", 400)
        if any(not isinstance(data[k], str) or not ID.fullmatch(data[k]) for k in ("registrationId", "attemptId")):
            raise Rejected("invalid_binding", 400)
        if request.headers.get("idempotency-key") != data["attemptId"]:
            raise Rejected("idempotency_key_required", 400)
        if (not isinstance(data["expectedName"], str) or not 3 <= len(data["expectedName"].strip()) <= 160
                or data["policy"] != POLICY or data["checks"] != ["document", "faceMatch", "liveness"]
                or data["returnUrl"] != "https://estore.com.my/register"):
            raise Rejected("invalid_request", 400)
        return backend_state(app.state.store.create(data), origin)

    @app.get("/v1/sessions/{identity}")
    def status(identity: str):
        if not ID.fullmatch(identity):
            raise Rejected("invalid_session", 400)
        return backend_state(app.state.store.read(identity), origin)

    @app.get("/capture/session")
    def capture_status(request: Request):
        return public_state(app.state.store.read(request.state.capture_token, capture=True))

    @app.post("/capture/document")
    def document(request: Request):
        data = request.state.payload
        if set(data) != {"image", "kind", "consent"} or data["kind"] not in ("mykad", "passport") or data["consent"] is not True:
            raise Rejected("document_consent_required", 400)
        def operation(session, now):
            if "documentVector" in session:
                raise Rejected("document_already_bound", 409)
            try:
                vector = analyzer.document(data["image"], session["expectedName"], data["kind"])
            except Rejected as error:
                if error.status == 503:
                    raise
                session["documentAttempts"] = session.get("documentAttempts", 0) + 1
                session["reason"] = error.code
                if session["documentAttempts"] >= 3:
                    scrub(session, "failed", now, error.code)
                return
            session.pop("reason", None)
            session["consentedAt"] = now
            start_capture(session, vector, now)
        return public_state(app.state.store.read(request.state.capture_token, capture=True, operation=operation))

    @app.post("/capture/frame")
    def frame(request: Request):
        data = request.state.payload
        if set(data) != {"frame", "challengeId"} or not isinstance(data["challengeId"], str):
            raise Rejected("invalid_request", 400)
        return public_state(app.state.store.read(request.state.capture_token, capture=True,
            operation=lambda session, now: accept_frame(session, data, analyzer, now)))

    @app.post("/capture/cancel")
    def cancel(request: Request):
        if request.state.payload != {}:
            raise Rejected("invalid_request", 400)
        return public_state(app.state.store.read(request.state.capture_token, capture=True,
            operation=lambda session, now: scrub(session, "failed", now, "cancelled")))

    return app
