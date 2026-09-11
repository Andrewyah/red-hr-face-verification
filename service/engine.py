"""Local CPU inference using pinned YuNet, SFace and two MiniFASNet models.

Outputs are measurements for evaluation, not authorization to create a session.
"""
import hashlib
import json
import threading
from pathlib import Path

import cv2
import numpy as np
import torch

from scripts.fetch_models import validate
from service.images import FrameRejected
from service.vendor.minifasnet import MiniFASNetV1SE, MiniFASNetV2

ROOT = Path(__file__).resolve().parents[1]
MODEL_VERSION = "red-face-2026-09-v1"


def unit_vector(vector):
    value = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm = np.linalg.norm(value)
    if value.shape != (128,) or not np.isfinite(value).all() or norm < 1e-6:
        raise FrameRejected("invalid_template")
    return value / norm


def scaled_crop(image, box, scale):
    # Same edge-preserving crop geometry as upstream generate_patches.py.
    height, width = image.shape[:2]
    x, y, bw, bh = [float(v) for v in box]
    scale = min(scale, (height - 1) / bh, (width - 1) / bw)
    nw, nh = bw * scale, bh * scale
    left = min(max(0.0, x + bw / 2 - nw / 2), width - 1 - nw)
    top = min(max(0.0, y + bh / 2 - nh / 2), height - 1 - nh)
    crop = image[int(top):int(top + nh) + 1, int(left):int(left + nw) + 1]
    return cv2.resize(crop, (80, 80), interpolation=cv2.INTER_LINEAR)


class FaceEngine:
    # Evaluation defaults only. These are not measured production operating points.
    MATCH_THRESHOLD = 0.65
    PAD_THRESHOLD = 0.99

    def __init__(self, model_dir=None):
        model_dir = Path(model_dir or ROOT / "models")
        manifest = json.loads((ROOT / "models.lock.json").read_text())
        for item in manifest["files"]:
            path = model_dir / item["name"]
            if not path.is_file() or not validate(path.read_bytes(), item):
                raise RuntimeError("Pinned model files are missing or corrupt")
        cv2.setNumThreads(1)
        torch.set_num_threads(1)
        self.lock = threading.Lock()
        self.detector = cv2.FaceDetectorYN.create(
            str(model_dir / "face_detection_yunet_2023mar.onnx"), "", (640, 640), 0.9, 0.3, 5000
        )
        self.recognizer = cv2.FaceRecognizerSF.create(
            str(model_dir / "face_recognition_sface_2021dec.onnx"), ""
        )
        self.pad_models = []
        for factory, name, scale in [
            (MiniFASNetV2, "2.7_80x80_MiniFASNetV2.pth", 2.7),
            (MiniFASNetV1SE, "4_0_0_80x80_MiniFASNetV1SE.pth", 4.0),
        ]:
            model = factory(conv6_kernel=(5, 5))
            weights = torch.load(model_dir / name, map_location="cpu", weights_only=True)
            weights = {key.removeprefix("module."): value for key, value in weights.items()}
            model.load_state_dict(weights, strict=True)
            model.eval()
            self.pad_models.append((model, scale))

    def _measure(self, image):
        height, width = image.shape[:2]
        self.detector.setInputSize((width, height))
        _, faces = self.detector.detect(image)
        if faces is None or len(faces) != 1:
            raise FrameRejected("exactly_one_face_required")
        face = faces[0]
        x, y, bw, bh = face[:4]
        if min(bw, bh) < 80 or bw * bh / (width * height) > 0.65:
            raise FrameRejected("adjust_distance")
        if x < 0 or y < 0 or x + bw >= width or y + bh >= height:
            raise FrameRejected("face_outside_frame")
        roi = image[int(y):int(y + bh), int(x):int(x + bw)]
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        if not 35 <= float(gray.mean()) <= 220 or cv2.Laplacian(gray, cv2.CV_64F).var() < 30:
            raise FrameRejected("improve_lighting_or_focus")
        aligned = self.recognizer.alignCrop(image, face)
        embedding = unit_vector(self.recognizer.feature(aligned))
        live_scores = []
        with torch.inference_mode():
            for model, scale in self.pad_models:
                crop = scaled_crop(image, face[:4], scale)
                # Upstream expects BGR, CHW, float32 in [0,255], NOT RGB or /255.
                tensor = torch.from_numpy(crop.transpose(2, 0, 1).copy()).float().unsqueeze(0)
                probabilities = torch.softmax(model(tensor), dim=1).numpy()[0]
                if probabilities.shape != (3,) or not np.isfinite(probabilities).all():
                    raise FrameRejected("model_output_invalid")
                live_scores.append(float(probabilities[1]))
        eyes = sorted([face[4:6], face[6:8]], key=lambda point: point[0])
        eye_distance = float(np.linalg.norm(eyes[1] - eyes[0]))
        if eye_distance < 15:
            raise FrameRejected("face_alignment")
        nose_offset = float((face[8] - (eyes[0][0] + eyes[1][0]) / 2) / eye_distance)
        return embedding, live_scores, nose_offset

    def measure(self, images):
        if len(images) < 3 or len(images) > 6:
            raise FrameRejected("three_to_six_frames_required")
        hashes = {hashlib.sha256(image.tobytes()).digest() for image in images}
        if len(hashes) != len(images):
            raise FrameRejected("duplicate_frames")
        if not self.lock.acquire(blocking=False):
            raise FrameRejected("service_busy")
        try:
            samples = [self._measure(image) for image in images]
        finally:
            self.lock.release()
        vectors = [sample[0] for sample in samples]
        # Require consistent identity across all frames, not merely their mean.
        similarity = min(float(np.dot(a, b)) for i, a in enumerate(vectors) for b in vectors[i + 1:])
        pad_min = min(score for _, scores, _ in samples for score in scores)
        return {
            "embedding": unit_vector(np.mean(vectors, axis=0)),
            "embeddings": vectors,
            "min_consistency": similarity,
            "min_live_score": pad_min,
            "nose_offsets": [sample[2] for sample in samples],
            "quality_passed": similarity >= self.MATCH_THRESHOLD and pad_min >= self.PAD_THRESHOLD,
        }
