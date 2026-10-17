"""Protocol/compatibility tests. Simulated measurements are NOT biometric acceptance."""
import hashlib
import json
import secrets
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from customer_identity.app import create_app, MAX_BODY
from customer_identity.protocol import POLICY, Rejected
from customer_identity.analyzer import check_document_text, Analyzer
from customer_identity.runtime import create_runtime
from customer_identity.store import Store
from service.app import create_app as create_staff
from service.engine import FaceEngine
from test_service import KEY, ENC, MeasurementsOnly, frame, signed

ORIGIN = "https://face.example.test"
API_KEY = "test-only-customer-key-" + "a" * 43
VECTOR = [1.0] + [0.0] * 127


class Clock:
    now = 1_800_000_000.0
    def __call__(self):
        return self.now


class FakeAnalyzer:
    def document(self, image, name, kind):
        if image == "bad":
            raise Rejected("document_not_readable")
        return VECTOR.copy()

    def live(self, encoded):
        return json.loads(encoded)


@pytest.fixture
def setup(tmp_path):
    clock = Clock()
    app = create_app(FakeAnalyzer(), API_KEY, ORIGIN, str(tmp_path / "sessions.db"), clock)
    root = FastAPI()
    root.mount("/customer-identity", app)
    with TestClient(root) as client:
        yield client, app, clock
    app.state.store.close()


def new_session(client, attempt=None, **overrides):
    attempt = attempt or secrets.token_urlsafe(24)
    payload = dict(registrationId="registration-a", attemptId=attempt, expectedName="Test Customer",
                   policy=POLICY, checks=["document", "faceMatch", "liveness"], returnUrl="https://estore.com.my/register")
    payload.update(overrides)
    return client.post("/customer-identity/v1/sessions", json=payload,
        headers={"Authorization": "Bearer " + API_KEY, "Idempotency-Key": attempt})


def headers(session):
    return {"Authorization": "Bearer " + session["url"].split("#")[1], "Origin": ORIGIN}


def upload(client, session, **overrides):
    return client.post("/customer-identity/capture/document", headers=headers(session),
                       json={"image": "sample", "kind": "mykad", "consent": True, **overrides})


def sample(action, **overrides):
    return json.dumps({"vector": VECTOR.copy(), "pose": {"center": 0.0, "left": 0.3, "right": -0.3}[action],
                       "pad": 0.999, "hash": secrets.token_hex(32), **overrides})


def submit(client, session, state, clock, **overrides):
    clock.now += 1
    return client.post("/customer-identity/capture/frame", headers=headers(session), json={
        "challengeId": state["challenge"]["id"], "frame": sample(state["challenge"]["action"], **overrides)})


def test_bound_private_session_and_idempotency(setup):
    client, app, clock = setup
    assert client.post("/customer-identity/v1/sessions", json={}).status_code == 401
    first = new_session(client, "attempt-a").json()
    assert first == new_session(client, "attempt-a").json()
    assert new_session(client, "attempt-a", registrationId="different").status_code == 409
    assert new_session(client, returnUrl="https://evil.example").status_code == 400
    assert first["mode"] == "evaluation" and not first["activationAllowed"]
    assert client.get("/customer-identity/v1/sessions/"+first["id"], headers=headers(first)).status_code == 401
    assert client.get("/customer-identity/capture/session", headers={"Authorization": "Bearer "+API_KEY}).status_code in (401, 410)
    assert client.get("/customer-identity/capture/session", headers=headers(first)).status_code == 200


def test_full_protocol_scrubs_vectors_and_never_issues_production_pass(setup):
    client, app, clock = setup
    session = new_session(client).json()
    state = upload(client, session).json()
    ids, actions = [], []
    for _ in range(5):
        ids.append(state["challenge"]["id"])
        actions.append(state["challenge"]["action"])
        assert "directions" not in state and "expectedName" not in state
        state = submit(client, session, state, clock).json()
    assert state["state"] == "evaluated" and state["activationAllowed"] is False
    assert len(set(ids)) == 5 and actions[::2] == ["center"] * 3
    assert set(actions[1::2]) == {"left", "right"}
    stored = app.state.store.read(session["id"])
    for field in ("documentVector", "vectors", "expectedName", "hashes", "baseline", "challenge"):
        assert field not in stored
    response = client.get("/customer-identity/v1/sessions/"+session["id"], headers={"Authorization": "Bearer "+API_KEY}).json()
    assert response["state"] == "evaluated" and "verifiedAt" not in response and "checks" not in response
    assert upload(client, session).status_code == 409


@pytest.mark.parametrize("change,reason", [
    ({"pose": 0.4}, "look_straight"), ({"pad": 0.5}, "liveness_not_confirmed"),
    ({"vector": [-1.0]+[0.0]*127}, "document_face_mismatch"), ({"pose": float("nan")}, "invalid_measurement")])
def test_failed_checks_are_terminal(setup, change, reason):
    client, app, clock = setup
    session = new_session(client).json()
    state = upload(client, session).json()
    result = submit(client, session, state, clock, **change).json()
    assert result["state"] == "failed" and result["reason"] == reason
    assert "documentVector" not in app.state.store.read(session["id"])


