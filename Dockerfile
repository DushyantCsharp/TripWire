# syntax=docker/dockerfile:1.7
# Tripwire's images, one target each, built from the repo root:
#   docker buildx build --target api|worker|console --platform linux/amd64,linux/arm64 .
# The JavaScript is built once on the build machine's platform and the runtime stages only copy
# it, so an image for the other architecture needs no emulation. Runtime: distroless Node 22 on
# Debian 13 as uid 65532 (nonroot), with no shell or package manager. CLAUDE.md "CI and release"
# covers running them. Base images are pinned by digest; Dependabot proposes updates.

FROM --platform=$BUILDPLATFORM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS deps
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo
# Optional native modules (bullmq's msgpackr-extract) for both targets, so one install serves
# either image. Only the build's copy of the workspace file says so: a Mac checkout keeps its own.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN printf '\nsupportedArchitectures:\n  os: [linux]\n  cpu: [x64, arm64]\n  libc: [glibc]\n' \
      >> pnpm-workspace.yaml \
 && cp pnpm-workspace.yaml /tmp/pnpm-workspace.yaml
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile --store-dir=/pnpm/store
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    cp /tmp/pnpm-workspace.yaml pnpm-workspace.yaml \
 && pnpm install --offline --frozen-lockfile --store-dir=/pnpm/store

FROM deps AS api-build
RUN pnpm turbo run build --filter=@tripwire/api...
# deploy installs the app and its workspace packages (their `files`) from the lockfile; it needs
# them injected, which only the deploy turns on: the workspace itself keeps its symlinks.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@tripwire/api deploy --prod --offline --store-dir=/pnpm/store \
      --config.inject-workspace-packages=true /out

FROM deps AS worker-build
RUN pnpm turbo run build --filter=@tripwire/worker...
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter=@tripwire/worker deploy --prod --offline --store-dir=/pnpm/store \
      --config.inject-workspace-packages=true /out

FROM deps AS console-build
RUN pnpm turbo run build --filter=@tripwire/console...

# What every image runs on, for the target platform.
FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Numeric, so Kubernetes' runAsNonRoot can check it: distroless's nonroot user.
USER 65532:65532

# REST and GraphQL on :4000. Needs REDIS_URL and WEBHOOK_SECRETS (apps/api/src/config.ts).
FROM runtime AS api
ENV API_HOST=0.0.0.0 API_PORT=4000
COPY --from=api-build --chown=65532:65532 /out/ ./
EXPOSE 4000
CMD ["dist/main.js"]

# BullMQ workers. Needs REDIS_URL and DATABASE_URL (apps/worker/src/config.ts). It drains for up to
# SHUTDOWN_TIMEOUT_MS (75s) on SIGTERM: give it a stop timeout longer than that. One-off commands:
#   node_modules/@tripwire/db/dist/cli.js up    migrations (the image's entrypoint is node)
#   dist/runbooks-index.js                     index /app/runbooks for get_runbook
FROM runtime AS worker
ENV RUNBOOKS_DIR=/app/runbooks
COPY --from=worker-build --chown=65532:65532 /out/ ./
COPY --chown=65532:65532 runbooks/ ./runbooks/
CMD ["dist/main.js"]

# The console on :3000. GRAPHQL_URL is read per request, so one image serves any deployment.
FROM runtime AS console
ENV HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
COPY --from=console-build --chown=65532:65532 /repo/apps/console/.next/standalone/ ./
COPY --from=console-build --chown=65532:65532 /repo/apps/console/.next/static/ ./apps/console/.next/static/
EXPOSE 3000
CMD ["apps/console/server.js"]
