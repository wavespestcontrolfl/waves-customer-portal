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

const REQUEST_DATA_INCLUDE = Object.freeze({
  cookies: false,
  data: false,
  headers: false,
  ip: false,
  query_string: false,
  url: false,
});

// Request URLs throughout this app can contain long-lived customer bearer
// tokens, while auth/reset bodies and headers contain staff credentials. Keep
// only the HTTP method on Sentry error events. This is intentionally stricter
// than the application logger's shape-only redaction: Sentry is a third-party
// system and does not need request payloads to group server exceptions.
function stripSentryRequestData(event) {
  if (!event || typeof event !== 'object') return event;

  if (event.request) {
    const method = typeof event.request.method === 'string'
      ? event.request.method
      : undefined;
    event.request = method ? { method } : undefined;
  }

  // HTTP/fetch breadcrumbs can independently retain the full request URL even
  // when RequestData is disabled. Drop those breadcrumbs; keep application
  // breadcrumbs, which remain useful for diagnosing control flow.
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.filter((breadcrumb) => {
      const category = String(breadcrumb?.category || '').toLowerCase();
      return category !== 'http'
        && category !== 'fetch'
        && category !== 'xhr';
    });
  }

  return event;
}

function buildSentryOptions() {
  return {
    dsn: "https://b63c130c0ad93998528d5ff82250e68d@o4511171673849856.ingest.us.sentry.io/4511171681255425",
    enabled: sentryEnabled,
    environment: railwayEnv || process.env.NODE_ENV || "development",
    sendDefaultPii: false,
    serverName: process.env.RAILWAY_SERVICE_NAME || undefined,
    // Tracing is not used by this service. Keeping it explicitly dark prevents
    // raw URL span attributes from becoming a second credential egress path if
    // an environment-level Sentry default changes later.
    tracesSampleRate: 0,
    profilesSampleRate: 0,
    integrations(defaultIntegrations) {
      const withoutRequestData = (defaultIntegrations || [])
        .filter((integration) => integration?.name !== 'RequestData');
      return [
        ...withoutRequestData,
        Sentry.requestDataIntegration({ include: REQUEST_DATA_INCLUDE }),
      ];
    },
    beforeSend: stripSentryRequestData,
    beforeSendTransaction(event) {
      const sanitized = stripSentryRequestData(event);
      if (!sanitized || typeof sanitized !== 'object') return sanitized;
      // Defense in depth if tracing is explicitly enabled in code later.
      sanitized.transaction = 'http.request';
      sanitized.spans = [];
      return sanitized;
    },
  };
}

Sentry.init(buildSentryOptions());

module.exports = {
  REQUEST_DATA_INCLUDE,
  buildSentryOptions,
  stripSentryRequestData,
};
