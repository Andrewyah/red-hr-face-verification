# Hands-free face login — draft, not activated

The requested repeat-login flow is: tap the face icon, hold the front camera
steady, automatically capture and verify, show green after the server and Auth
confirm success, then enter HR. Registered employees do not enter Email/Password
again. Account verification remains part of **first registration**, available
through the separate “First time? Register your face” action.

The existing employee registration is retained in Supabase. This change does not
replace templates or request re-enrollment. No AWS or external recognition API,
WebAuthn/passkey sheet, Authenticator code, capture button or second Sign in
button is involved in the proposed repeat-login flow.

## What is implemented

- `web/face-login.js` starts the front camera on the original tap. It waits for
  stable preview pixels, takes three transient frames, and permits at most three
  attempts. Stability is a UX aid, **not a liveness check**. Close/backgrounding
  stops tracks; late credentials are discarded. Green appears only after a real
  server response, Auth identity verification and successful session installation.
- `service/identify.py` compares measured embeddings to the backend's active
  enrollment set. It rejects ambiguous identities and requires consistent match
  across all frames. At most 64 enrolled employees are supported in this draft.
  Its 0.65 match / 0.12 separation / existing 0.99 PAD operating points are
  unvalidated. The private signed `/v1/identify` endpoint returns measurements,
  never Auth credentials.
- `hr-face-login.sql` protects anonymous login jobs behind backend-only RPCs,
  short-lived random proofs, one-use claims, rate limits and repeated active
  employee / enrollment revision checks. Templates stay in the existing private
  schema. Anonymous/authenticated database roles cannot call the exchange RPC.
  Capture fingerprints prevent **exact** byte replay for one day; recompression,
  altered pixels and injected video remain part of the unresolved liveness work.
- `hr-face-login/` orchestrates the verified backend match. It derives identity
  exclusively from the server enrollment snapshot, then creates/consumes an Auth
  token internally and rechecks the actual Auth session before returning it.
  No email is delivered or OTP requested. A revoked enrollment or failed identity
  check discards the new session. Browser-supplied identities, templates and match
  results are rejected. This draft has only synthetic Auth contract testing.
- `web/hr-site.patch` changes only the relevant source/controller tests against
  HR commit `e10dca700e8f7a0dbb7cdd849a804e8deb29e7b1` (published version 54).
  Face login and first-time registration have separate handlers; page changes and
  signout cancel both. HR still independently validates the authenticated user
  and active employee workspace before showing private content.

## Verification completed

On 2026-09-11:

- 18 Python tests passed (new identification contract plus existing API/security
  regressions). The existing real-model smoke test was excluded from this run;
  model weights were unchanged. These measurements used synthetic fixtures.
- 31 Node tests passed, including 7 automatic-camera lifecycle tests, 8 exchange
  HTTP contracts and a local PostgreSQL contract covering privileges, empty and
  expired release policy, proof/replay/expiry, enrollment revision/revocation,
  Auth session binding and rate limits. PostgreSQL used PGlite 0.5.8 with minimal
  synthetic Auth/HR schema; no production schema or data was changed.
- The HR source patch passed 46 controller tests and 2 build/source/CSP checks.
  The static build succeeded. Camera rendering and actual iPhone hardware were
  not tested in this environment.

These tests show control-flow behavior, not face-recognition accuracy, spoof
resistance or a live Supabase passwordless integration. A successful enrollment
also does not demonstrate those properties.

## Remaining release work

The current camera channel and passive classifiers do not establish that a
capture is fresh. Server-validated active challenge/replay/injection handling
and genuine/printed-photo/display/video/impostor measurements on supported
devices remain incomplete. Implement and validate freshness while preserving
the requested hands-free UX. A new recipe/version must be bound into the Edge
Function and database policy when that protocol changes.

Finish this work and record the tested builds, devices, datasets/provenance,
operating points, measured errors and limitations in a real validation report.
Then test the real session exchange in staging, including inactive/deleted/
banned employees, revoked templates, concurrent requests, cancellation and
disabling the release during an exchange. The current synthetic Auth adapter is
not evidence that the hosted Auth deployment accepts the exchange unchanged.

`hr_face_private.login_policy` deliberately starts empty. A trusted operator may
only record an enabled policy for a validated exact model/recipe with the hash
of its actual report and a bounded review expiry. A hash is an audit reference,
not proof of validation; do not insert an arbitrary/test hash to activate login.
No report, active policy or production activation is included in this branch.

## Prepared cutover after the remaining work

1. Deploy the reviewed model service with `/v1/identify`. The inference service
   continues to report `authenticated: false` because only the Edge exchange can
   issue credentials. Preserve existing HMAC and template keys in secret storage.
2. Apply the reviewed additive SQL through the project's Supabase migration
   workflow, after the existing enrollment schema. Leave the policy empty until
   real validation and staging integration checks succeed.
3. Deploy `hr-face-login` with gateway JWT verification disabled: first capture
   begins before an employee has a session. Its own proof, model and policy
   checks are mandatory. `SUPABASE_SERVICE_ROLE_KEY` is server-only; use the
   existing private Vault service configuration. Do not ship keys to the browser.
4. Apply `web/hr-site.patch` to the corresponding HR source checkout, then run:

   ```sh
   git apply --check /path/to/hr-site.patch
   git apply /path/to/hr-site.patch
   python3 v3/scripts/build.py
   node --test v3/tests/controller.test.cjs v3/tests/source-check.test.js v3/tests/build-security.test.cjs
   ```

5. Re-run real-device staging acceptance for initial enrollment and repeat
   login, then publish the built HR version and the validated release policy.
   Ordinary email/password recovery stays available separately. Existing Auth
   factors and database access policies are not removed by this draft.

If login must be disabled, expire/disable the policy to stop both new jobs and
in-flight finalization, and return the site to its prior published version.
Do not remove the existing enrollments or template encryption key.

For reproducible local SQL tests, install Node 22.18+ and run `npm ci && npm test`.
`tests/face-login-bootstrap.sql` creates only local fixture schemas and must
never be run against the real HR database.
