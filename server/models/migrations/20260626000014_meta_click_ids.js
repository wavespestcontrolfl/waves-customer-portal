/**
 * Meta click identifiers — fbclid (Meta's gclid analog) plus the _fbc / _fbp
 * browser cookies — on leads + ad_service_attribution, so Meta web leads can be
 * attributed in the PPC funnel and fed back via the Conversions API (Phase 3).
 * Mirrors 20260613000030 (gbraid/wbraid). Idempotent; existing rows stay NULL.
 */
exports.up = async function up(knex) {
  const addMetaIds = async (tableName) => {
    if (!(await knex.schema.hasTable(tableName))) return;
    const hasFbclid = await knex.schema.hasColumn(tableName, 'fbclid');
    const hasFbc = await knex.schema.hasColumn(tableName, 'fbc');
    const hasFbp = await knex.schema.hasColumn(tableName, 'fbp');
    await knex.schema.alterTable(tableName, (t) => {
      if (!hasFbclid) t.string('fbclid', 255);
      if (!hasFbc) t.string('fbc', 255);
      if (!hasFbp) t.string('fbp', 255);
    });
  };
  await addMetaIds('leads');
  await addMetaIds('ad_service_attribution');
};

exports.down = async function down(knex) {
  const dropMetaIds = async (tableName) => {
    if (!(await knex.schema.hasTable(tableName))) return;
    const hasFbclid = await knex.schema.hasColumn(tableName, 'fbclid');
    const hasFbc = await knex.schema.hasColumn(tableName, 'fbc');
    const hasFbp = await knex.schema.hasColumn(tableName, 'fbp');
    await knex.schema.alterTable(tableName, (t) => {
      if (hasFbclid) t.dropColumn('fbclid');
      if (hasFbc) t.dropColumn('fbc');
      if (hasFbp) t.dropColumn('fbp');
    });
  };
  await dropMetaIds('ad_service_attribution');
  await dropMetaIds('leads');
};
