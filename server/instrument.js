const Sentry = require("@sentry/node");

// Only report to Sentry from real Railway deployments. Locally, NODE_ENV is often
// "production", which tagged local-dev crashes as a production environment, and a
// hardcoded server name made them indistinguishable from the live host — so the
// prod issue view filled with local noise (EADDRINUSE, EPIPE, worktree schema
// drift). Gate on Railway's injected environment, derive the environment + server
// name from Railway, and let SENTRY_ENABLED=true force-enable for local testing.
const railwayEnv =
  process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || null;
const sentryEnabled = process.env.SENTRY_ENABLED === "true" || Boolean(railwayEnv);

Sentry.init({
  dsn: "https://b63c130c0ad93998528d5ff82250e68d@o4511171673849856.ingest.us.sentry.io/4511171681255425",
  enabled: sentryEnabled,
  environment: railwayEnv || process.env.NODE_ENV || "development",
  sendDefaultPii: true,
  serverName: process.env.RAILWAY_SERVICE_NAME || undefined,
});
