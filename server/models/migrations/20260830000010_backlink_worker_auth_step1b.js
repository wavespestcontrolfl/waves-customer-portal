/**
 * Backlink registry step 1b — worker-auth audit + plan-delta columns.
 *
 * Plan of record: docs/design/backlink-manager-plan.md (§3.4c, §12, §14 step 1/1b).
 * EXPAND only — no drops, no data rewrites:
 *   - seo_link_worker_nonces: insert-first replay protection for per-provider
 *     HMAC request signing (PRIMARY KEY (key_id, nonce); signed_ts persisted so
 *     the sweep runs on the SIGNED timestamp, never seen_at).
 *   - seo_link_worker_requests: one row per ACCEPTED claim/report
 *     authentication (empty claims included) — the durable evidence for the
 *     §14 step-1b bearer retirement (7 days of zero auth_scheme='bearer' rows
 *     across EVERY hermesAuth-successor mount, vendor routes included).
 *   - seo_link_acquisition_paths.execution_after_send (§3.2): investigator-set
 *     action ordering for execution-bearing outreach paths; default true.
 *   - seo_link_prospects.conversation_closed_at (§3.3): durable outreach
 *     conversation closure; consumed by the step-4 recipient guard (dark here).
 */

const AUTH_SCHEMES = ['hmac', 'bearer'];
const ENDPOINTS = ['claim', 'report', 'vendor_price', 'vendor_login'];
const RESULTS = ['authenticated', 'empty_claim', 'leased', 'report_accepted', 'report_rejected'];

const check = (table, name, expr) =>
  `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr})`;
const inSet = (col, values) => `${col} IN (${values.map((v) => `'${v}'`).join(', ')})`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('seo_link_worker_nonces'))) {
    await knex.schema.createTable('seo_link_worker_nonces', (t) => {
      t.string('key_id').notNullable();
      t.string('nonce', 128).notNullable();
      t.timestamp('signed_ts').notNullable();
      t.timestamp('seen_at').notNullable().defaultTo(knex.fn.now());
      t.primary(['key_id', 'nonce']);
    });
    await knex.raw('CREATE INDEX IF NOT EXISTS seo_link_worker_nonces_signed_ts_idx ON seo_link_worker_nonces (signed_ts)');
  }

  if (!(await knex.schema.hasTable('seo_link_worker_requests'))) {
    await knex.schema.createTable('seo_link_worker_requests', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('key_id').notNullable();
      t.string('provider').notNullable();
      t.string('auth_scheme').notNullable();
      t.string('method').notNullable();
      t.text('path').notNullable();
      t.jsonb('query');
      t.string('endpoint').notNullable();
      t.string('result').notNullable().defaultTo('authenticated');
      t.uuid('prospect_id');
      t.uuid('attempt_id');
      t.text('nonce');
      t.timestamp('received_at').notNullable().defaultTo(knex.fn.now());
      t.index(['auth_scheme', 'received_at']);
      t.index(['provider', 'received_at']);
    });
    await knex.raw(check('seo_link_worker_requests', 'seo_link_worker_requests_auth_scheme_check', inSet('auth_scheme', AUTH_SCHEMES)));
    await knex.raw(check('seo_link_worker_requests', 'seo_link_worker_requests_endpoint_check', inSet('endpoint', ENDPOINTS)));
    await knex.raw(check('seo_link_worker_requests', 'seo_link_worker_requests_result_check', inSet('result', RESULTS)));
  }

  if (await knex.schema.hasTable('seo_link_acquisition_paths')) {
    if (!(await knex.schema.hasColumn('seo_link_acquisition_paths', 'execution_after_send'))) {
      await knex.schema.alterTable('seo_link_acquisition_paths', (t) => {
        t.boolean('execution_after_send').notNullable().defaultTo(true);
      });
    }
  }

  if (await knex.schema.hasTable('seo_link_prospects')) {
    if (!(await knex.schema.hasColumn('seo_link_prospects', 'conversation_closed_at'))) {
      await knex.schema.alterTable('seo_link_prospects', (t) => {
        t.timestamp('conversation_closed_at');
      });
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('seo_link_prospects')) {
    if (await knex.schema.hasColumn('seo_link_prospects', 'conversation_closed_at')) {
      await knex.schema.alterTable('seo_link_prospects', (t) => t.dropColumn('conversation_closed_at'));
    }
  }
  if (await knex.schema.hasTable('seo_link_acquisition_paths')) {
    if (await knex.schema.hasColumn('seo_link_acquisition_paths', 'execution_after_send')) {
      await knex.schema.alterTable('seo_link_acquisition_paths', (t) => t.dropColumn('execution_after_send'));
    }
  }
  await knex.schema.dropTableIfExists('seo_link_worker_requests');
  await knex.schema.dropTableIfExists('seo_link_worker_nonces');
};
