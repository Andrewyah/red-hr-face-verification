"""Private inference API. This release does not create employee login sessions."""
import asyncio
import base64
from contextlib import asynccontextmanager
import json
import os
import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import numpy as np

from service.engine import FaceEngine, MODEL_VERSION
from service.images import decode_frame, FrameRejected
from service.security import RequestAuthenticator
from service.templates import TemplateCodec
from service.identify import identify

MAX_BODY = 3_300_000


def create_app(engine=None, auth_key=None, template_key=None):
    @asynccontextmanager
    async def lifespan(app):
        try:
            signing_key = auth_key or base64.b64decode(os.environ.get("FACE_SERVICE_HMAC_KEY", ""), validate=True)
            sealing_key = template_key or base64.b64decode(os.environ.get("FACE_TEMPLATE_KEY", ""), validate=True)
            app.state.auth = RequestAuthenticator(signing_key)
            app.state.templates = TemplateCodec(sealing_key)
            app.state.engine = engine or FaceEngine()
            app.state.ready = True
        except Exception:
            # Deliberately no exception payloads, keys, requests or frames in logs.
            app.state.ready = False
        yield
        app.state.ready = False

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.ready = False

    @app.middleware("http")
    async def private_api(request, call_next):
        if request.url.path in {"/healthz", "/readyz"}:
            return await call_next(request)
        if not app.state.ready:
            return JSONResponse({"error": "service_not_ready"}, status_code=503)
        if request.method != "POST" or request.url.path not in {"/v1/enroll", "/v1/verify", "/v1/identify"}:
            return JSONResponse({"error": "not_found"}, status_code=404)
        if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
            return JSONResponse({"error": "json_required"}, status_code=415)
        # Bound streamed payloads too; do not trust Content-Length.
        body = bytearray()
        try:
            async with asyncio.timeout(15):
                async for chunk in request.stream():
                    body.extend(chunk)
                    if len(body) > MAX_BODY:
                        return JSONResponse({"error": "request_too_large"}, status_code=413)
        except TimeoutError:
            return JSONResponse({"error": "request_timeout"}, status_code=408)
        raw = bytes(body)
        verified = app.state.auth.verify(request.method, request.url.path, raw,
            request.headers.get("x-face-timestamp"), request.headers.get("x-face-nonce"),
            request.headers.get("x-face-signature"))
        if not verified:
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            request.state.payload = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return JSONResponse({"error": "invalid_request"}, status_code=400)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/healthz")
    def health():
        return {"status": "up"}

    @app.get("/readyz")
    def ready():
        return JSONResponse({"ready": app.state.ready, "mode": "evaluation",
                             "login_enabled": False, "model_version": MODEL_VERSION},
                            status_code=200 if app.state.ready else 503)

    def process(request, verifying):
        payload = request.state.payload
        allowed = {"subject", "frames", "template"} if verifying else {"subject", "frames"}
        if not isinstance(payload, dict) or set(payload) != allowed:
            return JSONResponse({"error": "invalid_request"}, status_code=400)
        subject, frames = payload.get("subject"), payload.get("frames")
        if not isinstance(subject, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", subject):
            return JSONResponse({"error": "invalid_request"}, status_code=400)
        if not isinstance(frames, list) or not 3 <= len(frames) <= 6:
            return JSONResponse({"error": "three_to_six_frames_required"}, status_code=400)
        try:
            reference = app.state.templates.open(subject, payload["template"]) if verifying else None
            images = [decode_frame(frame) for frame in frames]
            measured = app.state.engine.measure(images)
            result = {"mode": "evaluation", "authenticated": False,
                      "model_version": MODEL_VERSION,
                      "quality_passed": bool(measured["quality_passed"]),
                      "min_live_score": round(measured["min_live_score"], 6),
                      "min_consistency": round(measured["min_consistency"], 6)}
            if verifying:
                score = min(float(np.dot(reference, vector)) for vector in measured["embeddings"])
                result["similarity"] = round(score, 6)
                result["candidate_match"] = bool(measured["quality_passed"] and score >= FaceEngine.MATCH_THRESHOLD)
            elif measured["quality_passed"]:
                result["template"] = app.state.templates.seal(subject, measured["embedding"])
            return result
        except FrameRejected as exc:
            code = str(exc)
            return JSONResponse({"error": code, "authenticated": False},
                                status_code=429 if code == "service_busy" else 422)
        except Exception:
            return JSONResponse({"error": "inference_failed", "authenticated": False}, status_code=503)

    @app.post("/v1/enroll")
    def enroll(request: Request):
        return process(request, False)

    @app.post("/v1/verify")
    def verify(request: Request):
        return process(request, True)

    @app.post("/v1/identify")
    def identify_capture(request: Request):
        payload = request.state.payload
        if not isinstance(payload, dict) or set(payload) != {"frames", "candidates"}:
            return JSONResponse({"error": "invalid_request"}, status_code=400)
        if not isinstance(payload["frames"], list) or len(payload["frames"]) != 3:
            return JSONResponse({"error": "three_frames_required"}, status_code=400)
        try:
            images = [decode_frame(frame) for frame in payload["frames"]]
            result = identify(app.state.engine, app.state.templates, images, payload["candidates"])
            return {**result, "mode": "evaluation", "authenticated": False,
                    "model_version": MODEL_VERSION}
        except FrameRejected as exc:
            code = str(exc)
            return JSONResponse({"error": code, "authenticated": False},
                                status_code=429 if code == "service_busy" else 422)
        except Exception:
            return JSONResponse({"error": "inference_failed", "authenticated": False}, status_code=503)

    return app


app = create_app()
