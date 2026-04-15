const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireTechOrAdmin);

// Auto-create table if missing
async function ensureTable() {
  if (!(await db.schema.hasTable('sms_templates'))) {
    await db.schema.createTable('sms_templates', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('template_key', 80).unique().notNullable();
      t.string('name', 200).notNullable();
      t.string('category', 30).notNullable();
      t.text('body').notNullable();
      t.text('description');
      t.jsonb('variables');
      t.boolean('is_active').defaultTo(true);
      t.boolean('is_internal').defaultTo(false);
      t.integer('sort_order').defaultTo(100);
      t.timestamps(true, true);
    });
    // Seed default templates
    const templates = [
      { template_key: 'appointment_confirmation', name: 'Appointment Confirmation', category: 'service', body: 'Hi {first_name}! Your {service_type} with Waves is confirmed for {date} between {time}. Reply to reschedule.\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','service_type','date','time']), sort_order: 1 },
      { template_key: 'reminder_72h', name: '72-Hour Reminder', category: 'service', body: 'Hello {first_name}! This is a reminder from Waves that your {service_type} appointment is scheduled for {day} at {time}. Expect your technician to arrive within a two-hour window of your scheduled start time. Need to reschedule? Log into your Waves Customer Portal at portal.wavespestcontrol.com. If you have any questions or need assistance, simply reply to this message. — Waves', variables: JSON.stringify(['first_name','service_type','day','time']), sort_order: 2 },
      { template_key: 'reminder_24h', name: '24-Hour Reminder', category: 'service', body: 'Hello {first_name}! This is a reminder from Waves that your {service_type} appointment is scheduled for tomorrow at {time}. Expect your technician to arrive within a two-hour window of your scheduled start time. Your tech will text you when they are 15 minutes out. If you have any questions or need assistance, simply reply to this message. — Waves', variables: JSON.stringify(['first_name','service_type','time']), sort_order: 3 },
      { template_key: 'tech_en_route', name: 'Tech En Route', category: 'service', body: 'Hello {first_name}! Your Waves technician is on the way. ETA: ~{eta_minutes} minutes.', variables: JSON.stringify(['first_name','eta_minutes']), sort_order: 3 },
      { template_key: 'service_complete', name: 'Service Complete', category: 'service', body: 'Hello {first_name}! Your service report is ready. View it here: portal.wavespestcontrol.com\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name']), sort_order: 4 },
      { template_key: 'service_complete_with_invoice', name: 'Service Complete + Invoice', category: 'service', body: "Hello {first_name}! Your {service_type} service report is ready: {portal_url}\n\nInvoice for today's visit: {pay_url}\n\nQuestions or requests? Reply to this message. Thank you for choosing Waves!", variables: JSON.stringify(['first_name','service_type','portal_url','pay_url']), sort_order: 5 },
      { template_key: 'missed_call', name: 'Missed Call Follow-Up', category: 'service', body: 'Hey {first_name}, this is Waves. Sorry we missed your call. How can we help? Reply or call (941) 318-7612.', variables: JSON.stringify(['first_name']), sort_order: 5 },
      { template_key: 'invoice_sent', name: 'Invoice Sent', category: 'billing', body: 'Hi {first_name}! Your invoice for {service_type} completed on {service_date} is ready: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','service_type','service_date','pay_url']), sort_order: 10 },
      { template_key: 'payment_failed', name: 'Payment Failed', category: 'billing', body: "Hi {first_name}, your payment for {service_type} completed on {service_date} didn't go through. Please update your payment method or reply for help.", variables: JSON.stringify(['first_name','service_type','service_date']), sort_order: 11 },
      { template_key: 'late_payment_7d', name: 'Late Payment — 7 Day', category: 'billing', body: 'Hello {first_name}! This is a reminder from Waves. Your invoice for {invoice_title} completed on {service_date} is now 7 days overdue.\n\nPlease make your payment here: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date','pay_url']), sort_order: 12 },
      { template_key: 'late_payment_14d', name: 'Late Payment — 14 Day', category: 'billing', body: 'Hello {first_name}, this is a reminder from Waves. Your invoice for {invoice_title} completed on {service_date} is now 14 days overdue.\n\nPlease make your payment as soon as possible at: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date','pay_url']), sort_order: 13 },
      { template_key: 'late_payment_30d', name: 'Late Payment — 30 Day', category: 'billing', body: 'Hello {first_name}, this is a final reminder from Waves. Your invoice for {invoice_title} completed on {service_date} is now 30 days overdue.\n\nPlease make your payment immediately at: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date','pay_url']), sort_order: 14 },
      { template_key: 'late_payment_60d', name: 'Late Payment — 60 Day', category: 'billing', body: 'Hello {first_name}, this is an urgent notice from Waves. Your invoice for {invoice_title} completed on {service_date} is now 60 days overdue.\n\nPlease make payment or contact us immediately to avoid further action: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date','pay_url']), sort_order: 15 },
      { template_key: 'late_payment_90d', name: 'Late Payment — 90 Day', category: 'billing', body: 'Hello {first_name}, your invoice from Waves for {invoice_title} completed on {service_date} is now 90 days overdue.\n\nFinal notice: This account will be sent to collections if payment is not received today. Please pay now: {pay_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','invoice_title','service_date','pay_url']), sort_order: 16 },
      { template_key: 'estimate_sent', name: 'Estimate Sent', category: 'estimates', body: 'Hi {first_name}! Your Waves estimate is ready: {estimate_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!', variables: JSON.stringify(['first_name','estimate_url']), sort_order: 20 },
      { template_key: 'lead_auto_reply_biz', name: 'Lead Auto-Reply (Business Hours)', category: 'estimates', body: 'Hello {first_name}! Thanks for reaching out to Waves! What are you interested in — Pest Control, Lawn Care, or a One-Time Service? Reply and we\'ll get you a quote right away.', variables: JSON.stringify(['first_name']), sort_order: 21 },
      { template_key: 'estimate_accepted_onetime', name: 'Estimate Accepted — One-Time Booking', category: 'estimates', body: "Hey {first_name}! Thanks for booking your {service_label} with Waves. Pick your time here — we'll show you slots when a tech will already be in your neighborhood: {booking_url}\n\nQuestions? Just reply. — Waves", variables: JSON.stringify(['first_name','service_label','booking_url']), sort_order: 22 },
      { template_key: 'review_request', name: 'Review Request', category: 'reviews', body: "Hi {first_name}! How was your service? We'd love your feedback: {review_url}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!", variables: JSON.stringify(['first_name','review_url']), sort_order: 30 },
      { template_key: 'referral_nudge', name: 'Referral Nudge', category: 'referrals', body: 'Hi {first_name}! Share your link — they get $25 off, you get $50: {referral_link}', variables: JSON.stringify(['first_name','referral_link']), sort_order: 31 },
      { template_key: 'churn_save_step1', name: 'Churn Save — Step 1', category: 'retention', body: 'Hey {first_name}, this is Adam from Waves. Just checking in — anything we can do better? Reply here.', variables: JSON.stringify(['first_name']), sort_order: 40 },
      { template_key: 'admin_new_lead', name: 'New Lead Alert', category: 'internal', body: '🔔 New lead! {name} 📞 {phone} 📍 {address} 🌐 {source}', variables: JSON.stringify(['name','phone','address','source']), is_internal: true, sort_order: 60 },
    ];
    for (const t of templates) { await db('sms_templates').insert(t).onConflict('template_key').ignore(); }
  }
}

