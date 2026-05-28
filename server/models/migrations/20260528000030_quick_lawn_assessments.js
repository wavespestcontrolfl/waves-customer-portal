/**
 * Quick Lawn Assessment — extend `lawn_assessments` to support a lightweight,
 * baseline-excluded "quick capture" mode.
 *
 * A quick assessment can:
 *   - exist detached (no customer yet) for internal AI feedback,
 *   - attach to a lead or an existing customer,
 *   - carry its own shareable report token (no service_record to hang it on),
 *   - be explicitly promoted into official history (admin-only, at the route).
 *
 * Backfill keeps every existing row behaving exactly as before:
 *   source=standard_customer_assessment, subject=customer,
 *   status=reviewed, baseline_policy=eligible.
 *
 * Decisions locked in docs/design/quick-lawn-assessment-plan.md §12:
 *   - customer_id becomes nullable (backfilled rows are unaffected)
 *   - plaintext + unique + rate-limited token convention (matches reports-public),
 *     plus an expiry column
 *   - property_id deferred (properties are not first-class)
 */

const SOURCES = ['quick_capture', 'standard_customer_assessment', 'admin_created'];
const SUBJECTS = ['unassigned', 'lead', 'customer'];
const STATUSES = ['draft', 'analyzing', 'reviewed', 'ready', 'sent', 'archived'];
const BASELINE_POLICIES = ['excluded', 'eligible', 'promoted'];
const REPORT_STATUSES = ['none', 'generated', 'sent', 'expired'];
const AI_STATUSES = ['pending', 'complete', 'failed'];

function quoted(values) {
  return values.map((v) => `'${v}'`).join(', ');
}

exports.up = async function up(knex) {
  const T = 'lawn_assessments';

  const addColumn = async (name, builder) => {
    if (!(await knex.schema.hasColumn(T, name))) {
      await knex.schema.alterTable(T, builder);
    }
  };

  // 1. Quick captures can start with no customer attached.
  //    (DROP NOT NULL is a no-op if already nullable — safe to re-run.)
  await knex.raw('ALTER TABLE lawn_assessments ALTER COLUMN customer_id DROP NOT NULL');

  // 1b. Photo rows for a quick capture are written before a customer is
  //     linked, so they must allow a null customer_id too (backfilled on
  //     attach). Existing photo rows are already populated and unaffected.
  if (await knex.schema.hasColumn('lawn_assessment_photos', 'customer_id')) {
    await knex.raw('ALTER TABLE lawn_assessment_photos ALTER COLUMN customer_id DROP NOT NULL');
  }

  // 2. Classification + lifecycle. NOT NULL + default backfills existing rows
  //    to their current effective state in one statement.
  await addColumn('assessment_source', (t) =>
    t.string('assessment_source', 40).notNullable().defaultTo('standard_customer_assessment'));
  await addColumn('assessment_subject_type', (t) =>
    t.string('assessment_subject_type', 20).notNullable().defaultTo('customer'));
  await addColumn('status', (t) =>
    t.string('status', 20).notNullable().defaultTo('reviewed'));
  await addColumn('baseline_policy', (t) =>
    t.string('baseline_policy', 20).notNullable().defaultTo('eligible'));
  await addColumn('ai_status', (t) => t.string('ai_status', 20));

  // 3. Subject linkage + captured contact for unassigned / lead drafts.
  await addColumn('lead_id', (t) =>
    t.uuid('lead_id').references('id').inTable('leads').onDelete('SET NULL'));
  await addColumn('contact_snapshot', (t) => t.jsonb('contact_snapshot'));
  await addColumn('address_snapshot', (t) => t.jsonb('address_snapshot'));
  await addColumn('created_by_user_id', (t) => t.uuid('created_by_user_id'));

  // 4. Self-hosted report token. No service_record exists for a quick
  //    assessment, so the token lives on the assessment itself. Matches the
  //    existing plaintext + unique + rate-limited convention; adds an expiry.
  await addColumn('report_view_token', (t) => t.string('report_view_token', 64));
  await addColumn('report_status', (t) =>
    t.string('report_status', 20).notNullable().defaultTo('none'));
  await addColumn('report_expires_at', (t) => t.timestamp('report_expires_at'));
  await addColumn('last_sent_at', (t) => t.timestamp('last_sent_at'));

  // 5. Promotion audit (explicit; admin-only enforced at the route layer).
  await addColumn('promoted_to_snapshot_id', (t) =>
    t.uuid('promoted_to_snapshot_id')
      .references('id').inTable('property_health_snapshots').onDelete('SET NULL'));
  await addColumn('promoted_at', (t) => t.timestamp('promoted_at'));
  await addColumn('promoted_by_user_id', (t) => t.uuid('promoted_by_user_id'));
  await addColumn('archived_at', (t) => t.timestamp('archived_at'));

  // 6. Enum CHECK constraints (drop-then-add keeps this idempotent).
  await knex.raw(`
    ALTER TABLE lawn_assessments
    DROP CONSTRAINT IF EXISTS lawn_assessments_source_check,
    DROP CONSTRAINT IF EXISTS lawn_assessments_subject_type_check,
    DROP CONSTRAINT IF EXISTS lawn_assessments_status_check,
    DROP CONSTRAINT IF EXISTS lawn_assessments_baseline_policy_check,
    DROP CONSTRAINT IF EXISTS lawn_assessments_report_status_check,
    DROP CONSTRAINT IF EXISTS lawn_assessments_ai_status_check
  `);
  await knex.raw(`
    ALTER TABLE lawn_assessments
    ADD CONSTRAINT lawn_assessments_source_check
      CHECK (assessment_source IN (${quoted(SOURCES)})),
    ADD CONSTRAINT lawn_assessments_subject_type_check
      CHECK (assessment_subject_type IN (${quoted(SUBJECTS)})),
    ADD CONSTRAINT lawn_assessments_status_check
      CHECK (status IN (${quoted(STATUSES)})),
    ADD CONSTRAINT lawn_assessments_baseline_policy_check
      CHECK (baseline_policy IN (${quoted(BASELINE_POLICIES)})),
    ADD CONSTRAINT lawn_assessments_report_status_check
      CHECK (report_status IN (${quoted(REPORT_STATUSES)})),
    ADD CONSTRAINT lawn_assessments_ai_status_check
      CHECK (ai_status IS NULL OR ai_status IN (${quoted(AI_STATUSES)}))
  `);

  // 7. Indexes. Partial-unique token index allows many NULLs while keeping
  //    issued tokens globally unique (same shape as report lookups elsewhere).
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS idx_lawn_assessments_report_token ON lawn_assessments(report_view_token) WHERE report_view_token IS NOT NULL');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_lawn_assessments_lead_id ON lawn_assessments(lead_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_lawn_assessments_baseline_policy ON lawn_assessments(customer_id, baseline_policy)');
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_lawn_assessments_source_status ON lawn_assessments(assessment_source, status)');
};

