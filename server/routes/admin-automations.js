/**
 * Admin automation routes — CRUD on templates + steps, enrollment log,
 * test-send, and AI drafting. Mounted at /api/admin/automations.
 *
 * Authoritative surface for the Automations tab. Legacy
 * /admin/email-automations and the Beehiiv service were removed
 * in the teardown (migration 20260424000008).
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const AutomationRunner = require('../services/automation-runner');
const MODELS = require('../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

router.use(adminAuthenticate, requireAdmin);

const AUTOMATION_FROM_ALLOWLIST = (process.env.AUTOMATION_FROM_ALLOWLIST
  || 'automations@wavespestcontrol.com,newsletter@wavespestcontrol.com,events@wavespestcontrol.com,weekly@wavespestcontrol.com'
).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const AUTOMATION_ASM_GROUPS = new Set(['service', 'newsletter']);

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function normalizeAutomationFromEmail(email) {
  if (!email) return 'automations@wavespestcontrol.com';
  const lc = String(email).trim().toLowerCase();
  if (!AUTOMATION_FROM_ALLOWLIST.includes(lc)) {
    throw badRequest(`fromEmail must be one of: ${AUTOMATION_FROM_ALLOWLIST.join(', ')}`);
  }
  return lc;
}

function normalizeAsmGroup(value, fallback = 'service') {
  const group = String(value || fallback).trim().toLowerCase();
  if (!AUTOMATION_ASM_GROUPS.has(group)) {
    throw badRequest('asmGroup must be service or newsletter');
  }
  return group;
}

function limitedText(value, field, max) {
  if (value == null) return '';
  const text = String(value).trim();
  if (text.length > max) throw badRequest(`${field} must be ${max} characters or fewer`);
  return text;
}

const aiDraftLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `tech_${req.technicianId || req.ip}`,
  message: { error: 'Too many AI drafts in the last hour. Try again later.' },
});

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
      asm_group: asmGroup !== undefined ? normalizeAsmGroup(asmGroup, t.asm_group) : t.asm_group,
      updated_at: new Date(),
    });
    const updated = await db('automation_templates').where({ key: req.params.key }).first();
    res.json({ template: updated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
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
      from_email: normalizeAutomationFromEmail(fromEmail),
      reply_to: replyTo || 'contact@wavespestcontrol.com',
      enabled: true,
    }).returning('*');

    res.json({ step: row });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
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
      from_email: fromEmail !== undefined ? normalizeAutomationFromEmail(fromEmail) : step.from_email,
      reply_to: replyTo ?? step.reply_to,
      enabled: enabled ?? step.enabled,
      step_order: stepOrder ?? step.step_order,
      updated_at: new Date(),
    });
    const updated = await db('automation_steps').where({ id: req.params.id }).first();
    res.json({ step: updated });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
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
router.post('/draft-ai', aiDraftLimiter, async (req, res) => {
  try {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'Anthropic API not configured' });
    }
    const { templateKey, stepGoal, stepIndex = 0, totalSteps = 1, audience, tone, includeCTA = true } = req.body;
    const cleanStepGoal = limitedText(stepGoal, 'stepGoal', 2000);
    if (cleanStepGoal.length < 4) {
      return res.status(400).json({ error: 'stepGoal is required' });
    }
    const cleanAudience = limitedText(audience, 'audience', 500);
    const cleanTone = limitedText(tone, 'tone', 300);
    const safeStepIndex = Math.max(0, Math.min(Number(stepIndex) || 0, 20));
    const safeTotalSteps = Math.max(1, Math.min(Number(totalSteps) || 1, 20));

    const template = templateKey ? await db('automation_templates').where({ key: templateKey }).first() : null;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You draft transactional automation emails for Waves Pest Control, a family-owned pest control + lawn care company in Southwest Florida (Bradenton, Parrish, Palmetto, Sarasota, Venice, North Port, Lakewood Ranch).

CONTEXT FOR THIS EMAIL:
${template ? `- Automation: ${template.name}
- Purpose: ${template.description || '(no description)'}` : '- No template context provided.'}
- Step ${safeStepIndex + 1} of ${safeTotalSteps}

VOICE:
- Warm, neighborly, owner-operator tone
- Short sentences, short paragraphs (2-4 sentences)
- Use "we"/"our team"/"our trucks"
- SWFL-aware when relevant: sandy soil, summer storms, St. Augustine grass, salt air, humidity, no-see-ums, hurricane season, etc.
- Personalization: you MAY use {{first_name}} in the body. Do NOT invent other placeholders.

PURPOSE OF STEP (what the email should accomplish):
${cleanStepGoal}

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
${cleanAudience ? `\nAudience: ${cleanAudience}` : ''}
${cleanTone ? `\nTone: ${cleanTone}` : ''}`;

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
    res.status(err.status || 500).json({ error: err.message });
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

// POST /api/admin/automations/templates/:key/trigger — manually enroll a
// specific customer in this automation's sequence (the per-row "Send" button).
// Enrollment is idempotent (an active enrollment is a no-op) and the runner
// sends step 1 per its delay. Responds with an operator-facing message so the
// UI can say exactly what happened instead of a bare success flag.
function manualEnrollMessage(templateName, result) {
  if (result.enrolled) return `${templateName} — enrolled. Step 1 sends on its configured delay.`;
  switch (result.reason) {
    case 'no email': return 'This customer has no email on file, so they can\'t receive this automation.';
    case 'already enrolled': return 'This customer already has an active enrollment on this automation — nothing was re-sent.';
    case 'template disabled': return 'This automation is disabled. Enable it first, then send.';
    case 'no steps': return 'This automation has no enabled steps yet, so there is nothing to send.';
    default: return `Couldn't enroll: ${result.reason || 'unknown reason'}.`;
  }
}

router.post('/templates/:key/trigger', async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first();
    if (!customer) return res.status(404).json({ error: 'customer not found' });

    const template = await db('automation_templates').where({ key: req.params.key }).first();
    if (!template) return res.status(404).json({ error: 'template not found' });

    const result = await AutomationRunner.enrollCustomer({ templateKey: req.params.key, customer });
    const message = manualEnrollMessage(template.name, result);

    if (result.enrolled) {
      // Audit trail on the customer timeline, attributed to the operator who
      // clicked Send (best-effort — an audit hiccup must not fail the send).
      try {
        await db('customer_interactions').insert({
          customer_id: customer.id,
          interaction_type: 'email_outbound',
          admin_user_id: req.technicianId || null,
          subject: `${template.name} automation sent (manual)`,
          body: `Enrolled manually from the Automations page — sequence emails go to ${customer.email}.`,
        });
      } catch (auditErr) {
        logger.warn(`[automations/trigger] audit log failed for customer ${customer.id}: ${auditErr.message}`);
      }
    }

    res.json({ success: true, message, ...result });
  } catch (err) {
    logger.error(`[automations/trigger] failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Segment send ─────────────────────────────────────────────────
// Bulk enrollment for announcement-style automations (e.g. Pricing Update):
// preview a segment's live count, then enroll the whole segment on an explicit
// operator confirm. Two-step by design — the send endpoint re-counts and
// refuses if the segment drifted from the previewed count, so the operator
// always confirms the number that actually sends.

const SEGMENT_SCOPES = new Set(['customers', 'program']);
const SEGMENT_LOCATIONS = new Set(['bradenton', 'parrish', 'sarasota', 'venice']);
const SEGMENT_SEND_CAP = 2000;

// Live customers with an email, per the canonical real-customer predicate
// (customer-stages.js — pipeline_stage, NOT the always-true `active` flag
// alone). scope 'program' = WaveGuard program (recurring) customers only.
function segmentQuery({ scope, locationId }) {
  const { whereLiveCustomer } = require('../services/customer-stages');
  let q = db('customers')
    .modify(whereLiveCustomer)
    .whereNotNull('email')
    .whereRaw("TRIM(email) <> ''");
  if (scope === 'program') q = q.whereNotNull('waveguard_tier');
  if (locationId) q = q.where('nearest_location_id', locationId);
  return q;
}

function parseSegment(body) {
  const scope = String(body?.segment?.scope || '');
  if (!SEGMENT_SCOPES.has(scope)) throw badRequest('segment.scope must be customers or program');
  const locationId = body?.segment?.locationId ? String(body.segment.locationId) : null;
  if (locationId && !SEGMENT_LOCATIONS.has(locationId)) throw badRequest('segment.locationId is not a known location');
  return { scope, locationId };
}

// POST /api/admin/automations/templates/:key/segment-preview — count only
router.post('/templates/:key/segment-preview', async (req, res) => {
  try {
    const segment = parseSegment(req.body);
    const template = await db('automation_templates').where({ key: req.params.key }).first();
    if (!template) return res.status(404).json({ error: 'template not found' });

    const row = await segmentQuery(segment).count('* as count').first();
    const count = Number(row?.count || 0);
    res.json({ count, cap: SEGMENT_SEND_CAP, overCap: count > SEGMENT_SEND_CAP });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[automations/segment-preview] failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/automations/templates/:key/segment-send
// Body: { segment: { scope, locationId? }, expectedCount }
router.post('/templates/:key/segment-send', async (req, res) => {
  try {
    const segment = parseSegment(req.body);
    const expectedCount = Number(req.body?.expectedCount);
    if (!Number.isFinite(expectedCount) || expectedCount <= 0) {
      return res.status(400).json({ error: 'expectedCount required — preview the segment first' });
    }

    const template = await db('automation_templates').where({ key: req.params.key }).first();
    if (!template) return res.status(404).json({ error: 'template not found' });
    if (!template.enabled) return res.status(400).json({ error: 'This automation is disabled. Enable it first, then send.' });
    if (!(await AutomationRunner.hasLocalContent(req.params.key))) {
      return res.status(400).json({ error: 'No enabled step has content yet — there is nothing to send.' });
    }

    const countRow = await segmentQuery(segment).count('* as count').first();
    const liveCount = Number(countRow?.count || 0);
    if (liveCount !== expectedCount) {
      // Segment moved between preview and confirm — make the operator look at
      // the real number before a mass send.
      return res.status(409).json({ error: `Segment is now ${liveCount} customers (you previewed ${expectedCount}). Preview again to confirm the current count.`, count: liveCount });
    }
    if (liveCount > SEGMENT_SEND_CAP) {
      return res.status(400).json({ error: `Segment (${liveCount}) exceeds the ${SEGMENT_SEND_CAP}-customer cap for one send.` });
    }

    const customers = await segmentQuery(segment)
      .select('id', 'email', 'first_name', 'last_name')
      .orderBy('id', 'asc');

    // enrollCustomer per customer: idempotent (active enrollment = no-op),
    // reactivates completed rows (a repeat announcement SHOULD reach past
    // recipients), refreshes stale contact fields, and the runner applies
    // ASM/suppression checks at send time. The scheduler drains 50/minute,
    // so a full segment fans out over ~N/50 minutes rather than instantly.
    const summary = { enrolled: 0, alreadyActive: 0, skipped: 0 };
    for (const customer of customers) {
      try {
        const result = await AutomationRunner.enrollCustomer({ templateKey: req.params.key, customer });
        if (result.enrolled) summary.enrolled += 1;
        else if (result.reason === 'already enrolled') summary.alreadyActive += 1;
        else summary.skipped += 1;
      } catch (err) {
        summary.skipped += 1;
        logger.warn(`[automations/segment-send] enroll failed for customer ${customer.id}: ${err.message}`);
      }
    }

    // One audit row for the mass action (best-effort).
    try {
      await db('activity_log').insert({
        admin_user_id: req.technicianId || null,
        action: 'automation_segment_send',
        description: `${template.name}: segment send to ${segment.scope}${segment.locationId ? ` @ ${segment.locationId}` : ''} — ${summary.enrolled} enrolled, ${summary.alreadyActive} already active, ${summary.skipped} skipped.`,
        metadata: JSON.stringify({ template_key: req.params.key, segment, summary }),
      });
    } catch (auditErr) {
      logger.warn(`[automations/segment-send] audit log failed: ${auditErr.message}`);
    }

    logger.info(`[automations/segment-send] ${req.params.key} → ${segment.scope}${segment.locationId ? `@${segment.locationId}` : ''}: ${JSON.stringify(summary)}`);
    res.json({
      success: true,
      ...summary,
      message: `${template.name} — ${summary.enrolled} enrolled${summary.alreadyActive ? `, ${summary.alreadyActive} already active` : ''}${summary.skipped ? `, ${summary.skipped} skipped (no usable email / disabled)` : ''}. The runner sends ~50/minute.`,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error(`[automations/segment-send] failed: ${err.message}`);
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
