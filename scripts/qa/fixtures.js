'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { v5 } = require('uuid');
const { etDateString, addETDays, etParts, deriveWindowEnd } = require('../../server/utils/datetime-et');
const { createScheduledService } = require('../../server/services/booking/create-scheduled-service');

// MUTATES only the dedicated dev database supplied by the managed launcher.
// Fixture IDs are deterministic within a run. No production data is copied.
function fixtureDates(now, daysOff = [0, 6], blackouts = new Set()) {
  const dates = [];
  for (let offset = 14; offset <= 45 && dates.length < 2; offset++) {
    const candidate = addETDays(now, offset);
    const date = etDateString(candidate);
    if (!daysOff.includes(etParts(candidate).dayOfWeek) && !blackouts.has(date)) dates.push(date);
  }
  if (dates.length < 2) throw new Error('QA needs two open scheduling dates within the next 45 days.');
  return { date: dates[0], nextDate: dates[1] };
}

function fixtureIdentity(runId = crypto.randomUUID()) {
  const id = (name) => v5(name, runId);
  const suffix = runId.slice(0, 8);
  return { runId, customerId: id('customer'), adminId: id('admin'), technicianId: id('technician'),
    estimateId: id('estimate'), appointmentId: id('appointment'), invoiceId: id('invoice'),
    productId: id('product'), productName: `QA material ${suffix}`, conflictId: id('conflict'), siblingCustomerId: id('sibling-customer'), foreignCustomerId: id('foreign-customer'),
    otherTechnicianId: id('other-technician'), siblingAppointmentId: id('sibling-appointment'), foreignAppointmentId: id('foreign-appointment'),
    foreignRecordId: id('foreign-record'), foreignDocumentId: id('foreign-document'),
    token: crypto.randomBytes(32).toString('hex'), invoiceToken: crypto.randomBytes(32).toString('hex'),
    password: crypto.randomBytes(24).toString('base64url'),
    adminEmail: `qa-admin-${suffix}@example.invalid`, techEmail: `qa-tech-${suffix}@example.invalid`,
    customerEmail: `qa-customer-${suffix}@example.invalid`, otherTechEmail: `qa-other-tech-${suffix}@example.invalid`,
    siblingEmail: `qa-sibling-${suffix}@example.invalid`, foreignEmail: `qa-foreign-${suffix}@example.invalid`,
    phone: `+194155501${String(parseInt(suffix, 16) % 100).padStart(2, '0')}`,
    foreignPhone: `+194155501${String((parseInt(suffix, 16) + 50) % 100).padStart(2, '0')}`,
    ...fixtureDates(new Date()),
    paymentIntentId: `pi_qa_${suffix}`, eventId: `evt_qa_${suffix}`,
    // Saved-card charge journey: its own open invoice, so the webhook journey's invoice stays untouched.
    cardInvoiceId: id('card-invoice'), cardInvoiceToken: crypto.randomBytes(32).toString('hex'),
    cardInvoiceNumber: `QA-CARD-${suffix.toUpperCase()}`, cardInvoiceSubtotal: 149.37, cardPaymentMethodId: id('card-payment-method'),
    stripeCustomerId: `cus_qa_${suffix}`, stripePaymentMethodId: `pm_qa_${suffix}`, cardBrand: 'visa', cardLastFour: '4242',
    cardEventId: `evt_qa_card_${suffix}`,
    // Prepay-at-booking journey: its own recurring estimate, so the one-time estimate above stays untouched.
    prepayEstimateId: id('prepay-estimate'), prepayToken: crypto.randomBytes(32).toString('hex'),
    prepayConsentId: id('prepay-consent'), prepayAppointmentId: id('prepay-appointment'), prepayEventId: `evt_qa_prepay_${suffix}`,
    // Reminder and completion-text journeys: each books its own visit for the fixture customer.
    reminderAppointmentId: id('reminder-appointment'), completionTextAppointmentId: id('completion-text-appointment'),
    // Refund journey: its signed Stripe events (a2 is a second event about the first refund).
    refundEventIds: ['a', 'a2', 'b'].map((part) => `evt_qa_refund_${part}_${suffix}`) };
}

