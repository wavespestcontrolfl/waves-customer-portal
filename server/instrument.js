const Sentry = require("@sentry/node");

// Only report to Sentry from real Railway deployments. Two traps this avoids:
//   1. Locally, NODE_ENV is often "production" (worktrees), which tagged local-dev
//      crashes as the production environment, and a hardcoded server name made them
//      indistinguishable from the live host — so the prod issue view filled with
//      local noise (EADDRINUSE, EPIPE, worktree schema drift).
//   2. `railway run` / `railway shell` inject RAILWAY_ENVIRONMENT_NAME (and
//      _SERVICE_NAME) into LOCAL commands, so gating on the env name alone would
//      re-enable Sentry from a dev shell. RAILWAY_DEPLOYMENT_ID / RAILWAY_REPLICA_ID
//      are set ONLY inside an actual running deployment, never by the CLI locally
//      (verified: both null under `railway run`), so they are the reliable
//      deployment signal. SENTRY_ENABLED=true force-enables for local testing.
const railwayEnv =
  process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || null;
const isRailwayDeployment = Boolean(
  process.env.RAILWAY_DEPLOYMENT_ID || process.env.RAILWAY_REPLICA_ID
);
const sentryEnabled =
  process.env.SENTRY_ENABLED === "true" || isRailwayDeployment;

Sentry.init({
  dsn: "https://b63c130c0ad93998528d5ff82250e68d@o4511171673849856.ingest.us.sentry.io/4511171681255425",
  enabled: sentryEnabled,
  environment: railwayEnv || process.env.NODE_ENV || "development",
  sendDefaultPii: true,
  serverName: process.env.RAILWAY_SERVICE_NAME || undefined,
});
