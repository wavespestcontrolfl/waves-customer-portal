/**
 * Add create_invoice_on_complete flag to scheduled_services and
 * seed a combined "service report + invoice pay link" SMS template.
 */

exports.up = async function (knex) {
  const hasCol = await knex.schema.hasColumn('scheduled_services', 'create_invoice_on_complete');
  if (!hasCol) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.boolean('create_invoice_on_complete').defaultTo(false);
    });
  }

  // Seed / upsert the combined SMS template
  const hasTable = await knex.schema.hasTable('sms_templates');
  if (hasTable) {
    const existing = await knex('sms_templates')
      .where({ template_key: 'service_complete_with_invoice' }).first();
    const row = {
      template_key: 'service_complete_with_invoice',
      name: 'Service Complete + Invoice',
      category: 'service',
      body:
        'Hello {first_name}! Your {service_type} service report is ready: {portal_url}\n\n' +
        'Invoice for today\'s visit: {pay_url}\n\n' +
        'Questions or requests? Reply to this message. Thank you for choosing Waves!',
      variables: JSON.stringify(['first_name', 'service_type', 'portal_url', 'pay_url']),
      sort_order: 5,
    };
    if (existing) {
      await knex('sms_templates').where({ id: existing.id }).update(row);
    } else {
      await knex('sms_templates').insert(row);
    }
  }
};

exports.down = async function (knex) {
  const hasCol = await knex.schema.hasColumn('scheduled_services', 'create_invoice_on_complete');
  if (hasCol) {
    await knex.schema.alterTable('scheduled_services', (t) => {
      t.dropColumn('create_invoice_on_complete');
    });
  }
  const hasTable = await knex.schema.hasTable('sms_templates');
  if (hasTable) {
    await knex('sms_templates').where({ template_key: 'service_complete_with_invoice' }).del();
  }
};
