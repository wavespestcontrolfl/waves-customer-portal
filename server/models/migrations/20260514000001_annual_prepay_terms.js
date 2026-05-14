exports.up = async function up(knex) {
  const hasTerms = await knex.schema.hasTable('annual_prepay_terms');
  if (!hasTerms) {
    await knex.schema.createTable('annual_prepay_terms', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.uuid('source_estimate_id').nullable().references('id').inTable('estimates').onDelete('SET NULL');
      t.uuid('prepay_invoice_id').nullable().references('id').inTable('invoices').onDelete('SET NULL');
      t.string('plan_label', 120);
      t.decimal('monthly_rate', 10, 2);
      t.decimal('prepay_amount', 10, 2);
      t.date('term_start').notNullable();
      t.date('term_end').notNullable();
      t.string('status', 30).notNullable().defaultTo('payment_pending');
      t.uuid('last_scheduled_service_id').nullable().references('id').inTable('scheduled_services').onDelete('SET NULL');
      t.date('last_scheduled_service_date');
      t.timestamp('notice_30_sent_at', { useTz: true });
      t.timestamp('notice_15_sent_at', { useTz: true });
      t.timestamp('notice_7_sent_at', { useTz: true });
      t.timestamp('notice_30_claimed_at', { useTz: true });
      t.timestamp('notice_15_claimed_at', { useTz: true });
      t.timestamp('notice_7_claimed_at', { useTz: true });
      t.timestamp('renewal_contacted_at', { useTz: true });
      t.uuid('renewal_contacted_by');
      t.string('renewal_decision', 30);
      t.timestamp('renewal_decision_at', { useTz: true });
      t.uuid('renewal_decision_by');
      t.text('renewal_notes');
      t.timestamps(true, true);

      t.index(['customer_id', 'status'], 'idx_annual_prepay_terms_customer_status');
      t.index(['term_end', 'status'], 'idx_annual_prepay_terms_term_end');
      t.index(['last_scheduled_service_date', 'status'], 'idx_annual_prepay_terms_last_service');
      t.unique(['source_estimate_id'], 'annual_prepay_terms_source_estimate_unique');
      t.unique(['prepay_invoice_id'], 'annual_prepay_terms_invoice_unique');
    });
  }

  if (await knex.schema.hasTable('annual_prepay_terms')) {
    const noticeClaimColumns = ['notice_30_claimed_at', 'notice_15_claimed_at', 'notice_7_claimed_at'];
    for (const col of noticeClaimColumns) {
      if (!(await knex.schema.hasColumn('annual_prepay_terms', col))) {
        await knex.schema.alterTable('annual_prepay_terms', (t) => {
          t.timestamp(col, { useTz: true });
        });
      }
    }
  }

  if (await knex.schema.hasTable('scheduled_services')) {
    const hasScheduledTerm = await knex.schema.hasColumn('scheduled_services', 'annual_prepay_term_id');
    if (!hasScheduledTerm) {
      await knex.schema.alterTable('scheduled_services', (t) => {
        t.uuid('annual_prepay_term_id').nullable().references('id').inTable('annual_prepay_terms').onDelete('SET NULL');
        t.index(['annual_prepay_term_id'], 'idx_scheduled_services_annual_prepay_term');
      });
    }
  }

  if (await knex.schema.hasTable('invoices')) {
    const hasInvoiceTerm = await knex.schema.hasColumn('invoices', 'annual_prepay_term_id');
    if (!hasInvoiceTerm) {
      await knex.schema.alterTable('invoices', (t) => {
        t.uuid('annual_prepay_term_id').nullable().references('id').inTable('annual_prepay_terms').onDelete('SET NULL');
        t.index(['annual_prepay_term_id'], 'idx_invoices_annual_prepay_term');
      });
    }
  }

  if (await knex.schema.hasTable('sms_templates')) {
    const cols = await knex('sms_templates').columnInfo();
    const now = new Date();
    const template = {
      template_key: 'annual_prepay_renewal_reminder',
      name: 'Annual Prepay Renewal Reminder',
      category: 'retention',
      body: 'Hello {first_name}! Your annual prepaid Waves plan is coming up for renewal on {term_end}.{last_service_sentence}\n\nReply RENEW, LAPSE, or CHANGE and our team will help with the next step. Questions or requests? Reply to this message.',
      variables: JSON.stringify(['first_name', 'term_end', 'last_service_sentence']),
      ...(cols.is_active ? { is_active: true } : {}),
      ...(cols.sort_order ? { sort_order: 50 } : {}),
      ...(cols.updated_at ? { updated_at: now } : {}),
      ...(cols.created_at ? { created_at: now } : {}),
    };

    const existing = await knex('sms_templates').where({ template_key: template.template_key }).first();
    if (existing) {
      await knex('sms_templates').where({ template_key: template.template_key }).update({
        name: template.name,
        category: template.category,
        body: template.body,
        variables: template.variables,
        ...(cols.is_active ? { is_active: true } : {}),
        ...(cols.updated_at ? { updated_at: now } : {}),
      });
    } else {
      await knex('sms_templates').insert(template);
    }
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('sms_templates')) {
    await knex('sms_templates').where({ template_key: 'annual_prepay_renewal_reminder' }).del();
  }

  if (await knex.schema.hasTable('invoices')) {
    const hasInvoiceTerm = await knex.schema.hasColumn('invoices', 'annual_prepay_term_id');
    if (hasInvoiceTerm) {
      await knex.schema.alterTable('invoices', (t) => {
        t.dropColumn('annual_prepay_term_id');
      });
    }
  }

  if (await knex.schema.hasTable('scheduled_services')) {
    const hasScheduledTerm = await knex.schema.hasColumn('scheduled_services', 'annual_prepay_term_id');
    if (hasScheduledTerm) {
      await knex.schema.alterTable('scheduled_services', (t) => {
        t.dropColumn('annual_prepay_term_id');
      });
    }
  }

  await knex.schema.dropTableIfExists('annual_prepay_terms');
};
