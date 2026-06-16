const RETIRED_KEYS = [
  ['lead', 'auto', 'reply', 'after', 'hours'],
  ['lead', 'service', 'lawn'],
  ['lead', 'service', 'one', 'time'],
  ['lead', 'address', 'needed'],
  ['lead', 'safe', 'ack'],
  ['estimate', 'accepted', 'office'],
  ['admin', 'new', 'lead'],
  ['autopay', 'authorization', 'request'],
  ['autopay', 'authorization', 'cancelled'],
  ['auto', 'renewal', '30', '60', 'day', 'notice'],
].map((parts) => parts.join('_'));

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  await knex('sms_templates')
    .whereIn('template_key', RETIRED_KEYS)
    .del();
};

exports.down = async function () {
  // Retired SMS copy; rollback should not recreate deleted templates.
};

exports.RETIRED_KEYS = RETIRED_KEYS;
