// Retire 4x/quarterly tree & shrub (owner directive 2026-09-24), follow-up to
// 20260924020000 / 20260924020010 (both already pushed, so frozen):
//   1. Record the tier retirement in pricing_changelog (POLICY.md: cadence
//      changes need a changelog entry), idempotently.
//   2. Purge the already-indexed tree_shrub_quarterly service chunk from
//      knowledge_embeddings so agent search stops returning it before the
//      next nightly sync (the connector now skips the row).
// down() is a no-op: the changelog row is history and the index repopulates
// only from the connector, which now excludes the retired row.

const CHANGELOG_IDENTITY = {
  version_from: 'v4.7',
  version_to: 'v4.7',
  changed_by: 'claude-2026-09-24',
  category: 'rule',
  summary: 'Retire the 4x/quarterly (Light) residential tree & shrub tier for new sales; 6x and 9x unaffected.',
};

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pricing_changelog')) {
    const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
    if (!existing) {
      await knex('pricing_changelog').insert({
        ...CHANGELOG_IDENTITY,
        affected_services: JSON.stringify(['tree_shrub']),
        before_value: JSON.stringify({ TREE_SHRUB: { tiers: { light: { hidden: false } } }, services: { tree_shrub_quarterly: { public_quote_selectable: true, booking_enabled: true } } }),
        after_value: JSON.stringify({ TREE_SHRUB: { tiers: { light: { hidden: true } } }, services: { tree_shrub_quarterly: { public_quote_selectable: false, booking_enabled: false } } }),
        rationale: 'Owner directive 2026-09-24: "remove quarterly tree and shrub care from the estimates, and services, any where we mention it, like we did with bi-monthly lawn." The 4-application/yr Light tier is hidden from every offering surface; its constants stay only to replay the one grandfathered quarterly plan. 6x Standard (default) and 9x Enhanced (upsell) prices are unchanged; the published tree & shrub range low rises from the Light floor to the Standard-derived minimum. Outstanding estimates that still quote 4x requote through the retired-cadence gate.',
      });
    }
  }
  if (await knex.schema.hasTable('knowledge_embeddings')) {
    await knex('knowledge_embeddings').where({ source: 'service', source_id: 'tree_shrub_quarterly' }).del();
  }
};

exports.down = async function down() {};

exports._internals = { CHANGELOG_IDENTITY };
