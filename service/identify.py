"""Closed-set measurements, not authorization. Operating points need validation."""
import numpy as np
from service.engine import FaceEngine
from service.images import FrameRejected

RECIPE = "red-face-identify-v1"
MIN_MARGIN = 0.12
MAX_CANDIDATES = 64


def identify(engine, codec, images, candidates):
    if not isinstance(candidates, list) or not 1 <= len(candidates) <= MAX_CANDIDATES:
        raise FrameRejected("invalid_candidates")
    references, subjects = [], set()
    for item in candidates:
        if not isinstance(item, dict) or set(item) != {"subject", "template"}:
            raise FrameRejected("invalid_candidates")
        subject = item["subject"]
        if not isinstance(subject, str) or not subject or subject in subjects:
            raise FrameRejected("invalid_candidates")
        subjects.add(subject)
        references.append((subject, codec.open(subject, item["template"])))
    # One inference per capture, irrespective of the number of employees.
    measured = engine.measure(images)
    rankings = []
    for subject, reference in references:
        scores = [float(np.dot(reference, vector)) for vector in measured["embeddings"]]
        if not scores or not np.isfinite(scores).all():
            raise FrameRejected("model_output_invalid")
        rankings.append((min(scores), max(scores), subject))
    rankings.sort(reverse=True)
    best = rankings[0]
    runner = max((row[1] for row in rankings[1:]), default=-1.0)
    unique = bool(measured["quality_passed"] and best[0] >= FaceEngine.MATCH_THRESHOLD
                  and best[0] - runner >= MIN_MARGIN)
    return {"recipe": RECIPE, "quality_passed": bool(measured["quality_passed"]),
            "candidate_match": unique, "subject": best[2] if unique else None,
            "similarity": round(best[0], 6), "margin": round(best[0] - runner, 6)}
