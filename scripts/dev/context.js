'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function rootDirectory() {
  return fs.realpathSync(git(process.cwd(), 'rev-parse', '--show-toplevel'));
}

function contextPath(root) { return path.join(root, '.tmp', 'dev', 'context.json'); }

function readContext(root = rootDirectory()) {
  const file = contextPath(root);
  if (!fs.existsSync(file)) throw new Error('Run npm run worktree:setup first.');
  const context = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (context.root !== fs.realpathSync(root)) throw new Error('Checkout moved: run worktree:setup again after stopping its processes.');
  return context;
}

async function availablePort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(new Error(`Cannot bind loopback port (${error.code}); check sandbox permissions.`));
    });
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function setup(root = rootDirectory()) {
  root = fs.realpathSync(root);
  if (fs.existsSync(contextPath(root))) {
    const existing = JSON.parse(fs.readFileSync(contextPath(root), 'utf8'));
    if (existing.root === root) return existing;
    const free = await Promise.all(Object.values(existing.ports).map(availablePort));
    if (!free.every(Boolean)) throw new Error('Moved worktree still has occupied ports. Stop its previous runner before repairing setup.');
    const repaired = { ...existing, root };
    fs.writeFileSync(contextPath(root), JSON.stringify(repaired, null, 2) + '\n', { mode: 0o600 });
    return repaired;
  }
  const used = new Set();
  const trees = git(root, 'worktree', 'list', '--porcelain').split('\n')
    .filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
  for (const tree of trees) {
    if (fs.existsSync(contextPath(tree))) {
      const sibling = JSON.parse(fs.readFileSync(contextPath(tree), 'utf8'));
      Object.values(sibling.ports).forEach((port) => used.add(port));
    }
  }
  const offset = crypto.createHash('sha256').update(root).digest().readUInt16BE(0) % 2000;
  for (let attempt = 0; attempt < 2000; attempt++) {
    const base = 18000 + ((offset + attempt) % 2000) * 4;
    const ports = { api: base, client: base + 1, inspector: base + 2, control: base + 3 };
    if (Object.values(ports).some((port) => used.has(port))) continue;
    const available = await Promise.all(Object.values(ports).map(availablePort));
    if (!available.every(Boolean)) continue;
    const context = { root, id: crypto.randomUUID(), ports, jwtSecret: crypto.randomBytes(32).toString('hex') };
    fs.mkdirSync(path.dirname(contextPath(root)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(contextPath(root), JSON.stringify(context, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return context;
  }
  throw new Error('No free worktree port block found.');
}

// Only explicitly selected dev DB credentials enter child processes. Never
// inherit provider keys, Railway deployment identity, NODE_OPTIONS or .env.
function childEnvironment(context, { database = false, sha } = {}) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'SystemRoot']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'development', WAVES_LOCAL_DEV: '1', GATE_CRON_JOBS: 'false',
    PORT: String(context.ports.api), CLIENT_URL: `http://127.0.0.1:${context.ports.client}`,
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${context.ports.api}`,
    JWT_SECRET: context.jwtSecret, WAVES_WORKTREE_ID: context.id,
    WAVES_WORKTREE_SHA: sha || git(context.root, 'rev-parse', 'HEAD'),
  });
  if (database) {
    const file = path.join(context.root, '.tmp', 'dev', 'database.env');
    if (!fs.existsSync(file)) throw new Error('Missing .tmp/dev/database.env. Configure a verified Railway dev/preview cluster DATABASE_URL and WAVES_DATABASE_ENVIRONMENT here, chmod 600 .tmp/dev/database.env, then run npm run qa:database for this worktree’s private QA database. See docs/development.md#dev-database.');
    const values = require('dotenv').parse(fs.readFileSync(file));
    if (!['development', 'preview', 'test'].includes(values.WAVES_DATABASE_ENVIRONMENT)) {
      throw new Error('database.env must identify WAVES_DATABASE_ENVIRONMENT=development, preview, or test. Production is forbidden.');
    }
    let url;
    try { url = new URL(values.DATABASE_URL); } catch { throw new Error('Invalid dev DATABASE_URL.'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) {
      throw new Error('Expected a PostgreSQL database URL.');
    }
    env.DATABASE_URL = values.DATABASE_URL;
  }
  return env;
}

function identity(context) {
  return { id: context.id, root: context.root, branch: git(context.root, 'branch', '--show-current'),
    sha: git(context.root, 'rev-parse', 'HEAD'), ports: context.ports };
}

function checkoutStamp(root) {
  return crypto.createHash('sha256').update(fs.realpathSync(root) + ':' + git(root, 'rev-parse', 'HEAD')).digest('hex');
}

module.exports = { checkoutStamp, git, rootDirectory, readContext, setup, availablePort, childEnvironment, identity };