// GET / — list all templates
router.get('/', async (req, res, next) => {
  try {
    await ensureTable();
    const { category } = req.query;
    let query = db('sms_templates').orderBy('category').orderBy('sort_order');
    if (category) query = query.where({ category });
    const templates = await query;
    res.json({ templates });
  } catch (err) { next(err); }
});

// GET /:id — single template
router.get('/:id', async (req, res, next) => {
  try {
    const template = await db('sms_templates').where({ id: req.params.id }).first();
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(template);
  } catch (err) { next(err); }
});

// PUT /:id — update template body
router.put('/:id', async (req, res, next) => {
  try {
    const { body, name, is_active } = req.body;
    const updates = { updated_at: new Date() };
    if (body !== undefined) updates.body = body;
    if (name !== undefined) updates.name = name;
    if (is_active !== undefined) updates.is_active = is_active;
    await db('sms_templates').where({ id: req.params.id }).update(updates);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST / — create new template
router.post('/', async (req, res, next) => {
  try {
    const { template_key, name, category, body, description, variables, is_internal } = req.body;
    if (!template_key || !name || !body) return res.status(400).json({ error: 'template_key, name, and body required' });
    const [template] = await db('sms_templates').insert({
      template_key, name, category: category || 'custom', body,
      description, variables: variables ? JSON.stringify(variables) : null,
      is_internal: is_internal || false,
    }).returning('*');
    res.status(201).json(template);
  } catch (err) { next(err); }
});

// DELETE /:id — delete template
router.delete('/:id', async (req, res, next) => {
  try {
    await db('sms_templates').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /preview — preview a template with sample data
router.post('/preview', async (req, res) => {
  try {
    const { templateId, sampleData } = req.body;
    const template = await db('sms_templates').where({ id: templateId }).first();
    if (!template) return res.status(404).json({ error: 'Template not found' });
    let preview = template.body;
    for (const [key, val] of Object.entries(sampleData || {})) {
      preview = preview.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
    }
    res.json({ preview, originalLength: template.body.length, previewLength: preview.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Map messageType values to template_key values
const MSG_TYPE_TO_TEMPLATE = {
  confirmation: 'appointment_confirmation',
  booking_confirmation: 'appointment_confirmation',
  appointment_reminder: 'reminder_24h',
  en_route: 'tech_en_route',
  service_complete: 'service_complete',
  missed_call_followup: 'missed_call',
  invoice: 'invoice_sent',
  late_payment: 'payment_failed',
  payment_expiry: 'payment_failed',
  review_request: 'review_request',
  referral_nudge: 'referral_nudge',
  referral_invite: 'referral_nudge',
  retention: 'churn_save_step1',
  retention_outreach: 'churn_save_step1',
  lead_response: 'lead_auto_reply_biz',
  auto_reply: 'lead_auto_reply_biz',
  balance_reminder: 'invoice_sent',
  reactivation: 'churn_save_step1',
};

// ── Template helper for services — check if a template is enabled before sending ──
router.isTemplateActive = async function(messageType) {
  try {
    if (!(await db.schema.hasTable('sms_templates'))) return true;
    const templateKey = MSG_TYPE_TO_TEMPLATE[messageType] || messageType;
    const t = await db('sms_templates').where({ template_key: templateKey }).first();
    if (!t) return true; // template not in DB = active by default
    return t.is_active !== false;
  } catch { return true; }
};

// Get template body by key (returns null if disabled)
router.getTemplate = async function(templateKey, vars = {}) {
  try {
    if (!(await db.schema.hasTable('sms_templates'))) return null;
    const t = await db('sms_templates').where({ template_key: templateKey }).first();
    if (!t || t.is_active === false) return null;
    let body = t.body;
    for (const [key, val] of Object.entries(vars)) {
      body = body.replace(new RegExp(`\\{${key}\\}`, 'g'), val || '');
    }
    return body;
  } catch { return null; }
};

module.exports = router;
