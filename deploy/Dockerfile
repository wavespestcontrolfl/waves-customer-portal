# Production image for the portal (owner 2026-11-02: "do what you recommend").
#
# Why this file exists: Railway's Nixpacks builder writes EVERY service variable name onto one
# `ARG` line and one `ENV k=$k` line of the Dockerfile it generates. BuildKit refuses a line
# over 65,535 bytes, so at ~1,260 variables (most of them GATE_* names) every production deploy
# failed on 2026-11-02 from 03:17 to 04:23 ET. A Dockerfile build receives only the variables it
# declares with ARG, so this file has no such line, however many variables the service holds.
#
# It is the build Nixpacks v1.41.0 generates for this repo, step for step (setup: nodejs_24,
# npm-9_x, ffmpeg; install: npm ci; build: npm run build && npx playwright install --with-deps
# chromium; start: node server/index.js), taken from the live build log (deploy cd467525,
# 10 stages) and the nixpacks v1.41.0 templates (dockerfile_generation.rs, nix/mod.rs,
# providers/node/mod.rs): the same pinned base image, the same Nix package set, ONE stage, and
# the same login-shell entry point. Only the variable lines differ.
#   - One stage on purpose: Playwright keeps Chromium under /root/.cache/ms-playwright and
#     `--with-deps` apt-installs its libraries and fonts into this same image; a second stage
#     would leave them behind and report PDFs would fail.
#   - The login shell (`bash -l`) is load-bearing: it puts the Nix profile (node, ffmpeg) on PATH
#     and sets LD_LIBRARY_PATH for sharp (gcc-unwrapped). The app finds ffmpeg as
#     `process.env.FFMPEG_PATH || 'ffmpeg'` on PATH. Railway runs a start or pre-deploy command
#     for a Dockerfile image in exec form, replacing this ENTRYPOINT, so both commands are wrapped
#     in `/bin/bash -l -c "..."` in the service settings (docs/DEPLOYMENT.md).
#
# Inert until Railway's service settings point at it (Builder = Dockerfile, Dockerfile path =
# deploy/Dockerfile). Deliberately NOT a file named `Dockerfile` at the repo root: Railway
# auto-detects that name and would switch the builder by itself on the next deploy.
FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067@sha256:d45c89d80e13d7ad0fd555b5130f22a866d9dd10e861f589932303ef2314c7de

ENTRYPOINT ["/bin/bash", "-l", "-c"]
WORKDIR /app/

COPY deploy/nixpkgs-23f9169c4ccce521379e602cc82ed873a1f1b52b.nix .nixpacks/nixpkgs-23f9169c4ccce521379e602cc82ed873a1f1b52b.nix
RUN nix-env -if .nixpacks/nixpkgs-23f9169c4ccce521379e602cc82ed873a1f1b52b.nix && nix-collect-garbage -d

# Build-time variables: only what `vite build` embeds in the client bundle. A missing one still
# builds, but the page ships without Maps, Turnstile or PostHog, so keep this list in step with
# the VITE_ names set on the Railway service.
ARG VITE_GATE_ADMIN_ADDRESS_AUTOCOMPLETE VITE_GOOGLE_MAPS_API_KEY VITE_POSTHOG_HOST VITE_POSTHOG_KEY VITE_TURNSTILE_SITE_KEY
# Nixpacks' own variables (core + node provider). NPM_CONFIG_PRODUCTION=false keeps
# devDependencies in `npm ci` although NODE_ENV=production; the client build needs them.
ENV NIXPACKS_METADATA=node NODE_ENV=production NPM_CONFIG_PRODUCTION=false CI=true

# install phase
ENV NIXPACKS_PATH=/app/node_modules/.bin:$NIXPACKS_PATH
COPY . /app/.
RUN --mount=type=cache,id=s/1134d775-0e2a-48f3-b9a7-06b290821abf-/root/npm,target=/root/.npm npm ci

# build phase
COPY . /app/.
RUN --mount=type=cache,id=s/1134d775-0e2a-48f3-b9a7-06b290821abf-node_modules/cache,target=/app/node_modules/.cache npm run build && npx playwright install --with-deps chromium

# start phase
RUN printf '\nPATH=/app/node_modules/.bin:$PATH' >> /root/.profile
COPY . /app
CMD ["node server/index.js"]
