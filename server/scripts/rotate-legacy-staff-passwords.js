#!/usr/bin/env node

/**
 * Deliberate replacement for migration-time legacy-password rotation.
 *
 * Default: read-only audit
 * Apply:   STAFF_PASSWORD_RESET_DELIVERY_VERIFIED=true node ... --apply
 *
 * WARNING: --apply randomizes matching hashes. Rolling back afterward to an
 * application build without the staff reset flow is not a valid recovery path.
 * Verify the deployed reset flow and real email delivery before applying.
 *
 * Output contains structural IDs/counts only. It never prints email addresses,
 * password hashes, reset tokens, or generated replacement credentials.
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../models/db');
const {
  RETIRED_LEGACY_STAFF_PASSWORD,
} = require('../utils/staff-password-policy');
const { canonicalStaffEmail } = require('../utils/staff-identity');

const STAFF_ROLES = ['admin', 'technician'];

function rowsFrom(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

async function databaseIdentity(connection) {
  const result = await connection.raw(`
    SELECT current_database() AS database_name,
           COALESCE(inet_server_addr()::text, 'local-socket') AS server_address,
           inet_server_port() AS server_port,
           current_user AS database_user
  `);
  return rowsFrom(result)[0];
}

function candidateFingerprint(rows) {
  const ids = (rows || []).map((row) => String(row.id)).sort();
  return crypto.createHash('sha256').update(ids.join('\n')).digest('hex');
}

function targetFingerprint(target, environment = process.env) {
  const identity = {
    databaseName: String(target?.database_name || ''),
    databaseUser: String(target?.database_user || ''),
    serverAddress: String(target?.server_address || ''),
    serverPort: String(target?.server_port || ''),
    railwayProjectId: String(environment.RAILWAY_PROJECT_ID || ''),
    railwayEnvironmentId: String(environment.RAILWAY_ENVIRONMENT_ID || ''),
    railwayEnvironmentName: String(environment.RAILWAY_ENVIRONMENT_NAME || ''),
    railwayServiceId: String(environment.RAILWAY_SERVICE_ID || ''),
    nodeEnv: String(environment.NODE_ENV || ''),
  };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function optionValue(name) {
  const prefix = `--${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

function targetLabel(target) {
  return `${target.database_name} on ${target.server_address}:${target.server_port || 'default'} `
    + `(user=${target.database_user}, env=${process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'development'})`;
}

function canonicalEmail(value) {
  return canonicalStaffEmail(value);
}

async function findLegacyRows(rows) {
  const legacyRows = [];
  for (const row of rows) {
    if (!row.password_hash) continue;
    // Sequential on purpose: keep CPU/memory pressure bounded in production.
    if (await bcrypt.compare(RETIRED_LEGACY_STAFF_PASSWORD, row.password_hash)) legacyRows.push(row);
  }
  return legacyRows;
}

function preflight(rows, legacyRows) {
  const emailOwners = new Map();
  for (const row of rows) {
    const email = canonicalEmail(row.email);
    if (!email) continue;
    const owners = emailOwners.get(email) || [];
    owners.push(row.id);
    emailOwners.set(email, owners);
  }

  const blockers = [];
  for (const row of legacyRows) {
    const email = canonicalEmail(row.email);
    // Inactive historical identities cannot authenticate and are still
    // randomized to remove the repository-known hash. Require a recoverable,
    // unique mailbox only for active candidates; reactivation itself enforces
    // the same email invariant in the Staff CRUD route.
    if (row.active && !email) {
      blockers.push({ technicianId: row.id, reason: 'missing_or_invalid_email' });
    } else if (row.active && (emailOwners.get(email) || []).length !== 1) {
      blockers.push({ technicianId: row.id, reason: 'duplicate_canonical_email' });
    }
    const version = Number(row.auth_token_version);
    if (
      row.auth_token_version === null
      || row.auth_token_version === undefined
      || row.auth_token_version === ''
      || !Number.isInteger(version)
      || version < 1
      || version >= 2147483647
    ) {
      blockers.push({ technicianId: row.id, reason: 'invalid_auth_token_version' });
    }
  }
  return blockers;
}

async function loadStaff(connection) {
  return connection('technicians')
    .whereIn('role', STAFF_ROLES)
    .select('id', 'email', 'active', 'password_hash', 'auth_token_version');
}

async function rotateLegacyRows({
  expectedDatabase,
  expectedTargetFingerprint,
  expectedCandidateCount,
  expectedFingerprint,
} = {}) {
  return db.transaction(async (trx) => {
    await trx.raw('LOCK TABLE technicians IN SHARE ROW EXCLUSIVE MODE');
    const target = await databaseIdentity(trx);
    const rows = await loadStaff(trx);
    const legacyRows = await findLegacyRows(rows);
    const fingerprint = candidateFingerprint(legacyRows);
    const actualTargetFingerprint = targetFingerprint(target);
    if (
      !expectedDatabase
      || target.database_name !== expectedDatabase
      || !expectedTargetFingerprint
      || actualTargetFingerprint !== expectedTargetFingerprint
      || !Number.isInteger(expectedCandidateCount)
      || legacyRows.length !== expectedCandidateCount
      || !expectedFingerprint
      || fingerprint !== expectedFingerprint
    ) {
      return {
        rotatedIds: [],
        blockers: [],
        confirmationMismatch: true,
        target,
        targetFingerprint: actualTargetFingerprint,
        candidateCount: legacyRows.length,
        fingerprint,
      };
    }
    const blockers = preflight(rows, legacyRows);
    if (blockers.length) return { rotatedIds: [], blockers };

    const rotatedIds = [];
    for (const row of legacyRows) {
      const replacement = crypto.randomBytes(48).toString('base64url');
      const replacementHash = await bcrypt.hash(replacement, 12);
      const updated = await trx('technicians')
        .where({ id: row.id, password_hash: row.password_hash })
        .update({
          password_hash: replacementHash,
          auth_token_version: Number(row.auth_token_version) + 1,
          must_change_password: true,
          password_changed_at: null,
          password_reset_token_hash: null,
          password_reset_expires_at: null,
          password_reset_requested_at: null,
          updated_at: trx.fn.now(),
        });
      if (updated !== 1) throw new Error('staff_password_changed_during_rotation');
      rotatedIds.push(row.id);
    }

    if (rotatedIds.length && await trx.schema.hasTable('push_subscriptions')) {
      await trx('push_subscriptions')
        .whereIn('admin_user_id', rotatedIds)
        .where({ active: true })
        .update({ active: false });
    }
    return {
      rotatedIds,
      blockers: [],
      target,
      targetFingerprint: actualTargetFingerprint,
      candidateCount: legacyRows.length,
      fingerprint,
    };
  });
}

async function main() {
  const apply = process.argv.includes('--apply');
  const details = process.argv.includes('--details');
  const target = await databaseIdentity(db);
  const rows = await loadStaff(db);
  const legacyRows = await findLegacyRows(rows);
  const blockers = preflight(rows, legacyRows);
  const fingerprint = candidateFingerprint(legacyRows);
  const actualTargetFingerprint = targetFingerprint(target);
  process.stdout.write(`Target database: ${targetLabel(target)}\n`);
  process.stdout.write(`Target fingerprint: ${actualTargetFingerprint}\n`);
  process.stdout.write(`Legacy staff credential candidates: ${legacyRows.length}\n`);
  process.stdout.write(`Candidate fingerprint: ${fingerprint}\n`);
  if (details) {
    process.stdout.write(`Candidate technician IDs: ${legacyRows.map((row) => row.id).join(', ') || 'none'}\n`);
  }

  if (blockers.length) {
    process.stdout.write(`BLOCKED: ${JSON.stringify(blockers)}\n`);
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    process.stdout.write('DRY RUN: no credentials changed. Re-run with --apply after reset-email delivery verification.\n');
    process.stdout.write('WARNING: after --apply, rollback to a build without the reset flow is not a valid recovery path.\n');
    process.stdout.write(
      `Required confirmations: --confirm-database=${target.database_name} `
      + `--confirm-target=${actualTargetFingerprint} `
      + `--confirm-candidates=${legacyRows.length} --confirm-fingerprint=${fingerprint}\n`,
    );
    return;
  }
  if (process.env.STAFF_PASSWORD_RESET_DELIVERY_VERIFIED !== 'true') {
    process.stdout.write('BLOCKED: set STAFF_PASSWORD_RESET_DELIVERY_VERIFIED=true only after a real reset-email delivery check.\n');
    process.exitCode = 1;
    return;
  }

  const expectedDatabase = optionValue('confirm-database');
  const expectedTargetFingerprint = optionValue('confirm-target');
  const candidateCountValue = optionValue('confirm-candidates');
  const expectedCandidateCount = candidateCountValue !== null && /^\d+$/.test(candidateCountValue)
    ? Number(candidateCountValue)
    : null;
  const expectedFingerprint = optionValue('confirm-fingerprint');
  if (
    expectedDatabase !== target.database_name
    || expectedTargetFingerprint !== actualTargetFingerprint
    || expectedCandidateCount !== legacyRows.length
    || expectedFingerprint !== fingerprint
  ) {
    process.stdout.write(
      'BLOCKED: database, target, candidate count, and candidate fingerprint must exactly match this dry-run.\n',
    );
    process.exitCode = 1;
    return;
  }

  const result = await rotateLegacyRows({
    expectedDatabase,
    expectedTargetFingerprint,
    expectedCandidateCount,
    expectedFingerprint,
  });
  if (result.confirmationMismatch) {
    process.stdout.write('BLOCKED: target or candidate set changed after confirmation; run a new dry-run.\n');
    process.exitCode = 1;
    return;
  }
  if (result.blockers.length) {
    process.stdout.write(`BLOCKED: ${JSON.stringify(result.blockers)}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Rotated ${result.rotatedIds.length} staff credential(s); sessions and push subscriptions revoked.\n`);
  if (details) {
    process.stdout.write(`Rotated technician IDs: ${result.rotatedIds.join(', ') || 'none'}\n`);
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      process.stderr.write(`Legacy staff credential rotation failed (${error.code || error.name || 'unknown'}).\n`);
      process.exitCode = 2;
    })
    .finally(async () => db.destroy());
}

module.exports = {
  canonicalEmail,
  candidateFingerprint,
  databaseIdentity,
  findLegacyRows,
  preflight,
  rotateLegacyRows,
  targetFingerprint,
};
