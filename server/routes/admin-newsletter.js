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
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const NewsletterSender = require('../services/newsletter-sender');
const crypto = require('crypto');
const { linkManyToCustomers, subscribeOrResubscribe, EMAIL_RE } = require('../services/newsletter-subscribers');
const NewsletterSubscribers = require('../services/newsletter-subscribers');
const { sendConfirmationEmail } = require('../services/newsletter-confirm');
const {
  scoreFreshEvent,
  isEligibleForFreshDigest,
} = require('../services/event-freshness');
const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');
const { computeSendRates, ratesFromTotals } = require('../services/newsletter-analytics');
const { newsletterAutoSendLive } = require('../config/feature-gates');

router.use(adminAuthenticate, requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// GET /sends lists the newest SENDS_LIST_LIMIT rows plus every older row in
// one of these statuses (each still has a cancel/resume/delete action).
const SENDS_LIST_LIMIT = 500;
const ACTIONABLE_SEND_STATUSES = ['draft', 'scheduled', 'sending', 'failed'];

// Every :id route in this router addresses a UUID-backed newsletter row.
// Reject malformed input before Knex/Postgres tries to cast it, yielding a
// stable client error instead of an avoidable database 500. Integer-keyed
// rows use their own param (see /subscribers/:subscriberId) — adding an
// integer route under :id would 400 before its handler runs.
router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'invalid id' });
  next();
});

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
      // An operator deliberately adding this address may bring a waitlist
      // row into sends (Codex #4737 r3 P2); bulk imports never do.
      promoteWaitlist: true,
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
    const { subscribers, source = 'admin_import', preConsented = false } = req.body;
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
    const importStatus = preConsented === true ? 'active' : 'pending';

    // Two-pass: filter to valid rows in JS (so we have a clean count of
    // bad inputs), then a single bulk INSERT ... ON CONFLICT DO NOTHING
    // for everything that survived. Postgres dedupes against the existing
    // unique index on email — we don't pre-query.
    const seen = new Set();
    const rows = [];
    for (const s of subscribers) {
      const email = (s.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) continue;
      if (seen.has(email)) continue;  // dedupe within this CSV
      seen.add(email);
      rows.push({
        email,
        first_name: s.firstName || s.first_name || null,
        last_name: s.lastName || s.last_name || null,
        source,
        status: importStatus,
        // Pending imports must be double-opt-in-ABLE: without a confirmation
        // token the row can never leave 'pending' (and the DOI email below
        // would have no link to send).
        ...(importStatus === 'pending' ? { confirmation_token: crypto.randomUUID() } : {}),
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
      // imported email set, idempotent on already-linked rows. One query,
      // and the SAME twin picker linkToCustomer uses: an unscoped match here
      // could pin an archived profile that the sender then suppresses.
      await linkManyToCustomers(rows.map((r) => r.email));
    }
    const skipped = subscribers.length - inserted;

    // Default (non-preConsented) imports land 'pending' — meaningless unless
    // each address gets its double-opt-in email. Send them here (the import
    // IS the signup event for this list), fire-and-forget and sequential so
    // a big CSV can't stampede SendGrid; each success stamps
    // confirmation_sent_at so the DOI TTL and stale-pending lifecycle apply.
    // Also covers rows stranded pending by older imports (token backfilled).
    let confirmationsQueued = 0;
    if (importStatus === 'pending' && rows.length) {
      const pendingUnconfirmed = await db('newsletter_subscribers')
        .whereIn('email', rows.map((r) => r.email))
        .where({ status: 'pending' })
        .whereNull('confirmation_sent_at')
        .select('id', 'email', 'first_name', 'confirmation_token');
      confirmationsQueued = pendingUnconfirmed.length;
      if (pendingUnconfirmed.length) {
        (async () => {
          let sent = 0;
          for (const sub of pendingUnconfirmed) {
            try {
              if (!sub.confirmation_token) {
                sub.confirmation_token = crypto.randomUUID();
                await db('newsletter_subscribers').where({ id: sub.id }).update({ confirmation_token: sub.confirmation_token, updated_at: new Date() });
              }
              await sendConfirmationEmail(sub);
              await db('newsletter_subscribers').where({ id: sub.id }).update({ confirmation_sent_at: new Date(), updated_at: new Date() });
              sent++;
            } catch (e) {
              logger.error(`[newsletter] import confirmation failed for subscriber id=${sub.id}: ${e.message}`);
            }
          }
          logger.info(`[newsletter] import confirmation drip done: ${sent}/${pendingUnconfirmed.length} sent`);
        })().catch(() => {});
      }
    }

    res.json({ success: true, inserted, skipped, total: subscribers.length, confirmationsQueued });
  } catch (err) { next(err); }
});

