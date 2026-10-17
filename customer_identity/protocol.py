"""Session-bound document/active-challenge protocol. Measurements, not authority."""
import hashlib
import math
import secrets
from datetime import datetime, timezone

POLICY = "document-face-liveness-20261017"
PROVIDER = "red-self-hosted"
RECIPE = "customer-active-pose-v1"
SESSION_SECONDS = 900
STEP_SECONDS = 45


class Rejected(ValueError):
    def __init__(self, code, status=422):
        self.code, self.status = code, status
        super().__init__(code)


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def cosine(a, b):
    if len(a) != 128 or len(b) != 128 or not all(math.isfinite(x) for x in [*a, *b]):
        raise Rejected("invalid_measurement")
    denominator = math.sqrt(sum(x*x for x in a) * sum(x*x for x in b))
    if denominator < 1e-6:
        raise Rejected("invalid_measurement")
    return sum(x*y for x, y in zip(a, b)) / denominator


def scrub(session, state, now, reason=None):
    session.update(state=state, completedAt=iso(now), reason=reason)
    for key in ("expectedName", "documentVector", "vectors", "hashes", "baseline", "challenge", "directions"):
        session.pop(key, None)


def challenge(session, now):
    # Future directions are never returned to the browser. Each response is bound
    # to a freshly generated, single-use nonce and a server-side time window.
    count = session.get("step", 0)
    action = "center" if count in (0, 2, 4) else session["directions"][(count-1)//2]
    session["challenge"] = {"id": secrets.token_urlsafe(24), "action": action,
                            "issued": now, "expires": now + STEP_SECONDS}


def start_capture(session, vector, now):
    session["documentVector"] = vector
    session["directions"] = secrets.choice([["left", "right"], ["right", "left"]])
    session.update(vectors=[], hashes=[], step=0)
    challenge(session, now)


def accept_frame(session, payload, analyzer, now):
    current = session.get("challenge")
    if not current or payload.get("challengeId") != current["id"]:
        raise Rejected("challenge_mismatch", 409)
    if now > current["expires"]:
        scrub(session, "failed", now, "challenge_expired")
        return
    if now - current["issued"] < 0.6:
        raise Rejected("challenge_too_fast", 409)
    try:
        measured = analyzer.live(payload["frame"])
        vector, pose, pad, frame_hash = (measured[k] for k in ("vector", "pose", "pad", "hash"))
        if not math.isfinite(pose) or not math.isfinite(pad):
            raise Rejected("invalid_measurement")
        if frame_hash in session["hashes"]:
            raise Rejected("duplicate_frame")
        # Frozen, explicitly uncalibrated evaluation points; separate from HR.
        if pad < 0.99:
            raise Rejected("liveness_not_confirmed")
        if cosine(session["documentVector"], vector) < 0.65:
            raise Rejected("document_face_mismatch")
        if any(cosine(previous, vector) < 0.65 for previous in session["vectors"]):
            raise Rejected("face_changed")
        if session["step"] == 0:
            if abs(pose) > 0.18:
                raise Rejected("look_straight")
            session["baseline"] = pose
        delta = pose - session["baseline"]
        # Unmirrored capture: subject's left projects toward image-right.
        valid_pose = {"center": abs(delta) <= 0.12,
                      "left": 0.18 <= delta <= 0.65,
                      "right": -0.65 <= delta <= -0.18}[current["action"]]
        if not valid_pose:
            raise Rejected("action_not_confirmed")
        session["vectors"].append(vector)
        session["hashes"].append(frame_hash)
        session["step"] += 1
        if session["step"] == 5:
            # Deliberately NOT state=passed. No environment variable can convert
            # unvalidated model measurements into production identity evidence.
            scrub(session, "evaluated", now)
            session["candidateChecks"] = {"document": "candidate", "faceMatch": "candidate", "liveness": "candidate"}
        else:
            challenge(session, now)
    except Rejected as error:
        if error.status == 503:
            raise
        scrub(session, "failed", now, error.code)


def public_state(session):
    value = {"state": session["state"], "mode": "evaluation", "activationAllowed": False,
             "expiresAt": iso(session["expires"]), "step": session.get("step", 0),
             "reason": session.get("reason"), "returnUrl": session["returnUrl"]}
    if session["state"] == "pending":
        value["documentNeeded"] = "documentVector" not in session
        if "challenge" in session:
            current = session["challenge"]
            value["challenge"] = {"id": current["id"], "action": current["action"],
                                  "expiresAt": iso(current["expires"])}
    return value


def backend_state(session, origin):
    value = {key: session[key] for key in ("id", "registrationId", "attemptId", "state")}
    value.update(provider=PROVIDER, policy=POLICY, recipe=RECIPE, mode="evaluation",
                 activationAllowed=False, expiresAt=iso(session["expires"]),
                 url=origin + "/customer-identity/verify#" + session["captureToken"],
                 documentScope="portrait_and_name_only")
    if session["state"] == "evaluated":
        value["candidateChecks"] = session["candidateChecks"]
        value["evaluatedAt"] = session["completedAt"]
    return value
