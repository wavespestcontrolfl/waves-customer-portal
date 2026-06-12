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
const { isFlagshipType, requiresClaimValidation } = require('../config/newsletter-types');
const { isEligibleForFreshDigest, scoreFreshEvent, getCurrentNewsletterThursday, getNewsletterWeekOf, defaultTargetSendAt, weekLockKey } = require('../services/event-freshness');
const { parseETDateTime, addETDays, etDateString, etParts } = require('../utils/datetime-et');
const { validateNewsletterDraft } = require('../services/newsletter-validator');
const { createNewsletterDraft } = require('../services/newsletter-draft');
const { buildDigestPlan } = require('../services/newsletter-autopilot');
const { computeSendRates, ratesFromTotals } = require('../services/newsletter-analytics');
const { assertInternalEmailRecipient } = require('../utils/internal-email-recipients');

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
    const { subscribers, source = 'beehiiv_import', preConsented = true } = req.body;
    if (!Array.isArray(subscribers) || subscribers.length === 0) {
      return res.status(400).json({ error: 'subscribers[] required' });
    }
    // Cap the batch so an accidental/oversized paste can't insert an enormous
    // active audience in one request (and to bound the bulk write).
    const MAX_IMPORT = 25000;
    if (subscribers.length > MAX_IMPORT) {
      return res.status(400).json({ error: `Too many rows (${subscribers.length}); max ${MAX_IMPORT} per import — split into batches` });
    }
    // Pre-consented imports (e.g. the Beehiiv migration of already-opted-in
    // subscribers) land 'active'. Pass preConsented:false to import an
    // unverified list as 'pending' so it can't be mailed until each address
    // double-opts-in, rather than silently becoming a sendable audience.
    const importStatus = preConsented === false ? 'pending' : 'active';

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
        status: importStatus,
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

// GET /api/admin/newsletter/sends/latest-autopilot — most recent
// autopilot-generated draft. The compose UI auto-loads this on mount
// so the admin sees the weekly draft without digging through history.
// Must be registered BEFORE /sends/:id so Express doesn't treat
// "latest-autopilot" as an :id param.
router.get('/sends/latest-autopilot', async (req, res, next) => {
  try {
    const now = new Date();
    const nowET = etParts(now);

    // ?type= selects which autopilot lane to hydrate (default: weekly
    // flagship). Each lane gets a freshness window matched to its cadence
    // so stale drafts from previous cycles don't resurface in Compose.
    const type = req.query.type === 'pest-insider-monthly'
      ? 'pest-insider-monthly'
      : 'local-weekly-fresh-events';

    let windowStart;
    if (type === 'pest-insider-monthly') {
      // Current ET month.
      const mm = String(nowET.month).padStart(2, '0');
      windowStart = parseETDateTime(`${nowET.year}-${mm}-01T00:00:00`);
    } else {
      // Current Thursday-anchored week.
      const daysBack = (nowET.dayOfWeek - 4 + 7) % 7; // 0 on Thu, 1 Fri, … 6 Wed
      windowStart = parseETDateTime(`${etDateString(addETDays(now, -daysBack))}T00:00:00`);
    }

    const draft = await db('newsletter_sends')
      .where({ newsletter_type: type, status: 'draft' })
      .whereNull('created_by')
      .where('created_at', '>=', windowStart)
      .orderBy('created_at', 'desc')
      .first();
    res.json({ draft: draft || null });
  } catch (err) { next(err); }
});

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

    // Attach derived engagement rates per send so the History view renders
    // open/click/bounce/unsub/complaint rates without re-deriving the math
    // client-side.
    const sends = rows.map((row) => ({ ...row, rates: computeSendRates(row) }));

    // Pooled aggregate is summed across ALL sent campaigns in the DB — not
    // the capped 500-row window above — so accounts with >500 rows still get
    // accurate lifetime rates (mirrors the uncapped status breakdown below).
    const aggRow = await db('newsletter_sends')
      .where('status', 'sent')
      .where('recipient_count', '>', 0)
      .select(
        db.raw('COUNT(*)::int as "campaignCount"'),
        db.raw('COALESCE(SUM(recipient_count), 0)::int as recipients'),
        db.raw('COALESCE(SUM(delivered_count), 0)::int as delivered'),
        db.raw('COALESCE(SUM(opened_count), 0)::int as opened'),
        db.raw('COALESCE(SUM(clicked_count), 0)::int as clicked'),
        db.raw('COALESCE(SUM(bounced_count), 0)::int as bounced'),
        db.raw('COALESCE(SUM(unsubscribed_count), 0)::int as unsubscribed'),
        db.raw('COALESCE(SUM(complained_count), 0)::int as complained'),
      )
      .first();
    const totals = {
      recipients: Number(aggRow?.recipients || 0),
      delivered: Number(aggRow?.delivered || 0),
      opened: Number(aggRow?.opened || 0),
      clicked: Number(aggRow?.clicked || 0),
      bounced: Number(aggRow?.bounced || 0),
      unsubscribed: Number(aggRow?.unsubscribed || 0),
      complained: Number(aggRow?.complained || 0),
    };
    const aggregate = {
      campaignCount: Number(aggRow?.campaignCount || 0),
      totals,
      rates: ratesFromTotals(totals),
    };

    // Uncapped status breakdown so callers (e.g. the Dashboard's Scheduled
    // tile) don't have to derive counts from the 500-row payload.
    const countRows = await db('newsletter_sends')
      .select('status')
      .count('* as count')
      .groupBy('status');
    const counts = Object.fromEntries(countRows.map((r) => [r.status, Number(r.count)]));

    res.json({ sends, counts, aggregate });
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
    .slice(0, 64);
  const date = etDateString();
  const suffix = require('crypto').randomUUID().slice(0, 6);
  return `${base}-${date}-${suffix}`;
}

