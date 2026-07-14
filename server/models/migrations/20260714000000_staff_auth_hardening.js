/**
 * Add staff authentication/session-revocation state without changing any
 * password hash. Railway runs migrations before the new application starts,
 * so destructive legacy-password rotation does not belong in this migration:
 * a failed rollout would otherwise leave the old build live with randomized
 * credentials and no recovery route.
 *
 * The strict application validator requires an explicit access-token type and
 * integer token version. Existing unversioned JWTs therefore stop working as
 * soon as the new build starts. Existing rows are also bumped from the new
 * nonzero default to make the migration's revocation intent explicit.
 */

const ACTIVE_WRITE_CONSTRAINT = 'time_entries_staff_active_write_generation_check';
const STAFF_EMAIL_CANONICAL_INDEX = 'technicians_staff_email_canonical_uidx';
const MAX_STAFF_EMAIL_LENGTH = 150;

function assertMaintenanceInterlock(env = process.env) {
  // Railway's pre-deploy environment is the authority for this production
  // migration. NODE_ENV is still checked for non-Railway production runs, but
  // it must not be possible to bypass the interlock by omitting or mis-setting
  // NODE_ENV on the production Railway environment.
  const isProduction = env.NODE_ENV === 'production'
    || String(env.RAILWAY_ENVIRONMENT_NAME || '').trim().toLowerCase() === 'production';
  if (isProduction && env.STAFF_MAINTENANCE_MODE !== 'true') {
    throw new Error(
      'STAFF_MAINTENANCE_MODE=true is required for the production Staff auth migration',
    );
  }
}

function rowsFrom(result) {
  return Array.isArray(result) ? result : (result?.rows || []);
}

async function setActiveWriteGeneration(knex, generation) {
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error('Staff write generation must be a positive integer');
  }
  if (!(await knex.schema.hasTable('time_entries'))
      || !(await knex.schema.hasColumn('time_entries', 'staff_write_generation'))) {
    throw new Error('Staff time schema reconciliation must run before auth hardening');
  }

  await knex.raw("SET LOCAL lock_timeout = '5s'");
  await knex.raw('LOCK TABLE time_entries IN ACCESS EXCLUSIVE MODE');
  const activeResult = await knex.raw(`
    SELECT EXISTS (
      SELECT 1
      FROM time_entries
      WHERE status = 'active'
    ) AS exists
  `);
  if (rowsFrom(activeResult)[0]?.exists) {
    throw new Error('Active Staff timers must be clocked out before auth hardening');
  }

  await knex.raw(`
    ALTER TABLE time_entries
    DROP CONSTRAINT IF EXISTS ${ACTIVE_WRITE_CONSTRAINT}
  `);
  await knex.raw(`
    ALTER TABLE time_entries
    ADD CONSTRAINT ${ACTIVE_WRITE_CONSTRAINT}
    CHECK (
      status <> 'active'
      OR staff_write_generation IS NOT DISTINCT FROM ${Number(generation)}
    )
  `);
}

async function assertPushSubscriptionSchema(knex) {
  if (!(await knex.schema.hasTable('push_subscriptions'))) {
    throw new Error('Staff auth hardening requires the push_subscriptions table');
  }
  for (const column of ['admin_user_id', 'active']) {
    if (!(await knex.schema.hasColumn('push_subscriptions', column))) {
      throw new Error(`Staff auth hardening requires push_subscriptions.${column}`);
    }
  }
}

