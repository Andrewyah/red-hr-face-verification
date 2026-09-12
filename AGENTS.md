# Protected production face login

On 12 September 2026, the owner reported repeated successful phone logins and explicitly requested that unrelated future changes preserve this feature.

- The accepted Railway inference source is commit `a90dcb87bb82ff689015b9c586f837a00a0a25cd`, deployment `196bb008-7331-4063-979e-a7d6bf4e9ae8`. Branch `face-login-stable-2026-09-12` is its recovery reference. Do not move or delete this reference during unrelated work.
- Freeze `service/`, `models.lock.json`, `requirements.lock`, `scripts/fetch_models.py`, deployment commands, origin/domain configuration and both face-service keys. Do not redeploy or retune them for unrelated HR/ERP/e-commerce work.
- Current login is device-bound authentication with supplementary face verification. The independent face-only release remains disabled. User-confirmed usability does not resolve the documented replay finding.
- The HR frontend is maintained in the existing HR Sites repository. Accepted frontend source: `aba15d35145926d2ff42ced28164594402e6176c`, Site version 63. Its `v3/protection/` directory contains the offline build gate and live database fingerprints.
- Do not apply the older `integration/web/hr-site.patch` or face-only draft over the current Site. `integration/DEPLOYMENT_STATUS.md` describes an earlier investigation; the owner has now confirmed the later Site works.
- Unrelated migrations must not change face SQL functions, policy/grants, enrolled templates, browser key identifiers or Supabase face Edge Functions. Preserve unlimited normal login retries, three-frame verification, camera cancellation and the green-to-HR handoff.
- A future explicit request to change face login must be scoped separately with a rollback point, contract tests and renewed real-device acceptance. Do not remove tests or refresh protection fingerprints merely to make unrelated work pass.

This is an engineering preservation rule and recovery reference, not provider-enforced branch protection or an uptime guarantee.
