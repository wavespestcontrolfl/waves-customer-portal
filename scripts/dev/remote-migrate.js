'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { git, identity } = require('./context');

const PROJECT_ID = '5a674c8a-d443-4126-8bfd-3d4775464448';
const PRODUCTION_ID = '8fb20379-5f3d-4590-b39c-19c03079afdd';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function assertNonproduction(id, name) {
  if (!UUID.test(id || '') || id === PRODUCTION_ID ||
      !/^(staging|codex-dev|development|test|preview|waves-customer-portal-pr-\d+)$/.test(name || '')) {
    throw new Error('Remote migrations require a verified dev/preview Railway environment.');
  }
}

function selectDeployment(status, config, sha) {
  const environment = status.environments?.edges?.find(({ node }) => node.id === config.environmentId)?.node;
  assertNonproduction(environment?.id, environment?.name);
  if (status.id !== PROJECT_ID || environment.deletedAt || environment.canAccess !== true) throw new Error('Railway project/environment mismatch.');
  const services = environment.serviceInstances?.edges?.map(({ node }) => node) || [];
  const service = services.find((item) => item.serviceId === config.serviceId);
  if (!services.some((item) => item.serviceId === config.databaseServiceId)) throw new Error('Database service is absent from the selected environment.');
  const deployment = service?.activeDeployments?.find((item) => item.status === 'SUCCESS' &&
    !item.deploymentStopped && item.meta?.commitHash === sha && item.meta?.repo === 'wavespestcontrolfl/waves-customer-portal');
  const instance = deployment?.instances?.find((item) => item.status === 'RUNNING');
  if (!instance) throw new Error('No running dev deployment matches this checkout commit. Wait for its PR preview.');
  return { deploymentId: deployment.id, instanceId: instance.id, environmentName: environment.name };
}

function privateDatabaseUrl(context, selected, variables, config) {
  if (variables.RAILWAY_PROJECT_ID !== PROJECT_ID || variables.RAILWAY_ENVIRONMENT_ID !== config.environmentId ||
      variables.RAILWAY_SERVICE_ID !== config.databaseServiceId) throw new Error('Database service identity mismatch.');
  const url = new URL(selected);
  const database = `waves_qa_${context.id.replaceAll('-', '')}`;
  if (!UUID.test(context.id) || url.pathname !== `/${database}` ||
      url.search || url.hash || url.hostname !== variables.RAILWAY_TCP_PROXY_DOMAIN || url.port !== String(variables.RAILWAY_TCP_PROXY_PORT)) {
    throw new Error('Selected database must be this worktree’s private QA database on the verified dev service.');
  }
  if (!/^[a-z0-9-]+\.railway\.internal$/.test(variables.RAILWAY_PRIVATE_DOMAIN || '') ||
      !/^\d+$/.test(variables.RAILWAY_TCP_APPLICATION_PORT || '')) throw new Error('Database private networking is unavailable.');
  url.hostname = variables.RAILWAY_PRIVATE_DOMAIN;
  url.port = variables.RAILWAY_TCP_APPLICATION_PORT;
  return url.href;
}

function railwayJson(args, root) {
  try {
    return JSON.parse(execFileSync('railway', args, { cwd: root, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 8 * 1024 * 1024 }));
  } catch {
    // CLI errors can contain variable values. Keep secrets out of diagnostics.
    throw new Error('Railway lookup failed. Run railway --version (requires 5.49+), then railway whoami; use railway login if signed out. Verify access to the selected dev environment.');
  }
}

function prepareRemoteMigration(context, env) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(context.root, '.tmp/dev/remote.json'), 'utf8'));
  } catch {
    throw new Error('Create valid JSON in .tmp/dev/remote.json with environmentId, serviceId and databaseServiceId from the verified Railway dev/preview environment. See docs/development.md#run-migrations-near-the-dev-database.');
  }
  for (const key of ['environmentId', 'serviceId', 'databaseServiceId']) {
    if (!UUID.test(config?.[key])) throw new Error(`remote.json requires a UUID ${key}.`);
  }
  if (config.environmentId === PRODUCTION_ID) throw new Error('Production is forbidden.');
  const nodePath = config.nodePath || 'node';
  if (typeof nodePath !== 'string' || !/^(node|\/[a-zA-Z0-9_./-]+)$/.test(nodePath)) throw new Error('nodePath must be an absolute executable path.');
  if (config.identityFile && (typeof config.identityFile !== 'string' ||
      !fs.existsSync(path.resolve(context.root, config.identityFile)))) {
    throw new Error('identityFile must name an existing SSH private key. Omit it to use Railway key discovery; verify keys with railway ssh keys list.');
  }
  if (git(context.root, 'status', '--porcelain')) throw new Error('Commit all checkout changes before remote migration.');
  let version;
  try {
    version = execFileSync('railway', ['--version'], { cwd: context.root, encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 }).trim().match(/^railway (\d+)\.(\d+)\.\d+/);
  } catch { /* Report only fixed guidance; CLI errors may contain credentials. */ }
  if (!version || Number(version[1]) < 5 || (Number(version[1]) === 5 && Number(version[2]) < 49)) {
    throw new Error('Railway CLI 5.49+ is required. Install or upgrade Railway, then run railway login and retry.');
  }
  const { sha } = identity(context);
  const scope = ['--project', PROJECT_ID, '--environment', config.environmentId];
  const status = railwayJson(['status', ...scope, '--json'], context.root);
  const target = selectDeployment(status, config, sha);
  const variables = railwayJson(['variable', 'list', ...scope, '--service', config.databaseServiceId, '--json'], context.root);
  const databaseUrl = privateDatabaseUrl(context, env.DATABASE_URL, variables, config);
  const args = ['ssh', ...scope, '--service', config.serviceId, '--deployment-instance', target.instanceId];
  if (config.identityFile) args.push('--identity-file', path.resolve(context.root, config.identityFile));
  // SSH argv contains no credentials. NODE_OPTIONS must be removed before Node starts.
  return { args, nodePath, databaseUrl, config, target, sha };
}

async function remoteMigration(context, env) {
  const { args, nodePath, databaseUrl, config, target, sha } = prepareRemoteMigration(context, env);
  args.push('--', 'env', '-u', 'NODE_OPTIONS', nodePath, 'scripts/dev/remote-migrate-worker.js');
  const nonce = randomUUID();
  const child = spawn('railway', args, { cwd: context.root, stdio: ['pipe', 'pipe', 'pipe'] });
  let acknowledged = false;
  let output = '';
  const acknowledgment = JSON.stringify({ remoteMigration: 'complete', nonce });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    const lines = output.split('\n');
    output = lines.pop().slice(-16384);
    if (lines.some((line) => line.trim() === acknowledgment)) acknowledged = true;
  });
  child.stderr.resume(); // SSH/Knex diagnostics must not disclose credential payloads.
  child.stdin.on('error', () => { /* SSH failure is reported by the child close. */ });
  const completed = new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('close', (code) => resolve(code === 0 && acknowledged ? 0 : (code || 1)));
  });
  child.stdin.end(JSON.stringify({ projectId: PROJECT_ID, environmentId: config.environmentId,
    serviceId: config.serviceId, deploymentId: target.deploymentId, sha, worktreeId: context.id, databaseUrl, nonce }));
  const code = await completed;
  console.log(code === 0 ? 'Remote migration pass verified. Run local dev:doctor.' :
    'Remote migration did not report success. Check SSH access and the private database before retrying.');
  return code;
}

module.exports = { prepareRemoteMigration, remoteMigration, selectDeployment, privateDatabaseUrl, assertNonproduction, PROJECT_ID };
