# Portal production image for Railway.
#
# Why this file exists: Nixpacks wrote every service variable name on one
# Dockerfile line (ENV A=$A B=$B ...). With 1,264 variables that line passed
# BuildKit's 65,535-character limit on 2026-11-02, and every portal build
# failed until variables were deleted. This build sees only the ARGs below;
# Railway still injects every service variable when the app runs.
#
# Railway uses this file only where the service's Dockerfile path (or
# RAILWAY_DOCKERFILE_PATH) points at deploy/portal.Dockerfile. It is not a
# root Dockerfile on purpose: the seo-pipeline-worker builds from the same
# repo root with Nixpacks and would switch builders too.
#
# Same plan as the Nixpacks build it replaces (docs/DEPLOYMENT.md):
#   setup    Node 24, npm, ffmpeg (nixpacks.toml)
#   install  npm ci, every workspace, dev dependencies included
#   build    npm run build && npx playwright install --with-deps chromium
#   start    the service start command, node server/index.js
#            (pre-deploy command: npm run db:migrate)
# server/tests/portal-dockerfile.test.js keeps those steps and the ARG list.

FROM node:24-bookworm

# NODE_ENV=production as Nixpacks set it (Railway sets it again at runtime;
# feature-gates.js treats any other value as non-production). The Nixpacks
# login shell also had node_modules/.bin on PATH.
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    PATH=/app/node_modules/.bin:$PATH

# ffmpeg: the Reel metadata strip and the recap transcoder spawn `ffmpeg`
# from PATH and fail closed without it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# --include=dev: with NODE_ENV=production npm would skip the dev dependencies
# that the client build and the prebuild checks need (Nixpacks set
# NPM_CONFIG_PRODUCTION=false for the same reason).
RUN --mount=type=cache,id=s/1134d775-0e2a-48f3-b9a7-06b290821abf-/root/.npm,target=/root/.npm \
    npm ci --include=dev --no-audit --no-fund

# Build-time variables. Vite inlines the VITE_ names client code reads, so a
# name missing here builds as undefined. RAILWAY_DEPLOYMENT_ID and
# RAILWAY_GIT_COMMIT_SHA tell scripts/check-domain-rules.js it runs on
# Railway, where a stale gate index only warns instead of failing the build.
ARG RAILWAY_DEPLOYMENT_ID
ARG RAILWAY_GIT_COMMIT_SHA
ARG VITE_ANDROID_APP_URL
ARG VITE_API_PROXY_TARGET
ARG VITE_API_URL
ARG VITE_DESIGN_SYSTEM_ALLOWLIST
ARG VITE_GATE_ADMIN_ADDRESS_AUTOCOMPLETE
ARG VITE_GOOGLE_MAPS_API_KEY
ARG VITE_IOS_APP_URL
ARG VITE_POSTHOG_HOST
ARG VITE_POSTHOG_KEY
ARG VITE_POSTHOG_UI_HOST
ARG VITE_TURNSTILE_SITE_KEY
ARG VITE_WAVES_FDACS_LICENSE

RUN npm run build && npx playwright install --with-deps chromium

# Smoke check: the image must run ffmpeg and print a PDF from Chromium
# (service report PDFs, price scans). If either fails, the build fails and
# production keeps its current image.
RUN ffmpeg -hide_banner -version > /dev/null \
 && node -e "const { chromium } = require('playwright'); (async () => { const browser = await chromium.launch({ args: ['--no-sandbox'] }); const version = browser.version(); const page = await browser.newPage(); await page.setContent('<p>Waves</p>'); const pdf = await page.pdf(); await browser.close(); if (pdf.length < 500) throw new Error('empty PDF'); console.log('chromium', version, 'pdf bytes', pdf.length); })().catch((err) => { console.error(err); process.exit(1); });"

CMD ["node", "server/index.js"]
