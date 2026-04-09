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
      { template_key: 'appointment_confirmation', name: 'Appointment Confirmation', category: 'service', body: 'Hi {first_name}! Your {service_type} with Waves is confirmed for {date} between {time}. Reply to reschedule. — Waves', variables: JSON.stringify(['first_name','service_type','date','time']), sort_order: 1 },
      { template_key: 'reminder_24h', name: '24-Hour Reminder', category: 'service', body: 'Hi {first_name}! Your {service_type} is tomorrow. Your tech will arrive between {time}. — Waves', variables: JSON.stringify(['first_name','service_type','time']), sort_order: 2 },
      { template_key: 'tech_en_route', name: 'Tech En Route', category: 'service', body: 'Hello {first_name}! Your Waves technician is on the way. ETA: ~{eta_minutes} minutes.', variables: JSON.stringify(['first_name','eta_minutes']), sort_order: 3 },
      { template_key: 'service_complete', name: 'Service Complete', category: 'service', body: 'Hello {first_name}! Your service report is ready under Documents > Visit Reports. Questions? Reply here. — Waves!', variables: JSON.stringify(['first_name']), sort_order: 4 },
      { template_key: 'missed_call', name: 'Missed Call Follow-Up', category: 'service', body: 'Hey {first_name}, this is Waves. Sorry we missed your call. How can we help? Reply or call (941) 318-7612.', variables: JSON.stringify(['first_name']), sort_order: 5 },
      { template_key: 'invoice_sent', name: 'Invoice Sent', category: 'billing', body: 'Hi {first_name}! Your invoice for ${amount} is ready: {pay_url} — Waves', variables: JSON.stringify(['first_name','amount','pay_url']), sort_order: 10 },
      { template_key: 'payment_failed', name: 'Payment Failed', category: 'billing', body: 'Hi {first_name}, your payment of ${amount} didn\'t go through. Please update your payment method or reply for help.', variables: JSON.stringify(['first_name','amount']), sort_order: 11 },
      { template_key: 'estimate_sent', name: 'Estimate Sent', category: 'estimates', body: 'Hi {first_name}! Your Waves estimate is ready: {estimate_url}. Questions? Reply or call (941) 318-7612.', variables: JSON.stringify(['first_name','estimate_url']), sort_order: 20 },
      { template_key: 'lead_auto_reply_biz', name: 'Lead Auto-Reply (Business Hours)', category: 'estimates', body: 'Hello {first_name}! Waves here! We received your quote request. A specialist will be calling soon. Thank you!', variables: JSON.stringify(['first_name']), sort_order: 21 },
      { template_key: 'review_request', name: 'Review Request', category: 'reviews', body: 'Hi {first_name}! How was your service? We\'d love your feedback: {review_url} — Waves 🌊', variables: JSON.stringify(['first_name','review_url']), sort_order: 30 },
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

module.exports = router;
