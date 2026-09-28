'use strict';
// PR #5119 Codex r5: 20260928040000 added sms_patch_proposals.prompt_version
// as a nullable column, and the proposer's per-cell watermark now matches
// only proposals for the LIVE prompt version. Every proposal written before
// that column existed was produced while house_voice_v11 was the only live
// drafter prompt, so without this backfill the first proposer run would
// treat all historical v11 evidence as fresh again and supersede pending
// review cards with duplicates. Rows written after the column exists always
// carry their version, so only NULLs are touched.
const LEGACY_PROMPT_VERSION = 'house_voice_v11';

exports.up = async (knex) => {
  await knex('sms_patch_proposals').whereNull('prompt_version').update({ prompt_version: LEGACY_PROMPT_VERSION });
};

// Irreversible by design: after the backfill a legacy row is
// indistinguishable from a genuine v11 proposal, and nulling both would
// reopen the duplicate-proposal window this migration closes.
exports.down = async () => {};