async function seed(db, f) {
  // Read the scheduling calendar through the explicitly selected QA
  // connection. Importing blackout-dates here would initialize its global DB.
  const weekly = await db('system_settings').where({ key: 'schedule_weekly_days_off' }).first('value');
  const daysOff = JSON.parse(weekly?.value || '[0,6]').map(Number);
  const blackouts = await db('schedule_blackout_dates').select(db.raw('date::text AS date'));
  Object.assign(f, fixtureDates(new Date(), daysOff, new Set(blackouts.map((row) => row.date))));
  const passwordHash = await bcrypt.hash(f.password, 12);
  await db.transaction(async (trx) => {
    const existing = await trx('customers').where({ phone: f.phone }).first('id');
    if (existing && existing.id !== f.customerId) throw new Error('Fixture phone already in use; use a fresh run or clean up the previous fixtures.');
    await trx('customer_accounts').insert([
      { id: f.customerId, first_name: 'QA', email: f.customerEmail, phone: f.phone },
      { id: f.foreignCustomerId, first_name: 'QA', email: f.foreignEmail },
    ]).onConflict('id').ignore();
    await trx('technicians').insert([
      { id: f.otherTechnicianId, name: 'QA Other Technician', email: f.otherTechEmail, role: 'technician', active: true, employment_status: 'active', field_dispatchable: true, password_hash: passwordHash, auth_token_version: 1, must_change_password: false },
      { id: f.adminId, name: 'QA Admin', email: f.adminEmail, role: 'admin', active: true, employment_status: 'active', field_dispatchable: false, password_hash: passwordHash, auth_token_version: 1, must_change_password: false },
      { id: f.technicianId, name: 'QA Technician', email: f.techEmail, role: 'technician', active: true, employment_status: 'active', field_dispatchable: true, password_hash: passwordHash, auth_token_version: 1, must_change_password: false },
    ]).onConflict('id').ignore();
    await trx('customers').insert({ id: f.customerId, first_name: 'QA', last_name: 'Customer',
      email: f.customerEmail, phone: f.phone, account_id: f.customerId, active: true, pipeline_stage: 'active_customer',
      address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219',
      onboarding_complete: true, is_primary_profile: true, property_type: 'residential',
      gate_code: 'QA-PRIVATE-ACCESS-DO-NOT-PUBLISH', autopay_enabled: false, stripe_customer_id: f.stripeCustomerId,
    }).onConflict('id').ignore();
    // A saved credit card (funding known, so no provider lookup) and an open invoice whose card total
    // adds the card fee. The fee itself is never written here: the journey asks computeChargeAmount.
    await trx('payment_methods').insert({ id: f.cardPaymentMethodId, customer_id: f.customerId, processor: 'stripe',
      method_type: 'card', stripe_payment_method_id: f.stripePaymentMethodId, stripe_customer_id: f.stripeCustomerId,
      card_brand: f.cardBrand, last_four: f.cardLastFour, exp_month: '12', exp_year: String(new Date().getFullYear() + 3),
      card_funding: 'credit', card_funding_checked_at: new Date(), is_default: true, autopay_enabled: false,
    }).onConflict('id').ignore();
    await trx('invoices').insert({ id: f.cardInvoiceId, customer_id: f.customerId, token: f.cardInvoiceToken,
      invoice_number: f.cardInvoiceNumber, title: 'QA saved card service', status: 'sent', service_date: etDateString(),
      due_date: etDateString(addETDays(new Date(), 14)), subtotal: f.cardInvoiceSubtotal, total: f.cardInvoiceSubtotal,
      discount_amount: 0, tax_rate: 0, tax_amount: 0,
      line_items: JSON.stringify([{ description: 'QA saved card service', quantity: 1, unit_price: f.cardInvoiceSubtotal, amount: f.cardInvoiceSubtotal }]),
    }).onConflict('id').ignore();
    // The saved card carries the Auto Pay consent a real customer gave when it was saved, so the estimate page treats
    // it as an enrolled method (v8+ consent text, a source that authorizes charging it).
    const { CONSENT_VERSION, getConsentText } = require('../../server/services/payment-method-consent-text');
    await trx('payment_method_consents').insert({ id: f.prepayConsentId, customer_id: f.customerId, payment_method_id: f.cardPaymentMethodId,
      stripe_payment_method_id: f.stripePaymentMethodId, source: 'portal_add_card', consent_text_version: CONSENT_VERSION,
      consent_text_snapshot: getConsentText('card') }).onConflict('id').ignore();
    await trx('customers').insert([
      { id: f.siblingCustomerId, account_id: f.customerId, first_name: 'QA', last_name: 'Sibling', email: f.siblingEmail, phone: f.phone, active: true, is_primary_profile: false, onboarding_complete: true, pipeline_stage: 'active_customer', address_line1: '200 Example Court', city: 'Parrish', state: 'FL', zip: '34219' },
      { id: f.foreignCustomerId, account_id: f.foreignCustomerId, first_name: 'QA', last_name: 'Unrelated', email: f.foreignEmail, phone: f.foreignPhone, active: true, is_primary_profile: true, onboarding_complete: true, pipeline_stage: 'active_customer', address_line1: '300 Example Court', city: 'Parrish', state: 'FL', zip: '34219' },
    ]).onConflict('id').ignore();
    const service = await trx('services').where({ service_key: 'pest_general_quarterly', is_active: true }).first();
    if (!service) throw new Error('Migrated general pest catalog row is required for the report journey.');
    const material = await trx('products_catalog').where({ name: 'Suspend Polyzone' }).first();
    if (!material?.epa_reg_number) throw new Error('Migrated product identity is required for the material ledger check.');
    await trx('products_catalog').insert({ id: f.productId, name: f.productName, category: material.category,
      active_ingredient: material.active_ingredient, epa_reg_number: material.epa_reg_number, formulation: material.formulation,
      application_method: material.application_method, active: true,
      inventory_on_hand: 10, inventory_unit: 'fl_oz', cost_per_unit: 5, cost_unit: 'fl_oz' });
    f.serviceId = service.id;
    f.serviceName = service.name;
    await trx('estimates').insert({ id: f.estimateId, customer_id: f.customerId, status: 'sent',
      token: f.token, customer_name: 'QA Customer', customer_email: f.customerEmail, customer_phone: f.phone,
      sent_at: new Date(), expires_at: addETDays(new Date(), 30), bill_by_invoice: true,
      use_v2_view: true, category: 'RESIDENTIAL', onetime_total: 99,
      estimate_data: { result: { recurring: { services: [], monthly: 0, annual: 0 },
        oneTime: { total: 99, membershipFee: 0,
          items: [{ service: 'pest_general', catalogServiceKey: service.service_key, name: service.name, price: 99 }] } } },
    }).onConflict('id').ignore();
    await createScheduledService({ trx, cols: await trx('scheduled_services').columnInfo(),
      source: { sourceAction: 'qa_fixture' }, idempotencyKey: `qa:${f.runId}:appointment`,
      insertData: { id: f.appointmentId, customer_id: f.customerId,
        technician_id: f.technicianId, service_id: service.id, service_type: service.name,
        scheduled_date: f.date, window_start: '09:00:00', window_end: '10:30:00',
        status: 'pending', estimated_duration_minutes: 90, estimated_price: 99,
        source_estimate_id: f.estimateId, reservation_expires_at: new Date(Date.now() + 15 * 60000),
        is_recurring: false, create_invoice_on_complete: true,
      } });
    // A quarterly pest plan quoted at $45 a visit: four visits, $15 a month, $180 a year before any prepay discount.
    await trx('estimates').insert({ id: f.prepayEstimateId, customer_id: f.customerId, status: 'sent', token: f.prepayToken,
      customer_name: 'QA Customer', customer_email: f.customerEmail, customer_phone: f.phone, sent_at: new Date(),
      expires_at: addETDays(new Date(), 30), bill_by_invoice: false, use_v2_view: true, category: 'RESIDENTIAL',
      monthly_total: 15, annual_total: 180, onetime_total: 0, waveguard_tier: 'Bronze',
      estimate_data: JSON.stringify({ customerSelection: { frequency: 'quarterly' }, setupFeeQuote: { amount: 0, waived: true },
        result: { totals: { year2mo: 15, year2: 180 },
          results: { pestTiers: [{ label: 'Quarterly', mo: 15, ann: 180, apps: 4, pa: 45 }] },
          recurring: { discount: 0, monthlyTotal: 15, grandTotal: 15,
            services: [{ name: 'Pest Control', service: 'pest_control', mo: 15, visitsPerYear: 4, perTreatment: 45 }] },
          oneTime: { items: [], membershipFee: 0 } } }),
    }).onConflict('id').ignore();
    // The page's slot hold for that estimate (the journey renews it just before it accepts).
    await createScheduledService({ trx, cols: await trx('scheduled_services').columnInfo(),
      source: { sourceAction: 'qa_fixture' }, idempotencyKey: `qa:${f.runId}:prepay-appointment`,
      insertData: { id: f.prepayAppointmentId, customer_id: f.customerId, technician_id: f.technicianId, service_id: service.id,
        service_type: service.name, scheduled_date: f.nextDate, window_start: '09:00:00', window_end: '10:30:00', status: 'pending',
        estimated_duration_minutes: 90, estimated_price: 45, source_estimate_id: f.prepayEstimateId,
        reservation_expires_at: new Date(Date.now() + 15 * 60000), is_recurring: false } });
    for (const [id, customerId, start] of [[f.siblingAppointmentId, f.siblingCustomerId, '14:00:00'], [f.foreignAppointmentId, f.foreignCustomerId, '16:00:00']]) {
      await createScheduledService({ trx, cols: await trx('scheduled_services').columnInfo(), source: { sourceAction: 'qa_fixture' },
        insertData: { id, customer_id: customerId, technician_id: f.otherTechnicianId, service_id: service.id, service_type: service.name,
          scheduled_date: f.date, window_start: start, window_end: start.replace('00:00', '30:00'), status: 'confirmed' } });
    }
    await trx('service_records').insert({ id: f.foreignRecordId, customer_id: f.foreignCustomerId, service_date: f.date, service_type: service.name });
    await trx('customer_documents').insert({ id: f.foreignDocumentId, customer_id: f.foreignCustomerId, document_type: 'service_report', title: 'QA document', file_name: 'qa.pdf' });
  });
  return f;
}

