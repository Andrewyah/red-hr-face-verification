"""Synthetic contract tests; do not establish biometric accuracy or liveness."""
import hashlib
import numpy as np
import pytest
from fastapi.testclient import TestClient
from service.app import create_app
from service.engine import unit_vector
from service.identify import identify
from service.images import FrameRejected
from service.templates import TemplateCodec
from tests.test_service import signed, frame, KEY, ENC


class Engine:
    def __init__(self, live=True):
        self.live = live
        self.calls = 0

    def measure(self, images):
        self.calls += 1
        return {"embeddings": [unit_vector(np.ones(128))] * 3, "quality_passed": self.live}


def candidate(codec, subject, vector):
    return {"subject": subject, "template": codec.seal(subject, unit_vector(vector))}


def test_unique_match_requires_live_consistent_measurement():
    codec = TemplateCodec(ENC)
    refs = [candidate(codec, "employee-a", np.ones(128)), candidate(codec, "employee-b", -np.ones(128))]
    engine = Engine()
    result = identify(engine, codec, [None] * 3, refs)
    assert result["subject"] == "employee-a" and result["candidate_match"]
    assert engine.calls == 1
    assert identify(Engine(False), codec, [None] * 3, refs)["subject"] is None


def test_two_matching_enrollments_are_ambiguous_and_never_choose_first():
    codec = TemplateCodec(ENC)
    refs = [candidate(codec, "a", np.ones(128)), candidate(codec, "b", np.ones(128))]
    result = identify(Engine(), codec, [None] * 3, refs)
    assert result["subject"] is None and not result["candidate_match"]


def test_corrupt_swapped_duplicate_or_excessive_reference_fails_closed():
    codec = TemplateCodec(ENC)
    ref = candidate(codec, "a", np.ones(128))
    for refs in [[{**ref, "subject": "b"}], [ref, ref], [ref] * 65, []]:
        with pytest.raises(FrameRejected):
            identify(Engine(), codec, [None] * 3, refs)


def test_identify_is_private_and_never_issues_tokens():
    codec = TemplateCodec(ENC)
    payload = {"frames": [frame(99), frame(100), frame(101)],
               "candidates": [candidate(codec, "a", np.ones(128))]}
    with TestClient(create_app(Engine(), KEY, ENC)) as client:
        assert client.post("/v1/identify", json=payload).status_code == 401
        raw, headers = signed("/v1/identify", payload)
        r = client.post("/v1/identify", content=raw, headers=headers)
        assert r.status_code == 200
        assert r.json()["candidate_match"] and r.json()["authenticated"] is False
        assert not ({"access_token", "refresh_token", "template"} & r.json().keys())
        assert client.post("/v1/identify", content=raw, headers=headers).status_code == 401
