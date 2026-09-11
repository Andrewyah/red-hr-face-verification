# Face authentication deployment status — 2026-09-11

**Later diagnostic:** `REPLAY_FINDING_2026-09-11.md` records a reproduced
acceptance of previously recorded camera pixels by the current passive checks.
This is an unresolved model/protocol defect, not only missing phone test results.
The release policy remains empty; no face-only login has been activated.

## Deployed components

- HR Site version 56, commit `81196087b944274f9c78732bbb7283d48b812349`:
  separate automatic front-camera login and first-time Email registration.
- Supabase project `xkeisacomchcsxjkmwcv`: additive
  `hr_face_login_gated_exchange` migration and `hr-face-login` version 1.
  The private release policy remains empty. Anonymous and authenticated roles
  cannot execute the backend exchange RPC.
- Railway service `face-verifier-api`, deployment
  `196bb008-7331-4063-979e-a7d6bf4e9ae8`: SUCCESS at commit
  `a90dcb87bb82ff689015b9c586f837a00a0a25cd` (merged PR 3).
  Readiness returned HTTP 200 with ready=true. The new `/v1/identify` route
  rejected an unsigned request with HTTP 401. Keys and domain were retained.

The ordinary Railway redeploy operation reused an old source snapshot. A
deployment explicitly pinned to the merged commit was required; check commit
provenance before treating a redeployment as a source update.

## Real hosted Auth contract check

`auth-contract-probe.ts` was deployed temporarily behind an unpredictable
256-bit invocation secret hash, a short expiry and an in-process one-use guard.
No real employee account, enrollment or access policy was modified. The probe
created a temporary Auth-only account at a reserved `.invalid` address; it sent
no email and returned no credentials or employee data to the caller.

Observed result:

```json
{"passed":true,"checks":{"hosted_exchange":true,"verified_identity":true,"one_use_token":true,"unlinked_account_denied":true,"signout":true},"cleanup":true,"failure":null}
```

The test verified `admin.generateLink` plus server-side `verifyOtp`, `getUser`,
one-use token rejection, denial of HR workspace to an unlinked account and
signout. The temporary user was deleted; a production query found zero probe
users afterward. The temporary Edge Function was replaced by a no-operation
HTTP 410 handler with gateway JWT verification enabled (version 2). The secret
and temporary deployment wrapper are not retained here.

This confirms the hosted Auth API contract. It does not validate face identity,
biometric operating points, full login finalization races or physical capture.

## Other observed checks

- 19 Python tests passed, including loading the real pinned model weights and
  rejecting non-face inputs. Recognition/PAD acceptance tests use synthetic
  contract fixtures, not a biometric benchmark.
- 55 HR camera/controller/static checks and 16 existing Edge/database/camera
  contracts passed in the preceding entry release.
- Production face events within the last day: one `capture_started`, one
  `enrolled`, no `test_match` or `test_no_match` events.

## Remaining work and current behavior

The face-only login release is still disabled. No real validated report or
enabled release policy exists. The browser stops after `begin` is rejected;
it uploads no login frames and returns no session or green success state.

Fresh capture / replay and injection defenses need completion, followed by
real-device genuine, impostor, printed-photo, screen-photo and video checks.
The enrollment screen's existing signed-in Settings → Face recognition →
Test my face path can collect an initial real-device match result. That one
result alone must not be interpreted as spoof-resistance validation.

`FACE_LOGIN_DRAFT.md` documents the original implementation. This file
supersedes its deployment status and statement that the hosted Auth contract
has not been exercised; its biometric limitations and release gate still apply.
