'use strict';

// Deployment-vs-local detection for Railway — the single shared predicate
// (consumed by instrument.js for Sentry enablement and by
// stripe-webhook-health for the fail-closed missing-key check).
//
// RAILWAY_DEPLOYMENT_ID / RAILWAY_REPLICA_ID are set ONLY inside an actual
// running deployment. `railway run` / `railway shell` inject
// RAILWAY_ENVIRONMENT_NAME (and _SERVICE_NAME) into LOCAL commands but never
// these two (verified: both null under `railway run` — see instrument.js),
// and local worktrees often run with NODE_ENV=production — so neither the
// env name nor NODE_ENV alone is a safe "deployed" signal.

function isRailwayDeployment(env = process.env) {
  return Boolean(env.RAILWAY_DEPLOYMENT_ID || env.RAILWAY_REPLICA_ID);
}

// Deployed AND the production environment specifically — staging / PR
// preview deployments are excluded (they legitimately run without the full
// production secret set; Railway PR envs are based on staging).
function isDeployedProduction(env = process.env) {
  const name = String(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT || '').toLowerCase();
  return isRailwayDeployment(env) && name === 'production';
}

module.exports = { isRailwayDeployment, isDeployedProduction };
