# Producer Studio — single image for the web (API + SPA) and worker services.
#   docker build -t producer-studio .
#   docker run -p 8787:8787 -v ps-data:/data -e ANTHROPIC_API_KEY=... producer-studio
# ROLE=all|api|worker selects what the container runs (default all).

# ---------- whisper.cpp (speech-to-text) ----------
FROM debian:bookworm-slim AS whisper
ARG WHISPER_REF=v1.7.6
ARG WHISPER_MODEL=small.en
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_REF} https://github.com/ggml-org/whisper.cpp /src/whisper.cpp
WORKDIR /src/whisper.cpp
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF \
 && cmake --build build -j"$(nproc)" --config Release --target whisper-cli \
 && mkdir -p /opt/whisper \
 && cp build/bin/whisper-cli /opt/whisper/whisper-cli
RUN curl -fsSL -o /opt/whisper/ggml-${WHISPER_MODEL}.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin

# ---------- dependencies + web build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @producer/web

# ---------- runtime ----------
FROM node:22-bookworm-slim
# ffmpeg + the shared libraries chrome-headless-shell (HyperFrames renderer) needs
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates tini \
      fonts-liberation libnss3 libatk-bridge2.0-0 libatk1.0-0 libgbm1 libasound2 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxrandr2 libxfixes3 libxext6 libx11-6 libxcb1 libpango-1.0-0 libcairo2 libcups2 libdrm2 \
      libdbus-1-3 libexpat1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
COPY --from=whisper /opt/whisper /opt/whisper
ENV NODE_ENV=production \
    PORT=8787 \
    ROLE=all \
    MODE=cloud \
    DATA_DIR=/data \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe \
    WHISPER_CLI=/opt/whisper/whisper-cli \
    WHISPER_MODEL=/opt/whisper/ggml-small.en.bin \
    KOKORO_CACHE=/opt/kokoro \
    PRODUCER_SKILL_DIR=/app/apps/server/skill \
    HYPERFRAMES_NO_TELEMETRY=1
# Pre-fetch the headless Chrome used by HyperFrames and the Kokoro-82M model so the first job doesn't download them.
ARG PREFETCH=1
RUN if [ "$PREFETCH" = "1" ]; then \
      node node_modules/hyperframes/bin/hyperframes.mjs browser ensure \
      && mkdir -p /opt/kokoro \
      && echo '{"id":"w","type":"warm"}' | node apps/server/scripts/tts-worker.mjs; \
    fi
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "apps/server/src/index.ts"]