def test_challenge_wrong_session_replay_and_timing(setup):
    client, app, clock = setup
    a, b = new_session(client).json(), new_session(client).json()
    sa, sb = upload(client, a).json(), upload(client, b).json()
    assert submit(client, b, sa, clock).status_code == 409
    result = submit(client, a, sa, clock).json()
    assert submit(client, a, sa, clock).status_code == 409
    too_fast = client.post("/customer-identity/capture/frame", headers=headers(b), json={
        "challengeId": sb["challenge"]["id"], "frame": sample("center")})
    assert too_fast.status_code == 200  # b's challenge has had time to age
    fresh = too_fast.json()
    assert client.post("/customer-identity/capture/frame", headers=headers(b), json={
        "challengeId": fresh["challenge"]["id"], "frame": sample(fresh["challenge"]["action"])}).status_code == 409
    clock.now += 46
    assert submit(client, a, result, clock).json()["reason"] == "challenge_expired"


def test_duplicate_pixels_and_wrong_action_rejected(setup):
    client, app, clock = setup
    session = new_session(client).json()
    state = upload(client, session).json()
    state = submit(client, session, state, clock, hash="same-pixels").json()
    assert submit(client, session, state, clock, hash="same-pixels").json()["reason"] == "duplicate_frame"
    session = new_session(client).json()
    state = submit(client, session, upload(client, session).json(), clock).json()
    assert submit(client, session, state, clock, pose=0.0).json()["reason"] == "action_not_confirmed"


def test_cancel_expiry_and_encrypted_storage(setup, tmp_path):
    client, app, clock = setup
    session = new_session(client).json()
    upload(client, session)
    data = (tmp_path/"sessions.db").read_bytes()
    assert b"Test Customer" not in data and session["url"].split("#")[1].encode() not in data
    assert client.post("/customer-identity/capture/cancel", json={}, headers=headers(session)).json()["state"] == "failed"
    assert "expectedName" not in app.state.store.read(session["id"])
    session = new_session(client).json()
    clock.now += 901
    app.state.store.purge()
    assert client.get("/customer-identity/capture/session", headers=headers(session)).status_code == 410
    assert app.state.store.db.execute("SELECT count(*) FROM sessions").fetchone()[0] == 0
    assert new_session(client, session["attemptId"]).status_code == 410


def test_document_binding_retries_consent_origin_body_limit_and_injection(setup):
    client, app, clock = setup
    session = new_session(client).json()
    assert upload(client, session, consent=False).status_code == 400
    assert upload(client, session, matched=True).status_code == 400
    assert client.post("/customer-identity/capture/document", json={}, headers={**headers(session), "Origin": "https://evil.example"}).status_code == 403
    response = client.post("/customer-identity/capture/document", content=b"A"*(MAX_BODY+1), headers={**headers(session), "Content-Type": "application/json"})
    assert response.status_code == 413 and response.headers["cache-control"] == "no-store"
    for _ in range(2):
        assert upload(client, session, image="bad").json()["state"] == "pending"
    assert upload(client, session, image="bad").json()["state"] == "failed"
    session = new_session(client).json()
    upload(client, session)
    assert upload(client, session).status_code == 409


def test_static_capture_has_csp_no_cache_and_no_third_party_assets(setup):
    client, _, _ = setup
    for name in ("verify", "capture.js", "capture.css"):
        response = client.get("/customer-identity/"+name)
        assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
        assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
        assert response.headers["referrer-policy"] == "no-referrer"
    assert client.options("/customer-identity/capture/frame").status_code == 401


def test_ocr_is_name_layout_check_not_document_authentication():
    check_document_text("MALAYSIA KAD PENGENALAN 900101-01-1234 TEST CUSTOMER", "Test Customer", "mykad")
    check_document_text("PASSPORT P<MYS CUSTOMER<<TEST", "Test Customer", "passport")
    with pytest.raises(Rejected, match="document_name"):
        check_document_text("MALAYSIA PENGENALAN 900101-01-1234 SOMEONE ELSE", "Test Customer", "mykad")
    with pytest.raises(Rejected, match="document_not_readable"):
        check_document_text("TEST CUSTOMER", "Test Customer", "mykad")


@pytest.mark.parametrize("enabled", [False, True])
def test_mounted_runtime_preserves_staff_signed_contract(monkeypatch, tmp_path, enabled):
    monkeypatch.setenv("CUSTOMER_IDENTITY_ENABLED", str(enabled).lower())
    monkeypatch.setenv("CUSTOMER_IDENTITY_API_KEY", API_KEY)
    monkeypatch.setenv("CUSTOMER_IDENTITY_ORIGIN", ORIGIN)
    monkeypatch.setenv("CUSTOMER_IDENTITY_DB", str(tmp_path/"runtime.db"))
    staff = create_staff(MeasurementsOnly(), KEY, ENC)
    with TestClient(create_runtime(staff)) as client:
        assert client.get("/readyz").json()["ready"] is True
        assert client.get("/customer-identity/readyz").status_code == (200 if enabled else 503)
        payload = {"subject": "test-staff", "frames": [frame(99), frame(100), frame(101)]}
        raw, hdr = signed("/v1/enroll", payload)
        enrolled = client.post("/v1/enroll", content=raw, headers=hdr)
        assert enrolled.status_code == 200 and not enrolled.json()["authenticated"]
        payload["template"] = enrolled.json()["template"]
        raw, hdr = signed("/v1/verify", payload)
        assert client.post("/v1/verify", content=raw, headers=hdr).json()["candidate_match"] is True
        assert client.post("/v1/verify", content=raw, headers=hdr).status_code == 401
        assert client.get("/readyz").json()["login_enabled"] is False


def test_real_analyzer_rejects_non_face_without_changing_legacy_model():
    engine = FaceEngine()
    with pytest.raises(Rejected, match="exactly_one_face_required"):
        Analyzer(engine).live(frame())
    with pytest.raises(Rejected, match="document_name_not_confirmed"):
        Analyzer(engine).document(frame(), "Test Customer", "mykad")
