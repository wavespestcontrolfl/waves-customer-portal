/**
 * Migration — persist WHY a codex_remediation_state row parked, and at which
 * PR head.
 *
 * park() previously recorded only status='parked'; the reason went to logs
 * (short retention) and was unrecoverable afterwards — three autonomous blog
 * PRs (astro #362/#364/#365) sat parked at rounds=0 with no way to tell which
 * gate parked them. parked_head_sha additionally lets the loop re-arm itself
 * when the PR branch receives a NEW head after the park (a human or agent
 * pushed a fix): a park is a verdict on a specific head, not on the PR.
 *
 *   park_reason      — the park() reason string (truncated to 1000 chars)
 *   parked_head_sha  — PR head sha the park verdict applied to; NULL on
 *                      legacy rows (parked before this column existed), which
 *                      the loop treats as re-armable once.
 */

exports.up = async function up(knex) {
  const has = await knex.schema.hasTable('codex_remediation_state');
  if (!has) return;
  if (!(await knex.schema.hasColumn('codex_remediation_state', 'park_reason'))) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.text('park_reason');
    });
  }
  if (!(await knex.schema.hasColumn('codex_remediation_state', 'parked_head_sha'))) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.string('parked_head_sha', 64);
    });
  }
};

exports.down = async function down(knex) {
  const has = await knex.schema.hasTable('codex_remediation_state');
  if (!has) return;
  if (await knex.schema.hasColumn('codex_remediation_state', 'parked_head_sha')) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.dropColumn('parked_head_sha');
    });
  }
  if (await knex.schema.hasColumn('codex_remediation_state', 'park_reason')) {
    await knex.schema.alterTable('codex_remediation_state', (t) => {
      t.dropColumn('park_reason');
    });
  }
};
