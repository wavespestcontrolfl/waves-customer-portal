'use strict';
// PR #5119 Codex r4: a patch proposal is a fix FOR the prompt version whose
// evidence produced it. Stored so the proposer's per-cell watermark is
// version-specific (a v11 proposal never hides v12 evidence) and the card
// says which version it targets. Existing rows stay NULL (pre-versioned).
exports.up = async (knex) => {
  await knex.schema.alterTable('sms_patch_proposals', (t) => {
    t.string('prompt_version', 40);
    t.index(['surface', 'failure_mode', 'prompt_version'], 'sms_patch_proposals_cell_version_idx');
  });
};
exports.down = async (knex) => {
  await knex.schema.alterTable('sms_patch_proposals', (t) => {
    t.dropIndex(['surface', 'failure_mode', 'prompt_version'], 'sms_patch_proposals_cell_version_idx');
    t.dropColumn('prompt_version');
  });
};
