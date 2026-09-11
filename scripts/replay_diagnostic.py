"""Offline regression for recorded inputs. Never connects to HR or creates sessions.

Run as a module from the repository root. Output excludes frames, embeddings,
templates, account identifiers and input filenames. Exit 1 means that a known
recording passed the current passive classifier; exit 0 only means this input
was rejected, not that a model is safe for production authentication.
"""
import argparse
import hashlib
import json
from pathlib import Path

import cv2

from service.engine import FaceEngine, MODEL_VERSION
from service.images import FrameRejected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording", type=Path)
    parser.add_argument("--times", nargs=3, type=float, required=True)
    parser.add_argument("--crop", nargs=4, type=int, required=True,
                        metavar=("X", "Y", "WIDTH", "HEIGHT"))
    parser.add_argument("--model-dir", type=Path)
    args = parser.parse_args()
    if (any(t < 0 for t in args.times) or sorted(set(args.times)) != args.times
            or min(args.crop[:2]) < 0 or min(args.crop[2:]) < 1):
        parser.error("Use three increasing nonnegative times and a valid crop")

    digest = hashlib.sha256()
    with args.recording.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    cap = cv2.VideoCapture(str(args.recording))
    images = []
    try:
        for seconds in args.times:
            cap.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
            ok, frame = cap.read()
            if not ok:
                parser.error("Could not decode a requested frame")
            x, y, width, height = args.crop
            if x + width > frame.shape[1] or y + height > frame.shape[0]:
                parser.error("Crop lies outside the recording")
            images.append(frame[y:y + height, x:x + width].copy())
    finally:
        cap.release()

    report = {
        "schema": "red-face-replay-diagnostic-1",
        "source_sha256": digest.hexdigest(),
        "source_type": "known_recording_not_live_capture",
        "times_seconds": args.times,
        "crop_xywh": args.crop,
        "model_version": MODEL_VERSION,
        "model_manifest_sha256": hashlib.sha256(
            (Path(__file__).resolve().parents[1] / "models.lock.json").read_bytes()
        ).hexdigest(),
        "match_threshold": FaceEngine.MATCH_THRESHOLD,
        "pad_threshold": FaceEngine.PAD_THRESHOLD,
        "identity_lookup_performed": False,
        "authentication_attempted": False,
        "production_validation": False,
    }
    try:
        measured = FaceEngine(args.model_dir).measure(images)
        accepted = bool(measured["quality_passed"])
        report.update({
            "recording_passed_passive_checks": accepted,
            "min_pad_score": float(measured["min_live_score"]),
            "min_frame_consistency": float(measured["min_consistency"]),
            "result": "recording_acceptance_failure" if accepted else "this_recording_rejected",
        })
    except FrameRejected as exc:
        accepted = False
        report.update({"recording_passed_passive_checks": False,
                       "result": "this_recording_rejected", "rejection": str(exc)})
    finally:
        for image in images:
            image.fill(0)
        images.clear()
    print(json.dumps(report, indent=2))
    return 1 if accepted else 0


if __name__ == "__main__":
    raise SystemExit(main())
