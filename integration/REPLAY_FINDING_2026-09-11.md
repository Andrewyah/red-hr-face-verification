# Recorded camera frames pass the current passive checks

Status: **reproduced; unresolved; face-only login remains disabled**.

This finding supersedes the previous assumption that only real-device acceptance
results were missing. The current passive inference recipe is demonstrably
insufficient to establish capture freshness. A successful signed-in match test
alone will not resolve this defect.

## Observed behavior

The supplied 14.9-second, 512×1106 screen recording shows a working front-camera
preview and then `Face login is not available yet. Please use Sign in.` The
deployed browser receives the disabled release response before submitting
frames. Production events still contain one enrollment and no match-test events.

An offline diagnostic extracted only the displayed camera area at 3.5, 4.3 and
5.1 seconds, with rectangle x=80, y=356, width=350, height=352. It used the
unchanged pinned production models and `FaceEngine.measure`, without any HR
database lookup, real employee template or authentication request.

Observed values:

| Check | Value |
| --- | --- |
| Model | `red-face-2026-09-v1` |
| Minimum passive PAD score | 0.9961174726486206 |
| Current PAD threshold | 0.99 |
| Minimum inter-frame embedding consistency | 0.9330065250396729 |
| `quality_passed` | `true` |
| Input provenance | Previously recorded pixels, not a fresh capture |
| Diagnostic outcome | **FAIL — recording accepted by passive checks** |

These scores are model outputs, **not calibrated probabilities**. The result
does not establish that a physical photograph or a phone pointed at another
screen would pass. It demonstrates acceptance of replayed digital pixels. No
employee identity was resolved and no account login was attempted. The empty
release policy continues to prevent the incomplete exchange from issuing a
session, so this is not a demonstrated production account takeover.

## Reproduction

The private recording is not committed, uploaded to Railway, or used to replace
an enrollment. With that original recording supplied locally, run:

```sh
python -m scripts.replay_diagnostic /path/to/recording.mp4 --times 3.5 4.3 5.1 --crop 80 356 350 352
```

The tool outputs only diagnostic metadata and aggregate scores. Exit code 1
means this known recording passed the passive checks. A rejection / exit 0 is
only one negative-case result and never authorizes production activation.

Source SHA-256:
`80cac5542a225e5ca0484cd2151883bb2c63506280a1c6824d84b8840338ac6a`

Pinned model manifest SHA-256:
`02b251e081acf62ea121a30bd2be4fa7e4446f8c80339136d0b0d07f27024c19`

## Required remediation

- Introduce and evaluate evidence tied to a fresh, unpredictable server
  challenge or a trusted device capture channel. The current request nonce
  authenticates Edge-to-model traffic; it does not authenticate the pixels.
- Evaluate old recordings, recompression, reordered frames, prepared responses,
  adaptive/injected responses, printed and displayed images as distinct cases,
  alongside genuine captures on supported iPhone and desktop browsers.
- Validate the new protocol's real acceptance/rejection behavior and then bind
  its exact recipe/model/build to the login release. Do not raise the passive
  threshold to fit this one video, blacklist its hash, or treat synthetic test
  fixtures as real acceptance measurements.
- Keep first-time registration separate from repeat login. Preserve the requested
  no-Email/no-intermediate-button repeat-login interaction; any materially
  different physical interaction must be made explicit, not silently introduced.

The [W3C media capture specification](https://www.w3.org/TR/mediacapture-streams/)
defines media capture APIs, not an HR server's trusted proof of capture freshness.
[Face Flashing research](https://arxiv.org/abs/1801.01949) describes randomized
light reflection, timing and face-shape validation as a hands-free approach.
Its published result is not validation of this implementation. A simple color
animation or a blink/turn detector does not inherit that protocol's guarantees.

No new challenge protocol or validated replacement model was completed in this
diagnostic. The system cannot yet be described as complete or safely enabled for
face-only authentication.
