/**
 * Data Hygiene Agent — Phase 0 schema.
 *
 * Four tables that together back the data-hygiene proposal/review pipeline.
 * Phase 0 ships schema + audit helpers + feature gates only; no scanner code
 * writes rows yet (Phase 1 wires the deterministic scanner; Phase 1.5 wires
 * the call_log.ai_extraction bootstrap; Phase 4 wires LLM extraction).
 *
 *  - data_hygiene_runs                  one row per scan invocation. Acts as
 *                                       the run lock via a partial unique index
 *                                       on status='running' (see P8 — replaces
 *                                       session-scoped pg_try_advisory_lock,
 *                                       which is unsafe under pooled queries).
 *
 *  - data_hygiene_proposals             one row per proposed change. Reviewed
 *                                       in admin UI, applied transactionally
 *                                       with an optimistic stale guard, audited
 *                                       to audit_log with {before, after}.
 *                                       Resource/scope split (P1): resource_id
 *                                       is the target row (NULL when create-on
 *                                       -apply, e.g. property_preferences not
 *                                       yet inserted); scope_type/scope_id are
 *                                       always the owning customer/account so
 *                                       per-customer queries are cheap.
 *
 *  - data_hygiene_source_extractions    durable record that the LLM has already
 *                                       processed a given (source, extractor_
 *                                       version, source_hash). Prevents repeat
 *                                       LLM calls across scan ticks (P5). Re-
 *                                       processing only happens when the
 *                                       extractor_version is bumped (prompt or
 *                                       schema change) or the source body
 *                                       itself changes.
 *
 *  - data_hygiene_sensitive_vault       encrypted raw before/after values for
 *                                       sensitive proposals (gate codes,
 *                                       lockbox codes, access notes). Normal
 *                                       proposal/audit tables keep redacted
 *                                       display values only; safe revert reads
 *                                       this vault under admin permission.
 *
 * Allowed enum values are enforced via CHECK constraints rather than Postgres
 * enums so the application can evolve them without ALTER TYPE pain.
 */

