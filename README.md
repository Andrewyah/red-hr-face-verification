# Red HR — self-hosted face verification

Backend inference for Red Aluminium & Hardware Sdn Bhd. Face detection, embeddings
and two anti-spoof classifiers execute inside this container. No AWS Rekognition
or other facial recognition API is called. Model files are fetched from their
pinned upstream sources **at build time** and verified before every startup.

**Status: evaluation service, not a completed passwordless login system.**
This release never issues a Supabase session. Every inference response includes
`authenticated: false`; `/readyz` includes `login_enabled: false`.
There is deliberately no configuration switch to turn measurements into login.
Employee enrollment, live challenge capture, Supabase integration, revocation,
and device-specific genuine-user/spoof evaluation remain release gates.

The model weights are licensed pretrained open-source weights, not a new
proprietary model trained on employee faces. See `THIRD_PARTY_NOTICES.md` and
`licenses/` for provenance and license texts.

## Running the backend

Use Python 3.12 and one process/replica:

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.lock
.venv/bin/python scripts/fetch_models.py
```

Generate **two separate** 32-byte random keys, base64-encode them, and set
`FACE_SERVICE_HMAC_KEY` and `FACE_TEMPLATE_KEY` in the server's secret settings.
Use `.env.example` only as a naming reference; the app does not load an env file.
Never put either key into frontend JavaScript, GitHub, logs or build arguments.
Retain the template key in an approved secret store; losing it requires re-enrollment.

```sh
.venv/bin/uvicorn service.app:app --host 127.0.0.1 --port 8080 --workers 1 --no-access-log
```

The included Dockerfile runs as an unprivileged user. `railway.toml` configures
Docker builds, one replica and readiness checks. No volume is required: this
service does not persist employee images or enrollment records.

`GET /healthz` checks the process. `GET /readyz` returns HTTP 200 only when both
keys and all real models load; otherwise it returns 503. Readiness does not
mean biometric accuracy or login integration has been validated.

## Backend-only API

Only a trusted HR backend / Supabase Edge Function can call inference endpoints.
TLS is required outside loopback. Browser origins are not enabled for this API.
Use the signing example in `integration/supabase-client.ts` from a private Edge
Function; never bundle it into the employee website.

The exact UTF-8 JSON request is signed with HMAC-SHA256. Headers:

- `Content-Type: application/json`
- `X-Face-Timestamp`: Unix seconds
- `X-Face-Nonce`: fresh cryptographically random base64url string, 24–80 characters
- `X-Face-Signature`: lowercase hexadecimal HMAC of this UTF-8 string, without
  a trailing newline: `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256_OF_RAW_BODY`.

The service rejects modified bodies, invalid signatures, timestamps more than
60 seconds away, and repeated signed requests. Its bounded nonce cache is
process-local; use one process/replica. The HR backend must additionally store
single-use login challenges in a database. This cache is not that login store.

`POST /v1/enroll` accepts exactly:

```json
{"subject":"opaque-employee-id","frames":["base64-jpeg-1","base64-jpeg-2","base64-jpeg-3"]}
```

Send 3–6 distinct camera frames. Each must be JPEG/PNG, at most 400,000 bytes and
1280×1280 pixels. Quality checks require exactly one fully visible face,
sufficient face size, lighting, focus, identity consistency and both PAD model
scores above the evaluation threshold. Successful evaluation returns a sealed
AES-256-GCM template bound to the subject and model version. Only the trusted
backend may store that template in its private Supabase table.

`POST /v1/verify` accepts the same keys plus `template`, retrieved by the backend
from the currently active enrollment. It returns measurements and
`candidate_match`. **That field is not authorization to sign in.** A browser must
never choose a different subject or supply its own reference template.

Frames and embeddings are neither logged nor written to disk. Turn off upstream
request-body logging, tracing payload capture, error-session replay and proxy
body storage as well. Attendance stores date/time/GPS only, without face photos.

## Remaining Supabase / HR release work

1. Authenticate the employee with an existing trusted method before first
   enrollment, validate that the employee is active and the session is current,
   and record explicit biometric enrollment consent. Do not bind by typed email
   alone or trust user-editable JWT metadata.
2. Store sealed templates, enrollment version, consent time and revocation state
   in a private schema. Deny `anon`/`authenticated` direct access. Audit access
   without images or plaintext vectors; implement retention and deletion.
3. Add a server-issued, expiring, one-time capture challenge with a randomized
   action sequence and server-side sequence checking. Persist attempts and
   consumption atomically; rate-limit by account and request source. Reject
   replayed requests and never trust client liveness booleans.
4. Provide a front-camera UI using `getUserMedia({video:{facingMode:'user'},audio:false})`.
   Camera access still requires the browser's permission. Stop all tracks when
   done, cancelled or navigating away. This is camera verification, not Apple's
   hardware Face ID or WebAuthn. Do not trigger the password form from its button.
5. Measure genuine accepts/rejects and printed-photo, display/video replay,
   lookalike and injected-video attacks on the actual supported devices. The
   defaults (cosine 0.65 / both PAD scores 0.99) are **unvalidated evaluation
   thresholds**, not measured false-accept rates. PAD scores are not proof of
   physical presence and a browser camera is not a trusted capture path.
6. Only after those gates, add a separately reviewed Supabase session exchange
   that rechecks employee status and consumes the successful challenge exactly
   once. Preserve password recovery; do not bypass existing account controls.
   No TOTP/Authenticator step is part of the proposed face login flow.

No production employee rows, Auth factors or attendance tables are modified by
this repository.

## Tests

```sh
.venv/bin/pip install -r requirements-test.lock
.venv/bin/python -m pytest -q
```

Tests cover signature tampering/replay/expiry, subject-bound template encryption,
image/request limits, unsigned clients, injected result fields and the rule that
evaluation is never login authorization. A real-model smoke test loads all four
downloaded models and rejects blank images. Mock measurements are used for API
contract tests; they are not evidence of face-recognition or anti-spoof accuracy.
