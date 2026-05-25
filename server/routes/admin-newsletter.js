/**
 * Admin newsletter routes — subscribers + campaigns.
 *
 * Mounted at /api/admin/newsletter. Newsletter is rolled out and
 * always-on for admins; the only gate is the standard admin auth
 * applied at router.use() below.
 *
 * See docs/design/DECISIONS.md (PR 5) for the scope.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const sendgrid = require('../services/sendgrid-mail');
const NewsletterSender = require('../services/newsletter-sender');
const { linkToCustomer, subscribeOrResubscribe } = require('../services/newsletter-subscribers');
const { wrapNewsletter } = require('../services/email-template');
const MODELS = require('../config/models');
const { isFlagshipType, getNewsletterType } = require('../config/newsletter-types');
const { getVoiceProfile, validateVoice } = require('../config/voice-profiles');
const { isEligibleForFreshDigest, scoreFreshEvent } = require('../services/event-freshness');
const { parseETDateTime, addETDays, etDateString, etParts } = require('../utils/datetime-et');
const { validateNewsletterDraft } = require('../services/newsletter-validator');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

router.use(adminAuthenticate, requireAdmin);

// Per-admin rate limiter on /draft-ai. Each call hits Anthropic with up
// to 2k output tokens on the FLAGSHIP/WORKHORSE model — without a cap a
// compromised admin token (or a runaway client) can rack up real spend
// in minutes. Keyed by technicianId so two admins drafting concurrently
// don't share the bucket.
const aiDraftLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `tech_${req.technicianId || req.ip}`,
  message: { error: 'Too many AI drafts in the last hour. Try again later.' },
});

// Server-side allowlist for newsletter from-email. SendGrid's domain auth
// (DKIM/SPF) is on wavespestcontrol.com, so a typo to a subdomain or
// adjacent domain sends unsigned and lands in spam — and the operator
// has no UI signal that anything went wrong. Defaults cover the three
// canonical sender mailboxes; override via env when adding new ones.
const FROM_EMAIL_ALLOWLIST = (process.env.NEWSLETTER_FROM_ALLOWLIST
  || 'newsletter@wavespestcontrol.com,events@wavespestcontrol.com,weekly@wavespestcontrol.com'
).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function normalizeFromEmail(email) {
  if (!email) return 'newsletter@wavespestcontrol.com';
  const lc = String(email).trim().toLowerCase();
  if (!FROM_EMAIL_ALLOWLIST.includes(lc)) {
    const err = new Error(`from_email must be one of: ${FROM_EMAIL_ALLOWLIST.join(', ')}`);
    err.status = 400;
    throw err;
  }
  return lc;
}

// ── Subscribers ──────────────────────────────────────────────────

// GET /api/admin/newsletter/subscribers?status=active|unsubscribed|bounced&q=search
//
// `bounced` is a synthetic filter: there's no status='bounced' in the table
// (the webhook handler only flips status to 'unsubscribed' on hard
// complaints, otherwise just increments bounce_count). Surface every
// subscriber whose recent sends have bounced via bounce_count > 0 instead.
router.get('/subscribers', async (req, res, next) => {
  try {
    const { status, q } = req.query;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const query = db('newsletter_subscribers').orderBy('subscribed_at', 'desc').limit(limit).offset(offset);
    if (status === 'bounced') {
      query.where('bounce_count', '>', 0);
    } else if (status) {
      query.where({ status });
    }
    if (q) query.where('email', 'ilike', `%${q}%`);
    const rows = await query;

    const counts = await db('newsletter_subscribers')
      .select('status')
      .count('* as count')
      .groupBy('status');
    const byStatus = Object.fromEntries(counts.map((r) => [r.status, Number(r.count)]));
    byStatus.all = counts.reduce((sum, r) => sum + Number(r.count), 0);
    // Synthetic 'bounced' tally — see filter above.
    const bouncedRow = await db('newsletter_subscribers')
      .where('bounce_count', '>', 0)
      .count('* as count').first();
    byStatus.bounced = Number(bouncedRow?.count || 0);

    res.json({ subscribers: rows, counts: byStatus });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/subscribers
// Body: { email, firstName?, lastName?, source? }
//
// Routes through services/newsletter-subscribers.js#subscribeOrResubscribe
// — same flow as the public signup and quote-wizard dual-write. strict=false
// preserves the historical behavior (admin can paste anything that looks
// vaguely like an email; the public path is stricter).
router.post('/subscribers', async (req, res, next) => {
  try {
    const { email, firstName, lastName, source } = req.body;
    const result = await subscribeOrResubscribe({
      email,
      firstName: firstName || null,
      lastName: lastName || null,
      source: source || 'admin_manual',
      strict: false,
    });
    res.json({
      success: true,
      subscriber: result.subscriber,
      resubscribed: result.action === 'resubscribed',
    });
  } catch (err) {
    if (err.code === 'EMAIL_REQUIRED' || err.code === 'INVALID_EMAIL') {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// GET /api/admin/newsletter/subscribers.csv — full filtered export.
// Streamed as text/csv; filename includes today's date so multiple
// exports the same day distinguish themselves in the operator's
// downloads folder. Uses the same status filter semantics as the JSON
// list endpoint above (including the synthetic 'bounced' filter).
router.get('/subscribers.csv', async (req, res, next) => {
  try {
    const { status, q } = req.query;
    const query = db('newsletter_subscribers').orderBy('subscribed_at', 'desc');
    if (status === 'bounced') {
      query.where('bounce_count', '>', 0);
    } else if (status) {
      query.where({ status });
    }
    if (q) query.where('email', 'ilike', `%${q}%`);
    const rows = await query;

    // CSV formula-injection defense: Excel / Google Sheets execute cells
    // starting with =, +, -, @, tab, or CR as formulas. first_name,
    // last_name, source, and tags are subscriber-controlled via the
    // public signup path, so a malicious value would fire as a formula
    // the moment Waves opens the export. Leading apostrophe forces text
    // mode without rendering inside the cell. Applied uniformly via the
    // `escape` helper — harmless on legitimate values.
    const escape = (v) => {
      if (v == null) return '';
      let s = String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const stamp = new Date().toISOString().slice(0, 10);
    res.type('text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="newsletter-subscribers-${stamp}.csv"`);
    res.write('email,first_name,last_name,status,source,bounce_count,customer_id,tags,subscribed_at,unsubscribed_at\n');
    for (const r of rows) {
      res.write([
        escape(r.email),
        escape(r.first_name),
        escape(r.last_name),
        escape(r.status),
        escape(r.source),
        escape(r.bounce_count ?? 0),
        escape(r.customer_id),
        escape(Array.isArray(r.tags) ? r.tags.join('|') : ''),
        escape(r.subscribed_at instanceof Date ? r.subscribed_at.toISOString() : r.subscribed_at),
        escape(r.unsubscribed_at instanceof Date ? r.unsubscribed_at.toISOString() : r.unsubscribed_at),
      ].join(',') + '\n');
    }
    res.end();
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/subscribers/import
// Body: { subscribers: [{ email, firstName?, lastName? }], source? }
// Designed for a Beehiiv CSV export → POST flow.
router.post('/subscribers/import', async (req, res, next) => {
  try {
    const { subscribers, source = 'beehiiv_import' } = req.body;
    if (!Array.isArray(subscribers) || subscribers.length === 0) {
      return res.status(400).json({ error: 'subscribers[] required' });
    }

    // Two-pass: filter to valid rows in JS (so we have a clean count of
    // bad inputs), then a single bulk INSERT ... ON CONFLICT DO NOTHING
    // for everything that survived. Postgres dedupes against the existing
    // unique index on email — we don't pre-query.
    const seen = new Set();
    const rows = [];
    for (const s of subscribers) {
      const email = (s.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) continue;
      if (seen.has(email)) continue;  // dedupe within this CSV
      seen.add(email);
      rows.push({
        email,
        first_name: s.firstName || s.first_name || null,
        last_name: s.lastName || s.last_name || null,
        source,
        status: 'active',
      });
    }

    let inserted = 0;
    if (rows.length) {
      const result = await db('newsletter_subscribers')
        .insert(rows)
        .onConflict('email')
        .ignore()
        .returning('id');
      inserted = result.length;

      // Bulk customer auto-link covers both fresh inserts AND rows that
      // already existed (the onConflict path) — running over the full
      // imported email set, idempotent on already-linked rows. One query.
      await db.raw(
        `UPDATE newsletter_subscribers ns
            SET customer_id = c.id, updated_at = NOW()
            FROM customers c
           WHERE ns.email = ANY(?)
             AND ns.customer_id IS NULL
             AND LOWER(c.email) = ns.email`,
        [rows.map((r) => r.email)],
      );
    }
    const skipped = subscribers.length - inserted;

    res.json({ success: true, inserted, skipped, total: subscribers.length });
  } catch (err) { next(err); }
});

// DELETE /api/admin/newsletter/subscribers/:id — admin unsubscribe
router.delete('/subscribers/:id', async (req, res, next) => {
  try {
    await db('newsletter_subscribers').where({ id: req.params.id }).update({
      status: 'unsubscribed',
      unsubscribed_at: new Date(),
      updated_at: new Date(),
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Sends (campaigns) ────────────────────────────────────────────

// GET /api/admin/newsletter/sends
router.get('/sends', async (req, res, next) => {
  try {
    // Order by effective send date (sent_at for sent rows, otherwise created_at)
    // so Beehiiv-imported historical posts slot into chronological order
    // instead of bunching at "now" by import time.
    const rows = await db('newsletter_sends')
      .leftJoin('technicians', 'newsletter_sends.created_by', 'technicians.id')
      .select('newsletter_sends.*', 'technicians.name as created_by_name')
      .orderByRaw('COALESCE(newsletter_sends.sent_at, newsletter_sends.created_at) DESC')
      .limit(500);

    // Uncapped status breakdown so callers (e.g. the Dashboard's Scheduled
    // tile) don't have to derive counts from the 500-row payload.
    const countRows = await db('newsletter_sends')
      .select('status')
      .count('* as count')
      .groupBy('status');
    const counts = Object.fromEntries(countRows.map((r) => [r.status, Number(r.count)]));

    res.json({ sends: rows, counts });
  } catch (err) { next(err); }
});

// GET /api/admin/newsletter/sends/:id
router.get('/sends/:id', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });

    const deliveries = await db('newsletter_send_deliveries')
      .where({ send_id: req.params.id })
      .orderBy('created_at', 'desc')
      .limit(1000);

    // Per-variant aggregate for A/B sends — operator currently has to
    // run a DB query to know which subject won. Computed via COUNT
    // (column) which excludes nulls, so each timestamp column counts
    // the recipients who reached that step. Skipped entirely on
    // non-A/B campaigns to save the round trip.
    let variantStats = null;
    if (send.subject_b) {
      const rows = await db('newsletter_send_deliveries')
        .where({ send_id: req.params.id })
        .select('ab_variant')
        .count('* as total')
        .count('delivered_at as delivered')
        .count('opened_at as opened')
        .count('clicked_at as clicked')
        .count('bounced_at as bounced')
        .groupBy('ab_variant');
      variantStats = { a: null, b: null };
      for (const r of rows) {
        if (r.ab_variant === 'a' || r.ab_variant === 'b') {
          variantStats[r.ab_variant] = {
            total: Number(r.total),
            delivered: Number(r.delivered),
            opened: Number(r.opened),
            clicked: Number(r.clicked),
            bounced: Number(r.bounced),
          };
        }
      }
    }

    res.json({ send, deliveries, variantStats });
  } catch (err) { next(err); }
});

function generateSlug(subject) {
  const base = (subject || 'newsletter')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  const date = etDateString();
  return `${base}-${date}`;
}

// POST /api/admin/newsletter/sends — create a draft
router.post('/sends', async (req, res, next) => {
  try {
    const { subject, subjectB, htmlBody, textBody, previewText, fromName, fromEmail, replyTo, segmentFilter, aiPrompt, newsletterType } = req.body;
    if (!subject) return res.status(400).json({ error: 'subject required' });

    let normalizedFromEmail;
    try { normalizedFromEmail = normalizeFromEmail(fromEmail); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    const [row] = await db('newsletter_sends').insert({
      subject,
      subject_b: subjectB || null,
      html_body: htmlBody || null,
      text_body: textBody || null,
      preview_text: previewText || null,
      from_name: fromName || 'Waves Pest Control',
      from_email: normalizedFromEmail,
      reply_to: replyTo || 'contact@wavespestcontrol.com',
      status: 'draft',
      segment_filter: segmentFilter || null,
      ai_prompt: aiPrompt || null,
      newsletter_type: newsletterType || null,
      slug: generateSlug(subject),
      created_by: req.technicianId || null,
    }).returning('*');

    res.json({ success: true, send: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/newsletter/sends/:id — edit a draft (or a scheduled row)
router.patch('/sends/:id', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (!['draft', 'scheduled'].includes(send.status)) return res.status(400).json({ error: 'can only edit drafts or scheduled' });

    const { subject, subjectB, htmlBody, textBody, previewText, fromName, fromEmail, replyTo, segmentFilter, aiPrompt, newsletterType } = req.body;

    // Validate from_email only when the caller is changing it. Skipping
    // validation on PATCHes that don't touch the field keeps existing
    // drafts editable even if the allowlist contracts.
    let nextFromEmail = send.from_email;
    if (fromEmail !== undefined) {
      try { nextFromEmail = normalizeFromEmail(fromEmail); }
      catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    }

    await db('newsletter_sends').where({ id: req.params.id }).update({
      subject: subject ?? send.subject,
      subject_b: subjectB !== undefined ? subjectB : send.subject_b,
      html_body: htmlBody ?? send.html_body,
      text_body: textBody ?? send.text_body,
      preview_text: previewText ?? send.preview_text,
      from_name: fromName ?? send.from_name,
      from_email: nextFromEmail,
      reply_to: replyTo ?? send.reply_to,
      segment_filter: segmentFilter !== undefined ? segmentFilter : send.segment_filter,
      ai_prompt: aiPrompt !== undefined ? aiPrompt : send.ai_prompt,
      newsletter_type: newsletterType !== undefined ? newsletterType : send.newsletter_type,
      updated_at: new Date(),
    });

    const updated = await db('newsletter_sends').where({ id: req.params.id }).first();
    res.json({ success: true, send: updated });
  } catch (err) { next(err); }
});

// DELETE /api/admin/newsletter/sends/:id — delete a draft
router.delete('/sends/:id', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'draft') return res.status(400).json({ error: 'can only delete drafts' });
    await db('newsletter_sends').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/sends/:id/test — send preview to one email
router.post('/sends/:id/test', async (req, res) => {
  try {
    if (!sendgrid.isConfigured()) return res.status(400).json({ error: 'SendGrid not configured (SENDGRID_API_KEY missing)' });

    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });

    // Default to the logged-in admin's own email so an empty test-email
    // input doesn't fire into the shared contact@ inbox where Virginia
    // works real customer replies.
    const testEmail = req.body.email || req.technician?.email || 'contact@wavespestcontrol.com';
    // Demo unsubscribe URL — won't resolve to a real subscriber but the link
    // renders correctly and Gmail/Apple Mail will show the native unsub UI.
    const demoUrl = sendgrid.unsubscribeUrl('test-' + send.id);
    // Same wrapper the real send uses (newsletter-sender.js) so the
    // operator's preview matches what subscribers will receive.
    const html = wrapNewsletter({
      body: send.html_body || '',
      unsubscribeUrl: demoUrl,
      preheader: send.preview_text || undefined,
      newsletterType: send.newsletter_type || undefined,
    });

    const result = await sendgrid.sendOne({
      to: testEmail,
      fromEmail: send.from_email,
      fromName: send.from_name,
      subject: `[TEST] ${send.subject}`,
      html,
      text: send.text_body || undefined,
      replyTo: send.reply_to,
      headers: {
        'List-Unsubscribe': `<${demoUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      categories: ['newsletter_test', `send_${send.id}`],
      // Match the live broadcast's ASM group so the test renders the same
      // unsub UI the operator will see in production.
      asmGroupId: sendgrid.newsletterGroupId(),
    });

    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    logger.error(`[newsletter] test send failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/newsletter/sends/:id/send — send to all matching active subscribers
//
// Returns 202 + dispatches sendCampaign asynchronously. The synchronous
// version held the request open for the duration of the send (~30s+ for a
// 5k list with per-recipient DB updates) which timed out at the proxy and
// led operators to retry, double-blasting recipients. sendCampaign's atomic
// status claim (draft/scheduled → sending) is the double-click guard now.
// Errors during the background run flip status to 'failed' so the History
// tab surfaces them.
router.post('/sends/:id/send', async (req, res) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (!['draft', 'scheduled'].includes(send.status)) {
      return res.status(400).json({ error: 'already sent or in progress' });
    }
    if (!send.html_body && !send.text_body) {
      return res.status(400).json({ error: 'body required' });
    }

    // Pre-flight 0-recipient guard for synchronous feedback. sendCampaign
    // itself re-checks (defense in depth + scheduler-tick coverage), but
    // doing it here lets us 400 immediately with the force=true hint
    // instead of returning 202 + later landing as 'failed'.
    const force = !!req.body?.force;
    if (!force) {
      const segCount = await NewsletterSender.buildSubscriberQuery(send.segment_filter).count('* as c').first();
      if (Number(segCount?.c || 0) === 0) {
        return res.status(400).json({
          error: 'segment matches 0 active subscribers; pass { force: true } to send anyway',
        });
      }
    }

    // Server-side validation gate for flagship sends. Hard errors
    // (no subject, no body) always block. force=true skips only the
    // 0-recipient check (existing contract) — not structural errors.
    if (isFlagshipType(send.newsletter_type)) {
      const recipientCount = force ? 1 : Number(
        (await NewsletterSender.buildSubscriberQuery(send.segment_filter).count('* as c').first())?.c || 0
      );
      const { errors } = validateNewsletterDraft(send, { recipientCount });
      if (errors.length > 0) {
        return res.status(400).json({ error: 'Validation failed', errors });
      }
    }

    // Fire-and-forget. Don't await — the response should land before the
    // first recipient is queued.
    NewsletterSender.sendCampaign(req.params.id, { force }).catch(async (err) => {
      // ALREADY_CLAIMED = another worker (scheduler tick, or a second
      // manual click that beat us to the atomic claim) is actively
      // sending this row. Do NOT flip to 'failed' or we'd overwrite an
      // in-flight campaign — let the winner finish and stamp 'sent'.
      if (err.code === 'ALREADY_CLAIMED') {
        logger.info(`[newsletter] background send ${req.params.id} already claimed by another worker — no-op`);
        return;
      }
      logger.error(`[newsletter] background send ${req.params.id} failed: ${err.message}`, { stack: err.stack });
      try {
        await db('newsletter_sends').where({ id: req.params.id }).update({ status: 'failed' });
      } catch { /* swallow */ }
    });

    res.status(202).json({ accepted: true, sendId: req.params.id, status: 'sending' });
  } catch (err) {
    logger.error(`[newsletter] send dispatch failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/newsletter/sends/:id/resume — operator-triggered re-send
// for a previously failed or partially-completed campaign. Per-recipient
// idempotency in NewsletterSender skips anyone already in terminal-success
// state so the resume only mails the ones that didn't make it.
//
// Refuses 'sending' (active worker holds it) and 'draft'/'scheduled' (use
// the normal /send route). Refuses with NOTHING_TO_RESUME if every row is
// already terminal-success — the campaign is effectively done.
router.post('/sends/:id/resume', async (req, res) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });

    const prepared = await NewsletterSender.prepareResumeCampaign(req.params.id);
    void NewsletterSender.sendCampaign(prepared.sendId, {
      force: true,
      preserveSentAt: true,
      existingDeliveriesOnly: prepared.existingDeliveriesOnly,
      preclaimed: prepared.preclaimed,
    }).catch(async (err) => {
      if (err.code === 'ALREADY_CLAIMED') {
        logger.info(`[newsletter] background resume ${req.params.id} already claimed by another worker — no-op`);
        return;
      }
      logger.error(`[newsletter] background resume ${req.params.id} failed: ${err.message}`, { stack: err.stack });
      try {
        await db('newsletter_sends').where({ id: req.params.id }).update({ status: 'failed' });
      } catch { /* swallow */ }
    });

    res.status(202).json({ accepted: true, sendId: req.params.id, status: 'resuming' });
  } catch (err) {
    if (err.code === 'STILL_SENDING' || err.code === 'ALREADY_CLAIMED') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err.code === 'NOT_RESUMABLE' || err.code === 'NOTHING_TO_RESUME') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    logger.error(`[newsletter] resume dispatch failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/newsletter/sends/:id/schedule — mark a draft as scheduled
router.post('/sends/:id/schedule', async (req, res, next) => {
  try {
    const { scheduledFor } = req.body;
    if (!scheduledFor) return res.status(400).json({ error: 'scheduledFor required (ISO timestamp)' });
    const when = new Date(scheduledFor);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'invalid scheduledFor' });
    if (when.getTime() <= Date.now()) return res.status(400).json({ error: 'scheduledFor must be in the future' });

    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'draft') return res.status(400).json({ error: 'can only schedule drafts' });
    if (!send.html_body && !send.text_body) return res.status(400).json({ error: 'body required before scheduling' });

    await db('newsletter_sends').where({ id: send.id }).update({
      status: 'scheduled',
      scheduled_for: when,
      updated_at: new Date(),
    });
    const updated = await db('newsletter_sends').where({ id: send.id }).first();
    res.json({ success: true, send: updated });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/sends/:id/cancel-schedule — return a scheduled row to draft
router.post('/sends/:id/cancel-schedule', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'scheduled') return res.status(400).json({ error: 'not scheduled' });
    await db('newsletter_sends').where({ id: send.id }).update({
      status: 'draft',
      scheduled_for: null,
      updated_at: new Date(),
    });
    const updated = await db('newsletter_sends').where({ id: send.id }).first();
    res.json({ success: true, send: updated });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/preview — wrap the operator's HTML body in
// the same chrome the live send uses (header, logo, footer with a demo
// unsub link) so the Compose modal can render the final email without
// requiring a saved draft or a test send. Stateless: no DB read/write.
router.post('/preview', async (req, res) => {
  try {
    const { htmlBody, previewText, newsletterType } = req.body || {};
    const demoUrl = sendgrid.unsubscribeUrl('preview-demo-token');
    const html = wrapNewsletter({
      body: htmlBody || '',
      unsubscribeUrl: demoUrl,
      preheader: previewText || undefined,
      newsletterType: newsletterType || undefined,
    });
    res.json({ html });
  } catch (err) {
    logger.error(`[newsletter] preview failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/newsletter/tags — distinct tag values across the
// subscriber list. Used by the Compose tag input as a datalist source so
// the operator picks an existing tag instead of typing a near-miss
// (case/typo) that won't match any subscriber.
router.get('/tags', async (req, res, next) => {
  try {
    const result = await db.raw(`
      SELECT DISTINCT jsonb_array_elements_text(tags) AS tag
        FROM newsletter_subscribers
       WHERE jsonb_typeof(tags) = 'array'
       ORDER BY tag ASC
    `);
    const tags = (result.rows || []).map((r) => r.tag).filter(Boolean);
    res.json({ tags });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/segment-preview — count subscribers matching a segment
router.post('/segment-preview', async (req, res, next) => {
  try {
    const count = await NewsletterSender.buildSubscriberQuery(req.body.segmentFilter || null).count('* as c').first();
    res.json({ count: Number(count?.c || 0) });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/draft-ai — Claude drafts a newsletter
// Body: { prompt, template?, newsletterType?, eventIds?, audience?, tone?, includeCTA? }
//   newsletterType: when 'local-weekly-fresh-events', uses the flagship
//     Phase 3 system prompt with structured section output + voice profile.
//   template: legacy param — one of 'weekend' | 'pest_concern' |
//     'local_spotlight' | 'service_promo'. Used when newsletterType is
//     absent (backward compat).
//   eventIds: optional array of events_raw UUIDs. When present, the
//     approved events are fetched and injected into the user prompt so
//     Claude drafts from real event data instead of inventing.
router.post('/draft-ai', aiDraftLimiter, async (req, res) => {
  try {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'Anthropic API not configured' });
    }
    const { prompt, template, newsletterType, eventIds, audience, tone, includeCTA } = req.body;
    if (!prompt || prompt.trim().length < 8) {
      return res.status(400).json({ error: 'prompt required (min 8 chars)' });
    }
    if (prompt.length > 4000) {
      return res.status(400).json({ error: 'prompt too long (max 4000 chars)' });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const month = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });

    // ── Flagship flow: local-weekly-fresh-events ──────────────────────
    if (isFlagshipType(newsletterType)) {
      const typeConfig = getNewsletterType(newsletterType);
      const voice = getVoiceProfile(typeConfig.voiceProfile);

      let eventBlock = '';
      const MAX_EVENT_IDS = 12;
      if (Array.isArray(eventIds) && eventIds.length > 0) {
        const safeIds = eventIds.slice(0, MAX_EVENT_IDS).filter(
          (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
        );
        if (safeIds.length === 0) {
          return res.status(400).json({ error: 'eventIds must be valid UUIDs' });
        }
        const events = await db('events_raw as e')
          .leftJoin('event_sources as s', 's.id', 'e.source_id')
          .select(
            'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
            'e.venue_name', 'e.venue_address', 'e.city', 'e.event_url',
            'e.categories', 's.name as source_name',
          )
          .whereIn('e.id', safeIds);

        if (events.length > 0) {
          eventBlock = '\n\nAPPROVED EVENTS (use ONLY these — do not invent events):\n' +
            events.map((ev, i) => {
              const parts = [`${i + 1}. ${ev.title}`];
              if (ev.city) parts.push(`   City: ${ev.city}`);
              if (ev.start_at) parts.push(`   Date: ${new Date(ev.start_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })}`);
              if (ev.start_at) parts.push(`   Time: ${new Date(ev.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}`);
              if (ev.venue_name) parts.push(`   Venue: ${ev.venue_name}`);
              if (ev.venue_address) parts.push(`   Address: ${ev.venue_address}`);
              if (ev.event_url) parts.push(`   URL: ${ev.event_url}`);
              if (ev.source_name) parts.push(`   Source: ${ev.source_name}`);
              if (ev.description) parts.push(`   Details: ${ev.description.slice(0, 200)}`);
              return parts.join('\n');
            }).join('\n\n');
        }
      }

      const flagshipSystemPrompt = `You write the Waves weekly local events newsletter — "Fresh This Week from North Port to Tampa."

This is NOT a corporate pest control email. It is a punchy, local, FOMO-driven weekend guide from North Port to Tampa, written like a friend texting "yo, here's what's actually worth doing."

The newsletter leads with local events. Waves pest/lawn/homeowner content appears only as a short useful sidebar (Homeowner Minute) and a soft CTA at the end.

CURRENT MONTH: ${month}

SWFL SEASONAL CONTEXT (pick what's relevant):
- Local events & seasonal rhythms by month:
  • Jan–Feb: snowbird season peak, cooler mornings, dry lawns, red tide drift
  • Mar: spring break traffic, love bugs starting, citrus bloom
  • Apr: Bradenton Blues Festival week, baseball spring training tail, lawn pre-emergents
  • May: DeSoto Heritage Festival & Grand Parade (Bradenton), mosquito season ramp, no-see-um peak at dawn/dusk
  • Jun: hurricane season begins (Jun 1), afternoon thunderstorms daily, nitrogen blackout begins on lawns (Jun–Sept by county ordinance)
  • Jul: 4th of July on the waterfront, peak rainy season, German roach pressure, palmetto bugs indoors
  • Aug: back-to-school in Manatee/Sarasota schools, peak hurricane risk month, chinch bug damage on St. Augustine
  • Sep: hurricane peak, Siesta Key Crystal Classic (sand sculpture), subterranean termite swarms after storms
  • Oct: snowbirds return, cooler nights, rodent season begins (mice seeking warmth), Halloween on the barrier islands
  • Nov: Sarasota Season of Sculpture, turkey trots, last major hurricane risk tapers, winter annuals go in
  • Dec: holidays, boat parades (Downtown Bradenton Riverwalk, Venice), cooler weather drives indoor pest activity
- SWFL pests by season: subterranean termites (swarm after rain), German cockroaches, palmetto bugs, no-see-ums, salt-marsh mosquitoes, fire ants, chinch bugs on St. Augustine, sod webworms

VOICE:
- Irreverent but not mean
- Energetic but not chaotic
- Specific to this week's events
- Conversational, like a local friend
- Short, scannable, and useful
- Never corporate
- Owner-operator energy: "we", "our team", first names welcome

SUBJECT LINES:
- Punchy, max ${voice.subjectLineRules.maxLength} chars
- FOMO-driven, specific to this week's event mix
- Can be playful, emoji-led, or slightly ridiculous when appropriate
- Never generic ("Monthly Newsletter", "Weekly Update")
- Good examples: ${voice.subjectLineRules.examples.map(e => `"${e}"`).join(', ')}

EVENT BLURBS:
- Include city, date/day, venue/location when provided
- Explain in one sentence why it is worth going
- Do NOT invent events — use only the approved event records provided
- Do NOT change dates, times, prices, venues, or URLs from the approved records
- Do NOT include stale recurring events unless explicitly marked as fresh

HOMEOWNER MINUTE:
- One useful seasonal tip (pest, lawn, or home prep)
- Max ~90 words
- Genuinely useful, not salesy
- No scare tactics, no hard pitch
- Must stand on its own without selling Waves

SIGN-OFF: Must end with "${voice.signoff}"

NEVER WRITE:
${voice.bannedCorporatePhrases.map(p => `- "${p}"`).join('\n')}

FORMAT: HTML body only (no <html>/<head>/<body> wrapper, no unsubscribe footer).
Use <h2> for section headers, <p> for paragraphs, <strong> for emphasis, <ul><li> for lists.

REQUIRED SECTIONS (produce all of these):
1. local_intro — 1-2 sentence casual hook for the week
2. fresh_this_week — 4-6 top event picks (one-time, annual, opening weekends)
3. just_starting — 1-2 new recurring series or seasonal launches
4. weekend_picks — 2-3 Friday–Sunday highlights (can overlap with fresh_this_week)
5. family_or_low_key_pick — one family-friendly or low-effort option
6. road_trip_pick — one event worth the drive from outside the reader's immediate zone
7. homeowner_minute — short seasonal tip from Waves
8. waves_cta — soft call to action (book, call, reply)

Return STRICT JSON with these keys:
{
  "subjectVariants": ["string", "string", "string"],
  "selectedSubject": "string (your best pick from subjectVariants)",
  "previewText": "string, 50-110 chars, complements subject without repeating",
  "sections": {
    "local_intro": "HTML string",
    "fresh_this_week": "HTML string",
    "just_starting": "HTML string",
    "weekend_picks": "HTML string",
    "family_or_low_key_pick": "HTML string",
    "road_trip_pick": "HTML string",
    "homeowner_minute": "HTML string",
    "waves_cta": "HTML string"
  },
  "htmlBody": "string — all sections assembled into one HTML body",
  "textBody": "string — plain-text version of the same content"
}
No prose outside the JSON.`;

      const userPrompt = `Topic / prompt: ${prompt}
${audience ? `Audience: ${audience}` : ''}
${tone ? `Tone: ${tone}` : ''}${eventBlock}`;

      const response = await anthropic.messages.create({
        model: MODELS.WORKHORSE,
        max_tokens: 3000,
        system: flagshipSystemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const text = response.content?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Claude did not return JSON');

      const draft = JSON.parse(jsonMatch[0]);
      const voiceCheck = validateVoice(
        { subject: draft.selectedSubject || draft.subjectVariants?.[0], htmlBody: draft.htmlBody },
        typeConfig.voiceProfile,
      );
      draft.voiceWarnings = voiceCheck.warnings;
      draft.newsletterType = newsletterType;

      // Map flagship output to legacy shape so the compose UI can consume it
      draft.subject = draft.selectedSubject || draft.subjectVariants?.[0] || '';
      return res.json({ success: true, draft });
    }

    // ── Legacy flow: template-guided or free-form ─────────────────────
    const TEMPLATE_GUIDANCE = {
      weekend: `
TEMPLATE: Weekend Lineup
- Lead with an emoji + a punchy, FOMO-friendly weekend headline (think "Your No-Lame-Plans Weekend Starts Here", not "Weekly Update").
- Open with a casual, irreverent hook (1-2 sentences).
- Body: 3-5 SWFL events. Each event uses <h2>[Event name]</h2> followed by <p><strong>[City] · [Day, time]</strong> — [one or two sentences on why it's worth going]</p>.
- Optional final section <h2>One more thing</h2> with a soft pest/lawn tie-in if it fits naturally.
- Sign off "— The Waves crew" (not "Waves Pest Control").
- Tone is neighborly + slightly irreverent; this format is the highest-engagement one historically.`,

      pest_concern: `
TEMPLATE: Pest / Lawn Concern
- Lead with an emoji + concern headline (e.g., "🦟 Mosquitoes are back across SWFL").
- <h2>Why now</h2> — 1-2 sentences on weather/season/lifecycle trigger.
- <h2>Signs to watch for</h2> — <ul><li> with 3-5 specific, visible signs.
- <h2>What to do this week</h2> — 2-3 sentences of practical homeowner advice + soft Waves mention. Don't oversell.
- Sign off "Stay ahead of it, — The Waves crew".`,

      local_spotlight: `
TEMPLATE: Local Spotlight
- Lead with an emoji + food/shop/lifestyle hook.
- Open: 1-2 sentences framing the rundown ("built from what our techs and neighbors are talking about").
- Body: 3-4 spots. Each uses <h2>[Spot name]</h2> followed by <p><strong>[Neighborhood / city]</strong> — [1-2 sentences on why to visit. Drop a vibe or a specific dish]</p>.
- Sign off with a casual closer like "Tell 'em Waves sent you. — The Waves crew".`,

      service_promo: `
TEMPLATE: Service Promo
- Lead with an emoji + a clear, direct offer headline (no clickbait — say the dollar value or % off).
- Open: 1-2 sentences naming the offer, audience, and expiration date.
- <h2>The deal</h2> — exact offer, eligibility, dollar value.
- <h2>What's included</h2> — <ul><li> 3-4 inclusions.
- <h2>How to claim</h2> — clear next step (reply, call) and expiration.
- This is a promotional template — DO end with a clear CTA regardless of the includeCTA setting.
- Sign off "— The Waves crew".`,
    };
    const templateGuidance = TEMPLATE_GUIDANCE[template] || '';

    const systemPrompt = `You draft email newsletters for Waves Pest Control, a family-owned pest control + lawn care company in Southwest Florida (SWFL). Core service area: Bradenton, Parrish, Palmetto, Sarasota, Venice, North Port, Lakewood Ranch.

EVERY NEWSLETTER IS CENTERED ON LOCAL SWFL EVENTS, SEASON, AND COMMUNITY. Do not write generic pest-industry content. Write like a neighbor who happens to run a pest control truck — someone who drives Manatee and Sarasota county roads every day and knows what's happening in town this month.

CURRENT MONTH: ${month}

ALWAYS CONSIDER (pick what's relevant to the topic):
- Local events & seasonal rhythms by month:
  • Jan–Feb: snowbird season peak, cooler mornings, dry lawns, red tide drift
  • Mar: spring break traffic, love bugs starting, citrus bloom
  • Apr: Bradenton Blues Festival week, baseball spring training tail, lawn pre-emergents
  • May: DeSoto Heritage Festival & Grand Parade (Bradenton), mosquito season ramp, no-see-um peak at dawn/dusk
  • Jun: hurricane season begins (Jun 1), afternoon thunderstorms daily, nitrogen blackout begins on lawns (Jun–Sept by county ordinance)
  • Jul: 4th of July on the waterfront, peak rainy season, German roach pressure, palmetto bugs indoors
  • Aug: back-to-school in Manatee/Sarasota schools, peak hurricane risk month, chinch bug damage on St. Augustine
  • Sep: hurricane peak, Siesta Key Crystal Classic (sand sculpture), subterranean termite swarms after storms
  • Oct: snowbirds return, cooler nights, rodent season begins (mice seeking warmth), Halloween on the barrier islands
  • Nov: Sarasota Season of Sculpture, turkey trots, last major hurricane risk tapers, winter annuals go in
  • Dec: holidays, boat parades (Downtown Bradenton Riverwalk, Venice), cooler weather drives indoor pest activity
- SWFL-specific conditions: sandy soil, afternoon thunderstorms, high humidity, salt air near the coast, canal-fed yards
- SWFL pests by relevance: subterranean termites (swarm after rain), German cockroaches, American/palmetto bugs, no-see-ums, salt-marsh mosquitoes, fire ants, silverfish, fleas/ticks, carpenter ants, drywood termites near the coast
- SWFL lawn: St. Augustine (Floratam, Palmetto cultivars), Bahia, chinch bugs, sod webworms, dollar weed, nitrogen blackout rules
- Community tone: Manatee/Sarasota neighbors, retirees + young families, fishing + boating + beach culture

VOICE:
- Warm, neighborly, no corporate jargon
- Owner-operator voice: "we", "our team", "our trucks", first names welcome
- Short sentences. Short paragraphs (2-4 sentences).
- Mention a specific city or landmark by name when natural (not every section)
- Anchor the newsletter in THIS month's reality — weather, events, what people are actually dealing with in their yards and homes right now

AVOID:
- Generic "pest control tips" framing
- National weather or non-FL references
- ALL CAPS, clickbait, corporate tone

FORMAT (HTML body):
- Lead with a SWFL-grounded opening line that references the current season, a local event, or a condition residents are experiencing
- 2-4 short sections, each with an <h2>
- Short paragraphs in <p> tags
- Use <ul><li> for any list
- ${includeCTA ? 'End with ONE clear call to action (book, call, reply)' : 'End with a friendly sign-off — no hard CTA'}
- Sign off from "Waves Pest Control" (or a team member if the prompt names one)
- NO unsubscribe footer (appended automatically)
- NO <html>/<head>/<body> wrapper — just the content markup
${templateGuidance ? `

WHEN A TEMPLATE IS SELECTED, FOLLOW ITS STRUCTURE + VOICE OVER THE GENERIC FORMAT ABOVE:
${templateGuidance}` : ''}

Return STRICT JSON with these keys:
{
  "subject": "string, 30-65 chars, no clickbait, no ALL CAPS — SWFL-grounded when natural",
  "previewText": "string, 50-110 chars, complements subject without repeating",
  "htmlBody": "string, the HTML body as described",
  "textBody": "string, plain-text version of the same content"
}
No prose outside the JSON.`;

    const userPrompt = `Topic / prompt: ${prompt}
${audience ? `Audience: ${audience}` : ''}
${tone ? `Tone: ${tone}` : ''}`;

    const response = await anthropic.messages.create({
      model: MODELS.WORKHORSE,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude did not return JSON');

    const draft = JSON.parse(jsonMatch[0]);
    res.json({ success: true, draft });
  } catch (err) {
    logger.error(`[newsletter] draft-ai failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/newsletter/events — upcoming events from events_raw,
// for the NewsletterPage Dashboard tiles. Query params:
//   days     — forward window in days (default 14, max 90)
//   limit    — max rows (default 12, max 50)
//   city     — optional city filter (matches events_raw.city case-insensitive)
//
// Sorted: dated events ascending by start_at first, then dateless
// (NULL start_at) at the bottom by pulled_at desc. Joins event_sources
// to surface the source name + the source's coverage_geo[0] as a
// fallback "region" when events_raw.city is null.
router.get('/events', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const city = req.query.city ? String(req.query.city).toLowerCase() : null;

    const cutoffMs = Date.now() + days * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs);

    let q = db('events_raw as e')
      .leftJoin('event_sources as s', 's.id', 'e.source_id')
      .select(
        'e.id',
        'e.title',
        'e.description',
        'e.start_at',
        'e.end_at',
        'e.venue_name',
        'e.venue_address',
        'e.city',
        'e.geo_lat',
        'e.geo_lng',
        'e.event_url',
        'e.image_url',
        'e.categories',
        'e.pulled_at',
        's.name as source_name',
        's.coverage_geo as source_coverage_geo',
      )
      // Drop events that already happened more than 2h ago (in case the
      // cron hasn't pruned them yet — same logic as ingestion's recap drop).
      .where(function () {
        this.whereNull('e.start_at').orWhere('e.start_at', '>=', new Date(Date.now() - 2 * 60 * 60 * 1000));
      })
      // Forward window cap so the dashboard never shows events 3 months out.
      .where(function () {
        this.whereNull('e.start_at').orWhere('e.start_at', '<=', cutoff);
      });

    if (city) {
      q = q.whereRaw('LOWER(e.city) = ?', [city]);
    }

    const rows = await q
      .orderByRaw('e.start_at IS NULL') // false (dated) before true (dateless)
      .orderBy('e.start_at', 'asc')
      .orderBy('e.pulled_at', 'desc')
      .limit(limit);

    const events = rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      startAt: r.start_at,
      endAt: r.end_at,
      venueName: r.venue_name,
      venueAddress: r.venue_address,
      city: r.city || (Array.isArray(r.source_coverage_geo) ? r.source_coverage_geo[0] : null),
      geoLat: r.geo_lat != null ? Number(r.geo_lat) : null,
      geoLng: r.geo_lng != null ? Number(r.geo_lng) : null,
      eventUrl: r.event_url,
      imageUrl: r.image_url,
      categories: r.categories || [],
      sourceName: r.source_name,
    }));

    res.json({ events, count: events.length, days, limit });
  } catch (err) {
    next(err);
  }
});

// ── Event Inbox ──────────────────────────────────────────────────────
// Admin curation endpoints for the newsletter content engine's
// freshness-first editorial policy.

// GET /api/admin/newsletter/events/inbox — paginated, filterable event
// list for the Event Inbox UI. Returns events with freshness labels,
// admin status, and source info.
router.get('/events/inbox', async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const { status, freshness, zone, source_id, q, date_from, date_to, sort } = req.query;

    let query = db('events_raw as e')
      .leftJoin('event_sources as s', 's.id', 'e.source_id')
      .select(
        'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
        'e.venue_name', 'e.venue_address', 'e.city', 'e.geo_lat', 'e.geo_lng',
        'e.event_url', 'e.image_url', 'e.categories',
        'e.event_type', 'e.recurrence_type', 'e.freshness_status', 'e.freshness_score',
        'e.admin_status', 'e.suppression_reason',
        'e.last_featured_at', 'e.times_featured',
        'e.region_zone', 'e.family_friendly', 'e.is_free', 'e.price_text',
        'e.pulled_at', 'e.normalized_at',
        's.name as source_name', 's.priority_tier as source_priority_tier',
      );

    // Filters
    if (status && status !== 'all') {
      query = query.where('e.admin_status', status);
    }
    if (freshness === 'fresh') {
      query = query.where('e.freshness_status', 'like', 'fresh_%');
    } else if (freshness === 'stale') {
      query = query.whereIn('e.freshness_status', ['stale_recurring', 'expired']);
    } else if (freshness === 'needs_review') {
      query = query.where('e.freshness_status', 'needs_review');
    }
    if (zone) {
      query = query.where('e.region_zone', zone);
    }
    if (source_id) {
      query = query.where('e.source_id', source_id);
    }
    if (q) {
      query = query.where('e.title', 'ilike', `%${q}%`);
    }
    if (date_from) {
      query = query.where('e.start_at', '>=', parseETDateTime(`${date_from}T00:00:00`));
    }
    if (date_to) {
      query = query.where('e.start_at', '<=', parseETDateTime(`${date_to}T23:59:59`));
    }

    // Sort
    if (sort === 'date') {
      query = query.orderByRaw('e.start_at IS NULL').orderBy('e.start_at', 'asc');
    } else if (sort === 'newest') {
      query = query.orderBy('e.pulled_at', 'desc');
    } else {
      // Default: freshness_score desc, then date asc
      query = query.orderByRaw('e.freshness_score DESC NULLS LAST').orderByRaw('e.start_at ASC NULLS LAST');
    }

    const rows = await query.limit(limit).offset(offset);

    // Status counts for filter tabs
    const counts = await db('events_raw')
      .select('admin_status')
      .count('* as count')
      .groupBy('admin_status');
    const byStatus = { all: 0, pending: 0, approved: 0, rejected: 0, featured: 0 };
    for (const r of counts) {
      byStatus[r.admin_status] = Number(r.count);
      byStatus.all += Number(r.count);
    }

    const events = rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      startAt: r.start_at,
      endAt: r.end_at,
      venueName: r.venue_name,
      venueAddress: r.venue_address,
      city: r.city,
      geoLat: r.geo_lat,
      geoLng: r.geo_lng,
      eventUrl: r.event_url,
      imageUrl: r.image_url,
      categories: r.categories || [],
      eventType: r.event_type,
      recurrenceType: r.recurrence_type,
      freshnessStatus: r.freshness_status,
      freshnessScore: r.freshness_score,
      adminStatus: r.admin_status,
      suppressionReason: r.suppression_reason,
      lastFeaturedAt: r.last_featured_at,
      timesFeatured: r.times_featured,
      regionZone: r.region_zone,
      familyFriendly: r.family_friendly,
      isFree: r.is_free,
      priceText: r.price_text,
      sourceName: r.source_name,
      sourcePriorityTier: r.source_priority_tier,
      eligible: isEligibleForFreshDigest(r),
      compositeScore: scoreFreshEvent(r),
    }));

    res.json({ events, counts: byStatus, limit, offset });
  } catch (err) { next(err); }
});