exports.up = async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  // -----------------------------------------------------------------
  // 1. data_hygiene_runs — created first so proposals can FK to it.
  // -----------------------------------------------------------------
  if (!(await knex.schema.hasTable('data_hygiene_runs'))) {
    await knex.schema.createTable('data_hygiene_runs', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      // Invocation context.
      t.string('mode', 20).notNullable();
      //  cron | manual | bootstrap | dry_run
      t.uuid('triggered_by'); // technicians.id when manual; null otherwise
      t.jsonb('phases').notNullable().defaultTo('[]');
      //  e.g. ['normalization'] or ['bootstrap'] or
      //  ['normalization','backfill','link','dedupe','extraction']

      // Lifecycle.
      t.timestamp('started_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('finished_at');
      t.string('status', 20).notNullable().defaultTo('running');
      //  running | ok | failed | lock_busy
      t.text('error_message');

      // Telemetry. Shape:
      //   { created, staled, auto_applied, errors,
      //     by_source: {...}, by_rule: {...} }
      t.jsonb('counts').notNullable().defaultTo('{}');

      // Provenance — git sha or 'v1'. Helps correlate behavior changes to a
      // specific deploy when triaging a run later.
      t.string('scanner_version', 64).notNullable();

      t.index(['started_at'], 'data_hygiene_runs_started_at_index');
      t.index(['status'], 'data_hygiene_runs_status_index');
    });

    // CHECK constraints (status + mode taxonomies). Named so they show up
    // clearly when a constraint violation surfaces to a logger.
    await knex.raw(`
      ALTER TABLE data_hygiene_runs
        ADD CONSTRAINT data_hygiene_runs_mode_check
        CHECK (mode IN ('cron','manual','bootstrap','dry_run'))
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_runs
        ADD CONSTRAINT data_hygiene_runs_status_check
        CHECK (status IN ('running','ok','failed','lock_busy'))
    `);

    // P8 — database-backed run lock. A second concurrent scan attempting to
    // INSERT (mode='cron'|'manual'|..., status='running') gets a unique-
    // violation that the orchestrator catches and converts into a
    // status='lock_busy' row + 409 response. Unlike session-scoped
    // pg_try_advisory_lock, this survives connection pooling correctly.
    // Ops note: stuck runs (finished_at IS NULL AND started_at < now() -
    // interval '2 hours') are reaped by server/services/data-hygiene/reaper.js
    // before each runScan attempt.
    await knex.raw(`
      CREATE UNIQUE INDEX one_running_data_hygiene_scan
        ON data_hygiene_runs ((1))
        WHERE status = 'running'
    `);
  }

  // -----------------------------------------------------------------
  // 2. data_hygiene_proposals — the review queue.
  // -----------------------------------------------------------------
  if (!(await knex.schema.hasTable('data_hygiene_proposals'))) {
    await knex.schema.createTable('data_hygiene_proposals', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      // Which scan produced this proposal. NULL after the run row is purged
      // (we keep proposals long after runs are gone).
      t.uuid('run_id')
        .references('id')
        .inTable('data_hygiene_runs')
        .onDelete('SET NULL');

      // Rule identity. rule_id is the stable rule key; rule_version is bumped
      // when the rule's logic changes (a new value rewrite, a tighter regex,
      // etc.) so an old rejected proposal does not silently mask a new
      // better-quality one. See idempotency_key composition in the orchestrator.
      t.string('rule_id', 80).notNullable();
      //   normalization:    'phone.e164', 'email.lowercase_trim',
      //                     'name.proper_case_first', 'zip.zero_pad_5',
      //                     'state.normalize_to_us_2letter', ...
      //   cross-record:     'backfill.first_name_from_account',
      //                     'backfill.address_from_call_ai_extraction', ...
      //   bootstrap:        'bootstrap.from_call_ai_extraction'
      //   link:             'link.conversation_by_phone', 'link.call_by_phone'
      //   extract:          'extract.gate_code', 'extract.lockbox_code',
      //                     'extract.access_notes', 'extract.pet_details', ...
      //   dedupe:           'dedupe.account_pair'
      t.string('rule_version', 16).notNullable();

      // Target — what gets UPDATEd on apply. resource_id is NULL only for
      // create-on-apply (a property_preferences row that does not exist yet);
      // scope_* is always set so per-customer queries can stay cheap.
      t.string('resource_type', 32).notNullable();
      //  customer | customer_account | property_preferences |
      //  conversation | call_log
      t.uuid('resource_id'); // NULL when create-on-apply
      t.string('scope_type', 32).notNullable();
      //  customer | customer_account
      t.uuid('scope_id').notNullable();

      // What changes. field names from the apply-handler allowlist (Phase 2);
      // sentinel '_link_customer_id' for conversation/call linking,
      // '_merge_into' for dedupe candidates.
      t.string('field', 64).notNullable();

      // Values stored as jsonb so null/empty-string/empty-array/array stay
      // distinct, and so structured proposed_value (e.g. dedupe metadata) does
      // not need a separate column. UI does its own diff formatting.
      t.jsonb('current_value');
      t.jsonb('proposed_value');

      // Provenance.
      t.string('source', 40).notNullable();
      //  normalization | cross-record-backfill | conversation-link | call-link
      //  | call-ai-extraction-import | message-extraction | call-extraction
      //  | email-local-part | dedupe-candidate
      t.specificType('confidence', 'numeric(4,3)').notNullable();
      t.string('tier', 10).notNullable();
      //  auto | high | medium | low

      // Why we believe this. Includes ids that prove provenance (call_id,
      // message_id, sibling_customer_id, scope_source, scope_confidence,
      // etc.), plus a 120-char transcript_excerpt window for extraction
      // proposals (NEVER the full transcript — see P6 on sensitive data).
      t.jsonb('evidence').notNullable().defaultTo('{}');

      // P6 — masking gate. Set true automatically for any rule_id matching
      // extract.gate_code / lockbox_code / garage_code / access_notes /
      // parking_notes, or for any field matching *_gate_code|lockbox_code|
      // garage_code|access_notes. UI masks the value by default; reveal is
      // permissioned and audit-logged.
      t.boolean('is_sensitive').notNullable().defaultTo(false);

      // Lifecycle.
      t.string('status', 16).notNullable().defaultTo('pending');
      //  pending | auto_applied | approved | rejected | superseded | stale
      t.string('reject_reason', 24);
      //  wrong_person | wrong_property | outdated | bad_parse | noise | other
      t.uuid('reviewer_id'); // technicians.id (admin/tech actor); null for auto
      t.string('reviewed_via', 8);
      //  ui | api | auto
      t.timestamp('reviewed_at');
      t.timestamp('applied_at');

      // Idempotency. Composition lives in proposal-store.js but the key
      // shape is:
      //   normalization / cross-record / link:
      //     sha256(resource_type|resource_id|field|json(proposed_value)
      //            |source|rule_id|rule_version
      //            |evidence_source_type|evidence_source_id)
      //   bootstrap:
      //     sha256(...|rule_id|call_id)
      //   message/call extraction:
      //     sha256(...|rule_id|message_id_OR_call_id)
      //   dedupe pair:
      //     sha256('dedupe-candidate|'||sort(account_a,account_b).join('|')
      //            ||'|'||rule_id||'|'||rule_version)
      // Same key reappearing on a later scan = ON CONFLICT DO NOTHING; the
      // existing row (incl. its `rejected` status if any) stays authoritative.
      t.text('idempotency_key').notNullable().unique();

      t.timestamps(true, true);

      // Queue read paths.
      t.index(['status', 'tier', 'created_at'], 'data_hygiene_proposals_queue_idx');
      // Per-resource panel.
      t.index(['resource_type', 'resource_id'], 'data_hygiene_proposals_resource_idx');
      // Per-customer/account grouping (UI groups proposals by scope).
      t.index(['scope_type', 'scope_id'], 'data_hygiene_proposals_scope_idx');
      // Run-back-reference for ops triage.
      t.index(['run_id'], 'data_hygiene_proposals_run_idx');
      // Rule analytics + dry-run rejection-rate measurement.
      t.index(['rule_id', 'status'], 'data_hygiene_proposals_rule_idx');
    });

    // Enum-shape CHECK constraints. Postgres enums would lock these in too
    // tightly for early iteration; CHECKs can be dropped and recreated in a
    // single migration.
    await knex.raw(`
      ALTER TABLE data_hygiene_proposals
        ADD CONSTRAINT data_hygiene_proposals_resource_type_check
        CHECK (resource_type IN ('customer','customer_account','property_preferences','conversation','call_log'))
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_proposals
        ADD CONSTRAINT data_hygiene_proposals_scope_type_check
        CHECK (scope_type IN ('customer','customer_account'))
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_proposals
        ADD CONSTRAINT data_hygiene_proposals_source_check
        CHECK (source IN (
          'normalization','cross-record-backfill','conversation-link','call-link',
          'call-ai-extraction-import','message-extraction','call-extraction',
          'email-local-part','dedupe-candidate'
        ))
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_proposals
        ADD CONSTRAINT data_hygiene_proposals_tier_check
        CHECK (tier IN ('auto','high','medium','low'))
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_proposals
        ADD CONSTRAINT data_hygiene_proposals_status_check
        CHECK (status IN ('pending','auto_applied','approved','rejected','superseded','stale'))
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_proposals
        ADD CONSTRAINT data_hygiene_proposals_reject_reason_check
        CHECK (reject_reason IS NULL OR reject_reason IN ('wrong_person','wrong_property','outdated','bad_parse','noise','other'))
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_proposals
        ADD CONSTRAINT data_hygiene_proposals_reviewed_via_check
        CHECK (reviewed_via IS NULL OR reviewed_via IN ('ui','api','auto'))
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_proposals
        ADD CONSTRAINT data_hygiene_proposals_confidence_range_check
        CHECK (confidence >= 0 AND confidence <= 1)
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_proposals
        ADD CONSTRAINT data_hygiene_proposals_resource_id_presence_check
        CHECK (
          resource_id IS NOT NULL
          OR (
            resource_type = 'property_preferences'
            AND field IN (
              'neighborhood_gate_code','property_gate_code','garage_code',
              'lockbox_code','parking_notes','access_notes','pet_details'
            )
          )
        )
    `);
  }

  // -----------------------------------------------------------------
  // 3. data_hygiene_source_extractions — LLM dedupe (P5).
  // -----------------------------------------------------------------
  if (!(await knex.schema.hasTable('data_hygiene_source_extractions'))) {
    await knex.schema.createTable('data_hygiene_source_extractions', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      // What was processed.
      t.string('source_type', 16).notNullable();
      //  call_log | message
      t.uuid('source_id').notNullable();

      // Which prompt/schema version did the work. Bump this in code to force
      // re-processing of every prior row.
      t.string('extractor_version', 32).notNullable();

      // Hash of the source body the extractor saw. If the underlying
      // transcription/body gets corrected later, the hash changes and Phase 4
      // re-processes naturally.
      t.string('source_hash', 64).notNullable();

      // Outcome. parse_error and failed get retried up to attempt_count=3;
      // failed_max_retries is terminal until extractor_version/source_hash
      // changes. ok and no_fields are skipped on the next tick.
      t.string('status', 24).notNullable();
      //  ok | parse_error | no_fields | failed | failed_max_retries
      t.integer('proposal_count').notNullable().defaultTo(0);
      t.integer('attempt_count').notNullable().defaultTo(1);
      t.text('error_message');
      t.timestamp('last_attempted_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('processed_at').notNullable().defaultTo(knex.fn.now());

      t.unique(
        ['source_type', 'source_id', 'extractor_version', 'source_hash'],
        { indexName: 'data_hygiene_source_extractions_uniq' }
      );
      t.index(['source_type', 'source_id'], 'data_hygiene_source_extractions_source_idx');
    });

    await knex.raw(`
      ALTER TABLE data_hygiene_source_extractions
        ADD CONSTRAINT data_hygiene_source_extractions_source_type_check
        CHECK (source_type IN ('call_log','message'))
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_source_extractions
        ADD CONSTRAINT data_hygiene_source_extractions_status_check
        CHECK (status IN ('ok','parse_error','no_fields','failed','failed_max_retries'))
    `);
    await knex.raw(`
      ALTER TABLE data_hygiene_source_extractions
        ADD CONSTRAINT data_hygiene_source_extractions_attempt_count_check
        CHECK (attempt_count >= 1)
    `);
  }

  // -----------------------------------------------------------------
  // 4. data_hygiene_sensitive_vault — encrypted raw sensitive values.
  // -----------------------------------------------------------------
  if (!(await knex.schema.hasTable('data_hygiene_sensitive_vault'))) {
    await knex.schema.createTable('data_hygiene_sensitive_vault', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('proposal_id')
        .notNullable()
        .references('id')
        .inTable('data_hygiene_proposals')
        .onDelete('CASCADE');

      // Set by the apply handler once the critical audit_log row exists.
      // Kept nullable so the vault row can be staged inside the same apply
      // transaction before audit insertion returns.
      t.uuid('audit_log_id');

      t.string('field', 64).notNullable();
      t.binary('before_encrypted');
      t.binary('after_encrypted');
      t.string('before_hash', 64).notNullable();
      t.string('after_hash', 64).notNullable();
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

      t.unique(['proposal_id', 'field'], { indexName: 'data_hygiene_sensitive_vault_unique_field' });
      t.index(['proposal_id'], 'data_hygiene_sensitive_vault_proposal_idx');
      t.index(['audit_log_id'], 'data_hygiene_sensitive_vault_audit_idx');
    });
  }
};

exports.down = async function down(knex) {
  // Drop in reverse FK order. Vault FKs to proposals; proposals FK to runs.
  if (await knex.schema.hasTable('data_hygiene_sensitive_vault')) {
    await knex.schema.dropTable('data_hygiene_sensitive_vault');
  }
  if (await knex.schema.hasTable('data_hygiene_source_extractions')) {
    await knex.schema.dropTable('data_hygiene_source_extractions');
  }
  if (await knex.schema.hasTable('data_hygiene_proposals')) {
    await knex.schema.dropTable('data_hygiene_proposals');
  }
  if (await knex.schema.hasTable('data_hygiene_runs')) {
    // Partial unique index drops with the table.
    await knex.schema.dropTable('data_hygiene_runs');
  }
};