exports.down = async function down(knex) {
  const T = 'lawn_assessments';

  await knex.raw('DROP INDEX IF EXISTS idx_lawn_assessments_source_status');
  await knex.raw('DROP INDEX IF EXISTS idx_lawn_assessments_baseline_policy');
  await knex.raw('DROP INDEX IF EXISTS idx_lawn_assessments_lead_id');
  await knex.raw('DROP INDEX IF EXISTS idx_lawn_assessments_report_token');

  await knex.raw(`
    ALTER TABLE lawn_assessments
    DROP CONSTRAINT IF EXISTS lawn_assessments_source_check,
    DROP CONSTRAINT IF EXISTS lawn_assessments_subject_type_check,
    DROP CONSTRAINT IF EXISTS lawn_assessments_status_check,
    DROP CONSTRAINT IF EXISTS lawn_assessments_baseline_policy_check,
    DROP CONSTRAINT IF EXISTS lawn_assessments_report_status_check,
    DROP CONSTRAINT IF EXISTS lawn_assessments_ai_status_check
  `);

  const dropColumn = async (name) => {
    if (await knex.schema.hasColumn(T, name)) {
      await knex.schema.alterTable(T, (t) => t.dropColumn(name));
    }
  };
  for (const col of [
    'assessment_source', 'assessment_subject_type', 'status', 'baseline_policy', 'ai_status',
    'lead_id', 'contact_snapshot', 'address_snapshot', 'created_by_user_id',
    'report_view_token', 'report_status', 'report_expires_at', 'last_sent_at',
    'promoted_to_snapshot_id', 'promoted_at', 'promoted_by_user_id', 'archived_at',
  ]) {
    await dropColumn(col);
  }

  // Restore the original NOT NULL. Detached quick captures (no customer) only
  // exist because of this feature, so they're dropped on a rollback (their
  // photo rows cascade away via the assessment_id FK).
  await knex('lawn_assessments').whereNull('customer_id').del();
  await knex.raw('ALTER TABLE lawn_assessments ALTER COLUMN customer_id SET NOT NULL');

  if (await knex.schema.hasColumn('lawn_assessment_photos', 'customer_id')) {
    await knex('lawn_assessment_photos').whereNull('customer_id').del();
    await knex.raw('ALTER TABLE lawn_assessment_photos ALTER COLUMN customer_id SET NOT NULL');
  }
};
