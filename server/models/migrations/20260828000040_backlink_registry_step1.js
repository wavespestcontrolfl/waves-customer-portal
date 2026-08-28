/**
 * Backlink Manager v2 — step 1: registry + paths + provenance + statuses
 * (docs/design/backlink-manager-plan.md §3.1–3.5, §4 legacy backfill, §14 step 1).
 *
 * Additive and reversible. Creates seo_link_domains, seo_link_acquisition_paths,
 * seo_link_domain_sources, seo_link_placement_authorities, seo_link_attempts;
 * adds the §3.3 columns to seo_link_prospects and widens its unique key to
 * (target_domain, target_page, location_key); copies seo_signup_attempts into
 * seo_link_attempts (idempotent, keyed by legacy_attempt_id) and links every
 * board row to a registry domain + path. seo_signup_attempts stays as read-only
 * history (no writer after this deploy; dropped by a later cleanup migration).
 *
 * Enum literals below are FROZEN copies of services/seo/link-registry.js —
 * server/tests/backlink-registry-step1-migration.test.js pins them equal. A
 * changed enum is a NEW migration that swaps the CHECK, never an edit here.
 */

const LINK_SOURCES = ['owner_seed', 'list_import', 'competitor_gap', 'competitor_clone', 'recursive', 'x', 'google_search', 'dataforseo', 'strategy_agent', 'existing_backlink', 'lost_recovery', 'local_opportunity', 'legacy_unknown'];
const AGENT_STATES = ['new', 'investigating', 'qualified', 'ready_to_acquire', 'acquiring', 'acquired', 'watching', 'not_reproducible', 'rejected'];
const DISCOVERY_PRIORITIES = ['owner_seed', 'normal'];
const ACQUISITION_TYPES = ['self_service_free', 'self_service_account', 'paid_listing', 'membership', 'association', 'sponsorship', 'vendor_registration', 'business_claim', 'resource_outreach', 'editorial_outreach', 'partnership', 'content_submission', 'not_reproducible', 'unknown'];
const EXPECTED_REL = ['dofollow', 'nofollow', 'sponsored', 'unknown'];
const EXPECTED_INDEXABILITY = ['indexable', 'noindex', 'unknown'];
const EXPECTED_PERSISTENCE = ['durable', 'rotating', 'unknown'];
const RENEWAL_PERIODS = ['annual', 'monthly', 'none'];
const PATH_LINK_TYPES = ['editorial', 'resource', 'guest_post', 'haro', 'directory', 'citation', 'social'];
const ATTEMPT_PROVIDERS = ['deterministic_runner', 'openai_cua', 'claude_cu', 'stagehand', 'grok', 'human'];
const ATTEMPT_ACTIONS = ['investigate', 'create_account', 'complete_form', 'submit', 'resume', 'outreach_send'];
const ATTEMPT_OUTCOMES = ['slot_reserved', 'submitting', 'submit_ambiguous', 'placed', 'pending', 'drafted', 'sent', 'failed', 'skipped', 'blocked', 'captcha', 'needs_owner', 'human_step_done', 'ready_for_payment', 'ready_for_credentials', 'no_payment_required', 'price_changed', 'instrument_unavailable', 'auto_renew_unavoidable', 'payment_ambiguous', 'mint_not_started', 'terms_changed', 'send_error', 'sandbox_replay'];
const AUTHORITY_DIMENSIONS = ['execution', 'payment', 'communication'];
const AUTHORITY_LEVELS = ['AUTO_FREE', 'AUTO_ACCOUNT', 'AUTO_OUTREACH', 'AUTO_PAID_WITHIN_POLICY', 'OWNER_FREE', 'OWNER_ACCOUNT', 'OWNER_OUTREACH', 'OWNER_PAYMENT', 'OWNER_MANUAL_PAYMENT', 'OWNER_MEMBERSHIP', 'OWNER_LEGAL', 'OWNER_HUMAN_STEP', 'DENY', 'INVALID'];

const quoted = (arr) => arr.map((v) => `'${v}'`).join(', ');
const check = (table, name, expr) => `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr})`;
const inSet = (col, arr, { nullable = false } = {}) => (nullable ? `${col} IS NULL OR ${col} IN (${quoted(arr)})` : `${col} IN (${quoted(arr)})`);

