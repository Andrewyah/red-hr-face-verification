"""Deployment smoke check. Read signing key from stdin; never print or persist it.

Sends synthetic blank images only, never employee records or enrollment images.
Run with the repository's Python environment (Pillow is required).
"""
import base64
import hashlib
import hmac
import io
import json
import secrets
import sys
import time
import urllib.error
import urllib.request
from PIL import Image

MODEL = "https://face-verifier-api-production.up.railway.app"
EDGE = "https://xkeisacomchcsxjkmwcv.supabase.co/functions/v1/hr-face-service-check"


def run(encoded_key):
    key = base64.b64decode(encoded_key, validate=True)
    if len(key) != 32:
        raise ValueError("A 32-byte base64 signing key is required")
    results = []

    def sign(path, body, offset=0):
        ts, nonce = str(int(time.time()) + offset), secrets.token_urlsafe(24)
        text = "\n".join(["POST", path, ts, nonce, hashlib.sha256(body).hexdigest()]).encode()
        return {"Content-Type": "application/json", "X-Face-Timestamp": ts,
                "X-Face-Nonce": nonce, "X-Face-Signature": hmac.new(key, text, hashlib.sha256).hexdigest()}

    def request(name, url, expected, body=None, headers=None):
        req = urllib.request.Request(url, data=body, headers=headers or {}, method="POST" if body is not None else "GET")
        try:
            response = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status = response.status
            data = json.loads(response.read(8192))
        if status != expected:
            raise RuntimeError(f"{name}: HTTP {status}, expected {expected}; error={data.get('error', 'unexpected_response')}")
        results.append({"check": name, "status": status})
        print(json.dumps(results[-1]), flush=True)
        return data

    health = request("model_ready", MODEL+"/readyz", 200)
    assert health["ready"] is True and health["login_enabled"] is False
    body = b'{"subject":"connectivity-probe","frames":[]}'
    request("unsigned_rejected", MODEL+"/v1/enroll", 401, body, {"Content-Type":"application/json"})
    headers = sign("/v1/enroll", body)
    assert request("signed_request_reaches_validation", MODEL+"/v1/enroll", 400, body, headers)["error"] == "three_to_six_frames_required"
    request("replay_rejected", MODEL+"/v1/enroll", 401, body, headers)
    request("tampering_rejected", MODEL+"/v1/enroll", 401, body+b" ", sign("/v1/enroll", body))
    request("expired_proof_rejected", MODEL+"/v1/enroll", 401, body, sign("/v1/enroll", body, -120))
    frames = []
    for gray in (90, 100, 110):
        buffer = io.BytesIO()
        Image.new("RGB", (200, 200), (gray, gray, gray)).save(buffer, format="PNG")
        frames.append(base64.b64encode(buffer.getvalue()).decode())
    body = json.dumps({"subject":"connectivity-probe", "frames":frames}, separators=(",", ":")).encode()
    nonface = request("real_model_rejects_blank_capture", MODEL+"/v1/enroll", 422, body, sign("/v1/enroll",body))
    assert nonface["error"] == "exactly_one_face_required" and nonface["authenticated"] is False
    body = b'{"operation":"probe"}'
    request("supabase_unsigned_rejected", EDGE, 401, body, {"Content-Type":"application/json"})
    headers = sign("/hr-face-service-check", body)
    connected = request("supabase_signed_roundtrip", EDGE, 200, body, headers)
    assert connected["connected"] is True and connected["signing_verified"] is True
    assert connected["model_ready"] is True and connected["login_enabled"] is False
    request("supabase_replay_rejected", EDGE, 429, body, headers)
    print(json.dumps({"passed":len(results), "checks":results, "mode":"evaluation", "login_enabled":False}))


if __name__ == "__main__":
    run(sys.stdin.readline().strip())
