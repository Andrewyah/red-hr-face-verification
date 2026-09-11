# Third-party notices

This is a company-hosted inference service using licensed pretrained models. It is
not a newly trained proprietary face model and does not call third-party facial
recognition APIs at runtime.

- OpenCV Zoo YuNet, MIT. Source commit `47534e27c9851bb1128ccc0102f1145e27f23f98`.
  Model: `models/face_detection_yunet/face_detection_yunet_2023mar.onnx`.
  Copyright notice and license: `licenses/YuNet-MIT.txt`.
- OpenCV Zoo SFace, Apache 2.0, same source commit.
  Model: `models/face_recognition_sface/face_recognition_sface_2021dec.onnx`.
  License: `licenses/SFace-Apache-2.0.txt`.
- Minivision Silent-Face-Anti-Spoofing, Apache 2.0, copyright 2020 Minivision.
  Source commit `b6d5f04ad78778917853b25c778acef6d5626d15`.
  `service/vendor/minifasnet.py` is an unmodified copy of
  `src/model_lib/MiniFASNet.py`. `service/engine.py` adapts the crop geometry and
  inference preprocessing from `src/generate_patches.py`, `src/anti_spoof_predict.py`
  and `src/data_io/functional.py`; changes include CPU-only eager loading,
  integrity validation, safe weights-only loading, bounded input and concurrency.
  The two pretrained weights are listed in `models.lock.json`.
  License: `licenses/Silent-Face-Anti-Spoofing-Apache-2.0.txt`.

Primary upstream repositories:
https://github.com/opencv/opencv_zoo
https://github.com/minivision-ai/Silent-Face-Anti-Spoofing

Dependencies retain their respective licenses. Model downloads happen during the
build, not when an employee submits camera frames.