// PATCH /api/admin/newsletter/events/:id — admin curation
router.patch('/events/:id', async (req, res, next) => {
  try {
    const event = await db('events_raw').where({ id: req.params.id }).first();
    if (!event) return res.status(404).json({ error: 'not found' });

    const {
      adminStatus, eventType, recurrenceType, freshnessStatus,
      suppressionReason, familyFriendly, isFree, regionZone, priceText,
    } = req.body;

    const VALID_ADMIN_STATUSES = ['pending', 'approved', 'rejected', 'featured'];
    const VALID_EVENT_TYPES = ['one_time', 'annual', 'limited_run', 'recurring_series', 'special_edition', 'ongoing', 'unknown'];
    const VALID_RECURRENCE_TYPES = ['none', 'daily', 'weekly', 'monthly', 'seasonal', 'annual', 'custom', 'unknown'];
    const VALID_FRESHNESS = ['fresh_one_time', 'fresh_annual', 'fresh_limited_run_opening', 'fresh_limited_run_closing', 'fresh_series_launch', 'fresh_special_edition', 'stale_recurring', 'expired', 'needs_review'];
    const VALID_ZONES = ['south_sarasota', 'sarasota', 'manatee', 'pinellas', 'tampa'];

    if (adminStatus !== undefined && !VALID_ADMIN_STATUSES.includes(adminStatus)) return res.status(400).json({ error: `invalid adminStatus: ${adminStatus}` });
    if (eventType !== undefined && !VALID_EVENT_TYPES.includes(eventType)) return res.status(400).json({ error: `invalid eventType: ${eventType}` });
    if (recurrenceType !== undefined && !VALID_RECURRENCE_TYPES.includes(recurrenceType)) return res.status(400).json({ error: `invalid recurrenceType: ${recurrenceType}` });
    if (freshnessStatus !== undefined && !VALID_FRESHNESS.includes(freshnessStatus)) return res.status(400).json({ error: `invalid freshnessStatus: ${freshnessStatus}` });
    if (regionZone !== undefined && regionZone !== null && !VALID_ZONES.includes(regionZone)) return res.status(400).json({ error: `invalid regionZone: ${regionZone}` });

    const updates = { updated_at: new Date() };
    if (adminStatus !== undefined) {
      updates.admin_status = adminStatus;
      // Only increment times_featured on transition TO featured
      if (adminStatus === 'featured' && event.admin_status !== 'featured') {
        updates.last_featured_at = new Date();
        updates.times_featured = db.raw('COALESCE(times_featured, 0) + 1');
      }
    }
    if (eventType !== undefined) updates.event_type = eventType;
    if (recurrenceType !== undefined) updates.recurrence_type = recurrenceType;
    if (freshnessStatus !== undefined) updates.freshness_status = freshnessStatus;
    if (suppressionReason !== undefined) updates.suppression_reason = suppressionReason;
    if (familyFriendly !== undefined) updates.family_friendly = familyFriendly;
    if (isFree !== undefined) updates.is_free = isFree;
    if (regionZone !== undefined) updates.region_zone = regionZone;
    if (priceText !== undefined) updates.price_text = priceText;

    // Recompute freshness when type, status, or times_featured changes
    const featureTransition = adminStatus === 'featured' && event.admin_status !== 'featured';
    if (eventType !== undefined || freshnessStatus !== undefined || featureTransition) {
      const { classifyFreshness } = require('../services/event-freshness');

      if (freshnessStatus !== undefined) {
        // Admin explicitly set freshness — use the matching base score
        const { FRESHNESS_SCORES } = require('../services/event-freshness');
        updates.freshness_score = FRESHNESS_SCORES[freshnessStatus] ?? 40;

        // Auto-derive event_type when admin sets a fresh status on an
        // unknown-type event, so eligibility doesn't reject it later
        const resolvedType = eventType || event.event_type;
        if (resolvedType === 'unknown' && freshnessStatus.startsWith('fresh_')) {
          const STATUS_TO_TYPE = {
            fresh_one_time: 'one_time', fresh_annual: 'annual',
            fresh_limited_run_opening: 'limited_run', fresh_limited_run_closing: 'limited_run',
            fresh_series_launch: 'recurring_series', fresh_special_edition: 'special_edition',
          };
          if (STATUS_TO_TYPE[freshnessStatus]) {
            updates.event_type = STATUS_TO_TYPE[freshnessStatus];
          }
        }
      } else {
        // Derive freshness from event type (use incremented count if featuring)
        const nextFeatured = featureTransition ? (event.times_featured || 0) + 1 : event.times_featured;
        const { freshness_status, freshness_score } = classifyFreshness({
          event_type: eventType || event.event_type,
          times_featured: nextFeatured,
          start_at: event.start_at,
          end_at: event.end_at,
        });
        updates.freshness_status = freshness_status;
        updates.freshness_score = freshness_score;
      }
    }

    await db('events_raw').where({ id: req.params.id }).update(updates);
    const updated = await db('events_raw').where({ id: req.params.id }).first();
    res.json({ success: true, event: updated });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/events/bulk-action — approve/reject multiple
router.post('/events/bulk-action', async (req, res, next) => {
  try {
    const { action, ids, suppressionReason } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids required' });
    }
    if (!['approve', 'reject', 'feature', 'reset'].includes(action)) {
      return res.status(400).json({ error: 'action must be approve, reject, feature, or reset' });
    }

    const MAX_BULK = 50;
    const safeIds = ids.slice(0, MAX_BULK).filter(
      (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    );
    if (safeIds.length === 0) {
      return res.status(400).json({ error: 'no valid UUIDs provided' });
    }

    const statusMap = { approve: 'approved', reject: 'rejected', feature: 'featured', reset: 'pending' };
    const updates = {
      admin_status: statusMap[action],
      updated_at: new Date(),
    };
    if (action === 'reject' && suppressionReason) {
      updates.suppression_reason = suppressionReason;
    }
    if (action === 'approve' || action === 'reset') {
      updates.suppression_reason = null;
    }
    if (action === 'feature') {
      updates.last_featured_at = new Date();
    }

    let query = db('events_raw').whereIn('id', safeIds);
    if (action === 'feature') {
      // Only increment times_featured on rows not already featured
      query = query.whereNot('admin_status', 'featured').update({
        ...updates,
        times_featured: db.raw('COALESCE(times_featured, 0) + 1'),
      });
    } else {
      query = query.update(updates);
    }
    const count = await query;

    // Recompute freshness for bulk-featured rows so times_featured
    // changes are reflected in freshness_status/score
    if (action === 'feature' && count > 0) {
      const { classifyFreshness } = require('../services/event-freshness');
      const featured = await db('events_raw')
        .select('id', 'event_type', 'times_featured', 'start_at', 'end_at')
        .whereIn('id', safeIds)
        .where('admin_status', 'featured');
      for (const row of featured) {
        const { freshness_status, freshness_score } = classifyFreshness(row);
        await db('events_raw').where({ id: row.id }).update({
          freshness_status, freshness_score,
        });
      }
    }

    res.json({ success: true, updated: count });
  } catch (err) { next(err); }
});

// GET /api/admin/newsletter/events/sources — source health dashboard
router.get('/events/sources', async (req, res, next) => {
  try {
    const sources = await db('event_sources')
      .select('*')
      .orderBy('priority_tier', 'asc')
      .orderBy('name', 'asc');

    // Event counts per source
    const countsRaw = await db('events_raw')
      .select('source_id')
      .count('* as count')
      .groupBy('source_id');
    const countMap = Object.fromEntries(countsRaw.map((r) => [r.source_id, Number(r.count)]));

    const result = sources.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      feedUrl: s.feed_url,
      feedType: s.feed_type,
      coverageGeo: s.coverage_geo,
      priorityTier: s.priority_tier,
      enabled: s.enabled,
      lastPulledAt: s.last_pulled_at,
      lastPullStatus: s.last_pull_status,
      lastError: s.last_error,
      consecutiveFailures: s.consecutive_failures,
      eventCount: countMap[s.id] || 0,
    }));

    res.json({ sources: result });
  } catch (err) { next(err); }
});

