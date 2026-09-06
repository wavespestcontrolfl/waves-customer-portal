'use strict';
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { v5 } = require('uuid');
const { etDateString, addETDays, etParts } = require('../../server/utils/datetime-et');
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
    conflictId: id('conflict'),
    token: crypto.randomBytes(32).toString('hex'), invoiceToken: crypto.randomBytes(32).toString('hex'),
    password: crypto.randomBytes(24).toString('base64url'),
    adminEmail: `qa-admin-${suffix}@example.invalid`, techEmail: `qa-tech-${suffix}@example.invalid`,
    customerEmail: `qa-customer-${suffix}@example.invalid`,
    phone: `+194155501${String(parseInt(suffix, 16) % 100).padStart(2, '0')}`,
    ...fixtureDates(new Date()),
    paymentIntentId: `pi_qa_${suffix}`, eventId: `evt_qa_${suffix}` };
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
    await trx('technicians').insert([
      { id: f.adminId, name: 'QA Admin', email: f.adminEmail, role: 'admin', active: true, employment_status: 'active', field_dispatchable: false, password_hash: passwordHash, auth_token_version: 1, must_change_password: false },
      { id: f.technicianId, name: 'QA Technician', email: f.techEmail, role: 'technician', active: true, employment_status: 'active', field_dispatchable: true, password_hash: passwordHash, auth_token_version: 1, must_change_password: false },
    ]).onConflict('id').ignore();
    await trx('customers').insert({ id: f.customerId, first_name: 'QA', last_name: 'Customer',
      email: f.customerEmail, phone: f.phone, active: true, pipeline_stage: 'active_customer',
      address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219',
      onboarding_complete: true, is_primary_profile: true, property_type: 'residential',
      gate_code: 'QA-PRIVATE-ACCESS-DO-NOT-PUBLISH', autopay_enabled: false,
    }).onConflict('id').ignore();
    const service = await trx('services').where({ service_key: 'pest_general_quarterly', is_active: true }).first();
    if (!service) throw new Error('Migrated general pest catalog row is required for the report journey.');
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
        is_recurring: false, create_invoice_on_complete: false,
      } });
    await trx('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, token: f.invoiceToken,
      invoice_number: `QA-${f.runId.slice(0, 8)}`, title: 'QA service invoice', subtotal: 99, total: 99,
      status: 'sent', stripe_payment_intent_id: f.paymentIntentId,
      line_items: JSON.stringify([{ description: service.name, quantity: 1, unit_price: 99, amount: 99 }]),
    }).onConflict('id').ignore();
  });
  return f;
}

async function cleanup(db, f) {
  const customer = await db('customers').where({ id: f.customerId }).first('email');
  if (customer && customer.email !== f.customerEmail) throw new Error('Fixture ownership mismatch; refusing cleanup.');
  // Only these run-owned root IDs are eligible. FK cascades remove dependent
  // records; an unhandled restrictive FK fails visibly, never broadens cleanup.
  await db.transaction(async (trx) => {
    await trx('stripe_webhook_events').where({ id: f.eventId }).del();
    await trx('receipt_delivery_jobs').where({ invoice_id: f.invoiceId }).del();
    await trx('stripe_payment_notification_log').where({ payment_intent_id: f.paymentIntentId }).del();
    await trx('notifications').where({ recipient_id: f.customerId })
      .orWhereRaw("metadata->'payload'->>'serviceId' = ?", [f.appointmentId])
      .orWhereRaw("metadata->'payload'->>'invoiceId' = ?", [f.invoiceId]).del();
    await trx('activity_log').where({ customer_id: f.customerId }).del();
    await trx('visit_billing_dispositions').whereIn('scheduled_service_id',
      trx('scheduled_services').select('id').where({ customer_id: f.customerId })).del();
    await trx('short_codes').where({ customer_id: f.customerId }).del();
    await trx('customer_cards').where({ customer_id: f.customerId }).del();
    await trx('referral_promoters').where({ customer_id: f.customerId }).del();
    await trx('property_application_history').whereIn('service_record_id',
      trx('service_records').select('id').where({ customer_id: f.customerId })).del();
    for (const table of ['sms_log', 'emails']) await trx(table).where({ customer_id: f.customerId }).del();
    await trx('payments').where({ customer_id: f.customerId }).del();
    await trx('invoices').where({ customer_id: f.customerId }).del();
    await trx('service_records').where({ customer_id: f.customerId }).del();
    await trx('reschedule_log').whereIn('scheduled_service_id',
      trx('scheduled_services').select('id').where({ customer_id: f.customerId })).del();
    await trx('scheduled_services').where({ customer_id: f.customerId }).del();
    await trx('estimates').where({ id: f.estimateId }).del();
    await trx('customers').where({ id: f.customerId }).del();
    // OTP login adopts an account-less customer as their own account.
    await trx('customer_accounts').where({ id: f.customerId, email: f.customerEmail }).del();
    await trx('admin_usage_events').whereIn('technician_id', [f.adminId, f.technicianId]).del();
    await trx('technicians').whereIn('id', [f.adminId, f.technicianId]).del();
  });
}
module.exports = { fixtureDates, fixtureIdentity, seed, cleanup };