// POST /api/admin/newsletter/sends — create a draft
router.post('/sends', async (req, res, next) => {
  try {
    const { subject, subjectB, htmlBody, textBody, previewText, fromName, fromEmail, replyTo, segmentFilter, aiPrompt, newsletterType, autoShareSocial, eventIds } = req.body;
    if (!subject) return res.status(400).json({ error: 'subject required' });

    let normalizedFromEmail;
    try { normalizedFromEmail = normalizeFromEmail(fromEmail); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }

    // Persist the locked event ids so the sender can advance times_featured for
    // the events that shipped. The manual Compose / Digest-Planner flow saves
    // here after /draft-ai (persist:false) returns the locked events — without
    // this the saved send keeps event_ids '[]' and markEventsFeatured no-ops,
    // defeating the recurring-series anti-repeat decay for AI-drafted sends.
    const safeEventIds = Array.isArray(eventIds)
      ? eventIds.filter((id) => typeof id === 'string' && UUID_RE.test(id)).slice(0, 12)
      : [];

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
      auto_share_social: autoShareSocial !== false,
      event_ids: JSON.stringify(safeEventIds),
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

    const { subject, subjectB, htmlBody, textBody, previewText, fromName, fromEmail, replyTo, segmentFilter, aiPrompt, newsletterType, autoShareSocial, eventIds } = req.body;

    // Factual-lock integrity: a flagship ("local-weekly-fresh-events") draft was
    // generated through the fact-locked, hallucination-gated pipeline. Both the
    // /send gate and the scheduler tick only run findHallucinatedClaims for the
    // flagship type, so flipping a flagship send's type away from flagship would
    // silently disable the hard-block ($-amount / efficacy claims would ship).
    // Refuse the change — delete + recreate to genuinely retype.
    if (newsletterType !== undefined
        && isFlagshipType(send.newsletter_type)
        && !isFlagshipType(newsletterType)) {
      return res.status(400).json({
        error: 'Cannot change a fresh-events (flagship) newsletter to another type — it would bypass the factual-locking send gate. Delete and recreate instead.',
      });
    }

    // Validate from_email only when the caller is changing it. Skipping
    // validation on PATCHes that don't touch the field keeps existing
    // drafts editable even if the allowlist contracts.
    let nextFromEmail = send.from_email;
    if (fromEmail !== undefined) {
      try { nextFromEmail = normalizeFromEmail(fromEmail); }
      catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    }

    // event_ids: only overwrite when the client explicitly supplies it (a fresh
    // AI re-draft or template swap changed the event set). An ordinary manual
    // edit — or editing a loaded draft whose ids the client never set — omits
    // it, so the stored locked ids are preserved instead of blanked. Without
    // this, re-drafting a saved campaign would ship a new event set while the
    // old event_ids drove times_featured.
    const nextEventIds = eventIds !== undefined
      ? JSON.stringify((Array.isArray(eventIds) ? eventIds : [])
          .filter((id) => typeof id === 'string' && UUID_RE.test(id)).slice(0, 12))
      : send.event_ids;

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
      auto_share_social: autoShareSocial !== undefined ? autoShareSocial : send.auto_share_social,
      event_ids: nextEventIds,
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
    const testEmail = assertInternalEmailRecipient(
      req.body.email || req.technician?.email || 'contact@wavespestcontrol.com',
      { adminEmail: req.technician?.email },
    );
    // Demo unsubscribe URL — won't resolve to a real subscriber but the link
    // renders correctly and Gmail/Apple Mail will show the native unsub UI.
    const demoUrl = sendgrid.unsubscribeUrl('test-' + send.id);
    // Same wrapper the real send uses (newsletter-sender.js) so the
    // operator's preview matches what subscribers will receive.
    let html = wrapNewsletter({
      body: send.html_body || '',
      unsubscribeUrl: demoUrl,
      preheader: send.preview_text || undefined,
      newsletterType: send.newsletter_type || undefined,
      preferredSourcesCta: true,
    });
    // Resolve the greeting first-name token the way the broadcast does:
    // use the test recipient's subscriber row when one exists, so the
    // operator previews real personalization ("Hey there, Adam!"); strip
    // the token when there's no row. sendOne has no substitutions API,
    // so this is a manual replace.
    const { GREETING_NAME_TOKEN, greetingNameValueFor } = require('../services/newsletter-draft');
    const testSub = await db('newsletter_subscribers')
      .whereRaw('LOWER(email) = ?', [String(testEmail).toLowerCase()])
      .first();
    const greetingValue = greetingNameValueFor(testSub?.first_name);
    html = html.split(GREETING_NAME_TOKEN).join(greetingValue);
    const testText = send.text_body
      ? String(send.text_body).split(GREETING_NAME_TOKEN).join(greetingValue)
      : undefined;

    const result = await sendgrid.sendOne({
      to: testEmail,
      fromEmail: send.from_email,
      fromName: send.from_name,
      subject: `[TEST] ${send.subject}`,
      html,
      text: testText,
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
    res.status(err.status || 500).json({ error: err.message });
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

    // Server-side validation gate for AI-generated sends (flagship +
    // Pest Insider). Hard errors (no subject, no body, hallucinated
    // claims) always block. force=true skips only the 0-recipient check
    // (existing contract) — not structural errors.
    if (requiresClaimValidation(send.newsletter_type)) {
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
    // Keep the calendar lifecycle in lockstep with the linked send so the
    // documented state machine self-drives (drafted → scheduled → sent)
    // instead of relying on manual PATCHes.
    await db('newsletter_calendar').where({ send_id: send.id }).update({ status: 'scheduled', updated_at: new Date() });
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
    // Roll the linked calendar row back to 'drafted' to match the send.
    await db('newsletter_calendar').where({ send_id: send.id }).update({ status: 'drafted', updated_at: new Date() });
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
    // Previews have no recipient — drop the greeting-name token so the
    // operator never sees a literal {{greeting-name}} in the dialog.
    const { stripGreetingNameToken } = require('../services/newsletter-draft');
    const html = wrapNewsletter({
      body: stripGreetingNameToken(htmlBody || ''),
      unsubscribeUrl: demoUrl,
      preheader: previewText || undefined,
      newsletterType: newsletterType || undefined,
      preferredSourcesCta: true,
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
//   template: 'weekend' (only remaining template). Used when
//     newsletterType is absent (backward compat).
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
    // Delegates to the shared createNewsletterDraft() service (persist:false
    // for a preview the operator reviews before saving). This is the SAME
    // path the autopilot uses, so manual Compose drafts get the same
    // DB-locked event facts — AI-supplied dates/venues/URLs are overwritten
    // from events_raw, not trusted from the model.
    if (isFlagshipType(newsletterType)) {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let resolvedEventIds;
      if (Array.isArray(eventIds) && eventIds.length > 0) {
        resolvedEventIds = eventIds.filter((id) => typeof id === 'string' && UUID_RE.test(id));
        if (resolvedEventIds.length === 0) {
          return res.status(400).json({ error: 'eventIds must be valid UUIDs' });
        }
      } else {
        // One-click "Draft With AI" sends no events. Auto-source this week's
        // approved/eligible events (same query the autopilot uses) so the
        // flagship draft stays DB-locked instead of inviting the model to
        // invent events.
        const { scored } = await buildDigestPlan();
        resolvedEventIds = scored.slice(0, 12).map((ev) => ev.id);
      }

      if (resolvedEventIds.length === 0) {
        return res.status(400).json({
          error: 'No approved events available for this week. Approve events in the Events tab or build a plan in the Digest Planner before drafting a flagship newsletter.',
        });
      }

      const { draft } = await createNewsletterDraft({
        prompt,
        eventIds: resolvedEventIds,
        newsletterType,
        audience,
        tone,
        includeCTA,
        persist: false,
      });
      // Return the locked event ids so the Compose flow can carry them into
      // the /sends save (the saved row needs them for times_featured tracking).
      const lockedEventIds = (draft.events || []).map((e) => e.eventId).filter(Boolean);
      return res.json({ success: true, draft, eventIds: lockedEventIds });
    }

    // ── Pest Insider flow: structured humor-sandwich draft ────────────
    // Same shared service as the monthly autopilot (persist:false preview)
    // so manual Compose drafts get the identical prompt, sanitization, and
    // assembler instead of the legacy free-form flow below.
    if (newsletterType === 'pest-insider-monthly') {
      const { draft } = await createNewsletterDraft({
        prompt,
        newsletterType,
        audience,
        tone,
        includeCTA,
        persist: false,
      });
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
        'e.approved_via', 'e.curated_at', 'e.curation_note',
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
      approvedVia: r.approved_via,
      curatedAt: r.curated_at,
      curationNote: r.curation_note,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/admin/newsletter/events/merge — collapse cross-source duplicate
// events into one survivor. The losing rows are marked admin_status='rejected'
// (which already excludes them from the queue + digest) with merged_into set
// to the primary, and any newsletter_calendar.event_ids referencing them are
// rewritten to the primary so planned weeks don't lose the event.
router.post('/events/merge', async (req, res, next) => {
  try {
    const { primaryId, duplicateIds } = req.body || {};
    if (typeof primaryId !== 'string' || !UUID_RE.test(primaryId)) {
      return res.status(400).json({ error: 'primaryId must be a valid event UUID' });
    }
    if (!Array.isArray(duplicateIds) || duplicateIds.length === 0) {
      return res.status(400).json({ error: 'duplicateIds required' });
    }
    const MAX_MERGE = 50;
    const dups = [...new Set(
      duplicateIds.slice(0, MAX_MERGE).filter((id) => typeof id === 'string' && UUID_RE.test(id)),
    )].filter((id) => id !== primaryId);
    if (dups.length === 0) {
      return res.status(400).json({ error: 'no valid duplicate UUIDs distinct from primaryId' });
    }

    // All rows must exist; primary must not itself already be merged away.
    const rows = await db('events_raw')
      .select('id', 'merged_into')
      .whereIn('id', [primaryId, ...dups]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const primary = byId.get(primaryId);
    if (!primary) return res.status(404).json({ error: 'primary event not found' });
    if (primary.merged_into) {
      return res.status(409).json({ error: 'primary event is itself already merged into another event' });
    }
    const presentDups = dups.filter((id) => byId.has(id));
    if (presentDups.length === 0) {
      return res.status(404).json({ error: 'no duplicate events found' });
    }

    // A duplicate already merged into a DIFFERENT primary (stale UI / concurrent
    // request) must not be silently re-pointed — that would corrupt provenance
    // and leave already-rewritten calendars inconsistent. Reject the request.
    const conflicts = presentDups.filter((id) => {
      const mi = byId.get(id).merged_into;
      return mi && mi !== primaryId;
    });
    if (conflicts.length > 0) {
      return res.status(409).json({
        error: 'some events are already merged into a different primary',
        conflicts,
      });
    }
    // Duplicates already merged into THIS primary are a no-op (idempotent).
    const toMerge = presentDups.filter((id) => byId.get(id).merged_into !== primaryId);
    if (toMerge.length === 0) {
      return res.json({ success: true, primaryId, merged: 0, calendarsUpdated: 0, alreadyMerged: presentDups.length });
    }

    // Shared, advisory-locked merge transaction (also used by the automated
    // cross-source dedup cron) — see server/services/event-dedup.js.
    const { mergeEvents } = require('../services/event-dedup');
    const { merged, calendarsUpdated } = await mergeEvents(primaryId, toMerge);

    res.json({ success: true, primaryId, merged, calendarsUpdated });
  } catch (err) { next(err); }
});

// GET /api/admin/newsletter/events/duplicates — suggested duplicate clusters
// among pending/approved events in the upcoming window, for the Event Inbox
// merge affordance. Detection is conservative (same normalized title + ET day
// + city) to keep false positives near zero.
router.get('/events/duplicates', async (req, res, next) => {
  try {
    const { findDuplicateClusters } = require('../services/event-duplicates');
    const days = Math.min(120, Math.max(1, Number(req.query.days) || 60));
    const startET = parseETDateTime(`${etDateString()}T00:00:00`);
    const endET = parseETDateTime(`${etDateString(addETDays(new Date(), days))}T23:59:59`);

    const rows = await db('events_raw as e')
      .leftJoin('event_sources as s', 's.id', 'e.source_id')
      .select(
        'e.id', 'e.title', 'e.start_at', 'e.city', 'e.venue_name',
        'e.event_url', 'e.image_url', 'e.admin_status', 'e.pulled_at',
        's.name as source_name',
      )
      .whereIn('e.admin_status', ['pending', 'approved', 'featured'])
      .whereNull('e.merged_into')
      .where('e.start_at', '>=', startET)
      .where('e.start_at', '<=', endET);

    const clusters = findDuplicateClusters(rows).map((c) => ({
      key: c.key,
      suggestedPrimaryId: c.suggestedPrimaryId,
      events: c.events.map((e) => ({
        id: e.id, title: e.title, startAt: e.start_at, city: e.city,
        venue: e.venue_name, sourceName: e.source_name,
        hasImage: !!e.image_url, hasUrl: !!e.event_url, adminStatus: e.admin_status,
      })),
    }));

    res.json({ clusters, clusterCount: clusters.length });
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
      consecutiveZeroYields: s.consecutive_zero_yields ?? 0,
      lastYieldCount: s.last_yield_count,
      lastNonzeroYieldAt: s.last_nonzero_yield_at,
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
      .whereNull('merged_into')
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
    const daysUntilThursday = (4 - nowET.dayOfWeek + 7) % 7; // 0 on Thu, 3 on Mon, 6 on Fri
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
      .whereNull('e.merged_into')
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

// ── Blog cross-publish ──────────────────────────────────────────

// PATCH /api/admin/newsletter/sends/:id/blog-convertible
// Mark a sent newsletter as blog-worthy (or unmark it).
router.patch('/sends/:id/blog-convertible', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'sent') return res.status(400).json({ error: 'only sent newsletters can be marked for blog' });

    const { convertible } = req.body;
    if (typeof convertible !== 'boolean') {
      return res.status(400).json({ error: 'convertible must be a boolean' });
    }
    await db('newsletter_sends').where({ id: req.params.id }).update({
      blog_convertible: convertible,
      updated_at: new Date(),
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/admin/newsletter/sends/:id/blog-export
// Export a sent newsletter as blog-ready content with v2 frontmatter.
router.get('/sends/:id/blog-export', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id, status: 'sent' }).first();
    if (!send) return res.status(404).json({ error: 'not found' });

    if (!send.blog_convertible) {
      return res.status(409).json({ error: 'Newsletter must be marked as blog-convertible before export' });
    }

    // Generate blog-ready frontmatter + content
    const slug = send.slug || send.id;
    const sentDate = send.sent_at ? etDateString(new Date(send.sent_at)) : etDateString();

    // Strip HTML to markdown-ish content (basic conversion)
    const bodyHtml = send.html_body || '';
    const bodyText = bodyHtml
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
      .replace(/<strong>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<em>(.*?)<\/em>/gi, '*$1*')
      .replace(/<a[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
      .replace(/<li>(.*?)<\/li>/gi, '- $1\n')
      .replace(/<ul>|<\/ul>|<ol>|<\/ol>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p>(.*?)<\/p>/gi, '$1\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const frontmatter = {
      schemaVersion: 2,
      title: send.subject,
      slug: `/newsletter/${slug}/`,
      meta_description: (send.preview_text || '').slice(0, 160),
      primary_keyword: 'local events southwest florida',
      category: 'seasonal',
      post_type: 'seasonal',
      service_areas_tag: ['Bradenton', 'Sarasota', 'Venice', 'North Port', 'Lakewood Ranch'],
      author: {
        name: 'The Waves Crew',
        role: 'Newsletter Team',
      },
      published: sentDate,
      updated: sentDate,
      review_cadence: 'quarterly',
      canonical: `https://www.wavespestcontrol.com/newsletter/${slug}/`,
      schema_types: ['Article'],
      newsletter_source: {
        send_id: send.id,
        newsletter_type: send.newsletter_type,
        sent_at: send.sent_at,
      },
    };

    // Mark as exported
    await db('newsletter_sends').where({ id: send.id }).update({
      blog_exported_at: new Date(),
      updated_at: new Date(),
    });

    const escYaml = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

    const yaml = Object.entries(frontmatter)
      .map(([k, v]) => {
        if (typeof v === 'object' && !Array.isArray(v)) {
          const inner = Object.entries(v).map(([ik, iv]) => `  ${ik}: "${escYaml(iv)}"`).join('\n');
          return `${k}:\n${inner}`;
        }
        if (Array.isArray(v)) {
          return `${k}:\n${v.map(i => `  - "${escYaml(i)}"`).join('\n')}`;
        }
        return `${k}: "${escYaml(v)}"`;
      })
      .join('\n');

    const markdown = `---\n${yaml}\n---\n\n${bodyText}`;

    res.json({
      success: true,
      frontmatter,
      markdown,
      htmlBody: send.html_body,
      filename: `${slug}.md`,
    });
  } catch (err) { next(err); }
});

// ── Regional zone distribution ──────────────────────────────────────

// GET /api/admin/newsletter/subscribers/zone-distribution
// Returns subscriber count by region_zone for active subscribers.
router.get('/subscribers/zone-distribution', async (req, res, next) => {
  try {
    const rows = await db('newsletter_subscribers')
      .where({ status: 'active' })
      .select('region_zone')
      .count('* as count')
      .groupBy('region_zone')
      .orderBy('count', 'desc');

    const distribution = {};
    let total = 0;
    for (const r of rows) {
      const zone = r.region_zone || 'unknown';
      distribution[zone] = Number(r.count);
      total += Number(r.count);
    }

    res.json({ distribution, total });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/subscribers/import-customers
// Imports all customers with email addresses as newsletter subscribers.
// Skips duplicates (existing subscribers by email). Links customer_id.
// Derives region_zone from customer city.
router.post('/subscribers/import-customers', async (req, res, next) => {
  try {
    const { cityToZone } = require('../services/event-freshness');

    // Get all customers with emails
    const customers = await db('customers')
      .whereNotNull('email')
      .where('email', '!=', '')
      .select('id', 'email', 'first_name', 'last_name', 'city');

    let imported = 0, skipped = 0, errors = 0;
    for (const c of customers) {
      try {
        // Skip subscribers who opted out OR are mid-double-opt-in — calling
        // subscribeOrResubscribe with requireConfirmation:false would promote
        // pending rows to active, bypassing the confirmation they started.
        const existing = await db('newsletter_subscribers')
          .where({ email: c.email.trim().toLowerCase() })
          .first();
        if (existing && (existing.status === 'unsubscribed' || existing.status === 'pending')) {
          skipped++;
          continue;
        }

        const result = await subscribeOrResubscribe({
          email: c.email,
          firstName: c.first_name || null,
          lastName: c.last_name || null,
          source: 'customer_import',
          strict: false,
          requireConfirmation: false,
          linkCustomer: true,
        });

        if (result.action === 'created' || result.action === 'resubscribed') {
          imported++;
        } else {
          skipped++;
        }

        // Always backfill region_zone if missing (covers already_active too)
        const zone = cityToZone(c.city);
        if (zone && result.subscriber?.id) {
          await db('newsletter_subscribers')
            .where({ id: result.subscriber.id })
            .whereNull('region_zone')
            .update({ region_zone: zone });
        }
      } catch (e) {
        errors++;
        logger.error(`[newsletter] import customer id=${c.id} failed: ${e.message}`);
      }
    }

    res.json({ success: true, imported, skipped, errors, total: customers.length });
  } catch (err) { next(err); }
});

// ── Editorial Calendar ──────────────────────────────────────────────

// GET /api/admin/newsletter/calendar
router.get('/calendar', async (req, res, next) => {
  try {
    const rawPast = Number(req.query.pastWeeks ?? 4);
    const pastWeeks = Math.min(12, Math.max(0, Math.floor(Number.isNaN(rawPast) ? 4 : rawPast)));
    const rawFuture = Number(req.query.futureWeeks ?? 12);
    const futureWeeks = Math.min(26, Math.max(1, Math.floor(Number.isNaN(rawFuture) ? 12 : rawFuture)));

    const currentThursday = getCurrentNewsletterThursday();

    // Generate all Thursday dates in the window (ET-safe)
    const baseDate = parseETDateTime(`${currentThursday}T12:00:00`);
    const allWeeks = [];
    for (let i = -pastWeeks; i < futureWeeks; i++) {
      allWeeks.push(etDateString(addETDays(baseDate, i * 7)));
    }

    // Fetch existing calendar rows
    const rows = await db('newsletter_calendar as cal')
      .leftJoin('newsletter_sends as ns', 'ns.id', 'cal.send_id')
      .select(
        'cal.*',
        'ns.subject as send_subject',
        'ns.status as send_status',
        'ns.recipient_count as send_recipient_count',
        'ns.delivered_count as send_delivered_count',
        'ns.opened_count as send_opened_count',
        'ns.clicked_count as send_clicked_count',
        'ns.sent_at as send_sent_at',
      )
      .whereIn('cal.week_of', allWeeks);

    const rowMap = {};
    for (const r of rows) {
      // pg returns the week_of DATE as a local-midnight JS Date. Key off its
      // LOCAL parts, not toISOString() — toISOString is UTC and would shift the
      // calendar day on a server ahead of UTC (the keys here are ET YYYY-MM-DD).
      const wk = r.week_of instanceof Date
        ? `${r.week_of.getFullYear()}-${String(r.week_of.getMonth() + 1).padStart(2, '0')}-${String(r.week_of.getDate()).padStart(2, '0')}`
        : r.week_of;
      rowMap[wk] = r;
    }

    // Build response with placeholders for missing weeks
    const calendar = allWeeks.map((weekOf) => {
      const row = rowMap[weekOf];
      if (row) {
        return {
          id: row.id,
          weekOf: weekOf,
          topic: row.topic,
          notes: row.notes,
          homeownerMinuteTopic: row.homeowner_minute_topic,
          targetSendAt: row.target_send_at,
          status: row.status,
          sendId: row.send_id,
          eventIds: row.event_ids || [],
          isPlaceholder: false,
          send: row.send_id ? {
            subject: row.send_subject,
            status: row.send_status,
            recipientCount: row.send_recipient_count,
            deliveredCount: row.send_delivered_count,
            openedCount: row.send_opened_count,
            clickedCount: row.send_clicked_count,
            sentAt: row.send_sent_at,
          } : null,
        };
      }
      return {
        id: null,
        weekOf: weekOf,
        topic: null,
        notes: null,
        homeownerMinuteTopic: null,
        targetSendAt: null,
        status: 'planned',
        sendId: null,
        eventIds: [],
        isPlaceholder: true,
        send: null,
      };
    });

    res.json({ calendar, currentWeek: currentThursday });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/calendar
router.post('/calendar', async (req, res, next) => {
  try {
    const { weekOf, topic, notes, homeownerMinuteTopic, targetSendAt, eventIds } = req.body;
    if (!weekOf || !/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) {
      return res.status(400).json({ error: 'weekOf must be YYYY-MM-DD format' });
    }

    // Validate Thursday
    const d = new Date(weekOf + 'T12:00:00Z');
    if (isNaN(d.getTime())) return res.status(400).json({ error: 'weekOf is not a valid date' });
    // Round-trip check: ensure the date didn't normalize (e.g. Feb 30 → Mar 2)
    if (d.toISOString().split('T')[0] !== weekOf) {
      return res.status(400).json({ error: 'weekOf is not a valid calendar date' });
    }
    if (d.getUTCDay() !== 4) return res.status(400).json({ error: 'weekOf must be a Thursday' });

    // Validate eventIds
    if (eventIds !== undefined) {
      if (!Array.isArray(eventIds)) return res.status(400).json({ error: 'eventIds must be an array' });
      if (eventIds.length > 12) return res.status(400).json({ error: 'eventIds max 12' });
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!eventIds.every(id => typeof id === 'string' && uuidRe.test(id))) {
        return res.status(400).json({ error: 'eventIds must be valid UUIDs' });
      }
    }

    let sendAt;
    if (targetSendAt) {
      if (typeof targetSendAt !== 'string') return res.status(400).json({ error: 'targetSendAt must be a string' });
      sendAt = parseETDateTime(targetSendAt);
      if (isNaN(sendAt.getTime())) return res.status(400).json({ error: 'Invalid targetSendAt format' });
    } else {
      sendAt = defaultTargetSendAt(weekOf);
    }

    const [row] = await db('newsletter_calendar')
      .insert({
        week_of: weekOf,
        topic: topic || null,
        notes: notes || null,
        homeowner_minute_topic: homeownerMinuteTopic || null,
        target_send_at: sendAt,
        event_ids: JSON.stringify(eventIds || []),
      })
      .onConflict('week_of')
      .merge({
        topic: topic !== undefined ? (topic || null) : db.raw('newsletter_calendar.topic'),
        notes: notes !== undefined ? (notes || null) : db.raw('newsletter_calendar.notes'),
        homeowner_minute_topic: homeownerMinuteTopic !== undefined ? (homeownerMinuteTopic || null) : db.raw('newsletter_calendar.homeowner_minute_topic'),
        target_send_at: targetSendAt ? sendAt : db.raw('newsletter_calendar.target_send_at'),
        event_ids: eventIds !== undefined ? JSON.stringify(eventIds) : db.raw('newsletter_calendar.event_ids'),
        updated_at: db.fn.now(),
      })
      .returning('*');

    res.json({ success: true, entry: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/newsletter/calendar/:id
router.patch('/calendar/:id', async (req, res, next) => {
  try {
    const entry = await db('newsletter_calendar').where({ id: req.params.id }).first();
    if (!entry) return res.status(404).json({ error: 'not found' });

    const { topic, notes, homeownerMinuteTopic, targetSendAt, eventIds, status } = req.body;

    const updates = { updated_at: new Date() };
    if (topic !== undefined) updates.topic = topic || null;
    if (notes !== undefined) updates.notes = notes || null;
    if (homeownerMinuteTopic !== undefined) updates.homeowner_minute_topic = homeownerMinuteTopic || null;
    if (targetSendAt !== undefined) {
      if (!targetSendAt) return res.status(400).json({ error: 'targetSendAt cannot be null' });
      if (typeof targetSendAt !== 'string') return res.status(400).json({ error: 'targetSendAt must be a string' });
      const parsed = parseETDateTime(targetSendAt);
      if (isNaN(parsed.getTime())) return res.status(400).json({ error: 'Invalid targetSendAt format' });
      updates.target_send_at = parsed;
    }
    if (status !== undefined) {
      const VALID = ['planned', 'drafted', 'scheduled', 'sent', 'skipped'];
      if (!VALID.includes(status)) return res.status(400).json({ error: 'invalid status' });
      // 'scheduled'/'sent' are system-derived from the linked send lifecycle
      // (POST /schedule and sendCampaign drive them). Hand-setting them on a
      // row with no send_id makes the Thursday autopilot skip that week — it
      // treats scheduled/sent as "already handled" and returns early — while
      // no newsletter actually exists, a silent missed week with no alert.
      if (['scheduled', 'sent'].includes(status) && !entry.send_id) {
        return res.status(400).json({ error: `Cannot set status '${status}' on a calendar entry with no linked send — schedule or send the draft instead.` });
      }
      updates.status = status;
    }
    if (eventIds !== undefined) {
      if (!Array.isArray(eventIds) || eventIds.length > 12) {
        return res.status(400).json({ error: 'eventIds must be array (max 12)' });
      }
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!eventIds.every(id => typeof id === 'string' && uuidRe.test(id))) {
        return res.status(400).json({ error: 'eventIds must be valid UUIDs' });
      }
      updates.event_ids = JSON.stringify(eventIds);
    }

    await db('newsletter_calendar').where({ id: req.params.id }).update(updates);
    const updated = await db('newsletter_calendar').where({ id: req.params.id }).first();
    res.json({ success: true, entry: updated });
  } catch (err) { next(err); }
});

// ── Calendar → Draft ────────────────────────────────────────────────

router.post('/calendar/:id/draft-from-plan', aiDraftLimiter, async (req, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      // Read week_of first (no row lock) to derive the per-week advisory-lock
      // key, then take that lock BEFORE the forUpdate. Acquiring the advisory
      // lock first in BOTH this path and the autopilot avoids a lock-order
      // deadlock (autopilot takes the advisory lock before touching any row).
      const wk = await trx('newsletter_calendar')
        .where({ id: req.params.id })
        .first(trx.raw("to_char(week_of, 'YYYY-MM-DD') as week_of"));
      if (!wk) {
        const err = new Error('not found');
        err.status = 404;
        throw err;
      }
      await trx.raw('SELECT pg_advisory_xact_lock(?)', [weekLockKey(wk.week_of)]);

      const calendar = await trx('newsletter_calendar')
        .where({ id: req.params.id })
        .forUpdate()
        .first();

      // Idempotent: return existing send if already drafted
      if (calendar.send_id) {
        const existingSend = await trx('newsletter_sends')
          .where({ id: calendar.send_id })
          .first();
        return { existing: true, send: existingSend };
      }

      if (calendar.status === 'skipped') {
        const err = new Error('Cannot draft a skipped week');
        err.status = 400;
        throw err;
      }

      // Adopt an autopilot draft created for this same week instead of making a
      // second one. The Thursday cron may have produced a draft while this
      // request waited on the advisory lock, and it links the calendar OUTSIDE
      // its lock — so calendar.send_id can still read null here even though a
      // draft exists. Same dedup the autopilot uses (flagship, status draft,
      // created_by NULL), bounded to this week's window so drafting a non-current
      // week can't adopt the current week's draft.
      const weekStart = parseETDateTime(`${wk.week_of}T00:00:00`);
      const weekEnd = parseETDateTime(`${etDateString(addETDays(weekStart, 7))}T00:00:00`);
      const autopilotDraft = await trx('newsletter_sends')
        .where({ newsletter_type: 'local-weekly-fresh-events', status: 'draft' })
        .whereNull('created_by')
        .where('created_at', '>=', weekStart)
        .where('created_at', '<', weekEnd)
        .first();
      if (autopilotDraft) {
        await trx('newsletter_calendar')
          .where({ id: calendar.id })
          .update({ send_id: autopilotDraft.id, status: 'drafted', updated_at: trx.fn.now() });
        return { existing: true, send: autopilotDraft };
      }

      // Build prompt from calendar plan
      const eventIds = Array.isArray(calendar.event_ids) ? calendar.event_ids : [];
      const prompt = calendar.topic
        ? `This week's theme: ${calendar.topic}. Fresh events from North Port to Tampa.${calendar.homeowner_minute_topic ? ` Homeowner Minute: ${calendar.homeowner_minute_topic}.` : ''}`
        : `Fresh events this week from North Port to Tampa.${calendar.homeowner_minute_topic ? ` Homeowner Minute: ${calendar.homeowner_minute_topic}.` : ''}`;

      const { send } = await createNewsletterDraft({
        prompt,
        eventIds,
        homeownerMinuteTopic: calendar.homeowner_minute_topic,
        topic: calendar.topic,
        newsletterType: 'local-weekly-fresh-events',
        audience: 'Waves subscribers — North Port to Tampa',
        tone: 'Neighborly, FOMO-driven, local friend energy',
        includeCTA: true,
        trx,
      });

      // Link send to calendar
      await trx('newsletter_calendar')
        .where({ id: calendar.id })
        .update({
          send_id: send.id,
          status: 'drafted',
          updated_at: trx.fn.now(),
        });

      return { existing: false, send };
    });

    if (result.existing) {
      return res.json({ success: true, existing: true, send: result.send });
    }
    res.json({ success: true, existing: false, send: result.send });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
