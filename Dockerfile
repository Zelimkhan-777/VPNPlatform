# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node@sha256:7326fb2dbdce998edd72140946851be64ef4a643e8715e138ca467e8e9d92c99

FROM ${NODE_IMAGE} AS workspace

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV DEBIAN_FRONTEND=noninteractive
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/node-agent/package.json apps/node-agent/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/orchestration-store/package.json packages/orchestration-store/package.json
COPY packages/safe-logger/package.json packages/safe-logger/package.json
COPY prisma/schema.prisma prisma/schema.prisma

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
COPY prisma ./prisma

RUN pnpm prisma:generate

FROM workspace AS api-build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm --filter @vpn-platform/api... build \
  && pnpm --filter @vpn-platform/api deploy --prod --legacy /opt/application \
  && cp -R /workspace/prisma /opt/application/prisma \
  && cd /opt/application \
  && /workspace/node_modules/.bin/prisma generate --schema prisma/schema.prisma

FROM workspace AS worker-build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm --filter @vpn-platform/worker... build \
  && pnpm --filter @vpn-platform/worker deploy --prod --legacy /opt/application \
  && cp -R /workspace/prisma /opt/application/prisma \
  && cd /opt/application \
  && /workspace/node_modules/.bin/prisma generate --schema prisma/schema.prisma \
  && rm -rf prisma

FROM workspace AS bot-build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  pnpm --filter @vpn-platform/bot... build \
  && pnpm --filter @vpn-platform/bot deploy --prod --legacy /opt/application

FROM workspace AS web-build
ARG WEB_API_PROXY_TARGET
ENV WEB_API_PROXY_TARGET=$WEB_API_PROXY_TARGET
RUN pnpm --filter @vpn-platform/web... build

FROM ${NODE_IMAGE} AS runtime-base

ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS api

ENV API_HOST=0.0.0.0
ENV API_PORT=3001
COPY --from=api-build --chown=node:node /opt/application/ ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health/live').then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]

FROM runtime-base AS worker

COPY --from=worker-build --chown=node:node /opt/application/ ./
USER node
CMD ["node", "dist/main.js"]

FROM runtime-base AS bot

COPY --from=bot-build --chown=node:node /opt/application/ ./
USER node
CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS web

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app/apps/web

COPY --from=web-build --chown=node:node /workspace/apps/web/.next/standalone/ /app/
COPY --from=web-build --chown=node:node /workspace/apps/web/.next/static/ ./.next/static/
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=3 --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