// GET /api/admin/newsletter/events/approved-ids — returns IDs of
// approved/featured events in the upcoming window, for the AI draft
// modal to auto-load into the flagship draft request.
router.get('/events/approved-ids', async (req, res, next) => {
  try {
    const days = Math.min(14, Math.max(1, Number(req.query.days) || 10));
    const todayET = parseETDateTime(`${etDateString()}T00:00:00`);
    const cutoffET = parseETDateTime(`${etDateString(addETDays(new Date(), days))}T23:59:59`);

    const rows = await db('events_raw')
      .select('id', 'admin_status', 'start_at', 'end_at', 'event_url', 'event_type', 'freshness_status', 'times_featured')
      .whereIn('admin_status', ['approved', 'featured'])
      .where('start_at', '>=', todayET)
      .where('start_at', '<=', cutoffET)
      .whereNotNull('event_url')
      .whereNotIn('freshness_status', ['expired', 'stale_recurring'])
      .orderByRaw('CASE WHEN admin_status = \'featured\' THEN 0 ELSE 1 END')
      .orderByRaw('freshness_score DESC NULLS LAST')
      .limit(20);

    const eligible = rows.filter((r) => isEligibleForFreshDigest(r)).slice(0, 12);
    res.json({ ids: eligible.map((r) => r.id), count: eligible.length });
  } catch (err) { next(err); }
});