// DELETE /api/admin/newsletter/subscribers/:subscriberId — admin unsubscribe.
// Deliberately NOT the shared :id param — newsletter_subscribers.id is an
// INTEGER, and the router-level :id validator rejects non-UUIDs (correct for
// every other row in this router). Same URL shape; integer-validated here.
router.delete('/subscribers/:subscriberId', async (req, res, next) => {
  try {
    const subscriberId = Number(req.params.subscriberId);
    if (!Number.isInteger(subscriberId) || subscriberId <= 0) {
      return res.status(400).json({ error: 'invalid subscriber id' });
    }
    await db('newsletter_subscribers').where({ id: subscriberId }).update({
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
    // `correctable` below reads archived-customer links: repair stale ones
    // first, as every audience read does, so a row whose archived link has a
    // live twin counts as outstanding (codex round 18 P2). Best effort — a
    // failed sweep must not blank the History list.
    try {
      await NewsletterSubscribers.relinkArchivedLinkedSubscribers(db);
    } catch (err) {
      logger.warn(`[newsletter] relink before /sends failed: ${err.message}`);
    }
    // Whether a Resume still has someone to mail: a failed/sent campaign
    // with an outstanding retryable ledger row can have its copy corrected
    // in place and resumed (PATCH correct-and-resume; the same predicate as
    // hasOutstandingDeliveries, codex round 14 P2).
    const outstandingExists = () => NewsletterSender
      .outstandingEligibleDeliveries('newsletter_sends.id', { correlate: true })
      .select(db.raw('1'));
    // Order by effective send date (sent_at for sent rows, otherwise created_at)
    // so Beehiiv-imported historical posts slot into chronological order
    // instead of bunching at "now" by import time.
    const listSends = () => db('newsletter_sends')
      .leftJoin('technicians', 'newsletter_sends.created_by', 'technicians.id')
      .select(
        'newsletter_sends.*',
        'technicians.name as created_by_name',
        db.raw('EXISTS (?) AS has_outstanding', [outstandingExists()]),
      )
      .orderByRaw('COALESCE(newsletter_sends.sent_at, newsletter_sends.created_at) DESC');
    const recentRows = await listSends().limit(SENDS_LIST_LIMIT);
    // A row that still needs an action (edit, cancel, resume or recover)
    // is listed however old it is: past the newest-500 window it would
    // otherwise lose its only entry point. Every such row is older than the
    // window, so appending keeps the date order.
    const recentIds = new Set(recentRows.map((row) => row.id));
    const actionableRows = await listSends().where((q) => {
      q.whereIn('newsletter_sends.status', ACTIONABLE_SEND_STATUSES)
        .orWhere((sent) => sent.where('newsletter_sends.status', 'sent').whereExists(outstandingExists()));
    });
    const rows = [...recentRows, ...actionableRows.filter((row) => !recentIds.has(row.id))];

    // Attach derived engagement rates per send so the History view renders
    // open/click/bounce/unsub/complaint rates without re-deriving the math
    // client-side.
    const sends = rows.map((row) => ({
      ...row,
      rates: computeSendRates(row),
      sending_stale: NewsletterSender.sendingClaimIsStale(row),
      correctable: ['failed', 'sent'].includes(row.status) && row.has_outstanding === true,
    }));

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

    // Event-level click rollup (owner spec 2026-07-28 PR 5): unique
    // clickers per locked event, in lineup position order. Guarded —
    // pre-migration environments just omit the field.
    let eventClicks = null;
    try {
      // Build from the LOCKED LINEUP and left-join click counts, so a
      // genuinely zero-click event (or a fully unclicked tracked send)
      // shows its zeros instead of vanishing — only untracked sends
      // (no evclick tokens in the stored body) omit the rollup.
      const { parseLockedEventIds } = require('../services/newsletter-event-selection');
      const lockedIds = [...new Set(parseLockedEventIds(send.event_ids).map(String))];
      const tracked = String(send.html_body || '').includes('{{evclick:');
      if (lockedIds.length && tracked) {
        const clickRows = await db('newsletter_event_clicks')
          // Human clicks only — scanner prefetches record as 'prefetch'.
          .where({ send_id: req.params.id, kind: 'details' })
          .select('event_id')
          .count('* as clicks')
          .groupBy('event_id');
        const clicksById = new Map(clickRows.map((r) => [String(r.event_id).toLowerCase(), Number(r.clicks)]));
        const titleRows = await db('events_raw').whereIn('id', lockedIds).select('id', 'title');
        const titleById = new Map(titleRows.map((r) => [String(r.id).toLowerCase(), r.title]));
        eventClicks = lockedIds.map((id, position) => ({
          eventId: id,
          title: titleById.get(id.toLowerCase()) || null,
          position,
          clicks: clicksById.get(id.toLowerCase()) || 0,
        }));
      }
    } catch { /* table not migrated yet — omit */ }

    // Reaction-footer rollup — 👍/😐/👎 counts plus the 👎 "what was
    // missing?" tallies. One delivery row per recipient, so these count
    // people (a changed mind overwrites, never double-counts).
    let feedback = null;
    const reactionRows = await db('newsletter_send_deliveries')
      .where({ send_id: req.params.id })
      .whereNotNull('feedback_reaction')
      .select('feedback_reaction')
      .count('* as n')
      .groupBy('feedback_reaction');
    if (reactionRows.length) {
      feedback = { reactions: {}, missing: {} };
      for (const r of reactionRows) feedback.reactions[r.feedback_reaction] = Number(r.n);
      const missingRows = await db('newsletter_send_deliveries')
        .where({ send_id: req.params.id })
        .whereNotNull('feedback_missing')
        .select('feedback_missing')
        .limit(5000);
      for (const row of missingRows) {
        let keys = row.feedback_missing;
        if (typeof keys === 'string') { try { keys = JSON.parse(keys); } catch { keys = []; } }
        for (const k of (Array.isArray(keys) ? keys : [])) {
          feedback.missing[k] = (feedback.missing[k] || 0) + 1;
        }
      }
    }

    res.json({ send, deliveries, variantStats, feedback, eventClicks });
  } catch (err) { next(err); }
});

// DELETE /api/admin/newsletter/sends/:id — delete a draft
router.delete('/sends/:id', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'draft') return res.status(400).json({ error: 'can only delete drafts' });
    await db.transaction(async (trx) => {
      const calendarIds = await trx('newsletter_calendar')
        .where({ send_id: req.params.id })
        .pluck('id');
      const deleted = await trx('newsletter_sends')
        .where({ id: req.params.id, status: 'draft' })
        .del();
      if (!deleted) {
        const err = new Error('campaign changed while it was being deleted');
        err.code = 'SEND_STATE_CONFLICT';
        throw err;
      }
      if (calendarIds.length) {
        // A deliberately deleted weekly campaign stays retired. Leaving a
        // calendar row as drafted + send_id=NULL makes autopilot resurrect it.
        await trx('newsletter_calendar').whereIn('id', calendarIds).update({
          status: 'skipped',
          send_id: null,
          updated_at: new Date(),
        });
      }
    });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'SEND_STATE_CONFLICT') return res.status(409).json({ error: err.message });
    next(err);
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
      // The prepared claim's owner token — without it sendCampaign would
      // mint a different token, fail its own first heartbeat, and strand
      // the campaign in 'sending' until the stale lease.
      claimToken: prepared.claimToken,
    }).catch(async (err) => {
      if (err.code === 'ALREADY_CLAIMED') {
        logger.info(`[newsletter] background resume ${req.params.id} already claimed by another worker — no-op`);
        return;
      }
      logger.error(`[newsletter] background resume ${req.params.id} failed: ${err.message}`, { stack: err.stack });
      try {
        await db('newsletter_sends').where({ id: req.params.id, status: 'sending' }).update({ status: 'failed' });
      } catch { /* swallow */ }
    });

    res.status(202).json({ accepted: true, sendId: req.params.id, status: 'resuming' });
  } catch (err) {
    if (err.code === 'STILL_SENDING' || err.code === 'ALREADY_CLAIMED' || err.code === 'VERSION_CHANGED') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    if (err.code === 'NOT_RESUMABLE' || err.code === 'NOTHING_TO_RESUME' || err.code === 'VALIDATION_FAILED') {
      return res.status(400).json({ error: err.message, code: err.code, errors: err.errors });
    }
    logger.error(`[newsletter] resume dispatch failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/newsletter/sends/:id/cancel-schedule — return a scheduled row to draft
router.post('/sends/:id/cancel-schedule', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'scheduled') return res.status(400).json({ error: 'not scheduled' });
    const cancelled = await db('newsletter_sends').where({ id: send.id, status: 'scheduled' }).update({
      status: 'draft',
      scheduled_for: null,
      // Cancelling an approved schedule invalidates the approval (same as
      // the PATCH and scheduler reverts): the draft must be re-proofed —
      // stale fields would both block a fresh proof (the claim requires
      // NULL proof_sent_at) and let a re-schedule ride the old approval.
      proof_token: null,
      proof_sent_at: null,
      proof_approved_at: null,
      proof_refused_at: null,
      updated_at: new Date(),
    });
    if (!cancelled) return res.status(409).json({ error: 'scheduled send was already claimed; it was not cancelled' });
    // Roll the linked calendar row back to 'drafted' to match the send. With
    // GATE_NEWSLETTER_AUTO_SEND on, or for an issue the switch queued
    // (approved with no approving email) even if it is off now, Cancel
    // schedule skips the week instead: a 'drafted' week gets a fresh proof
    // from the 4:30 AM catch-up, and that proof would queue the issue again
    // (owner 2026-10-30, option A).
    const autoQueued = Boolean(send.proof_approved_at) && !send.proof_approval_email_id;
    await db('newsletter_calendar').where({ send_id: send.id }).update({
      status: (autoQueued || newsletterAutoSendLive()) ? 'skipped' : 'drafted',
      updated_at: new Date(),
    });
    const updated = await db('newsletter_sends').where({ id: send.id }).first();
    res.json({ success: true, send: updated });
  } catch (err) { next(err); }
});

// GET /api/admin/newsletter/sends/:id/quiz-results — per-campaign quiz response
// breakdown for the History view: answer counts (labeled via the quiz config),
// total responses, and the response rate over the campaign's recipients.
router.get('/sends/:id/quiz-results', async (req, res, next) => {
  try {
    const { aggregateQuizResults } = require('../services/newsletter-quiz');
    const sendId = req.params.id;

    const totalRow = await db('newsletter_send_deliveries').where({ send_id: sendId }).count('* as c').first();
    const rows = await db('newsletter_send_deliveries')
      .where({ send_id: sendId })
      .whereNotNull('quiz_answered_at')
      .select('quiz_id', 'quiz_answer')
      .count('* as n')
      .groupBy('quiz_id', 'quiz_answer');

    const agg = aggregateQuizResults({ rows, totalRecipients: Number(totalRow?.c || 0) });
    res.json({ sendId, ...agg });
  } catch (err) { next(err); }
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
    const VALID_FRESHNESS = ['fresh_one_time', 'fresh_annual', 'fresh_limited_run_opening', 'fresh_limited_run_closing', 'fresh_special_edition', 'fresh_series_launch', 'stale_recurring', 'expired', 'needs_review'];
    const VALID_ZONES = ['south_sarasota', 'sarasota', 'manatee', 'pinellas', 'tampa'];

    if (adminStatus !== undefined && !VALID_ADMIN_STATUSES.includes(adminStatus)) return res.status(400).json({ error: `invalid adminStatus: ${adminStatus}` });
    if (eventType !== undefined && !VALID_EVENT_TYPES.includes(eventType)) return res.status(400).json({ error: `invalid eventType: ${eventType}` });
    if (recurrenceType !== undefined && !VALID_RECURRENCE_TYPES.includes(recurrenceType)) return res.status(400).json({ error: `invalid recurrenceType: ${recurrenceType}` });
    if (freshnessStatus !== undefined && !VALID_FRESHNESS.includes(freshnessStatus)) return res.status(400).json({ error: `invalid freshnessStatus: ${freshnessStatus}` });
    if (regionZone !== undefined && regionZone !== null && !VALID_ZONES.includes(regionZone)) return res.status(400).json({ error: `invalid regionZone: ${regionZone}` });

    const updates = { updated_at: new Date() };
    if (adminStatus !== undefined) {
      updates.admin_status = adminStatus;
      if (adminStatus === 'pending') {
        // An operator's return-to-pending is a decision to review it by hand:
        // mark it examined, with durable provenance, so auto-curation never
        // picks it up and re-approves it.
        updates.curated_at = db.raw('COALESCE(curated_at, now())');
        updates.approved_via = 'operator_reset';
      }
      // Featuring is an editorial STAR for the upcoming issue — not ship
      // history. times_featured/last_featured_at advance only in
      // markEventsFeatured when an issue actually sends; incrementing on
      // the click made isEligibleForFreshDigest reject the starred event
      // before it ever shipped (Codex r3 P1).
    }
    if (eventType !== undefined) updates.event_type = eventType;
    if (recurrenceType !== undefined) updates.recurrence_type = recurrenceType;
    if (freshnessStatus !== undefined) updates.freshness_status = freshnessStatus;
    if (suppressionReason !== undefined) updates.suppression_reason = suppressionReason;
    if (familyFriendly !== undefined) updates.family_friendly = familyFriendly;
    if (isFree !== undefined) updates.is_free = isFree;
    if (regionZone !== undefined) updates.region_zone = regionZone;
    if (priceText !== undefined) updates.price_text = priceText;

    // Recompute freshness when type, recurrence, or explicit status changes —
    // a recurrence-only correction (weekly → none, or the reverse) must
    // re-derive freshness_status or the digest SQL gate keeps acting on the
    // stale classification. (Featuring no longer touches the counters, so it
    // no longer triggers a recompute.)
    if (eventType !== undefined || recurrenceType !== undefined || freshnessStatus !== undefined) {
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
            fresh_special_edition: 'special_edition',
            // Manually curated series debut (single-use carve-out) — the
            // digest gate expects the recurring metadata to be honest.
            fresh_series_launch: 'recurring_series',
          };
          if (STATUS_TO_TYPE[freshnessStatus]) {
            updates.event_type = STATUS_TO_TYPE[freshnessStatus];
          }
        }
      } else {
        // Derive freshness from event type (counters untouched by featuring)
        const { freshness_status, freshness_score } = classifyFreshness({
          event_type: eventType || event.event_type,
          recurrence_type: recurrenceType !== undefined ? recurrenceType : event.recurrence_type,
          title: event.title,
          description: event.description,
          times_featured: event.times_featured,
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

    // Refuse an oversized request instead of truncating it: a silent cut
    // let the inbox report 100 events updated when only 50 were. The inbox
    // sends a larger selection in batches of this size.
    const MAX_BULK = 50;
    if (ids.length > MAX_BULK) {
      return res.status(400).json({ error: `at most ${MAX_BULK} ids per request` });
    }
    const safeIds = ids.filter(
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
    if (action === 'reset') {
      // Marked examined, with durable provenance, so auto-curation never
      // re-approves what the operator reset for manual review.
      updates.curated_at = db.raw('COALESCE(curated_at, now())');
      updates.approved_via = 'operator_reset';
    }
    // Featuring is an editorial star, not ship history — counters advance
    // only in markEventsFeatured when an issue actually sends (Codex r3 P1).
    // The updated ids go back to the inbox so a row that was not updated
    // (deleted meanwhile) stays selected instead of being reported done.
    const updatedRows = await db('events_raw').whereIn('id', safeIds).update(updates, ['id']);
    const updatedIds = (updatedRows || []).map((row) => row.id);
    const count = updatedIds.length;

    // Freshness recompute kept for parity with the single-event PATCH: the
    // counters didn't move, but a bulk feature over rows with stale
    // classifications refreshes them from current metadata.
    if (action === 'feature' && count > 0) {
      const { classifyFreshness } = require('../services/event-freshness');
      const featured = await db('events_raw')
        .select('id', 'title', 'description', 'event_type', 'recurrence_type', 'times_featured', 'start_at', 'end_at')
        .whereIn('id', safeIds)
        .where('admin_status', 'featured');
      for (const row of featured) {
        const { freshness_status, freshness_score } = classifyFreshness(row);
        await db('events_raw').where({ id: row.id }).update({
          freshness_status, freshness_score,
        });
      }
    }

    res.json({ success: true, updated: count, updatedIds });
  } catch (err) { next(err); }
});

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
    // Same rule as bulk-action: refuse, never truncate, so the confirm that
    // named the whole selection cannot merge only part of it.
    const MAX_MERGE = 50;
    if (duplicateIds.length > MAX_MERGE) {
      return res.status(400).json({ error: `at most ${MAX_MERGE} duplicates per merge` });
    }
    const dups = [...new Set(
      duplicateIds.filter((id) => typeof id === 'string' && UUID_RE.test(id)),
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

// Shared by both routes below. Default is a DRY RUN — a write needs both
// `dryRun: false` AND `confirm: 'IMPORT'` in the body; anything else
// (including an empty body) returns the dry-run result untouched.
//
// Held push-audit P1 (codex #5165): a confirmed write (dryRun:false) can hit
// per-customer errors (each caught by reconcileCustomers' own guardedEach,
// never aborting the batch) and still return the applied/excluded numbers
// alongside them, silently, at HTTP 200 — nothing in the response shape
// told a caller it was partial. A write with errors.length > 0 now answers
// 422 with an explicit `success: false`; the result object (importable,
// imported, excluded, byCity, projected, errors — id-only, per the module's
// own contract) is otherwise unchanged. Dry runs are never affected.
async function reconcileCustomersHandler(req, res, next) {
  try {
    const { reconcileCustomers } = require('../services/newsletter-list-reconcile');
    const write = req.body?.dryRun === false && req.body?.confirm === 'IMPORT';
    const result = await reconcileCustomers({ dryRun: !write });
    if (write && Array.isArray(result.errors) && result.errors.length > 0) {
      return res.status(422).json({ ...result, success: false });
    }
    res.json(result);
  } catch (err) { next(err); }
}

// POST /api/admin/newsletter/subscribers/import-customers
// SUPERSEDED (see PR body "Superseded behaviour"): used to import EVERY live
// customer with an email — leads included, ignoring marketing_offers and
// suppressions. Now a thin alias for reconcileCustomersHandler, kept so an
// existing no-body caller gets a dry run, not a 404.
router.post('/subscribers/import-customers', reconcileCustomersHandler);

// POST /api/admin/newsletter/subscribers/reconcile-customers
// Filtered customer import — see services/newsletter-list-reconcile.js for
// the candidate/exclusion rules.
router.post('/subscribers/reconcile-customers', reconcileCustomersHandler);

module.exports = router;
