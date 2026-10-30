#!/usr/bin/env node
// MUTATES (dry-run default) — mint the owner's Claude Code key for the read-only
// admin MCP endpoint (/api/mcp-admin, server/routes/mcp-admin.js). The key is a
// JWT of type 'mcp_read' (server/services/mcp-admin-key.js): every staff verifier
// refuses it, it is bound to the full-access login's technician row and its
// current auth_token_version (a password change or reset revokes it), and it
// expires after 30 days. The dry run prints the login id and token version and
// never a key. --execute writes one audit_log row (mcp.admin_key.mint: the key's
// jti and expiry, never the key), then the key to --out: a NEW file, mode 0600
// (an existing file is refused). The key is never printed.
//
//   PG_CA_FILE=~/ops-oneshots/certs/railway-pg-root.pem railway run --service Postgres -- \
//     railway run --service waves-customer-portal node ops/agents/mint-mcp-admin-key.js            # dry run
//   ... node ops/agents/mint-mcp-admin-key.js --execute --out=/path/to/new-key-file
//
// Register it in Claude Code on the owner's Mac, then delete the file:
//   claude mcp add --transport http --scope user waves-admin https://portal.wavespestcontrol.com/api/mcp-admin \
//     --header "Authorization: Bearer $(cat /path/to/new-key-file)" && rm /path/to/new-key-file
//
// Database: the pinned-root TLS + SCRAM-SHA-256-PLUS connection of
// ops/agents/second-tech-handover.js (PG_CA_FILE is required for a remote host).
// --email=<login> picks another full-access login (default: the first on the list).

// Any server module that reaches for the app's own knex fails closed: the only
// connection this script uses is the pinned one below.
process.env.DATABASE_URL = 'postgres://127.0.0.1:1/mint-mcp-admin-key-unused';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const root = path.join(__dirname, '..', '..', 'server');
const { tlsFor, connectionFields, scramPlusOnly } = require('./second-tech-handover');
const { signMcpAdminKey, mcpKeyEligible, MCP_KEY_TTL } = require(path.join(root, 'services', 'mcp-admin-key'));
const { fullAccessAllowlist } = require(path.join(root, 'services', 'intelligence-bar', 'ib-access'));
const { recordAuditEvent } = require(path.join(root, 'services', 'audit-log'));

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

// A writable twin of the planner's readOnlyConn: same pinned TLS, field-wise
// connection and SCRAM-PLUS-only login; one connection.
function writableConn(connectionString) {
  const ssl = tlsFor(connectionString);
  if (ssl) scramPlusOnly(require('pg'));
  return require('knex')({
    client: 'pg',
    connection: { ...connectionFields(connectionString), ssl, ...(ssl ? { enableChannelBinding: true } : {}) },
    pool: { min: 0, max: 1 },
  });
}

async function main() {
  const execute = process.argv.includes('--execute');
  const out = arg('out');
  const email = String(arg('email') || fullAccessAllowlist()[0]).trim().toLowerCase();
  const conn = process.env.DATABASE_PUBLIC_URL;
  if (!conn) {
    console.error('DATABASE_PUBLIC_URL not set — run via: railway run --service Postgres -- railway run --service waves-customer-portal node ops/agents/mint-mcp-admin-key.js');
    process.exit(2);
  }
  if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET not set — the inner `railway run --service waves-customer-portal` supplies it');
    process.exit(2);
  }
  if (execute && !out) {
    console.error('--execute needs --out=<path of a new file>');
    process.exit(2);
  }
  if (execute && fs.existsSync(out)) {
    console.error(`refusing to overwrite ${out}: give a new file path`);
    process.exit(2);
  }

  const db = writableConn(conn);
  try {
    const tech = await db('technicians').whereRaw('lower(email) = ?', [email])
      .first('id', 'email', 'role', 'employment_status', 'must_change_password', 'auth_token_version');
    const tokenVersion = Number(tech?.auth_token_version);
    if (!mcpKeyEligible(tech, tokenVersion)) {
      console.error(`no eligible login for ${email}: it must be an active admin on the full-access list, with no forced password change`);
      process.exitCode = 1;
      return;
    }
    console.log(`login ${tech.id}, token version ${tokenVersion}; the key would expire after ${MCP_KEY_TTL}`);
    if (!execute) {
      console.log('dry run — nothing written. Re-run with --execute --out=<path of a new file>.');
      return;
    }
    const jti = crypto.randomUUID();
    const key = signMcpAdminKey({ technicianId: tech.id, tokenVersion, jti }, process.env.JWT_SECRET);
    const expiresAt = new Date(jwt.decode(key).exp * 1000).toISOString();
    await recordAuditEvent({
      actor_type: 'system',
      action: 'mcp.admin_key.mint',
      resource_type: 'technician',
      resource_id: tech.id,
      metadata: { jti, expires_at: expiresAt, script: 'ops/agents/mint-mcp-admin-key.js' },
      critical: true,
      trx: db,
    });
    fs.writeFileSync(out, key, { mode: 0o600, flag: 'wx' });
    console.log(`key ${jti} written to ${out} (mode 0600), audit row written; it expires ${expiresAt}`);
  } finally {
    await db.destroy();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
