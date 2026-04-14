exports.up = async function (knex) {
  await knex('technicians')
    .whereIn('name', ['Waves', 'Carlos R.'])
    .update({ active: false });
};

exports.down = async function (knex) {
  await knex('technicians')
    .whereIn('name', ['Waves', 'Carlos R.'])
    .update({ active: true });
};
