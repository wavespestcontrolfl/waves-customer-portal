/**
 * Admin / Tech — Projects
 *
 * Post-service inspection-and-documentation records: WDO, termite, pest,
 * rodent exclusion, bed bug. Techs create them in the field, admin reviews
 * and sends the customer-facing report at /report/project/:token.
 *
 * Mounted at /api/admin/projects. Both admins and techs can create and
 * edit; only admins can delete or transition status to 'sent' / 'closed'.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const db = require('../models/db');
const config = require('../config');
const logger = require('../services/logger');
const MODELS = require('../config/models');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { PROJECT_TYPES, PROJECT_TYPE_KEYS, isValidProjectType, getProjectType } = require('../services/project-types');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { wrapEmail, formatDate, plainText } = require('../services/email-template');

router.use(adminAuthenticate, requireTechOrAdmin);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});
const PHOTO_PREFIX = 'project-photos/';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildProjectReportPrompt({ typeCfg, findings, rawRecommendations, customer, tech }) {
  const labelMap = Object.fromEntries((typeCfg.findingsFields || []).map(f => [f.key, f.label]));
  const findingsLines = Object.entries(findings || {})
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => `${labelMap[k] || k.replace(/_/g, ' ')}: ${v}`)
    .join('\n') || '[no structured findings captured]';

  return `# PROJECT REPORT WRITER — SYSTEM PROMPT v1

## CONTEXT

This generates customer-facing narrative copy for a Waves Pest Control & Lawn Care inspection / documentation report. The report is a branded PDF + web page delivered to the customer after a field visit.

Project types this prompt handles:
- WDO inspection (wood-destroying organism, often pre-home-purchase)
- Termite inspection
- Pest inspection (general survey, pre-treatment scoping)
- Rodent exclusion (entry-point mapping, trapping, exclusion work)
- Bed bug treatment (inspection + initial treatment, with an optional 14-day follow-up)

The narrative sits alongside structured findings (field/value pairs), photos, and Waves branding. This prompt writes three narrative sections only — it does NOT touch the structured findings.

## HARD CONSTRAINTS (READ FIRST — THESE OVERRIDE EVERYTHING ELSE)

1. **Never downplay a serious finding.** "Active subterranean termite infestation" stays serious. Do not soften to "some activity" or "a few signs." Accuracy beats reassurance.

2. **Never manufacture urgency that isn't there.** A clean inspection is calm: "no visible evidence of active wood-destroying organisms at time of inspection." Do not fear-sell: no "you dodged a bullet," "lucky," "imagine what could have happened."

3. **No military language.** Do not use: mission, tactical, deployment, fortification, fortress, sentries, invaders, infiltration, neutralize, annihilation, defensive perimeter, chemical barrier, vectors, sweep, recon, staging, advancement, threat, lockdown, intercept (as military metaphor).

4. **No overpromising.** Never: elimination, eradication, impenetrable, guaranteed, 100%, total protection, pest-free, foolproof. Use: reduce activity, manage pressure, support long-term control, limit conducive conditions.

5. **No invented observations.** Only reference findings, pests, species, locations, and conditions that appear in the inputs. If a field was left blank, do not fabricate content for it. Better to write less than to invent.

6. **No brand names for products.** Use active ingredient names (fipronil, bifenthrin, imidacloprid) or functional descriptions (non-repellent residual, insect growth regulator). If the active ingredient is not provided in the inputs, use the functional description only.

7. **Plain text only.** No markdown, no bold, no emojis, no bullet points, no em-dash headers. Just paragraphs under the three section titles.

8. **Length.** Each section 2–4 sentences. Total output roughly 100–180 words.

## VOICE

Write like a knowledgeable field specialist drafting a professional summary — someone who understands the science and the stakes, and who communicates plainly.

The tone is:
- Calm and precise
- Technically informed but readable at a 9th-grade level
- Confident without bragging
- Clean, modern, premium

Think: a well-written inspection report from a specialist you trust.
Do not think: action movie, military briefing, advertising copy, or fear-based sales pitch.

### Sentence-Level Rules

- Vary sentence openings. Do not start more than one sentence in a row with "We."
- Blend what was done with why it matters in the same sentence when you can.
- Avoid repeating the same word more than twice across all three sections (especially: treatment, inspect, applied, control, recommend).

## SECTIONS

### WHAT WE INSPECTED

2–3 sentences:
- The areas covered (from the structured findings)
- The method (visual, probing, infrared, etc.) ONLY if mentioned in inputs — otherwise omit
- Scope limitations where relevant for the project type (e.g. "visible and accessible areas" for WDO)

### WHAT WE FOUND

2–3 sentences:
- Findings translated from dropdown values into customer-friendly language
- Specific locations from the inputs
- Moisture / conducive conditions if noted
- Severity framed factually, not dramatically
- If clean: say so clearly ("no visible evidence of...") without filler

### WHAT WE RECOMMEND

2–4 sentences:
- Practical next steps grounded in the findings
- Follow-up timing if project type calls for it (bed bug 14-day, rodent trap check cadence, etc.)
- If no action needed: say that clearly, not vaguely

## TYPE-SPECIFIC GUIDANCE — USE WHICHEVER MATCHES THIS PROJECT'S TYPE

### WDO Inspection
Formal, defensible tone. This document may sit in a real-estate transaction file. State scope limitations (visible and accessible areas only; no invasive probing unless noted). If clean: "no visible evidence of active wood-destroying organisms at time of inspection." If evidence found: name the species, the location, and whether activity is active or inactive. Avoid softening language that could mislead a buyer.

### Termite Inspection
Standalone (not tied to a real-estate transaction). Same care as WDO. Can lean more directly toward treatment recommendations when warranted.

### Pest Inspection
General survey. Identify pests, severity, likely conducive conditions. Recommendations should connect to a treatment plan without becoming a sales pitch.

### Rodent Exclusion
Blend of inspection + work performed in one visit. Cover: species identified, entry points found, exclusion work completed today, work pending, trap count and placement, follow-up schedule for trap checks.

### Bed Bug Treatment
Sensitive topic — no stigma, no judgment. Address: rooms treated, treatment method (chemical, heat, steam, combo), customer prep instructions, and the 14-day follow-up visit if applicable. Keep language matter-of-fact.

## INPUTS

Customer: ${customer?.first_name || ''} ${customer?.last_name || ''}
Project type: ${typeCfg.label}
Technician: ${tech?.name || 'Not specified'}

Structured findings:
${findingsLines}

Technician's raw recommendations / notes:
${rawRecommendations || '[none provided]'}

## OUTPUT FORMAT

Output exactly this structure, plain text, no markdown:

WHAT WE INSPECTED

[2-3 sentences]

WHAT WE FOUND

[2-3 sentences]

WHAT WE RECOMMEND

[2-4 sentences]

Do not include the customer name as a header. Do not add greetings, sign-offs, or any text outside these three sections.`;
}

async function draftProjectReport({ typeCfg, findings, rawRecommendations, customer, tech }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 1200,
    messages: [{ role: 'user', content: buildProjectReportPrompt({ typeCfg, findings, rawRecommendations, customer, tech }) }],
  });
  return msg.content?.[0]?.text || '';
}

// ---------------------------------------------------------------------------
// GET /api/admin/projects/types — registry for form rendering
// ---------------------------------------------------------------------------
router.get('/types', (_req, res) => {
  res.json({ types: PROJECT_TYPES, keys: PROJECT_TYPE_KEYS });
});

// ---------------------------------------------------------------------------
// GET /api/admin/projects — list (admin dashboard)
// ---------------------------------------------------------------------------
router.get('/', async (req, res, next) => {
  try {
    const { status, project_type, customer_id, tech_id, limit = 100 } = req.query;

    let q = db('projects as p')
      .leftJoin('customers as c', 'p.customer_id', 'c.id')
      .leftJoin('technicians as t', 'p.created_by_tech_id', 't.id')
      .select(
        'p.*',
        'c.first_name', 'c.last_name', 'c.city', 'c.state',
        't.name as tech_name',
      )
      .orderBy('p.created_at', 'desc')
      .limit(Math.min(Number(limit) || 100, 500));

    if (status) q = q.where('p.status', status);
    if (project_type) q = q.where('p.project_type', project_type);
    if (customer_id) q = q.where('p.customer_id', customer_id);
    if (tech_id) q = q.where('p.created_by_tech_id', tech_id);

    const rows = await q;
    const photoCounts = await db('project_photos')
      .whereIn('project_id', rows.map(r => r.id))
      .select('project_id')
      .count('* as n')
      .groupBy('project_id');
    const photoMap = Object.fromEntries(photoCounts.map(x => [x.project_id, Number(x.n)]));

    res.json({
      projects: rows.map(r => ({
        ...r,
        customer_name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        photo_count: photoMap[r.id] || 0,
      })),
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// GET /api/admin/projects/:id — single project with photos
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res, next) => {
  try {
    const project = await db('projects as p')
      .where('p.id', req.params.id)
      .leftJoin('customers as c', 'p.customer_id', 'c.id')
      .leftJoin('technicians as t', 'p.created_by_tech_id', 't.id')
      .select(
        'p.*',
        'c.first_name', 'c.last_name', 'c.phone', 'c.email',
        'c.address_line1', 'c.city', 'c.state', 'c.zip',
        't.name as tech_name',
      )
      .first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const photos = await db('project_photos')
      .where({ project_id: project.id })
      .orderBy(['visit', 'sort_order', 'created_at']);

    res.json({
      project: {
        ...project,
        customer_name: `${project.first_name || ''} ${project.last_name || ''}`.trim(),
      },
      photos,
    });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects — create (tech-facing)
// ---------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const {
      customer_id, project_type, title, findings, recommendations,
      service_record_id, scheduled_service_id,
    } = req.body;

    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });
    if (!isValidProjectType(project_type)) return res.status(400).json({ error: 'Invalid project_type' });

    const [row] = await db('projects').insert({
      customer_id,
      project_type,
      title: title || null,
      findings: findings || null,
      recommendations: recommendations || null,
      service_record_id: service_record_id || null,
      scheduled_service_id: scheduled_service_id || null,
      status: 'draft',
      created_by_tech_id: req.technicianId,
    }).returning('*');

    logger.info(`[projects] created ${row.id} (${project_type}) by tech ${req.technicianId}`);
    res.json({ project: row });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/ai-write-preview — draft report copy before save
// ---------------------------------------------------------------------------
router.post('/ai-write-preview', requireAdmin, async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured' });

    const { project_type, findings, recommendations, customer_id } = req.body;
    if (!isValidProjectType(project_type)) return res.status(400).json({ error: 'Invalid project_type' });

    const typeCfg = getProjectType(project_type);
    const customer = customer_id ? await db('customers').where({ id: customer_id }).first() : null;
    const tech = req.technicianId ? await db('technicians').where({ id: req.technicianId }).first() : null;
    const report = await draftProjectReport({
      typeCfg,
      findings: findings || {},
      rawRecommendations: recommendations || '',
      customer,
      tech,
    });

    logger.info(`[projects] ai-write-preview ${project_type} — ${report.length} chars`);
    res.json({ report });
  } catch (err) {
    logger.error(`[projects] ai-write-preview failed: ${err.message}`);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /api/admin/projects/:id — update findings / recommendations / title
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const updates = {};
    const allowed = ['title', 'findings', 'recommendations', 'followup_date', 'followup_findings'];
    for (const f of allowed) if (req.body[f] !== undefined) updates[f] = req.body[f];
    if (Object.keys(updates).length === 0) return res.json({ project });

    await db('projects').where({ id: req.params.id }).update({ ...updates, updated_at: db.fn.now() });
    const updated = await db('projects').where({ id: req.params.id }).first();
    res.json({ project: updated });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/send — generate token, mark sent, notify customer
// Admin-only (prevents accidental send by tech before review).
//
// Notifies the customer via SMS (Twilio) and email (SendGrid) with the
// public report link. Failures on either channel are reported back but
// do not block the status transition — the report is still viewable
// at the public URL.
// ---------------------------------------------------------------------------
router.post('/:id/send', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const customer = project.customer_id
      ? await db('customers').where({ id: project.customer_id }).first()
      : null;

    const token = project.report_token || crypto.randomBytes(16).toString('hex');
    await db('projects').where({ id: req.params.id }).update({
      status: 'sent',
      report_token: token,
      sent_at: project.sent_at || db.fn.now(),
      updated_at: db.fn.now(),
    });

    const reportUrl = `https://portal.wavespestcontrol.com/report/project/${token}`;
    const typeCfg = getProjectType(project.project_type);
    const typeLabel = typeCfg?.label || 'Service';
    const firstName = customer?.first_name || 'there';

    const channels = {};

    // SMS
    if (customer?.phone) {
      try {
        const digits = String(customer.phone).replace(/\D/g, '');
        const normalized = digits.length === 11 && digits.startsWith('1') ? `+${digits}`
          : digits.length === 10 ? `+1${digits}`
          : null;
        if (!normalized) {
          channels.sms = { ok: false, error: `Invalid phone format: ${customer.phone}` };
        } else {
          const smsBody = `Hi ${firstName}! Your Waves ${typeLabel} report is ready: ${reportUrl}\n\nQuestions? Reply here.`;
          const result = await sendCustomerMessage({
            to: normalized,
            body: smsBody,
            channel: 'sms',
            audience: 'customer',
            purpose: 'support_resolution',
            customerId: customer.id,
            identityTrustLevel: 'phone_matches_customer',
            entryPoint: 'admin_project_report_send',
            metadata: {
              original_message_type: 'project_report',
              project_id: project.id,
            },
          });
          channels.sms = result.sent
            ? { ok: true }
            : { ok: false, error: result.reason || result.code || 'SMS send blocked/failed' };
        }
      } catch (e) {
        logger.error(`[projects] send sms failed: ${e.message}`);
        channels.sms = { ok: false, error: e.message };
      }
    } else {
      channels.sms = { ok: false, error: 'No phone on file' };
    }

    // Email (via SendGrid, service-tier ASM group)
    if (customer?.email) {
      try {
        const sendgrid = require('../services/sendgrid-mail');
        if (!sendgrid.isConfigured()) {
          channels.email = { ok: false, error: 'SendGrid not configured' };
        } else {
          const serviceGid = parseInt(process.env.SENDGRID_ASM_GROUP_SERVICE) || null;
          const safeTypeLabel = escapeHtml(typeLabel);
          const safeFirstName = escapeHtml(firstName);
          const safeTitle = project.title ? escapeHtml(project.title) : '';
          const clientName = `${customer?.first_name || ''} ${customer?.last_name || ''}`.trim();
          const fullAddress = [
            customer?.address_line1,
            [customer?.city, customer?.state].filter(Boolean).join(', '),
            customer?.zip,
          ].filter(Boolean).join(' ');
          const heading = `Your ${safeTypeLabel} report is ready`;
          const intro = `Hi ${safeFirstName}, your technician's report is posted. You can review the visit summary, photos, findings, and recommendations online.`;
          const lines = [
            ['Report', safeTypeLabel],
            safeTitle ? ['Title', safeTitle] : null,
            clientName ? ['Client', escapeHtml(clientName)] : null,
            customer?.email ? ['Email', escapeHtml(customer.email)] : null,
            customer?.phone ? ['Phone', escapeHtml(customer.phone)] : null,
            fullAddress ? ['Property', escapeHtml(fullAddress)] : null,
            ['Prepared', formatDate(project.sent_at || new Date())],
          ].filter(Boolean);
          const html = wrapEmail({
            preheader: `Your Waves ${typeLabel} report is ready.`,
            heading,
            intro,
            lines,
            ctaHref: reportUrl,
            ctaLabel: 'View report',
            footerNote: 'Questions? Reply to this email or call (941) 297-5749.',
          });
          const text = plainText([
            `Hi ${firstName},`,
            '',
            intro,
            '',
            `Report: ${typeLabel}`,
            project.title ? `Title: ${project.title}` : null,
            clientName ? `Client: ${clientName}` : null,
            customer?.email ? `Email: ${customer.email}` : null,
            customer?.phone ? `Phone: ${customer.phone}` : null,
            fullAddress ? `Property: ${fullAddress}` : null,
            `View report: ${reportUrl}`,
            '',
            'Questions? Reply to this email or call (941) 297-5749.',
            '— Waves Pest Control',
          ]);
          const result = await sendgrid.sendOne({
            to: customer.email,
            fromEmail: 'reports@wavespestcontrol.com',
            fromName: 'Waves Pest Control',
            replyTo: 'contact@wavespestcontrol.com',
            subject: `Your Waves ${typeLabel} report is ready`,
            html,
            text,
            categories: ['project_report', `type_${project.project_type}`],
            asmGroupId: serviceGid,
          });
          channels.email = { ok: true, messageId: result.messageId };
        }
      } catch (e) {
        logger.error(`[projects] send email failed: ${e.message}`);
        channels.email = { ok: false, error: e.message };
      }
    } else {
      channels.email = { ok: false, error: 'No email on file' };
    }

    logger.info(`[projects] sent ${project.id} token=${token} sms=${channels.sms?.ok} email=${channels.email?.ok}`);
    res.json({ project_id: project.id, report_token: token, report_url: `/report/project/${token}`, channels });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/close — admin only
// ---------------------------------------------------------------------------
router.post('/:id/close', requireAdmin, async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    await db('projects').where({ id: req.params.id }).update({ status: 'closed', updated_at: db.fn.now() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/followup — record bed-bug follow-up visit
// ---------------------------------------------------------------------------
router.post('/:id/followup', async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.project_type !== 'bed_bug') {
      return res.status(400).json({ error: 'Follow-up only applies to bed bug projects' });
    }
    const { followup_findings } = req.body;
    await db('projects').where({ id: req.params.id }).update({
      followup_findings: followup_findings || project.followup_findings,
      followup_completed_at: db.fn.now(),
      updated_at: db.fn.now(),
    });
    const updated = await db('projects').where({ id: req.params.id }).first();
    res.json({ project: updated });
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------------------
// POST /api/admin/projects/:id/ai-write — Claude drafts the three
// customer-facing narrative sections (WHAT WE INSPECTED / FOUND / RECOMMEND)
// from the structured findings + tech's raw notes. Admin reviews before Send.
//
// Accepts optional overrides in the body so the admin can generate against
// unsaved edits without a round-trip save. Admin-only — techs capture facts,
// admin owns customer-facing copy.
// ---------------------------------------------------------------------------
router.post('/:id/ai-write', requireAdmin, async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured' });

    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const typeCfg = getProjectType(project.project_type);
    if (!typeCfg) return res.status(400).json({ error: 'Unknown project type' });

    const findings = req.body.findings || project.findings || {};
    const rawRecommendations = (req.body.recommendations !== undefined
      ? req.body.recommendations
      : project.recommendations) || '';

    const customer = await db('customers').where({ id: project.customer_id }).first();
    const tech = project.created_by_tech_id
      ? await db('technicians').where({ id: project.created_by_tech_id }).first()
      : null;

    const report = await draftProjectReport({
      typeCfg,
      findings,
      rawRecommendations,
      customer,
      tech,
    });
    logger.info(`[projects] ai-write ${project.id} — ${report.length} chars`);
    res.json({ report });
  } catch (err) {
    logger.error(`[projects] ai-write failed: ${err.message}`);
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Photo endpoints
// ---------------------------------------------------------------------------

// POST /api/admin/projects/:id/photos — multipart upload
router.post('/:id/photos', upload.single('photo'), async (req, res, next) => {
  try {
    const project = await db('projects').where({ id: req.params.id }).first();
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });

    const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `${PHOTO_PREFIX}${project.id}/${Date.now()}-${safeName}`;
    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const [row] = await db('project_photos').insert({
      project_id: project.id,
      s3_key: key,
      category: req.body.category || null,
      caption: req.body.caption || null,
      visit: req.body.visit === 'followup' ? 'followup' : 'primary',
      uploaded_by_tech_id: req.technicianId,
    }).returning('*');

    res.json({ photo: row });
  } catch (err) { next(err); }
});

// GET /api/admin/projects/:id/photos/:photoId/url — presigned view URL
router.get('/:id/photos/:photoId/url', async (req, res, next) => {
  try {
    const photo = await db('project_photos').where({ id: req.params.photoId, project_id: req.params.id }).first();
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.s3.bucket, Key: photo.s3_key,
    }), { expiresIn: 3600 });
    res.json({ url });
  } catch (err) { next(err); }
});

// DELETE /api/admin/projects/:id/photos/:photoId — remove a photo
router.delete('/:id/photos/:photoId', async (req, res, next) => {
  try {
    const deleted = await db('project_photos')
      .where({ id: req.params.photoId, project_id: req.params.id })
      .del();
    if (!deleted) return res.status(404).json({ error: 'Photo not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PUT /api/admin/projects/:id/photos/:photoId — update caption / category
router.put('/:id/photos/:photoId', async (req, res, next) => {
  try {
    const updates = {};
    for (const f of ['caption', 'category', 'sort_order']) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (Object.keys(updates).length === 0) return res.json({ ok: true });
    await db('project_photos')
      .where({ id: req.params.photoId, project_id: req.params.id })
      .update({ ...updates, updated_at: db.fn.now() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
