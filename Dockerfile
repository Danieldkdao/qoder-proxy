FROM ghcr.io/pnpm/pnpm:12.18.0 AS pnpm
FROM node:24-slim AS base
COPY --from=pnpm /opt/pnpm /opt/pnpm
RUN ln -s /opt/pnpm/pnpm /usr/local/bin/pnpm
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN node scripts/build.mts

FROM base AS production-dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

FROM base AS qoder-cli
ARG QODERCLI_VERSION=1.1.84
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/qoder
# Qoder's dispatcher/postinstall and sharp require their reviewed install scripts.
RUN pnpm add --save-exact --allow-build=@qoder-ai/qodercli --allow-build=sharp @qoder-ai/qodercli@${QODERCLI_VERSION}
RUN /opt/qoder/node_modules/.bin/qodercli --version

FROM node:24-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=qoder-cli /opt/qoder /opt/qoder
# Keep the established CLI path used by read-only discovery and operator tools.
RUN ln -s /opt/qoder/node_modules/.bin/qodercli /usr/local/bin/qodercli
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 QODERCLI_BIN=/opt/qoder/node_modules/.bin/qodercli
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=production-dependencies --chown=node:node /app/node_modules/ ./node_modules/
COPY --from=build --chown=node:node /app/dist/ ./dist/
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=8s --start-period=15s --retries=3 CMD node -e "require('node:http').get('http://127.0.0.1:3000/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node","dist/server.js"]
