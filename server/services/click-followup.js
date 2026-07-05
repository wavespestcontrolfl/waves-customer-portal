/**
 * Click-followup action queue — clicked-but-didn't-book.
 *
 * A human click on an outbound estimate/booking short link (short_code_clicks,
 * part A of the click-tracking lane) is the highest-intent signal we get short
 * of an actual booking: the customer re-opened their quote and then went
 * quiet. This cron turns those clicks into PENDING message_drafts
 * (intent='click_followup') that the owner reviews in /admin/drafts.
 *
 * THIS SERVICE NEVER SENDS ANYTHING. It deliberately imports nothing from the
 * messaging send pipeline (the NO-SEND test pins this at the source level) —
 * the draft row is the terminal artifact, and the only path to a customer is
 * the owner approving the draft in /admin/drafts (which runs the full
 * messaging policy pipeline at send time). Because nothing sends, there is
 * no quiet-hours gate here either.
 *
 * Candidate = a human click, 4h–72h old (fresher than 4h: they may still be
 * reading; older than 72h: the moment is gone), on a short link with
 * kind IN ('estimate','booking') that resolves to an estimates row. Booking
 * links minted from booking_intents are deliberately excluded — the
 * booking-abandon-recovery lane already chases those and stacking a second
 * nudge on the same abandon would double-touch the prospect.
 *
 * Suppression lives in the SHARED pre-send gate (click-followup-gate.js),
 * which this cron evaluates at draft time and admin-drafts re-evaluates at
 * approval time — conversion (customer / lead-side / phone-evidence, never
 * estimate status='accepted'), opt-out/landline, 48h-outbound, reply-pause,
 * and cadence-due (incl. the gated deposit-abandonment stage). See the gate
 * module for the verdict codes and both callers' mappings.
 *
 * The click_followup_actions row is the atomic claim (partial unique indexes:
 * one open action per customer / per lead) AND the audit trail — see
 * migration 20260705000120. Actions are keyed per CLICK
 * (short_code_click_id): a fresh re-click after a terminal outcome
 * re-qualifies; contacts are deduped by customer → lead (resolved via
 * estimate-lead-linkage for lead-only estimates) → last-10 phone.
 *
 * Gated behind GATE_CLICK_FOLLOWUP (fails CLOSED everywhere): off → the cron
 * only shadow-logs candidate counts, writing nothing, so volume can be judged
 * before the owner's drafts queue grows a new lane. Runs from scheduler.js
 * every 30 min under runExclusive.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { createTrackedShortLink } = require('./short-url');
const { leadIdForEstimate } = require('./estimate-lead-linkage');
// The shared pre-send guard stack. The SAME gate re-runs at approval time in
// routes/admin-drafts.js, so every suppression this queue applies at draft
// time automatically has its twin when the owner clicks approve.
const {
  evaluateClickFollowupGate,
  cadenceStageDueSoon,
  depositStageDueSoon,
  leadConvertedSince,
  hasRepliedRecently,
  hasRecentOutboundSms,
  isSuppressedContact,
  last10,
  normalizeE164,
} = require('./click-followup-gate');

// Click window (hours from clicked_at). Cron runs every 30 min, so a click
// enters the queue ~4–4.5h after it landed.
const MIN_AGE_H = 4;
const MAX_AGE_H = 72;

// How long an open (pending|drafted) action holds its contact's slot before
// the sweep expires it. A drafted nudge the owner hasn't acted on in two
// weeks is stale — expiring frees the partial-unique guard for future clicks.
const ACTION_TTL_DAYS = 14;

// Deterministic draft copy — GSM-7 safe on purpose (plain hyphen, straight
// apostrophe, no em-dashes / curly quotes / emoji). The owner can still edit
// it in /admin/drafts before approving.
const DRAFT_TEMPLATE = "Hi {first_name}, saw you were taking another look at your Waves quote - anything I can answer? If you're ready, you can pick your first visit here: {estimate_url}";

// SECURITY: customer_name can originate from the public quote wizard, so it
// is client-supplied text interpolated into message copy. Same sanitizer as
// booking-abandon-recovery: name characters only, first token, capped.
function firstNameOf(name) {
  const raw = String(name || '').trim().split(/\s+/)[0] || '';
  const clean = raw.replace(/[^\p{L}\p{M}'-]/gu, '').slice(0, 40);
  return clean || 'there';
}

// Sweep stale open actions → 'expired' so the one-open-action-per-contact
// partial unique guard frees the slot (a drafted nudge the owner sat on for
// two weeks shouldn't block future clicks forever). The linked draft is
// retired WITH the action — a two-week-old "saw you were taking another
// look" nudge is stale copy, and leaving it status='pending' would keep it
// sendable in /admin/drafts after its action expired. 'rejected' is the
// existing terminal review status (message_drafts vocabulary: pending /
// approved / revised / rejected / sent / shadow / suggested / auto_sent);
// flags.expired=true marks it as swept rather than owner-declined. Scoped to
// status='pending' so an approved/sent draft's record is never rewritten.
async function expireStaleActions(now = new Date()) {
  const cutoff = new Date(now.getTime() - ACTION_TTL_DAYS * 86400000);
  try {
    const stale = await db('click_followup_actions')
      .whereIn('status', ['pending', 'drafted'])
      .where('created_at', '<', cutoff)
      .select('id', 'draft_id');
    if (!stale.length) return 0;

    await db('click_followup_actions')
      .whereIn('id', stale.map((r) => r.id))
      .update({ status: 'expired', updated_at: db.fn.now() });

    const draftIds = stale.map((r) => r.draft_id).filter(Boolean);
    if (draftIds.length) {
      await db('message_drafts')
        .whereIn('id', draftIds)
        .where({ status: 'pending' })
        .update({
          status: 'rejected',
          flags: db.raw(`COALESCE(flags, '{}'::jsonb) || '{"expired": true}'::jsonb`),
        });
    }
    logger.info(`[click-followup] expired ${stale.length} stale open action(s) (retired ${draftIds.length} linked draft(s))`);
    return stale.length;
  } catch (e) {
    logger.warn(`[click-followup] stale-action sweep failed: ${e.message}`);
    return 0;
  }
}

// Terminal outcome writer (dismissed / converted) — the row marks THIS click
// as handled for the candidate query's per-click whereNotExists; a fresh
// re-click later mints a new short_code_clicks row and re-qualifies.
// Terminal statuses sit outside the open-only partial uniques, so these
// inserts never contend.
async function recordOutcome(candidate, status, extra = {}) {
  await db('click_followup_actions').insert({
    short_code_id: candidate.short_code_id,
    short_code_click_id: candidate.click_id || null,
    customer_id: candidate.customer_id || null,
    lead_id: candidate.lead_id || null,
    contact_phone: candidate.contact_phone || null,
    entity_type: candidate.entity_type || null,
    entity_id: candidate.entity_id || null,
    clicked_at: candidate.clicked_at,
    status,
    ...extra,
  });
}

// Does this contact already hold an OPEN action (from a different link)?
// Advisory pre-check — the partial unique indexes (customer / lead / phone)
// are the atomic backstop. The phone key is what makes contactless dedupe
// hold ACROSS ticks: same phone, different estimate tomorrow → still one
// open action.
async function hasOpenAction({ customerId, leadId, entityId, phoneLast10 }) {
  if (!customerId && !leadId && !entityId && !phoneLast10) return false;
  const q = db('click_followup_actions')
    .whereIn('status', ['pending', 'drafted'])
    .first('id');
  q.where(function () {
    if (customerId) this.orWhere('customer_id', customerId);
    if (leadId) this.orWhere('lead_id', leadId);
    if (entityId) this.orWhere('entity_id', entityId);
    if (phoneLast10) this.orWhere('contact_phone', phoneLast10);
  });
  return !!(await q);
}

async function runQueue(now = new Date()) {
  const nowMs = now.getTime();
  const counts = { candidates: 0, drafted: 0, converted: 0, dismissed: 0, skipped: 0 };

  // Human clicks in the window, estimate-linked, not yet acted on. The
  // anti-join is per CLICK (short_code_click_id), not per code — a fresh
  // re-click after a terminal action (dismissed/converted/expired) must
  // re-qualify; the per-contact open-action uniques remain the claim.
  // Newest first so in-run contact dedupe keeps the freshest click.
  const clicks = await db('short_code_clicks as scc')
    .join('short_codes as sc', 'scc.short_code_id', 'sc.id')
    .where('scc.is_bot', false)
    .whereIn('sc.kind', ['estimate', 'booking'])
    .where('sc.entity_type', 'estimates')
    .whereNotNull('sc.entity_id')
    .where('scc.clicked_at', '<', new Date(nowMs - MIN_AGE_H * 3600000))
    .where('scc.clicked_at', '>', new Date(nowMs - MAX_AGE_H * 3600000))
    .whereNotExists(function () {
      this.select(db.raw('1'))
        .from('click_followup_actions as cfa')
        .whereRaw('cfa.short_code_click_id = scc.id');
    })
    .orderBy('scc.clicked_at', 'desc')
    .select(
      'scc.id as click_id',
      'scc.clicked_at',
      'sc.id as short_code_id',
      'sc.kind',
      'sc.entity_type',
      'sc.entity_id',
      'sc.customer_id',
      'sc.lead_id',
    );

  if (!clicks.length) return counts;

  // Estimates are read during BOTH grouping (contact resolution) and
  // processing — cache per run so each estimate loads once.
  const estCache = new Map();
  const loadEstimate = async (id) => {
    if (!estCache.has(id)) estCache.set(id, await db('estimates').where({ id }).first());
    return estCache.get(id);
  };

  // One candidate per CONTACT per run (newest click wins). Contact key
  // resolution, in order: customer_id → lead_id on the code → lead resolved
  // from the estimate (leads.estimate_id FK / estimate_data.lead_id mirror —
  // most pre-conversion mints only carried customerId, which is null) →
  // normalized last-10 phone. NEVER entity_id: one person with two open
  // estimates would key as two contacts and get duplicate drafts.
  const seen = new Set();
  const candidates = [];
  for (const c of clicks) {
    let key = null;
    if (c.customer_id) {
      key = `c:${c.customer_id}`;
    } else if (c.lead_id) {
      key = `l:${c.lead_id}`;
    } else {
      const est = await loadEstimate(c.entity_id);
      const resolvedLeadId = est ? await leadIdForEstimate(est) : null;
      if (resolvedLeadId) {
        c.lead_id = resolvedLeadId; // carried onto the action row + fresh mint
        key = `l:${resolvedLeadId}`;
      } else {
        const ten = last10(est && est.customer_phone);
        // No phone → the candidate dead-ends at the phone check anyway;
        // key per click so it can't shadow a real contact.
        key = ten ? `p:${ten}` : `x:${c.click_id}`;
      }
    }
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(c);
  }
  counts.candidates = candidates.length;

  if (!isEnabled('clickFollowup')) {
    logger.info(`[click-followup] shadow: ${candidates.length} candidate click(s), gate off — no drafts queued`);
    return counts;
  }

  for (const c of candidates) {
    let claimedId = null;
    try {
      const est = await loadEstimate(c.entity_id);

      // Contact resolution — a draft with no reachable phone is dead weight,
      // and the phone doubles as the gate's phone-evidence conversion key +
      // the persisted cross-tick dedupe key.
      let phone = est ? est.customer_phone || null : null;
      if (!phone && est && est.customer_id) {
        const cust = await db('customers').where({ id: est.customer_id }).first('phone');
        phone = cust?.phone || null;
      }
      c.contact_phone = last10(phone) || null;
      const contact = { customerId: (est && est.customer_id) || c.customer_id || null, phone };

      // The shared pre-send gate — the same stack re-runs at approval time
      // in admin-drafts. Map its verdict onto queue semantics:
      //   estimate_terminal / suppressed / cadence_due → dismissed (terminal
      //     action row: this click is handled; a re-click re-qualifies)
      //   converted → converted action row
      //   guard_error / recent_outbound / replied_recently → skip (no row —
      //     the click stays a candidate and the next tick re-evaluates
      //     until it ages out of the 72h window)
      const verdict = await evaluateClickFollowupGate({
        estimate: est,
        customerId: contact.customerId,
        leadId: c.lead_id || null,
        phone,
        sinceTs: c.clicked_at,
        now,
      });
      if (!verdict.ok) {
        if (verdict.code === 'converted') {
          await recordOutcome(c, 'converted', { converted_at: new Date() });
          counts.converted++;
        } else if (['estimate_terminal', 'suppressed', 'cadence_due'].includes(verdict.code)) {
          await recordOutcome(c, 'dismissed');
          counts.dismissed++;
        } else {
          counts.skipped++;
        }
        continue;
      }

      if (!phone) {
        await recordOutcome(c, 'dismissed');
        counts.dismissed++;
        continue;
      }

      if (await hasOpenAction({
        customerId: contact.customerId,
        leadId: c.lead_id,
        entityId: c.entity_id,
        phoneLast10: c.contact_phone,
      })) {
        counts.skipped++;
        continue;
      }

      // Atomic claim: the pending insert. The partial unique indexes make a
      // concurrent run (or a second link for the same contact) lose here.
      try {
        const inserted = await db('click_followup_actions')
          .insert({
            short_code_id: c.short_code_id,
            short_code_click_id: c.click_id || null,
            customer_id: contact.customerId,
            lead_id: c.lead_id || null,
            contact_phone: c.contact_phone,
            entity_type: c.entity_type,
            entity_id: c.entity_id,
            clicked_at: c.clicked_at,
            status: 'pending',
          })
          .returning(['id']);
        claimedId = inserted?.[0]?.id || null;
        if (!claimedId) {
          counts.skipped++;
          continue;
        }
      } catch (err) {
        if (err && err.code === '23505') {
          counts.skipped++;
          continue; // lost the claim — another run/link already holds it
        }
        throw err;
      }

      // Fresh tracked link for the draft body — a click on THIS link is
      // attributable to the click-followup nudge, not the original send.
      // Graceful long-URL fallback is safe here (no bearer token, and the
      // owner sees the body before anything sends).
      const longUrl = `https://portal.wavespestcontrol.com/estimate/${est.token}`;
      const { code, shortUrl } = await createTrackedShortLink(longUrl, {
        kind: 'estimate',
        entityType: 'estimates',
        entityId: est.id,
        customerId: contact.customerId,
        leadId: c.lead_id || null,
        channel: 'sms',
        purpose: 'click_followup',
      });

      const body = DRAFT_TEMPLATE
        .replace('{first_name}', firstNameOf(est.customer_name))
        .replace('{estimate_url}', shortUrl);

      const ageHours = Math.max(1, Math.round((nowMs - new Date(c.clicked_at).getTime()) / 3600000));
      // Draft insert + action link commit or roll back TOGETHER: a draft
      // that survives without its action's draft_id would be unlinked —
      // re-draftable via the anti-join and unreachable by the stale-action
      // sweep. On any failure the transaction leaves no draft, claimedId
      // stays set, and the finally below releases the claim for a retry.
      let draftId = null;
      await db.transaction(async (trx) => {
        const [draft] = await trx('message_drafts')
          .insert({
            customer_id: contact.customerId,
            draft_response: body,
            intent: 'click_followup',
            status: 'pending',
            context_summary: `Clicked their ${c.kind} link ~${ageHours}h ago but hasn't booked. Auto-queued click-followup nudge for estimate ${est.id} — review and approve to send.`,
            flags: JSON.stringify({
              click_followup: true,
              toPhone: normalizeE164(phone),
              short_code_id: c.short_code_id,
              estimate_id: est.id,
              lead_id: c.lead_id || null,
              clicked_at: c.clicked_at,
            }),
          })
          .returning(['id']);
        await trx('click_followup_actions')
          .where({ id: claimedId })
          .update({ status: 'drafted', draft_id: draft.id, updated_at: db.fn.now() });
        draftId = draft.id;
      });
      claimedId = null; // success — keep the claim

      // Best-effort: point the freshly minted code back at the draft that
      // carries it ('table:id' — message linkage for part-A analytics).
      if (code) {
        await db('short_codes')
          .where({ code })
          .update({ message_ref: `message_drafts:${draftId}`, updated_at: new Date() })
          .catch((err) => logger.warn(`[click-followup] message_ref stamp failed: ${err.message}`));
      }

      counts.drafted++;
      logger.info(`[click-followup] queued draft ${draftId} for estimate ${est.id} (click on ${c.kind} link)`);
    } catch (e) {
      logger.error(`[click-followup] candidate ${c.short_code_id} failed: ${e.message}`);
      counts.skipped++;
    } finally {
      if (claimedId) {
        // Claimed but never drafted — release so the next tick retries.
        await db('click_followup_actions').where({ id: claimedId }).del()
          .catch((err) => logger.warn(`[click-followup] claim release failed: ${err.message}`));
      }
    }
  }

  return counts;
}

async function checkClicks(now = new Date()) {
  if (isEnabled('clickFollowup')) await expireStaleActions(now);
  const counts = await runQueue(now);
  return counts;
}

module.exports = {
  checkClicks,
  _internals: {
    runQueue,
    expireStaleActions,
    cadenceStageDueSoon,
    depositStageDueSoon,
    leadConvertedSince,
    hasRepliedRecently,
    hasRecentOutboundSms,
    isSuppressedContact,
    firstNameOf,
    DRAFT_TEMPLATE,
    MIN_AGE_H,
    MAX_AGE_H,
    ACTION_TTL_DAYS,
  },
};
