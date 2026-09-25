# CPU-only image: the RL/settlement stack (torch, stable-baselines3, py-evm)
# is heavy, and nothing here needs a GPU. --extra-index-url pulls the CPU
# wheel for torch instead of pip's default CUDA build (saves ~2GB).
FROM python:3.11-slim

WORKDIR /app

# build-essential: a couple of the settlement-layer deps (py-evm's
# transitive requirements) don't ship manylinux wheels for every version
# and need to compile. curl: container healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --extra-index-url https://download.pytorch.org/whl/cpu \
    -r requirements.txt

COPY . .

ENV PYTHONUNBUFFERED=1 \
    DOCK_SETTLEMENT=on

EXPOSE 8000

ENTRYPOINT ["./docker-entrypoint.sh"]
