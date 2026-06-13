exports.up = async function (knex) {
  const addClickIdColumns = async (tableName) => {
    const hasTable = await knex.schema.hasTable(tableName);
    if (!hasTable) return;

    const hasWbraid = await knex.schema.hasColumn(tableName, 'wbraid');
    const hasGbraid = await knex.schema.hasColumn(tableName, 'gbraid');
    await knex.schema.alterTable(tableName, (t) => {
      if (!hasWbraid) t.string('wbraid', 200);
      if (!hasGbraid) t.string('gbraid', 200);
    });
  };

  await addClickIdColumns('leads');
  await addClickIdColumns('ad_service_attribution');
};

exports.down = async function (knex) {
  const dropClickIdColumns = async (tableName) => {
    const hasTable = await knex.schema.hasTable(tableName);
    if (!hasTable) return;

    const hasWbraid = await knex.schema.hasColumn(tableName, 'wbraid');
    const hasGbraid = await knex.schema.hasColumn(tableName, 'gbraid');
    await knex.schema.alterTable(tableName, (t) => {
      if (hasWbraid) t.dropColumn('wbraid');
      if (hasGbraid) t.dropColumn('gbraid');
    });
  };

  await dropClickIdColumns('ad_service_attribution');
  await dropClickIdColumns('leads');
};
