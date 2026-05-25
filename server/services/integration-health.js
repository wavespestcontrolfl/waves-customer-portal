const { ADMIN_INTEGRATIONS, getIntegrationEnvKeys } = require('../config/integration-registry');
const { gates } = require('../config/feature-gates');
const tokenHealth = require('./token-health');

const TOKEN_STATUS_MAP = {
  healthy: 'connected',
  expired: 'expired',
  error: 'error',
  not_configured: 'not_configured',
};

function getEnvPresence(env = process.env) {
  return Object.fromEntries(
    getIntegrationEnvKeys().map((key) => [key, !!(env[key] && String(env[key]).trim())]),
  );
}

function normalizeTokenStatus(status) {
  return TOKEN_STATUS_MAP[status] || 'unknown';
}

function statusLabel(status) {
  return {
    connected: 'Connected',
    degraded: 'Degraded',
    expired: 'Expired',
    missing: 'Missing config',
    not_configured: 'Not configured',
    error: 'Check failed',
    unknown: 'Unknown',
  }[status] || 'Unknown';
}

function summarizeEnv(integration, present) {
  const required = integration.env?.required || [];
  const oneOfRequired = integration.env?.oneOfRequired || [];
  const supporting = integration.env?.supporting || [];
  const degradeWhenMissing = new Set(integration.readiness?.degradeWhenMissing || []);
  const oneOfSatisfied = oneOfRequired.some((key) => present[key]);
  const rows = [
    ...required.map((key) => ({ key, required: true, present: !!present[key] })),
    ...oneOfRequired.map((key) => ({
      key,
      required: false,
      requiredGroup: 'one_of',
      groupSatisfied: oneOfSatisfied,
      present: !!present[key],
    })),
    ...supporting.map((key) => ({
      key,
      required: false,
      readinessImpact: degradeWhenMissing.has(key),
      present: !!present[key],
    })),
  ];
  const missingOneOf = oneOfRequired.length && !oneOfSatisfied
    ? [`one of ${oneOfRequired.join(', ')}`]
    : [];
  return {
    rows,
    missingRequired: [
      ...required.filter((key) => !present[key]),
      ...missingOneOf,
    ],
    missingReadiness: rows
      .filter((row) => row.readinessImpact && !row.present)
      .map((row) => row.key),
  };
}

function latestDate(rows) {
  const times = rows
    .map((row) => row?.last_verified_at || row?.lastVerifiedAt || row?.lastCheckedAt)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

function reasonForSingle({ integration, cred, credentialStatus, envSummary }) {
  if (credentialStatus === 'connected') {
    if (envSummary.missingReadiness.length) {
      return `Credential check passed, but ${envSummary.missingReadiness.join(', ')} is missing.`;
    }
    return integration.health?.primaryEnvKey
      ? `Credential check passed using ${integration.health.primaryEnvKey}.`
      : 'Credential check passed.';
  }
  if (envSummary.missingRequired.length) {
    return `Missing required config: ${envSummary.missingRequired.join(', ')}.`;
  }
  if (credentialStatus === 'expired') return cred?.last_error || 'Credential is expired or unauthorized.';
  if (credentialStatus === 'error') return cred?.last_error || 'Credential check failed.';
  if (credentialStatus === 'not_configured') return cred?.last_error || 'Credential is not configured.';
  return 'No credential check has run yet.';
}

function composeSingle(integration, credByPlatform, present) {
  const cred = credByPlatform[integration.health.key];
  const envSummary = summarizeEnv(integration, present);
  const credentialStatus = cred ? normalizeTokenStatus(cred.status) : 'unknown';
  let status = credentialStatus;

  if (envSummary.missingRequired.length) {
    status = credentialStatus === 'connected' ? 'degraded' : 'not_configured';
  } else if (credentialStatus === 'connected' && envSummary.missingReadiness.length) {
    status = 'degraded';
  }

  return {
    status,
    label: statusLabel(status),
    reason: reasonForSingle({ integration, cred, credentialStatus, envSummary }),
    lastCheckedAt: cred?.last_verified_at || null,
    tokenPlatform: integration.health.key,
    credentialStatus,
    connectedChecks: status === 'connected' ? 1 : 0,
    totalChecks: 1,
    children: [],
    env: envSummary.rows,
  };
}

function composeGrouped(integration, credByPlatform, present) {
  const envSummary = summarizeEnv(integration, present);
  const children = integration.health.children.map((child) => {
    const cred = credByPlatform[child.key];
    const status = cred ? normalizeTokenStatus(cred.status) : 'unknown';
    return {
      id: child.key,
      label: child.label,
      status,
      statusLabel: statusLabel(status),
      reason: cred?.last_error || null,
      lastCheckedAt: cred?.last_verified_at || null,
    };
  });
  const knownChildren = children.filter((child) => child.status !== 'unknown');
  const connectedChecks = children.filter((child) => child.status === 'connected').length;
  const totalChecks = children.length;
  let status = 'unknown';

  if (connectedChecks === totalChecks) {
    status = envSummary.missingRequired.length ? 'degraded' : 'connected';
  } else if (knownChildren.length === 0 && envSummary.missingRequired.length) status = 'not_configured';
  else if (connectedChecks > 0) status = 'degraded';
  else if (children.some((child) => child.status === 'expired')) status = 'expired';
  else if (children.some((child) => child.status === 'error')) status = 'error';
  else if (envSummary.missingRequired.length) status = 'not_configured';
  else if (knownChildren.length) status = 'not_configured';

  const missingConfigReason = envSummary.missingRequired.length
    ? ` Missing required config: ${envSummary.missingRequired.join(', ')}.`
    : '';
  const reason = status === 'connected'
    ? `${connectedChecks} of ${totalChecks} checks passed.`
    : `${connectedChecks} of ${totalChecks} checks passed.${missingConfigReason}`;

  return {
    status,
    label: status === 'connected'
      ? `Connected · ${connectedChecks}/${totalChecks}`
      : `${statusLabel(status)} · ${connectedChecks}/${totalChecks}`,
    reason,
    lastCheckedAt: latestDate(children),
    tokenPlatform: null,
    credentialStatus: status,
    connectedChecks,
    totalChecks,
    children,
    env: envSummary.rows,
  };
}

async function getIntegrationHealth() {
  const credentials = await tokenHealth.getAll();
  const credByPlatform = credentials.reduce((acc, cred) => {
    acc[cred.platform] = cred;
    return acc;
  }, {});
  const present = getEnvPresence();

  const integrations = ADMIN_INTEGRATIONS.map((integration) => {
    const health = integration.health?.type === 'grouped'
      ? composeGrouped(integration, credByPlatform, present)
      : composeSingle(integration, credByPlatform, present);
    const gateRows = (integration.gates || []).map((gate) => ({
      key: gate.key,
      label: gate.label,
      enabled: !!gates[gate.key],
    }));

    return {
      id: integration.id,
      category: integration.category,
      name: integration.name,
      platform: integration.platform,
      description: integration.description,
      deprecating: !!integration.deprecating,
      env: health.env,
      gates: gateRows,
      health: {
        status: health.status,
        label: health.label,
        reason: health.reason,
        lastCheckedAt: health.lastCheckedAt,
        tokenPlatform: health.tokenPlatform,
        credentialStatus: health.credentialStatus,
        connectedChecks: health.connectedChecks,
        totalChecks: health.totalChecks,
        children: health.children,
      },
    };
  });

  return { generatedAt: new Date().toISOString(), integrations };
}

module.exports = {
  getEnvPresence,
  getIntegrationHealth,
  statusLabel,
};
