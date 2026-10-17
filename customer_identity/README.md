# Customer document portrait and active-camera evaluation

This is an additive Customer registration capability in the existing
`Andrewyah/red-hr-face-verification` service. It is **evaluation only**. No route
returns a production pass, account token, employee template or login authority.
Setting an environment variable cannot turn this release into production KYC.

The existing staff `service/` files, models, Python dependencies, HMAC keys,
template keys, endpoint contracts and normal login retries are unchanged. The
ASGI wrapper runs their original lifespan and dispatches `/` to the original app.
The isolated Customer routes live under `/customer-identity`.

## Implemented flow

1. A trusted backend creates an idempotent session bound to registration ID,
   attempt ID, expected legal name, policy and an exact return URL. Only this
   backend has the separate Customer API secret.
2. The session URL carries a 256-bit capture capability in its fragment. The
   browser removes the fragment immediately, keeps the token only in memory,
   and sends it in an Authorization header. No external scripts or trackers.
3. Explicit consent plus a MyKad front/passport photo page is required. OCR
   checks name/layout consistency; the document portrait gets a pinned SFace
   embedding. It is deliberately **not** run through live-face PAD.
4. Five sequential, short-lived server challenges require center, a random
   side, center, the other side, center. Fresh nonces, server timing, pixel
   duplicate detection, passive PAD, cross-frame consistency and document
   comparison are checked on the server. Future actions are not exposed.
5. A candidate success returns `state=evaluated`, `mode=evaluation`,
   `activationAllowed=false`, **never** `state=passed` or `verifiedAt`.
   The Commerce production adapter must continue to reject it for activation.

Document images, live images and OCR text are processed in memory/pipes only.
Temporary embeddings/name/session capabilities are AES-GCM encrypted in SQLite;
biometric fields are removed at completion/cancellation. Expired sessions are
deleted every 30 seconds and on requests. Session lifetime: 15 minutes. The
default `/tmp` database intentionally expires all sessions on container loss.
There is no production-grade persistent evidence store in this evaluation.
An irreversible attempt-ID hash is retained for 24 hours to reject expired-key
reuse; it carries no name, image or biometric measurement. Container loss also
loses these tombstones, so callers must issue a new attempt after a restart.

## Configuration on the existing service

- `CUSTOMER_IDENTITY_ENABLED=true`
- `CUSTOMER_IDENTITY_API_KEY`: a separate random 32-byte base64url secret
  (43 characters). Never use or rotate the two existing staff keys for this.
- `CUSTOMER_IDENTITY_ORIGIN`: the exact existing HTTPS service origin.
- `CUSTOMER_IDENTITY_DB`: optional; default `/tmp/red-customer-evaluation.sqlite3`.

Keep one worker and one replica. Missing/invalid Customer settings leave only
Customer unavailable; the staff readiness and signed API continue unchanged.
The Docker delta only copies this package, adds the Tesseract CLI and dispatches
through the wrapper. `/readyz` remains the staff readiness contract;
`/customer-identity/readyz` separately reports evaluation readiness.

The API base for the Commerce contract is
`https://face-verifier-api-production.up.railway.app/customer-identity/v1`.
Do **not** set Commerce `CUSTOMER_IDENTITY_ENABLED=true` for production activation
with this release. Its provider ID is `red-self-hosted`; policy is
`document-face-liveness-20261017`. Capture URLs intentionally use a fragment.

## API for controlled real-device acceptance

`POST /customer-identity/v1/sessions`, bearer Customer API key and
`Idempotency-Key: <attemptId>`:

```json
{
  "registrationId": "an-opaque-test-registration-id",
  "attemptId": "a-new-opaque-test-attempt-id",
  "expectedName": "THE PARTICIPANT'S LEGAL NAME",
  "policy": "document-face-liveness-20261017",
  "checks": ["document", "faceMatch", "liveness"],
  "returnUrl": "https://estore.com.my/register"
}
```

Open the returned `url` on the participant's phone within 15 minutes. That link
is a secret capability; do not put it in tickets, PRs or public logs. The API key
must remain on the trusted backend/operator environment. Backend retrieval is
`GET /customer-identity/v1/sessions/{id}` with the same API key. Restart/expiry
returns 410; create a **new** attempt rather than reuse an expired attempt.
Capture endpoints are not an alternative backend result authority.

## Release blockers and acceptance

The existing passive models accepted recorded pixels in the documented
September replay finding. Random poses mitigate simple fixed-sequence replay
but are **not a trusted capture channel**: adaptive video injection, synthesized
faces and prepared challenge responses remain threats. No false-accept or
false-reject operating point has been measured for this new flow. OCR checks
cannot authenticate government documents, detect all alterations or establish
legal identity. Passport MRZ checksums/expiry and authoritative document
authenticity are not implemented; document scope is `portrait_and_name_only`.

Before production auto-activation, record consented genuine captures on the
supported iPhone/Android/desktop browsers, name/portrait mismatches, expired
challenges, re-encoded/reordered old videos, adaptive/injected responses,
printed documents/photos and screen replays. Record aggregate outcomes,
recipe/model hashes, device/browser and false accept/reject rates; do not commit
documents or face images. Calibrate Customer thresholds separately. Determine
whether a stronger capture/document-authenticity mechanism is needed based on
these results. Preserve the unresolved replay finding until actually retested.

Protocol unit tests use fake measurements for state/security tests. The real
model tests only prove loading and rejection of blank/non-face images. Neither
is evidence that a real person, document or replay will be correctly classified.
