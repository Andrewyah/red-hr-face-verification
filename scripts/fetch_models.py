"""Build-time downloads only. Validate pinned artifacts before any model load."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def validate(data: bytes, item: dict) -> bool:
    if len(data) != item["size"]:
        return False
    if "sha256" in item:
        return hashlib.sha256(data).hexdigest() == item["sha256"]
    # Upstream GitHub contents API supplies the Git blob digest for non-LFS files.
    header = f"blob {len(data)}\0".encode()
    return hashlib.sha1(header + data).hexdigest() == item["git_blob_sha1"]


def main():
    model_dir = ROOT / "models"
    model_dir.mkdir(exist_ok=True)
    manifest = json.loads((ROOT / "models.lock.json").read_text())
    for item in manifest["files"]:
        path = model_dir / item["name"]
        if path.exists() and validate(path.read_bytes(), item):
            print(f"Verified {item['name']}")
            continue
        req = urllib.request.Request(item["url"], headers={"User-Agent": "RedHR-ModelBuild/1.0"})
        with urllib.request.urlopen(req, timeout=60) as response:
            data = response.read(item["size"] + 1)
        if not validate(data, item):
            raise RuntimeError(f"Model integrity check failed: {item['name']}")
        temp = path.with_suffix(path.suffix + ".download")
        temp.write_bytes(data)
        temp.replace(path)
        print(f"Verified {item['name']}")


if __name__ == "__main__":
    main()
