# deploy/seo-worker.Dockerfile — the seo-pipeline-worker's build on Railway.
#
# Why: Nixpacks pins the worker's Node 24 to nodejs-24.10.0 (nixpkgs 23f9169c,
# build log 2026-11-06). That release is older than the October 21, 2026
# security release 24.22.1 (CVE-2026-111497, a Brotli decoder out-of-bounds
# write), and the worker fetches outside pages. This image uses the same
# moving node:24-bookworm base and the same Node floor check as
# deploy/portal.Dockerfile.
#
# The Nixpacks plan it replaces (build log 2026-11-06):
#   setup    nodejs_24, npm-9_x, ffmpeg   -> node:24-bookworm, apt ffmpeg
#   install  npm ci                       -> npm ci --include=dev, as the portal
#   build    npm run build                -> left out
#   start    node server/scripts/run-seo-pipeline-worker.js -> CMD, same command
# The build step only bundles the client (cd client && npm run build) after
# the portal's pre-build checks. The worker serves no pages, and its one read
# of a client file (the logo in social-card-renderer.js) finds client/public
# before client/dist.
#
# No browser: the Nixpacks image had none and this one has none, so the
# worker's Playwright paths keep failing at browser launch, as they do today.
# Installing one would let those paths run for the first time on this service.
#
# CMD is the start command, so an empty start command still starts the worker,
# never the portal. (2026-10-22: the worker read the portal's config and ran a
# second portal, crons included, for about an hour.)
#
# Selected by RAILWAY_DOCKERFILE_PATH=deploy/seo-worker.Dockerfile on the
# seo-pipeline-worker service only; the service's Nixpacks build command is
# then unused, as on the portal. Rollback: delete that variable; the next
# deploy builds with Nixpacks again.
FROM node:24-bookworm

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    PATH=/app/node_modules/.bin:$PATH

# ffmpeg: the social video metadata strip and the recap transcoder spawn it,
# and both load in the worker's process (nixpacks.toml adds it for the same reason).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Node floor: node:24-bookworm is a moving tag, so a stale cached base image
# could hold a Node 24 release older than 24.22.1. scripts/dev/runtime.js holds
# the floor and .nvmrc the major; the build stops here, before npm ci.
RUN node -e "console.log('node', require('./scripts/dev/runtime').checkRuntime('/app'))"

# Railway names a cache mount by its service: s/<seo-pipeline-worker service id>-.
RUN --mount=type=cache,id=s/5cc1acab-c32a-4a33-9ed5-b53d0ce0c15a-/root/.npm,target=/root/.npm \
    npm ci --include=dev --no-audit --no-fund

RUN ffmpeg -hide_banner -version > /dev/null

CMD ["node", "server/scripts/run-seo-pipeline-worker.js"]
