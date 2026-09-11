"""Strict bounded decoding; camera frames stay in memory and are never logged."""
import base64
import binascii
import io
import warnings

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

MAX_IMAGE_BYTES = 400_000
MAX_PIXELS = 1280 * 1280


class FrameRejected(ValueError):
    pass


def decode_frame(encoded: str):
    if not isinstance(encoded, str) or len(encoded) > (MAX_IMAGE_BYTES * 4 // 3 + 4):
        raise FrameRejected("invalid_image")
    try:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) > MAX_IMAGE_BYTES:
            raise FrameRejected("invalid_image")
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format not in {"JPEG", "PNG"} or getattr(image, "n_frames", 1) != 1:
                    raise FrameRejected("invalid_image")
                width, height = image.size
                if min(width, height) < 160 or width * height > MAX_PIXELS:
                    raise FrameRejected("image_dimensions")
                # Camera canvas frames have already been oriented by the browser.
                rgb = np.asarray(image.convert("RGB"))
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    except (UnidentifiedImageError, OSError, ValueError, binascii.Error,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        if isinstance(exc, FrameRejected):
            raise
        raise FrameRejected("invalid_image") from None
