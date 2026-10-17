"""Reuse pinned inference without modifying staff inference, keys or thresholds."""
import hashlib
import re
import subprocess
import unicodedata

import cv2
import numpy as np
from service.engine import unit_vector
from service.images import decode_frame, FrameRejected
from customer_identity.protocol import Rejected


def name_tokens(value):
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().upper()
    return re.findall(r"[A-Z]+", value)


def check_document_text(text, expected_name, kind):
    # OCR is only a name/layout consistency check. It cannot authenticate an ID,
    # detect all alterations, or query an issuing authority; release stays closed.
    tokens = name_tokens(text)
    name = name_tokens(expected_name)
    if len(name) < 2 or any(token not in tokens for token in name):
        raise Rejected("document_name_not_confirmed")
    if kind == "mykad":
        if not re.search(r"\b\d{6}\s*-?\s*\d{2}\s*-?\s*\d{4}\b", text) or not ({"MALAYSIA", "PENGENALAN"} <= set(tokens)):
            raise Rejected("document_not_readable")
    elif kind == "passport":
        if not ({"PASSPORT", "PASPORT"} & set(tokens)) or "P<" not in text.upper():
            raise Rejected("document_not_readable")
    else:
        raise Rejected("unsupported_document")


class Analyzer:
    def __init__(self, engine):
        self.engine = engine

    def document(self, encoded, name, kind):
        try:
            image = decode_frame(encoded)
            # OCR reads/writes pipes only; do not create image or text files.
            ok, png = cv2.imencode(".png", image)
            if not ok:
                raise Rejected("document_not_readable")
            try:
                result = subprocess.run(["tesseract", "stdin", "stdout", "-l", "eng", "--psm", "11"],
                    input=png.tobytes(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8,
                    check=True, env={"PATH": "/usr/bin:/bin", "OMP_THREAD_LIMIT": "1"})
            except (OSError, subprocess.SubprocessError):
                raise Rejected("document_reader_unavailable", 503) from None
            text = result.stdout.decode("utf-8", errors="replace")
            check_document_text(text, name, kind)
            if not self.engine.lock.acquire(blocking=False):
                raise Rejected("service_busy", 503)
            try:
                height, width = image.shape[:2]
                self.engine.detector.setInputSize((width, height))
                _, faces = self.engine.detector.detect(image)
                if faces is None or len(faces) != 1:
                    raise Rejected("document_one_portrait_required")
                face = faces[0]
                x, y, w, h = face[:4]
                if min(w, h) < 50 or x < 0 or y < 0 or x+w >= width or y+h >= height or w*h > width*height*0.35:
                    raise Rejected("document_portrait_not_clear")
                crop = self.engine.recognizer.alignCrop(image, face)
                return unit_vector(self.engine.recognizer.feature(crop)).tolist()
            finally:
                self.engine.lock.release()
        except FrameRejected as error:
            raise Rejected(str(error)) from None

    def live(self, encoded):
        try:
            image = decode_frame(encoded)
            if not self.engine.lock.acquire(blocking=False):
                raise Rejected("service_busy", 503)
            try:
                vector, scores, pose = self.engine._measure(image)
            finally:
                self.engine.lock.release()
            return {"vector": vector.tolist(), "pose": pose, "pad": min(scores),
                    "hash": hashlib.sha256(image.tobytes()).hexdigest()}
        except FrameRejected as error:
            raise Rejected(str(error)) from None
