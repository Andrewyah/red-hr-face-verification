"""Preserve the accepted staff runtime and allow only this reviewed Docker delta."""
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE = "a90dcb87bb82ff689015b9c586f837a00a0a25cd"
PROTECTED = ["service", "models.lock.json", "requirements.lock", "scripts/fetch_models.py", "railway.toml", ".dockerignore"]
COPY_LINES = ("COPY customer_identity ./customer_identity\n"
              "RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*\n")


def main():
    subprocess.run(["git", "diff", "--exit-code", BASELINE, "--", *PROTECTED], cwd=ROOT, check=True)
    original = subprocess.check_output(["git", "show", BASELINE + ":Dockerfile"], cwd=ROOT).decode()
    expected = original.replace("COPY service ./service\n", "COPY service ./service\n" + COPY_LINES)
    expected = expected.replace("uvicorn service.app:app", "uvicorn customer_identity.runtime:app")
    if (ROOT/"Dockerfile").read_text() != expected:
        raise SystemExit("Dockerfile differs from the explicitly scoped Customer addon changes")
    print("Accepted staff runtime unchanged; only reviewed Customer Docker additions present")


if __name__ == "__main__":
    main()
