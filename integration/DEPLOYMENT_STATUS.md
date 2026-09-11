# Face authentication deployment status — 2026-09-11

## Current status — 12:49 UTC / 20:49 MYT investigation

**The requested phone flow is not yet verified.** The latest phone recording
stops because the current browser cannot read a saved device credential. This
is a different failure from the independently gated face-only login path.
Do not report another deployment or a successful build as a fix for that phone.

The current application uses device possession plus supplementary face
comparison. The separate face-only release policy remains disabled.
`REPLAY_FINDING_2026-09-11.md` records that previously recorded camera pixels
passed the current passive checks. This is an unresolved model/protocol
defect. Removing device proof to work around missing browser storage would
expose this known replay issue.

## Current deployed components and source ownership

- HR Site version 60, commit
  `3cac24c75c023960dea28148fa7db0a1658c851b`:
  automatic front-camera login, separate first-time registration, retained
  device credentials, and restored-key signature checks with bounded client
  diagnostics. The frontend and device-login integration live in the HR Site
  source repository under `v3/web/face-login.js`,
  `v3/web/face-device.js`, `v3/integration/hr-device-face-login.sql`
  and the matching Edge Function source. This GitHub repository owns the
  Railway inference service; deploying it does not publish the HR frontend.
- Supabase: `hr-device-face-login` version 1 and its device policy are active.
  `hr-face-login` version 1 remains behind the separate disabled face-only
  release policy. Do not confuse those two endpoints or enable the latter
  as a browser-storage recovery mechanism.
- Railway service `face-verifier-api`, deployment
  `196bb008-7331-4063-979e-a7d6bf4e9ae8`: SUCCESS at commit
  `a90dcb87bb82ff689015b9c586f837a00a0a25cd` (merged PR 3).
  Its configured source is `Andrewyah/red-hr-face-verification`.
  Readiness returned HTTP 200; an unsigned identification request returned
  HTTP 401. The service also logged a signed verification request with HTTP
  200 at 12:03 UTC. HTTP 200 alone is not proof of an employee face match.
- GitHub main at investigation time was
  `fc4bb25546990dcf2c7ed0d304cf4ecef07267a6`, two commits ahead of that
  Railway deployment. The compare contains deployment/replay documentation,
  an Auth probe source and an offline diagnostic script; it contains no
  inference server or model behavior change.

The ordinary Railway redeploy operation previously reused an old source
snapshot. A deployment explicitly pinned to the merged commit was required.
Always compare the deployed commit and changed runtime files before treating
a redeployment as a source update. Reconnecting the same healthy repository
cannot recreate a private key missing from the phone.

## What the latest phone failure establishes

The recording shows camera permission and a preview, followed by the
`face_device_binding_required` message. The corresponding production
client diagnostics at 12:47:46 and 12:49:06 UTC reported:

```json
{"build":"device-readback-20260911","key_state":"missing","marker":"absent","context":"top","secure":true,"standalone":false,"persistence":"best_effort"}
```

Neither the IndexedDB device record nor its separate non-identifying marker
is visible in that browser context. These bounded, untrusted client reports
help diagnose a flow; they never authenticate a user. They do not establish
whether the cause is another browser, an isolated web view, or cleared data.
The local guard runs before the signed login request. No corresponding model
request appeared in the Railway logs for these failed attempts.

Current source review found that signout/visit-session cleanup removes Auth
session data without deleting the IndexedDB face device key. Binding already
tests an actual signature after reading back both the temporary and final
stored key. Successful read-back does not guarantee future storage survival.
The server stores the public key; it cannot reconstruct the browser's
non-exportable private key.

## Recovery and completion criteria

For the current device-bound design, the affected browser needs a trusted
one-time setup through the existing first-time login path. Use the same
regular browser and the same HR origin for setup and subsequent visits.
After setup, the implemented face flow has no Email field or intermediate
confirmation button. Browser camera permission remains controlled by the
phone. This is the intended behavior, not a claim that the affected phone has
now passed.

Before closing this incident, verify on that phone that the key survives
closing/reopening the same browser and that one face-button tap leads to
automatic capture, a backend-verified session, the green success state and HR
entry. Record any required camera permission separately. A previous successful
backend job, synthetic controller checks, or healthy deployment is not that
end-to-end evidence.

If the requirement includes a new or storage-cleared browser with no existing
trusted credential and no setup login, the current passive model is insufficient.
Complete and validate fresh-capture/replay defenses before enabling independent
face-only login. Do not add a client success shortcut, recreate a private key
from an account identifier, fabricate validation evidence, or silently bypass
the existing policy.

## Historical hosted Auth contract check

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

## Historical release checks

- 19 Python tests passed, including loading the real pinned model weights and
  rejecting non-face inputs. Recognition/PAD acceptance tests use synthetic
  contract fixtures, not a biometric benchmark.
- 55 HR camera/controller/static checks and 16 existing Edge/database/camera
  contracts passed in the earlier entry release. These are historical results,
  not tests rerun during this latest phone investigation.

`FACE_LOGIN_DRAFT.md` documents the original independent face-only
implementation. This file supersedes its deployment status and the earlier
version of this status file. Its biometric limitations and release gate still
apply to independent face-only authentication.
