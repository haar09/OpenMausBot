FROM node:24-bookworm-slim AS compiler
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY . .
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build:server && pnpm exec vite build && node --experimental-strip-types scripts/dmxo-desktop.ts /src/desktop.Dockerfile

FROM docker.io/library/docker@sha256:4fa0ee1f3a7e4354c4ea34558b6d4ee32859baf4973d4c8ccc8e7fe3dd730c04 AS dockercli
FROM ghcr.io/milind-soni/openmausbot@sha256:6621452307934fa9c41a7e68c82006abf7d639ec692fcfba8281a0cbc6e65ba0
USER root
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=compiler /src/dist-server/ /app/dist-server/
COPY --from=compiler /src/dist/ /app/dist/
COPY --from=compiler /src/desktop.Dockerfile /app/desktop.Dockerfile
RUN chmod -R a+rX /app/dist-server /app/dist && node --check /app/dist-server/index.js
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/haar09/OpenMausBot" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      io.dmxo.openmausbot.source-build="1" \
      io.dmxo.openmausbot.upstream-version="0.1.154"
USER maus
