/**
 * ai_fix_proposals — one row per proposed fix for a recurring AI mistake, any
 * area (correction-loop scope 2026-10-02 piece 2, owner ruling Q5: general
 * tables from day one). It answers "which mistake did we fix, where did the
 * fix go, and when did it ship" by holding the PR, the reviewed commit, the
 * replay runs and the shipped version on the proposal itself.
 *
 *   - Cell = (area, surface, failure_mode); `prompt_version` = the version the
 *     evidence was produced under.
 *   - `incident_keys` are the distinct ai_incidents.incident_key values behind
 *     `evidence_count`; `dev_incident_keys` / `holdout_incident_keys` are the
 *     split, fixed at proposal time (a dev case is never shown as proof).
 *   - partial UNIQUE (area, surface, failure_mode) WHERE status IN
 *     (pending, accepted, pr_open): one open fix per cell, so two weekly runs
 *     can never open competing fixes.
 *   - `supersedes`: the proposal this one replaced (new evidence on a pending
 *     proposal, or a carry-forward after a version bump).
 *   - `history`: append-only list of status changes and stamps
 *     ({ at, by, from, to, fields }).
 *
 * Status: pending → accepted | pr_open | dismissed | superseded |
 * insufficient_evidence; accepted → pr_open | …; pr_open → shipped | accepted
 * | dismissed; shipped → reverted. The legal moves live in
 * services/ai-incidents/fix-proposals.js. `dev_run_id` / `holdout_run_id`
 * carry no foreign key: the replay-run tables arrive with the runner.
 *
 * Nothing reads this table at runtime. Same internal-ops posture as
 * ai_incidents; deliberately NOT granted to the read-only chart role.
 */

const STATUSES = ['pending', 'accepted', 'pr_open', 'shipped', 'reverted', 'dismissed', 'superseded', 'insufficient_evidence'];
const FIX_KINDS = ['facts', 'prompt', 'tool', 'verifier'];
const OPEN_STATUSES = ['pending', 'accepted', 'pr_open'];

exports.STATUSES = STATUSES;
exports.FIX_KINDS = FIX_KINDS;
exports.OPEN_STATUSES = OPEN_STATUSES;

const list = (values) => values.map((v) => `'${v}'`).join(', ');

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('ai_fix_proposals')) return;
  await knex.schema.createTable('ai_fix_proposals', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('area', 30).notNullable();
    t.string('surface', 40).notNullable();
    t.string('failure_mode', 60).notNullable();
    t.string('fix_kind', 20).notNullable();
    t.string('prompt_version', 40);
    t.string('status', 30).notNullable().defaultTo('pending');
    t.integer('evidence_count').notNullable();
    t.jsonb('incident_keys').notNullable().defaultTo('[]');
    t.jsonb('dev_incident_keys').notNullable().defaultTo('[]');
    t.jsonb('holdout_incident_keys').notNullable().defaultTo('[]');
    // The window the evidence was read through: the next run counts only
    // incidents adjudicated after this instant.
    t.timestamp('evidence_cutoff_at').notNullable();
    t.text('proposal').notNullable();
    t.uuid('supersedes').references('id').inTable('ai_fix_proposals').onDelete('SET NULL');
    t.integer('pr_number');
    t.string('pr_url', 300);
    t.string('reviewed_commit', 64);
    t.uuid('dev_run_id');
    t.uuid('holdout_run_id');
    t.string('shipped_version', 60);
    t.timestamp('shipped_at');
    t.integer('revert_pr_number');
    t.timestamp('reverted_at');
    t.jsonb('history').notNullable().defaultTo('[]');
    t.string('schema_version', 40).notNullable().defaultTo('ai-fix-proposals.v1');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    t.index(['area', 'surface', 'failure_mode', 'prompt_version'], 'ai_fix_proposals_cell_idx');
    t.index(['area', 'status'], 'ai_fix_proposals_status_idx');
  });
  await knex.raw(`ALTER TABLE ai_fix_proposals ADD CONSTRAINT ai_fix_proposals_status_check CHECK (status IN (${list(STATUSES)}))`);
  await knex.raw(`ALTER TABLE ai_fix_proposals ADD CONSTRAINT ai_fix_proposals_fix_kind_check CHECK (fix_kind IN (${list(FIX_KINDS)}))`);
  // A status implies its stamps: no PR-open row without a PR, no shipped row
  // without the version and the Codex-clean commit, no reverted row without
  // the time it was reverted.
  await knex.raw(`
    ALTER TABLE ai_fix_proposals ADD CONSTRAINT ai_fix_proposals_stamps_check CHECK (
      (status NOT IN ('pr_open', 'shipped', 'reverted') OR pr_number IS NOT NULL)
      AND (status NOT IN ('shipped', 'reverted') OR (shipped_version IS NOT NULL AND shipped_at IS NOT NULL AND reviewed_commit IS NOT NULL))
      AND (status <> 'reverted' OR reverted_at IS NOT NULL)
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX ai_fix_proposals_one_open_per_cell
      ON ai_fix_proposals (area, surface, failure_mode)
      WHERE status IN (${list(OPEN_STATUSES)})
  `);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('ai_fix_proposals');
};
