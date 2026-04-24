/**
 * Admin automation routes — CRUD on templates + steps, enrollment log,
 * test-send, and AI drafting. Mounted at /api/admin/automations.
 *
 * Authoritative surface for the Automations tab. Legacy
 * /admin/email-automations and the Beehiiv service were removed
 * in the teardown (migration 20260424000008).
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const AutomationRunner = require('../services/automation-runner');
const MODELS = require('../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

router.use(adminAuthenticate, requireTechOrAdmin);

// ── Templates ────────────────────────────────────────────────────

// GET /api/admin/automations/templates — list with step & enrollment counts
router.get('/templates', async (req, res, next) => {
  try {
    const templates = await db('automation_templates').orderBy('name', 'asc');
    const stepCounts = await db('automation_steps').select('template_key').count('* as c').groupBy('template_key');
    const enrollCounts = await db('automation_enrollments').select('template_key', 'status').count('* as c').groupBy('template_key', 'status');

    const stepMap = Object.fromEntries(stepCounts.map((r) => [r.template_key, Number(r.c)]));
    const enrollMap = {};
    for (const r of enrollCounts) {
      enrollMap[r.template_key] = enrollMap[r.template_key] || {};
      enrollMap[r.template_key][r.status] = Number(r.c);
    }

    for (const t of templates) {
      t.step_count = stepMap[t.key] || 0;
      t.enrollment_counts = enrollMap[t.key] || {};
      t.has_local_content = await AutomationRunner.hasLocalContent(t.key);
    }

    res.json({ templates });
  } catch (err) { next(err); }
});

// GET /api/admin/automations/templates/:key — detail + all steps
router.get('/templates/:key', async (req, res, next) => {
  try {
    const template = await db('automation_templates').where({ key: req.params.key }).first();
    if (!template) return res.status(404).json({ error: 'template not found' });
    const steps = await db('automation_steps').where({ template_key: req.params.key }).orderBy('step_order', 'asc');
    res.json({ template, steps });
  } catch (err) { next(err); }
});

// PUT /api/admin/automations/templates/:key
router.put('/templates/:key', async (req, res, next) => {
  try {
    const { name, description, enabled, smsTemplate, asmGroup } = req.body;
    const t = await db('automation_templates').where({ key: req.params.key }).first();
    if (!t) return res.status(404).json({ error: 'not found' });
    await db('automation_templates').where({ key: req.params.key }).update({
      name: name ?? t.name,
      description: description ?? t.description,
      enabled: enabled ?? t.enabled,
      sms_template: smsTemplate !== undefined ? smsTemplate : t.sms_template,
      asm_group: asmGroup ?? t.asm_group,
      updated_at: new Date(),
    });
    const updated = await db('automation_templates').where({ key: req.params.key }).first();
    res.json({ template: updated });
  } catch (err) { next(err); }
});

// ── Steps ───────────────────────────────────────────────────────

// POST /api/admin/automations/templates/:key/steps — add a step
router.post('/templates/:key/steps', async (req, res, next) => {
  try {
    const template = await db('automation_templates').where({ key: req.params.key }).first();
    if (!template) return res.status(404).json({ error: 'template not found' });

    const { delayHours, subject, previewText, htmlBody, textBody, fromName, fromEmail, replyTo } = req.body;

    // Next available step_order
    const max = await db('automation_steps').where({ template_key: req.params.key }).max('step_order as m').first();
    const nextOrder = max?.m == null ? 0 : Number(max.m) + 1;

    const [row] = await db('automation_steps').insert({
      template_key: req.params.key,
      step_order: nextOrder,
      delay_hours: delayHours ?? 0,
      subject: subject || null,
      preview_text: previewText || null,
      html_body: htmlBody || null,
      text_body: textBody || null,
      from_name: fromName || 'Waves Pest Control',
      from_email: fromEmail || 'automations@wavespestcontrol.com',
      reply_to: replyTo || 'contact@wavespestcontrol.com',
      enabled: true,
    }).returning('*');

    res.json({ step: row });
  } catch (err) { next(err); }
});

// PUT /api/admin/automations/steps/:id
router.put('/steps/:id', async (req, res, next) => {
  try {
    const step = await db('automation_steps').where({ id: req.params.id }).first();
    if (!step) return res.status(404).json({ error: 'not found' });

    const { delayHours, subject, previewText, htmlBody, textBody, fromName, fromEmail, replyTo, enabled, stepOrder } = req.body;
    await db('automation_steps').where({ id: req.params.id }).update({
      delay_hours: delayHours ?? step.delay_hours,
      subject: subject !== undefined ? subject : step.subject,
      preview_text: previewText !== undefined ? previewText : step.preview_text,
      html_body: htmlBody !== undefined ? htmlBody : step.html_body,
      text_body: textBody !== undefined ? textBody : step.text_body,
      from_name: fromName ?? step.from_name,
      from_email: fromEmail ?? step.from_email,
      reply_to: replyTo ?? step.reply_to,
      enabled: enabled ?? step.enabled,
      step_order: stepOrder ?? step.step_order,
      updated_at: new Date(),
    });
    const updated = await db('automation_steps').where({ id: req.params.id }).first();
    res.json({ step: updated });
  } catch (err) { next(err); }
});

// DELETE /api/admin/automations/steps/:id
router.delete('/steps/:id', async (req, res, next) => {
  try {
    await db('automation_steps').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── AI drafting ─────────────────────────────────────────────────

// POST /api/admin/automations/draft-ai
// Body: { templateKey, stepGoal, stepIndex, totalSteps, audience?, tone?, includeCTA? }
router.post('/draft-ai', async (req, res) => {
  try {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'Anthropic API not configured' });
    }
    const { templateKey, stepGoal, stepIndex = 0, totalSteps = 1, audience, tone, includeCTA = true } = req.body;

    const template = templateKey ? await db('automation_templates').where({ key: templateKey }).first() : null;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You draft transactional automation emails for Waves Pest Control, a family-owned pest control + lawn care company in Southwest Florida (Bradenton, Parrish, Palmetto, Sarasota, Venice, North Port, Lakewood Ranch).

CONTEXT FOR THIS EMAIL:
${template ? `- Automation: ${template.name}
- Purpose: ${template.description || '(no description)'}` : '- No template context provided.'}
- Step ${stepIndex + 1} of ${totalSteps}

VOICE:
- Warm, neighborly, owner-operator tone
- Short sentences, short paragraphs (2-4 sentences)
- Use "we"/"our team"/"our trucks"
- SWFL-aware when relevant: sandy soil, summer storms, St. Augustine grass, salt air, humidity, no-see-ums, hurricane season, etc.
- Personalization: you MAY use {{first_name}} in the body. Do NOT invent other placeholders.

PURPOSE OF STEP (what the email should accomplish):
${stepGoal || '(not specified — use the automation description to guide you)'}

FORMAT (HTML body):
- Lead with a warm, specific opener using {{first_name}}
- 1-3 short sections. Use <h2> only if truly helpful.
- Short paragraphs in <p> tags
- ${includeCTA ? 'Include ONE clear call to action at the end (reply, call, book, review)' : 'Sign off warmly with no hard CTA'}
- NO unsubscribe footer (SendGrid ASM handles it)
- NO <html>/<head>/<body> wrapper

Return STRICT JSON:
{
  "subject": "30-65 chars, friendly, no ALL CAPS, no clickbait",
  "previewText": "50-110 chars, complements subject",
  "htmlBody": "the HTML as described",
  "textBody": "plain-text version"
}
No prose outside the JSON.`;

    const userPrompt = `Draft the email.
${audience ? `\nAudience: ${audience}` : ''}
${tone ? `\nTone: ${tone}` : ''}`;

    const response = await anthropic.messages.create({
      model: MODELS.WORKHORSE,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude did not return JSON');
    const draft = JSON.parse(jsonMatch[0]);
    res.json({ success: true, draft });
  } catch (err) {
    logger.error(`[automations/draft-ai] failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Test + trigger ──────────────────────────────────────────────

// POST /api/admin/automations/templates/:key/test — send full sequence to a test email
router.post('/templates/:key/test', async (req, res) => {
  try {
    const { toEmail } = req.body;
    if (!toEmail) return res.status(400).json({ error: 'toEmail required' });
    const result = await AutomationRunner.testSequence({ templateKey: req.params.key, toEmail });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[automations/test] failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/automations/templates/:key/trigger — enroll a specific customer
router.post('/templates/:key/trigger', async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return res.status(404).json({ error: 'customer not found' });

    const result = await AutomationRunner.enrollCustomer({ templateKey: req.params.key, customer });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[automations/trigger] failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/automations/enrollments?template=x&limit=100
router.get('/enrollments', async (req, res, next) => {
  try {
    const { template, status, limit = 100 } = req.query;
    let q = db('automation_enrollments as e')
      .leftJoin('customers as c', 'c.id', 'e.customer_id')
      .select('e.*', 'c.first_name as customer_first_name', 'c.last_name as customer_last_name')
      .orderBy('e.enrolled_at', 'desc')
      .limit(Math.min(+limit, 500));
    if (template) q = q.where('e.template_key', template);
    if (status) q = q.where('e.status', status);
    res.json({ enrollments: await q });
  } catch (err) { next(err); }
});

module.exports = router;
