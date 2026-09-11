# Red HR — self-hosted face verification

Backend inference for Red Aluminium & Hardware Sdn Bhd. Face detection, embeddings
and two anti-spoof classifiers execute inside this container. No AWS Rekognition
or other facial recognition API is called. Model files are fetched from their
pinned upstream sources **at build time** and verified before every startup.

**Status: evaluation service, not a completed passwordless login system.**
This release never issues a Supabase session. Every inference response includes
`authenticated: false`; `/readyz` includes `login_enabled: false`.
There is deliberately no configuration switch to turn measurements into login.
Authenticated employee enrollment, encrypted storage, one-use capture jobs and
revocation are implemented. Device-specific genuine-user/spoof evaluation, active
challenge validation and Supabase session exchange remain release gates.

The model weights are licensed pretrained open-source weights, not a new
proprietary model trained on employee faces. See `THIRD_PARTY_NOTICES.md` and
`licenses/` for provenance and license texts.

## Deployed service and Supabase connection

The Railway service is deployed at
`https://face-verifier-api-production.up.railway.app`. Public readiness is available
at `/readyz`; inference endpoints require a signed backend request.

`integration/supabase-service.sql` defines service-role-only configuration and
probe nonce functions, with a private RLS-protected nonce table. The signing key
and URL are stored as Supabase Vault secrets named `red_hr_face_service_hmac` and
`red_hr_face_service_url`. Secret values are not part of this repository. Do not
grant employee or anonymous roles access to these functions or Vault secrets.

`integration/hr-face-service-check/index.ts` is deployed as the Supabase Edge
Function `hr-face-service-check`. It uses custom HMAC authentication (therefore
gateway JWT verification is disabled), rejects replay, and permits at most six
accepted probes per minute. Its only input is `{"operation":"probe"}`. It cannot
relay employee images, reference templates or arbitrary URLs. Sign requests with
the path `/hr-face-service-check`, as received by the Edge Function.

The diagnostic verifies readiness and sends a signed empty-capture request to
the Railway validation layer. A positive result confirms the backend connection
and signing configuration; it does not validate an employee or issue a session.

On 2026-09-11, all ten live deployment checks passed: model readiness, rejection
of unsigned/modified/expired/replayed requests, actual model rejection of blank
synthetic captures, and the signed Supabase-to-Railway round trip. Employee face
accuracy and spoof-resistance have not been measured.

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

## Employee camera registration and testing

`integration/hr-face-enrollment.sql` adds private encrypted registrations,
90-second capture jobs and image-free audit events. `hr_face_self` permits only
an active employee with a live Supabase session to view their registration status,
start a capture or revoke their own registration. First enrollment also requires
password/OTP verification within 10 minutes and explicit consent version
`face-enrollment-1`. Normal employees cannot directly read or write templates.

`integration/hr-face-enrollment/index.ts` is the `hr-face-enrollment` Edge Function,
deployed **with JWT verification enabled**. It derives the user and session from
the validated employee context, then claims the job using service-only RPCs.
The browser cannot choose another employee, provide reference templates, or
supply match/liveness results. Claims are one-use; status, session ownership and
registration revision are rechecked before completion. Removing a registration
invalidates pending captures without clearing the attempt rate counter.

The HR Site camera button now opens `getUserMedia` directly from the click, with
front-facing preference and no audio. The old WebAuthn adapter is no longer loaded.
The camera dialog supports employee account verification, consent, registration,
matching tests and registration removal. Raw camera frames remain in memory,
travel only to the private HR backend/model service, and are discarded. Camera
tracks stop on completion, cancellation, navigation and backgrounding. This is
browser camera recognition, not Apple's hardware Face ID. The browser still
requires camera permission. A recognition test never signs the employee in;
entering HR here requires an explicitly verified password session.

Apply the enrollment SQL after `integration/supabase-service.sql`. Audit metadata
is retained for 90 days and capture jobs for one day, with cleanup on new capture
requests. A registration persists until its owner removes it or the related Auth
user/employee is deleted. At most 5 captures per employee per 5 minutes and 30
captures across the service per minute are accepted. Revocation is also limited
and never resets capture limits. No changes are made to attendance or Auth factors.

## Remaining release work

1. Validate randomized action challenges on the server, with replay/injection
   handling. Current captures are one-use jobs with passive PAD, not a trusted
   camera channel or validated active-liveness challenge.
2. Measure genuine accepts/rejects and printed-photo, display/video replay,
   lookalike and injected-video attacks on supported real devices. The defaults
   (cosine 0.65 / both PAD scores 0.99) are **unvalidated evaluation thresholds**.
   PAD scores are not measured false-accept rates or proof of physical presence.
3. After those measurements support release, add a reviewed Supabase session
   exchange that rechecks employee status and consumes a successful challenge
   exactly once. Preserve password recovery and account controls. No
   TOTP/Authenticator step is part of the proposed face login flow.

## Tests

```sh
.venv/bin/pip install -r requirements-test.lock
.venv/bin/python -m pytest -q
node --test tests/supabase-service-check.test.mjs tests/face-enrollment-edge.test.mjs
```

Tests cover signature tampering/replay/expiry, subject-bound template encryption,
image/request limits, unsigned clients, injected result fields and the rule that
evaluation is never login authorization. A real-model smoke test loads all four
downloaded models and rejects blank images. Mock measurements are used for API
contract tests; they are not evidence of face-recognition or anti-spoof accuracy.

For an authorized deployment check, run `.venv/bin/python scripts/live_probe.py`
with the HMAC key supplied on standard input from your secret manager. It sends
only synthetic blank images and diagnostic payloads. Do not put the key into
command-line arguments, a committed file or logs. A successful run reports ten
checks and `login_enabled: false`.

The enrollment Edge Function has nine synthetic HTTP contract tests. The SQL
regression in `tests/face-enrollment-db.sql` runs consent, fresh account proof,
ownership/session isolation, one-use completion, revocation and privilege tests
inside a transaction and rolls back all synthetic fixtures. It passed against the
existing HR database on 2026-09-11. These tests do not use employee face images.