async function normalizeStaffEmails(knex) {
  // Serialize every identity writer before inspecting or normalizing rows.
  // Noncanonical but otherwise valid Phase-A emails are repaired in-place so
  // the Phase-B post-deploy audit cannot fail solely because of case/spacing.
  // Missing/malformed active identities and canonical collisions fail closed.
  await knex.raw("SET LOCAL lock_timeout = '5s'");
  // EXCLUSIVE conflicts with SELECT ... FOR UPDATE's ROW SHARE table lock.
  // Take it before the time_entries lock so an in-flight first clock-in either
  // completes before this migration or blocks before we hold the timer table;
  // it cannot deadlock with the generation flip in the opposite lock order.
  await knex.raw('LOCK TABLE technicians IN EXCLUSIVE MODE');

  const adminPreflightResult = await knex.raw(`
    SELECT COUNT(*) FILTER (
             WHERE role IN ('admin', 'technician')
           )::integer AS staff_account_count,
           COUNT(*) FILTER (
             WHERE role = 'admin' AND active = true
           )::integer AS active_admin_count
    FROM technicians
  `);
  const adminPreflight = rowsFrom(adminPreflightResult)[0] || {};
  if (
    Number(adminPreflight.staff_account_count) > 0
    && Number(adminPreflight.active_admin_count) < 1
  ) {
    throw new Error('At least one active Staff admin is required before auth hardening');
  }

  const invalidResult = await knex.raw(`
    SELECT id
    FROM technicians
    WHERE role IN ('admin', 'technician')
      AND active = true
      AND (
        email IS NULL
        OR BTRIM(email) = ''
        OR LENGTH(BTRIM(email)) > ${MAX_STAFF_EMAIL_LENGTH}
        OR BTRIM(email) !~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
      )
    LIMIT 1
  `);
  if (rowsFrom(invalidResult).length > 0) {
    throw new Error('Active Staff accounts must have a valid email before auth hardening');
  }

  const duplicateResult = await knex.raw(`
    SELECT LOWER(BTRIM(email)) AS canonical_email
    FROM technicians
    WHERE role IN ('admin', 'technician')
      AND email IS NOT NULL
      AND BTRIM(email) <> ''
    GROUP BY LOWER(BTRIM(email))
    HAVING COUNT(*) > 1
    LIMIT 1
  `);
  if (rowsFrom(duplicateResult).length > 0) {
    throw new Error('Canonical Staff email collision must be resolved before auth hardening');
  }

  await knex.raw(`
    UPDATE technicians
    SET email = LOWER(BTRIM(email)),
        updated_at = CURRENT_TIMESTAMP
    WHERE role IN ('admin', 'technician')
      AND email IS NOT NULL
      AND BTRIM(email) <> ''
      AND email IS DISTINCT FROM LOWER(BTRIM(email))
  `);
}

exports.up = async function up(knex) {
  // The B0 gate must already be deployed, enabled, and drained before Railway
  // runs this forward-only migration. This env check cannot prove drain, but
  // it prevents an accidental production deploy that skips the interlock.
  assertMaintenanceInterlock();

  // The application binds every staff push subscription to the current auth
  // version. Treat missing legacy schema as a failed preflight, not as an
  // optional feature that would leave a bearer channel outside revocation.
  await assertPushSubscriptionSchema(knex);

  await normalizeStaffEmails(knex);

  // Phase A accepts generation 1. Flip to generation 2 while the timer table
  // is locked and empty, then revoke sessions in the same transaction. The
  // Phase-A application cannot create a timer after commit, while this Staff
  // build stamps generation 2 on every create/reopen-active write.
  await setActiveWriteGeneration(knex, 2);

  // Authentication and reset both resolve LOWER(BTRIM(email)). Application
  // locks make friendly conflicts deterministic, while this expression index
  // protects the invariant from old/maintenance-overlap and future writers.
  await knex.raw(`
    CREATE UNIQUE INDEX ${STAFF_EMAIL_CANONICAL_INDEX}
    ON technicians (LOWER(BTRIM(email)))
    WHERE role IN ('admin', 'technician')
      AND email IS NOT NULL
      AND BTRIM(email) <> ''
  `);

  await knex.schema.alterTable('technicians', (table) => {
    table.integer('auth_token_version').notNullable().defaultTo(1);
    table.boolean('must_change_password').notNullable().defaultTo(false);
    table.timestamp('password_changed_at');
    table.string('password_reset_token_hash', 64);
    table.timestamp('password_reset_expires_at');
    table.timestamp('password_reset_requested_at');
    table.index('password_reset_token_hash', 'technicians_password_reset_token_hash_idx');
  });

  await knex('technicians')
    .whereIn('role', ['admin', 'technician'])
    .update({
      auth_token_version: knex.raw('auth_token_version + 1'),
      updated_at: knex.fn.now(),
    });

  // Push endpoints are independent bearer channels. Establish the same clean
  // session boundary as the JWT migration; users can re-subscribe after their
  // next strict, versioned login. Persisting the version on each new staff
  // subscription also closes the pre-deploy race where the old application can
  // insert/reactivate a row after this migration's bulk deactivation.
  await knex.schema.alterTable('push_subscriptions', (table) => {
    table.integer('staff_token_version');
    table.index(
      ['admin_user_id', 'staff_token_version'],
      'push_subscriptions_staff_token_version_idx',
    );
  });
  await knex('push_subscriptions')
    .whereNotNull('admin_user_id')
    .where({ active: true })
    .update({ active: false });
};

exports.down = async function down() {
  // Intentionally forward-only. Returning to Phase A would restore acceptance
  // of unversioned 30-day Staff JWTs and the retired repository-known password,
  // so dropping the revocation schema is not a safe recovery action. Knex must
  // leave this migration recorded and operators must fix forward.
  throw new Error('Staff auth hardening is forward-only; fix forward instead of rolling back');
};

exports.setActiveWriteGeneration = setActiveWriteGeneration;
exports.normalizeStaffEmails = normalizeStaffEmails;
exports.assertMaintenanceInterlock = assertMaintenanceInterlock;