// ── Digest Planner ───────────────────────────────────────────────────

router.post('/events/digest-plan', async (req, res, next) => {
  try {
    const { weekStart, weekEnd } = req.body || {};
    const now = new Date();
    const nowET = etParts(now);
    const daysUntilThursday = (4 - nowET.dayOfWeek + 7) % 7;
    const defaultStart = addETDays(now, daysUntilThursday);
    const startDate = weekStart
      ? parseETDateTime(`${weekStart}T00:00:00`)
      : parseETDateTime(`${etDateString(defaultStart)}T00:00:00`);
    const endDate = weekEnd
      ? parseETDateTime(`${weekEnd}T23:59:59`)
      : parseETDateTime(`${etDateString(addETDays(startDate, 6))}T23:59:59`);

    const rows = await db('events_raw as e')
      .leftJoin('event_sources as s', 's.id', 'e.source_id')
      .select(
        'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
        'e.venue_name', 'e.city', 'e.event_url',
        'e.event_type', 'e.freshness_status', 'e.freshness_score',
        'e.admin_status', 'e.times_featured',
        'e.region_zone', 'e.family_friendly', 'e.is_free',
        's.name as source_name', 's.priority_tier as source_priority_tier',
      )
      .whereIn('e.admin_status', ['approved', 'featured'])
      .where('e.start_at', '>=', startDate)
      .where('e.start_at', '<=', endDate)
      .whereNotNull('e.event_url')
      .whereNotIn('e.freshness_status', ['expired', 'stale_recurring'])
      .orderByRaw('e.freshness_score DESC NULLS LAST');

    const eligible = rows.filter((r) => isEligibleForFreshDigest(r));
    const scored = eligible.map((r) => ({ ...r, compositeScore: scoreFreshEvent(r) }))
      .sort((a, b) => b.compositeScore - a.compositeScore);
    const suppressed = rows.filter((r) => !isEligibleForFreshDigest(r))
      .map((r) => ({ id: r.id, title: r.title, reason: r.freshness_status }));

    const assigned = new Set();
    const pick = (filter, max) => {
      const result = [];
      for (const ev of scored) {
        if (assigned.has(ev.id)) continue;
        if (filter(ev)) { result.push(ev); assigned.add(ev.id); if (result.length >= max) break; }
      }
      return result;
    };
    const fmt = (ev) => ({
      id: ev.id, title: ev.title, city: ev.city, startAt: ev.start_at, endAt: ev.end_at,
      venueName: ev.venue_name, eventUrl: ev.event_url, eventType: ev.event_type,
      freshnessStatus: ev.freshness_status, regionZone: ev.region_zone,
      familyFriendly: ev.family_friendly, isFree: ev.is_free,
      compositeScore: ev.compositeScore, sourceName: ev.source_name,
    });
    const isWeekend = (ev) => {
      if (!ev.start_at) return false;
      const dow = etParts(new Date(ev.start_at)).dayOfWeek;
      return dow === 5 || dow === 6 || dow === 0;
    };
    const zoneCounts = {};
    for (const ev of scored) { if (ev.region_zone) zoneCounts[ev.region_zone] = (zoneCounts[ev.region_zone] || 0) + 1; }
    const majorityZone = Object.entries(zoneCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

    const sections = {
      fresh_this_week: pick((ev) => ['one_time', 'annual', 'limited_run', 'special_edition'].includes(ev.event_type), 6).map(fmt),
      just_starting: pick((ev) => ev.event_type === 'recurring_series' && (ev.times_featured || 0) <= 2, 2).map(fmt),
      weekend_picks: pick((ev) => isWeekend(ev), 3).map(fmt),
      family_or_low_key_pick: pick((ev) => ev.family_friendly === true || ev.is_free === true, 1).map(fmt),
      road_trip_pick: pick((ev) => ev.region_zone && ev.region_zone !== majorityZone, 1).map(fmt),
    };

    const warnings = [];
    if (sections.fresh_this_week.length < 5) warnings.push(`Only ${sections.fresh_this_week.length} fresh events (recommended minimum 5)`);
    if (sections.family_or_low_key_pick.length === 0) warnings.push('No family-friendly or free pick found');
    if (sections.road_trip_pick.length === 0) warnings.push('No road trip pick found');
    if (sections.just_starting.length === 0) warnings.push('No new recurring series for "Just Starting"');

    res.json({
      weekStart: etDateString(startDate), weekEnd: etDateString(endDate),
      sections, suppressed,
      stats: { totalApproved: rows.length, totalEligible: eligible.length, totalAssigned: assigned.size, totalSuppressed: suppressed.length, zoneCoverage: zoneCounts },
      warnings,
    });
  } catch (err) { next(err); }
});

router.post('/sends/:id/validate', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    let recipientCount = null;
    try {
      const c = await NewsletterSender.buildSubscriberQuery(send.segment_filter).count('* as c').first();
      recipientCount = Number(c?.c || 0);
    } catch (queryErr) {
      logger.error(`[newsletter] validate subscriber count failed: ${queryErr.message}`);
      return res.status(500).json({ error: 'Could not verify subscriber count — try again' });
    }
    const { errors, warnings } = validateNewsletterDraft(send, { recipientCount });
    res.json({ valid: errors.length === 0, errors, warnings });
  } catch (err) { next(err); }
});

module.exports = router;
