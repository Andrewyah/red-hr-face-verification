import base64
import hashlib
import hmac
import io
import json
import secrets
import time
import torch

import numpy as np
from PIL import Image
import pytest
from fastapi.testclient import TestClient

from service.app import create_app, MAX_BODY
from service.engine import FaceEngine, unit_vector
from service.images import decode_frame, FrameRejected
from service.security import RequestAuthenticator
from service.templates import TemplateCodec

KEY = b"test-only-signing-key-never-deploy" * 2
ENC = hashlib.sha256(b"test-only-sealing-key-never-deploy").digest()


def signed(path, payload, nonce=None, timestamp=None):
    raw = json.dumps(payload, separators=(",", ":")).encode()
    timestamp = str(int(time.time())) if timestamp is None else str(timestamp)
    nonce = nonce or secrets.token_urlsafe(24)
    message = "\n".join(["POST", path, timestamp, nonce, hashlib.sha256(raw).hexdigest()]).encode()
    return raw, {"content-type": "application/json", "x-face-timestamp": timestamp,
                 "x-face-nonce": nonce, "x-face-signature": hmac.new(KEY, message, hashlib.sha256).hexdigest()}


def frame(color=100, size=(200, 200)):
    file = io.BytesIO()
    Image.new("RGB", size, (color, color, color)).save(file, format="PNG")
    return base64.b64encode(file.getvalue()).decode()


class MeasurementsOnly:
    def measure(self, images):
        vector = unit_vector(np.ones(128))
        return {"embedding": vector, "embeddings": [vector] * len(images),
                "min_consistency": 1.0, "min_live_score": 1.0, "quality_passed": True}


@pytest.fixture
def client():
    with TestClient(create_app(MeasurementsOnly(), KEY, ENC)) as client:
        yield client


def test_no_keys_cannot_be_ready(monkeypatch):
    monkeypatch.delenv("FACE_SERVICE_HMAC_KEY", raising=False)
    monkeypatch.delenv("FACE_TEMPLATE_KEY", raising=False)
    with TestClient(create_app(MeasurementsOnly())) as client:
        assert client.get("/readyz").status_code == 503
        assert client.post("/v1/enroll").status_code == 503


def test_signed_request_replay_and_tampering():
    path = "/v1/enroll"
    body, headers = signed(path, {"subject": "test-employee"})
    auth = RequestAuthenticator(KEY)
    args = [headers["x-face-timestamp"], headers["x-face-nonce"], headers["x-face-signature"]]
    assert not auth.verify("POST", path, body + b" ", *args)
    assert not auth.verify("POST", "/v1/verify", body, *args)
    assert auth.verify("POST", path, body, *args)
    assert not auth.verify("POST", path, body, *args)


@pytest.mark.parametrize("offset", [-61, 61, -600])
def test_expired_or_future_signed_request(offset):
    now = int(time.time())
    body, headers = signed("/v1/enroll", {}, timestamp=now + offset)
    assert not RequestAuthenticator(KEY).verify("POST", "/v1/enroll", body,
        headers["x-face-timestamp"], headers["x-face-nonce"], headers["x-face-signature"], now=now)


def test_template_is_bound_to_subject_and_rejects_tampering():
    codec = TemplateCodec(ENC)
    vector = unit_vector(np.arange(128))
    token = codec.seal("employee-a", vector)
    assert np.allclose(codec.open("employee-a", token), vector)
    for subject, value in [("employee-b", token), ("employee-a", token[:-8] + "AAAAAAAA")]:
        with pytest.raises(FrameRejected):
            codec.open(subject, value)


@pytest.mark.parametrize("value", ["not-base64!", "", "A" * 600_000])
def test_bad_images(value):
    with pytest.raises(FrameRejected):
        decode_frame(value)


def test_pixel_limit_checked_before_decompression():
    with pytest.raises(FrameRejected, match="image_dimensions"):
        decode_frame(frame(size=(2000, 2000)))


def test_unauthenticated_calls_rejected(client):
    assert client.post("/v1/enroll", json={}).status_code == 401
    assert client.options("/v1/enroll").status_code == 404


def test_body_limit_even_without_trust_in_content_length(client):
    assert client.post("/v1/enroll", content=b"A" * (MAX_BODY + 1),
                       headers={"content-type": "application/json"}).status_code == 413


def test_enrollment_and_verification_are_never_login_authorization(client):
    payload = {"subject": "test-employee", "frames": [frame(99), frame(100), frame(101)]}
    raw, headers = signed("/v1/enroll", payload)
    response = client.post("/v1/enroll", content=raw, headers=headers)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    enrolled = response.json()
    assert enrolled["authenticated"] is False
    assert "embedding" not in enrolled
    payload["template"] = enrolled["template"]
    raw, headers = signed("/v1/verify", payload)
    response = client.post("/v1/verify", content=raw, headers=headers)
    assert response.status_code == 200
    assert response.json()["candidate_match"] is True
    assert response.json()["authenticated"] is False
    assert client.post("/v1/verify", content=raw, headers=headers).status_code == 401
    assert client.get("/readyz").json()["login_enabled"] is False


def test_cannot_inject_client_match_result(client):
    payload = {"subject": "test-employee", "frames": [frame()] * 3, "matched": True}
    raw, headers = signed("/v1/enroll", payload)
    assert client.post("/v1/enroll", content=raw, headers=headers).status_code == 400


def test_real_models_load_and_reject_non_faces():
    # Actual downloaded models, not a mocked detector. Not a biometric accuracy test.
    engine = FaceEngine()
    with torch.inference_mode():
        for model, _ in engine.pad_models:
            logits = model(torch.zeros(1, 3, 80, 80))
            assert logits.shape == (1, 3) and torch.isfinite(logits).all()
    assert engine.recognizer.feature(np.zeros((112, 112, 3), dtype=np.uint8)).size == 128
    with pytest.raises(FrameRejected, match="exactly_one_face_required"):
        engine.measure([decode_frame(frame(90)), decode_frame(frame(100)), decode_frame(frame(110))])
    with pytest.raises(FrameRejected, match="duplicate_frames"):
        engine.measure([decode_frame(frame(90))] * 3)
