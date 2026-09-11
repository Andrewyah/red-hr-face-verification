FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 OMP_NUM_THREADS=1 OPENBLAS_NUM_THREADS=1
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY models.lock.json ./
COPY scripts ./scripts
RUN python scripts/fetch_models.py
COPY service ./service
COPY licenses ./licenses
COPY THIRD_PARTY_NOTICES.md ./
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin faceapp && chown -R root:root /app && chmod -R a-w /app
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','8080')+'/readyz',timeout=4)"
CMD ["sh", "-c", "exec uvicorn service.app:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --limit-concurrency 8 --timeout-keep-alive 5 --no-access-log"]
