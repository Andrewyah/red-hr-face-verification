"""Sealed, subject-bound templates; no photos and no plaintext embeddings at rest."""
import base64
import json
import os
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from service.engine import MODEL_VERSION, unit_vector
from service.images import FrameRejected


class TemplateCodec:
    def __init__(self, key):
        if len(key) != 32:
            raise ValueError("Template encryption key must be exactly 32 bytes")
        self.cipher = AESGCM(key)

    def seal(self, subject, vector):
        data = json.dumps({"model": MODEL_VERSION, "vector": unit_vector(vector).tolist()},
                          allow_nan=False, separators=(",", ":")).encode()
        nonce = os.urandom(12)
        return base64.b64encode(nonce + self.cipher.encrypt(nonce, data, subject.encode())).decode()

    def open(self, subject, token):
        try:
            if len(token) > 8192:
                raise ValueError()
            data = base64.b64decode(token, validate=True)
            decoded = self.cipher.decrypt(data[:12], data[12:], subject.encode())
            template = json.loads(decoded)
            if template["model"] != MODEL_VERSION:
                raise ValueError()
            return unit_vector(template["vector"])
        except (ValueError, InvalidTag, KeyError, TypeError):
            raise FrameRejected("invalid_template") from None