// One more visit for the fixture customer, written through the same booking insert the seed uses. The journeys that
// text about a visit each need their own, because the earlier journeys complete and move the seeded one.
async function insertVisit(db, f, { id, scheduledDate, windowStart, status = 'confirmed', estimatedPrice = 45, ...extra }) {
  await db.transaction(async (trx) => {
    await createScheduledService({ trx, cols: await trx('scheduled_services').columnInfo(), source: { sourceAction: 'qa_fixture' },
      idempotencyKey: `qa:${id}`,
      insertData: { id, customer_id: f.customerId, technician_id: f.technicianId, service_id: f.serviceId, service_type: f.serviceName,
        scheduled_date: scheduledDate, window_start: windowStart, window_end: deriveWindowEnd(windowStart, 90), status,
        estimated_duration_minutes: 90, estimated_price: estimatedPrice, is_recurring: false, create_invoice_on_complete: true, ...extra } });
  });
}

async function cleanup(db, f) {
  const customerIds = [f.customerId, f.siblingCustomerId, f.foreignCustomerId].filter(Boolean);
  for (const [id, email] of [[f.siblingCustomerId, f.siblingEmail], [f.foreignCustomerId, f.foreignEmail]]) {
    if (!id) continue;
    const owned = await db('customers').where({ id }).first('email');
    if (owned && owned.email !== email) throw new Error('Fixture ownership mismatch; refusing cleanup.');
  }
  const customer = await db('customers').where({ id: f.customerId }).first('email');
  if (customer && customer.email !== f.customerEmail) throw new Error('Fixture ownership mismatch; refusing cleanup.');
  // Only these run-owned root IDs are eligible. FK cascades remove dependent
  // records; an unhandled restrictive FK fails visibly, never broadens cleanup.
  await db.transaction(async (trx) => {
    await trx('stripe_webhook_events').whereIn('id', [f.eventId, f.cardEventId, f.prepayEventId, ...(f.refundEventIds || [])].filter(Boolean)).del();
    // Receipt jobs and payment notices follow the run's own invoices and card payments, whichever journey made them.
    await trx('receipt_delivery_jobs').whereIn('invoice_id', trx('invoices').select('id').whereIn('customer_id', customerIds)).del();
    await trx('stripe_payment_notification_log').whereIn('payment_intent_id',
      [f.paymentIntentId, ...(f.cardPaymentIntentId ? [f.cardPaymentIntentId] : []), ...(f.prepayPaymentIntentId ? [f.prepayPaymentIntentId] : [])]).del();
    // A notice names its run-owned records in its metadata, at the top level or under payload; invoices, estimates and visits
    // are still present here, so the run's own ids come from them.
    const ownInvoiceIds = trx('invoices').select(trx.raw('id::text')).whereIn('customer_id', customerIds);
    await trx('notifications').whereIn('recipient_id', customerIds)
      .orWhereRaw("metadata->'payload'->>'serviceId' = ?", [f.appointmentId])
      .orWhereIn(trx.raw("metadata->'payload'->>'invoiceId'"), ownInvoiceIds)
      .orWhereIn(trx.raw("metadata->>'invoiceId'"), ownInvoiceIds)
      .orWhereIn(trx.raw("metadata->>'customerId'"), customerIds)
      .orWhereIn(trx.raw("metadata->>'estimateId'"), [f.estimateId, f.prepayEstimateId].filter(Boolean)).del();
    await trx('activity_log').whereIn('customer_id', customerIds).del();
    await trx('visit_billing_dispositions').whereIn('scheduled_service_id',
      trx('scheduled_services').select('id').whereIn('customer_id', customerIds)).del();
    await trx('short_codes').whereIn('customer_id', customerIds).del();
    await trx('customer_cards').whereIn('customer_id', customerIds).del();
    await trx('referral_promoters').whereIn('customer_id', customerIds).del();
    // The first review ask stays on for a completed visit, so the journey's completion leaves a review request.
    // Its customer FK is restrictive (the review sequence and its drafts cascade).
    await trx('review_requests').whereIn('customer_id', customerIds).del();
    await trx('property_application_history').whereIn('service_record_id',
      trx('service_records').select('id').whereIn('customer_id', customerIds)).del();
    await trx('conversations').whereIn('customer_id', customerIds).del();
    for (const table of ['sms_log', 'emails']) await trx(table).whereIn('customer_id', customerIds).del();
    await trx('product_inventory_movements').whereIn('customer_id', customerIds).del();
    await trx('payments').whereIn('customer_id', customerIds).del();
    await trx('invoices').whereIn('customer_id', customerIds).del();
    await trx('service_records').whereIn('customer_id', customerIds).del();
    await trx('reschedule_log').whereIn('scheduled_service_id',
      trx('scheduled_services').select('id').whereIn('customer_id', customerIds)).del();
    await trx('scheduled_services').whereIn('customer_id', customerIds).del();
    await trx('estimates').whereIn('id', [f.estimateId, f.prepayEstimateId].filter(Boolean)).del();
    await trx('customers').whereIn('id', customerIds).del();
    if (f.productId) await trx('products_catalog').where({ id: f.productId, name: f.productName }).del();
    // OTP login adopts an account-less customer as their own account.
    await trx('customer_accounts').whereIn('id', [f.customerId, f.foreignCustomerId].filter(Boolean)).del();
    await trx('admin_usage_events').whereIn('technician_id', [f.adminId, f.technicianId, f.otherTechnicianId].filter(Boolean)).del();
    await trx('technicians').whereIn('id', [f.adminId, f.technicianId, f.otherTechnicianId].filter(Boolean)).del();
  });
}
module.exports = { fixtureDates, fixtureIdentity, seed, insertVisit, cleanup };
