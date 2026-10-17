# Explicitly scoped Customer verification addition

Owner instruction, 17 October 2026: “继续完善现有自建核验服务”, continuing the
Customer document portrait comparison and liveness registration repair. Reuse
the existing repository and Railway service; do not rebuild a separate app.

Baseline source before this work: `0df374fb4c6854924c835225f39f7435b546e4d5`.
Current successful Railway deployment before this work:
`dae005d3-3f60-4463-9444-ac7e3a335bcd`. The historical accepted staff runtime
reference and recovery branch in AGENTS.md remain unchanged.

Scope: new top-level `customer_identity/` package, its tests/documentation,
and exactly three Docker additions: copy package, install Tesseract CLI, replace
only the ASGI module entrypoint with an additive dispatcher. The new protection
script still compares every `service/` file and all model/dependency locks to
the original accepted commit. It checks the Dockerfile against the exact
reviewed delta, not a refreshed baseline fingerprint.

No HR frontend, SQL, Supabase policy, enrolled templates, old integration drafts,
origin/domain configuration, staff secrets or staff model thresholds change.
Compatibility tests exercise the old signed enroll/verify/replay contract through
the dispatcher with the Customer feature both enabled and disabled.

This authorization permits implementation and an evaluation deployment. It is
not a replacement for real-device/spoof acceptance and does not enable Customer
auto-activation or independent face-only employee login. Disable the Customer
flag to isolate the addon if an issue appears; staff source is unchanged.
