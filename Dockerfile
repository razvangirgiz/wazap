# docker build -t wazap .                          the server, on Alpine
# docker build --build-arg WITH_RECALL=1 -t wazap .  plus llama.cpp for search by meaning, on Debian
#   (then `wazap embed download` once into the /data volume fetches the model)
ARG WITH_RECALL=0

# The build runs on the runtime's own base: node_modules is copied into it, so
# anything installed per platform must match its libc (musl on Alpine, glibc
# in the recall image).
FROM node:22-alpine AS build-0
FROM node:22-bookworm-slim AS build-1

FROM build-${WITH_RECALL} AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

# The pinned llama.cpp release build (src/recall/llama.ts), sha256-verified.
# Its binaries are glibc builds, which is why the recall image is Debian.
FROM debian:bookworm-slim AS llama
ARG TARGETARCH
ARG LLAMA_TAG=b11516
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in \
      amd64) name=ubuntu-x64;   sum=8fd844c411fd56475215238a7a12e6510420dbfd963c8d76f84663dafb6557c8 ;; \
      arm64) name=ubuntu-arm64; sum=39a3d8fb891ff7cf69d23c192e59335a1c08a22874ba2d42b864dcb1cc125e41 ;; \
      *) echo "no pinned llama.cpp build for ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    file="llama-${LLAMA_TAG}-bin-${name}.tar.gz"; \
    curl -fsSL -o "/tmp/${file}" "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${file}"; \
    echo "${sum}  /tmp/${file}" | sha256sum -c -; \
    mkdir -p /opt/llama; \
    tar -xzf "/tmp/${file}" -C /opt/llama; \
    rm "/tmp/${file}"

FROM node:22-alpine AS runtime-0

FROM node:22-bookworm-slim AS runtime-1
ARG LLAMA_TAG=b11516
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=llama /opt/llama /opt/llama
ENV WAZAP_RECALL=local WAZAP_EMBED_BIN=/opt/llama/llama-${LLAMA_TAG}/llama-server

FROM runtime-${WITH_RECALL}
WORKDIR /app
ENV NODE_ENV=production WAZAP_DATA_DIR=/data WAZAP_HOST=0.0.0.0 WAZAP_PORT=8766
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE README.md AGENT.md ./
COPY skills ./skills
COPY eval/fixtures/world.json ./eval/fixtures/world.json
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8766
# node, not wget: the Debian image has no wget.
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8766/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
CMD ["serve", "--http"]