const LEGACY_UNIQUE = 'seo_link_prospects_target_domain_target_page_unique';
const NEW_UNIQUE = 'seo_link_prospects_target_domain_target_page_location_key_unique';

exports.up = async function (knex) {
  // ---- §3.1 registry -----------------------------------------------------
  if (!(await knex.schema.hasTable('seo_link_domains'))) {
    await knex.schema.createTable('seo_link_domains', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.text('domain').notNullable().unique();
      t.string('source').notNullable();
      t.text('source_detail');
      t.uuid('source_ref');
      t.string('discovery_priority').notNullable().defaultTo('normal');
      t.integer('domain_rating'); t.integer('organic_traffic'); t.integer('spam_score');
      t.integer('referring_domains'); t.integer('competitors_linked');
      t.jsonb('enrichment');
      t.timestamp('enriched_at');
      t.uuid('best_path_id');
      t.string('agent_state').notNullable().defaultTo('new');
      t.integer('score');
      t.text('score_reasons');
      t.timestamp('watch_recheck_at');
      t.text('notes'); t.string('owner');
      t.timestamps(true, true);
      t.index(['agent_state']); t.index(['source']);
    });
    await knex.raw(check('seo_link_domains', 'seo_link_domains_source_check', inSet('source', LINK_SOURCES)));
    await knex.raw(check('seo_link_domains', 'seo_link_domains_agent_state_check', inSet('agent_state', AGENT_STATES)));
    await knex.raw(check('seo_link_domains', 'seo_link_domains_discovery_priority_check', inSet('discovery_priority', DISCOVERY_PRIORITIES)));
  }

  // ---- §3.2 acquisition paths -------------------------------------------
  if (!(await knex.schema.hasTable('seo_link_acquisition_paths'))) {
    await knex.schema.createTable('seo_link_acquisition_paths', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('domain_id').notNullable().references('id').inTable('seo_link_domains').onDelete('CASCADE');
      t.string('acquisition_type').notNullable();
      t.text('submission_url');
      t.integer('estimated_cost_cents'); t.integer('renewal_cost_cents'); t.string('renewal_period');
      t.jsonb('merchant_binding');
      t.boolean('account_required').notNullable();
      t.boolean('email_verification').notNullable();
      t.boolean('payment_required').notNullable();
      t.boolean('legal_attestation').notNullable();
      t.text('legal_terms_hash');
      t.boolean('agent_completable').notNullable();
      t.boolean('baseline').notNullable().defaultTo(false);
      t.string('provider_override');
      t.string('expected_rel');
      t.string('expected_indexability');
      t.string('expected_persistence');
      t.string('link_type').notNullable();
      t.decimal('confidence', 3, 2);
      t.integer('revision').notNullable().defaultTo(1);
      t.integer('revision_payment').notNullable().defaultTo(1);
      t.integer('revision_communication').notNullable().defaultTo(1);
      t.integer('revision_execution').notNullable().defaultTo(1);
      t.string('authority_last_decided');
      t.jsonb('investigation');
      t.timestamp('last_investigated_at');
      t.text('path_key').notNullable();
      t.uuid('superseded_by').references('id').inTable('seo_link_acquisition_paths').onDelete('SET NULL');
      t.timestamp('superseded_at');
      t.timestamps(true, true);
      t.index(['domain_id']);
    });
    await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS seo_link_acquisition_paths_active_key_uniq ON seo_link_acquisition_paths (domain_id, path_key) WHERE superseded_by IS NULL');
    await knex.raw(check('seo_link_acquisition_paths', 'seo_link_acquisition_paths_type_check', inSet('acquisition_type', ACQUISITION_TYPES)));
    await knex.raw(check('seo_link_acquisition_paths', 'seo_link_acquisition_paths_link_type_check', inSet('link_type', PATH_LINK_TYPES)));
    await knex.raw(check('seo_link_acquisition_paths', 'seo_link_acquisition_paths_expected_rel_check', inSet('expected_rel', EXPECTED_REL, { nullable: true })));
    await knex.raw(check('seo_link_acquisition_paths', 'seo_link_acquisition_paths_expected_indexability_check', inSet('expected_indexability', EXPECTED_INDEXABILITY, { nullable: true })));
    await knex.raw(check('seo_link_acquisition_paths', 'seo_link_acquisition_paths_expected_persistence_check', inSet('expected_persistence', EXPECTED_PERSISTENCE, { nullable: true })));
    await knex.raw(check('seo_link_acquisition_paths', 'seo_link_acquisition_paths_renewal_period_check', inSet('renewal_period', RENEWAL_PERIODS, { nullable: true })));
    await knex.raw(check('seo_link_acquisition_paths', 'seo_link_acquisition_paths_provider_override_check', inSet('provider_override', ATTEMPT_PROVIDERS, { nullable: true })));
    await knex.raw(check('seo_link_acquisition_paths', 'seo_link_acquisition_paths_confidence_check', 'confidence IS NULL OR (confidence >= 0 AND confidence <= 1)'));
    // best_path_id → paths (declared after paths exist; SET NULL so a path can be deleted)
    await knex.raw('ALTER TABLE seo_link_domains ADD CONSTRAINT seo_link_domains_best_path_id_foreign FOREIGN KEY (best_path_id) REFERENCES seo_link_acquisition_paths(id) ON DELETE SET NULL');
  }

  // ---- §3.4b touches -----------------------------------------------------
  if (!(await knex.schema.hasTable('seo_link_domain_sources'))) {
    await knex.schema.createTable('seo_link_domain_sources', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('domain_id').notNullable().references('id').inTable('seo_link_domains').onDelete('CASCADE');
      t.string('source').notNullable(); t.text('source_detail'); t.uuid('source_ref');
      t.text('touch_key').notNullable();
      t.timestamp('seen_at').notNullable().defaultTo(knex.fn.now());
      t.unique(['domain_id', 'touch_key']);
      t.index(['source']);
    });
    await knex.raw(check('seo_link_domain_sources', 'seo_link_domain_sources_source_check', inSet('source', LINK_SOURCES)));
  }

  // ---- §3.3 placements: additive columns + wider unique key --------------
  const cols = await knex('seo_link_prospects').columnInfo();
  await knex.schema.alterTable('seo_link_prospects', (t) => {
    if (!cols.domain_id) t.uuid('domain_id').references('id').inTable('seo_link_domains').onDelete('SET NULL');
    if (!cols.path_id) t.uuid('path_id').references('id').inTable('seo_link_acquisition_paths').onDelete('SET NULL');
    if (!cols.pending_path_id) t.uuid('pending_path_id').references('id').inTable('seo_link_acquisition_paths').onDelete('SET NULL');
    if (!cols.parked_from_status) t.string('parked_from_status');
    if (!cols.credential_id) t.uuid('credential_id'); // → seo_link_credentials (step 5 adds the table + FK)
    if (!cols.location_key) t.string('location_key').notNullable().defaultTo('-');
    if (!cols.authority) t.string('authority');
    if (!cols.source_detail) t.text('source_detail');
    if (!cols.paid_through) t.date('paid_through');
    if (!cols.renews_at) t.date('renews_at');
    if (!cols.recurring_merchant) t.boolean('recurring_merchant').notNullable().defaultTo(false);
  });
  if (!cols.domain_id) await knex.raw('CREATE INDEX IF NOT EXISTS seo_link_prospects_domain_id_idx ON seo_link_prospects (domain_id)');
  if (!cols.path_id) await knex.raw('CREATE INDEX IF NOT EXISTS seo_link_prospects_path_id_idx ON seo_link_prospects (path_id)');
  // location_key replaces the runner's quality_signals.location identity: copy
  // the stamped GBP location onto rows that carry one ('default' = not scoped).
  // The old 2-column unique key guarantees no collision under the wider key.
  await knex.raw("UPDATE seo_link_prospects SET location_key = quality_signals->>'location' WHERE location_key = '-' AND COALESCE(quality_signals->>'location', '') NOT IN ('', 'default')");
  await knex.raw(`ALTER TABLE seo_link_prospects DROP CONSTRAINT IF EXISTS ${LEGACY_UNIQUE}`);
  await knex.raw(`DROP INDEX IF EXISTS ${LEGACY_UNIQUE}`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${NEW_UNIQUE} ON seo_link_prospects (target_domain, target_page, location_key)`);

  // ---- §3.3b authorities (schema only in step 1; the bridge writes it in step 4)
  if (!(await knex.schema.hasTable('seo_link_placement_authorities'))) {
    await knex.schema.createTable('seo_link_placement_authorities', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('prospect_id').notNullable().references('id').inTable('seo_link_prospects').onDelete('CASCADE');
      t.string('dimension').notNullable();
      t.string('level').notNullable();
      t.uuid('approval_id');
      t.uuid('floor_waiver_id');
      t.text('decision_inputs_hash').notNullable();
      t.integer('path_revision').notNullable();
      t.string('instance_key').notNullable().defaultTo('-:1');
      t.timestamp('decided_at').notNullable();
      t.timestamp('satisfied_at');
      t.timestamps(true, true);
      t.unique(['prospect_id', 'dimension', 'instance_key']);
    });
    await knex.raw(check('seo_link_placement_authorities', 'seo_link_placement_authorities_dimension_check', inSet('dimension', AUTHORITY_DIMENSIONS)));
    await knex.raw(check('seo_link_placement_authorities', 'seo_link_placement_authorities_level_check', inSet('level', AUTHORITY_LEVELS)));
  }

  // ---- §3.4 attempts -----------------------------------------------------
  if (!(await knex.schema.hasTable('seo_link_attempts'))) {
    await knex.schema.createTable('seo_link_attempts', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('prospect_id').references('id').inTable('seo_link_prospects').onDelete('SET NULL');
      t.uuid('path_id').references('id').inTable('seo_link_acquisition_paths').onDelete('SET NULL');
      t.string('provider').notNullable();
      t.string('action').notNullable();
      t.string('outcome').notNullable();
      t.integer('cost_cents'); t.integer('duration_ms');
      t.boolean('sandbox').notNullable().defaultTo(false);
      t.date('slot_day');
      t.text('lease_token');
      t.text('evidence_url'); t.jsonb('detail');
      t.uuid('legacy_attempt_id');
      t.timestamps(true, true);
      t.index(['prospect_id']); t.index(['slot_day', 'outcome']);
    });
    await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS seo_link_attempts_legacy_attempt_id_uniq ON seo_link_attempts (legacy_attempt_id) WHERE legacy_attempt_id IS NOT NULL');
    await knex.raw(check('seo_link_attempts', 'seo_link_attempts_provider_check', inSet('provider', ATTEMPT_PROVIDERS)));
    await knex.raw(check('seo_link_attempts', 'seo_link_attempts_action_check', inSet('action', ATTEMPT_ACTIONS)));
    await knex.raw(check('seo_link_attempts', 'seo_link_attempts_outcome_check', inSet('outcome', ATTEMPT_OUTCOMES)));
  }

  // ---- backfills (pure, re-runnable; the runner + boot catch-up re-run the first)
  const { backfillLegacyAttempts, backfillLegacyBoard } = require('../../services/seo/link-registry-backfill');
  await backfillLegacyBoard(knex);
  await backfillLegacyAttempts(knex);
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('seo_link_attempts');
  await knex.schema.dropTableIfExists('seo_link_placement_authorities');
  if (await knex.schema.hasTable('seo_link_prospects')) {
    await knex.raw(`DROP INDEX IF EXISTS ${NEW_UNIQUE}`);
    await knex.raw('DROP INDEX IF EXISTS seo_link_prospects_domain_id_idx');
    await knex.raw('DROP INDEX IF EXISTS seo_link_prospects_path_id_idx');
    const cols = await knex('seo_link_prospects').columnInfo();
    await knex.schema.alterTable('seo_link_prospects', (t) => {
      for (const c of ['domain_id', 'path_id', 'pending_path_id', 'parked_from_status', 'credential_id', 'location_key', 'authority', 'source_detail', 'paid_through', 'renews_at', 'recurring_merchant']) {
        if (cols[c]) t.dropColumn(c);
      }
    });
    await knex.raw(`ALTER TABLE seo_link_prospects ADD CONSTRAINT ${LEGACY_UNIQUE} UNIQUE (target_domain, target_page)`);
  }
  await knex.schema.dropTableIfExists('seo_link_domain_sources');
  if (await knex.schema.hasTable('seo_link_domains')) {
    await knex.raw('ALTER TABLE seo_link_domains DROP CONSTRAINT IF EXISTS seo_link_domains_best_path_id_foreign');
  }
  await knex.schema.dropTableIfExists('seo_link_acquisition_paths');
  await knex.schema.dropTableIfExists('seo_link_domains');
};
