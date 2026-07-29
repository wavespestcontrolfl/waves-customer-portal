/**
 * Inbox hygiene — the hands-off half of the email agent (owner directive
 * 2026-07-28: "green auto-applies, exceptions park in one digest, no triage
 * queues"). Three jobs, all idempotent, all called from the scheduler:
 *
 *   - sweepQuarantine(): spam classifications no longer trash instantly —
 *     handleSpam parks them under the Quarantine label with quarantined_at
 *     stamped. This sweep trashes rows older than the 24h undo window. A
 *     misfire costs one label-click inside a day instead of a hunt through
 *     932 trash items.
 *   - rescueSpamFolder(): Gmail's own spam folder swallows real mail
 *     silently. The sweep scans recent SPAM for senders we KNOW — customers,
 *     live leads, vendor domains, operational/partner domains — and moves
 *     them back to the inbox marked important. Customers additionally ring
 *     an admin bell (a buried customer email is an exception, not a stat).
 *   - collectUnansweredNudges(): inbound customer/lead conversation mail
 *     with no outbound reply after NUDGE_AFTER_DAYS surfaces in the morning
 *     digest — the follow-up-when-we-haven't lane. Reply detection reads
 *     the live Gmail thread for a SENT message dated after the inbound one
 *     (the emails table only mirrors the inbox, so a DB-only check would
 *     nudge on threads the operator already answered).
 *
 * Errors in one item never abort the sweep (log-and-continue) — but errors
 * in AUTH propagate so the scheduler logs a real failure instead of a
 * silently empty run.
 */

const psl = require('psl');
const db = require('../../models/db');
const logger = require('../logger');
const gmailClient = require('./gmail-client');
const { isOperationalDomain, domainFromAddress, normalizeAddress } = require('./spam-blocker');

const QUARANTINE_LABEL = 'Quarantine';
const QUARANTINE_HOURS = 24;
const NUDGE_AFTER_DAYS = 3;
const NUDGE_WINDOW_DAYS = 10;
const NUDGE_CATEGORIES = ['customer_request', 'scheduling', 'complaint', 'lead_inquiry'];
// Mirrors email-actions / spam-blocker (CLOSED_STATUSES in leads-tools).
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate', 'unresponsive'];

/** True when we know this sender: customer, live lead, vendor, or partner. */
async function isKnownSender(fromAddress) {
  const normalized = normalizeAddress(fromAddress);
  if (!normalized) return { known: false };
  if (isOperationalDomain(domainFromAddress(normalized))) return { known: true, kind: 'operational' };
  const customer = await db('customers').whereRaw('LOWER(email) = ?', [normalized]).whereNull('deleted_at').first();
  if (customer) return { known: true, kind: 'customer', customer };
  // OPEN leads only — a lost/disqualified/duplicate lead's address must not
  // keep a spam exemption (or a spam-folder rescue) after the lead closes.
  const lead = await db('leads')
    .whereRaw('LOWER(email) = ?', [normalized])
    .whereNull('deleted_at')
    .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
    .first();
  if (lead) return { known: true, kind: 'lead', lead };
  const domain = domainFromAddress(normalized);
  if (domain) {
    const vendor = await db('vendor_email_domains').where('domain', domain).first();
    if (vendor) return { known: true, kind: 'vendor' };
  }
  return { known: false };
}

/**
 * Park a message in quarantine — STAGED so the caller can tell a clean
 * failure (Gmail untouched → destructive fallback is safe) from an
 * AMBIGUOUS one (the label swap may have applied → never fall back to
 * trash). Order: label ensure (no mutation) → DB stamp (revertable) →
 * Gmail label swap (the ambiguous step, e.quarantineStage = 'gmail').
 */
async function quarantineMessage(email) {
  let labelId;
  try {
    labelId = await gmailClient.ensureLabel(QUARANTINE_LABEL);
  } catch (e) {
    e.quarantineStage = 'label-ensure'; // nothing mutated
    throw e;
  }
  try {
    await db('emails').where({ id: email.id }).update({
      is_archived: true,
      quarantined_at: new Date(),
      auto_action: 'spam_quarantined',
      updated_at: new Date(),
    });
  } catch (e) {
    e.quarantineStage = 'db'; // Gmail untouched
    throw e;
  }
  try {
    await gmailClient.modifyLabels(email.gmail_id, [labelId], ['INBOX']);
  } catch (e) {
    e.quarantineStage = 'gmail'; // AMBIGUOUS — swap may have applied
    // Park an AMBIGUOUS marker (never trashable) — the daily sweep
    // reconciles it against live Gmail labels: swap applied → adopt as
    // quarantined (24h window starts then); swap not applied → failed,
    // is_archived reset so the message stays visible in the portal.
    await db('emails').where({ id: email.id, auto_action: 'spam_quarantined' })
      .update({ auto_action: 'spam_quarantine_ambiguous', quarantined_at: null, updated_at: new Date() })
      .catch(() => {});
    throw e;
  }
}

/**
 * Cancel a quarantine (operator reclassified away from spam within the undo
 * window): restore the message to INBOX, drop the Quarantine label, clear
 * the sweep stamp so nothing can trash it later.
 */
async function cancelQuarantine(email, { restoreInbox = true } = {}) {
  const labelId = await gmailClient.ensureLabel(QUARANTINE_LABEL);
  // The Gmail restore comes FIRST and failure PROPAGATES — clearing the DB
  // state while the message still sits under the Quarantine label would
  // orphan it outside the inbox with nothing guarding it. The caller (the
  // reclassify route) surfaces the error and the quarantine stays intact
  // for a retry. restoreInbox=false keeps the message archived (used when
  // the replacement classification's own handler already archived it —
  // e.g. marketing_newsletter — and un-archiving would undo that outcome).
  await gmailClient.modifyLabels(email.gmail_id, restoreInbox ? ['INBOX'] : [], [labelId]);
  await db('emails').where({ id: email.id }).update({
    quarantined_at: null,
    ...(restoreInbox ? { is_archived: false } : {}),
    updated_at: new Date(),
  });
  // The cancellation marker only lands when no new handler already recorded
  // its own outcome for the fresh classification.
  await db('emails').where({ id: email.id })
    .whereRaw("auto_action LIKE 'spam_%'")
    .update({ auto_action: 'quarantine_cancelled_reclassified', updated_at: new Date() });
}

/**
 * Trash quarantined mail older than the undo window. The undo contract is
 * label-based: an operator who drags the message back to the inbox (or off
 * the Quarantine label) has vetoed the classification, so the sweep
 * re-reads the message's LIVE Gmail labels before touching it — the DB
 * row's auto_action alone is stale the moment a human acts in Gmail. Each
 * row is also claimed atomically in the DB before the destructive call so
 * a concurrent sweep/rescue can't double-fire.
 */
async function sweepQuarantine(now = new Date()) {
  const cutoff = new Date(now.getTime() - QUARANTINE_HOURS * 3600000);
  const quarantineLabelId = await gmailClient.ensureLabel(QUARANTINE_LABEL);
  let trashed = 0;
  let restored = 0;

  // Crash recovery FIRST: 'spam_trashing' is a seconds-long claim, so a row
  // still carrying it WELL past claim age is a prior run that died mid-trash.
  // The 10-minute grace keeps a concurrently running sweep's fresh claims
  // out of recovery (multi-pod safety). Reconcile against live Gmail state —
  // already trashed settles (and takes its deferred sender block); not
  // trashed reverts to quarantined so the main pass re-evaluates it.
  const claimGraceCutoff = new Date(now.getTime() - 10 * 60000);
  const stuck = await db('emails')
    .where('auto_action', 'spam_trashing')
    .where('updated_at', '<', claimGraceCutoff)
    .select('id', 'gmail_id', 'from_address');
  for (const row of stuck) {
    try {
      const labels = await gmailClient.getMessageLabels(row.gmail_id);
      if (labels.includes('TRASH')) {
        const n = await db('emails').where({ id: row.id, auto_action: 'spam_trashing' })
          .update({ auto_action: 'spam_trashed_block_pending', quarantined_at: null, updated_at: new Date() });
        if (n) {
          trashed += n;
          await settleDeferredBlock(row);
        }
      } else {
        await db('emails').where({ id: row.id, auto_action: 'spam_trashing' })
          .update({ auto_action: 'spam_quarantined', updated_at: new Date() });
      }
    } catch (e) {
      logger.warn(`[inbox-hygiene] stuck-claim recovery failed (email ${row.id}): ${e.message}`);
    }
  }

  // Reclassification claims stranded by a crashed route call: revert to
  // quarantined after the grace period so the undo window resumes (a live
  // route call finishes in seconds).
  try {
    const staleReclass = await db('emails')
      .where('auto_action', 'spam_reclassifying')
      .where('updated_at', '<', claimGraceCutoff)
      .select('id', 'gmail_id', 'from_address', 'quarantined_at', 'classification');
    for (const row of staleReclass) {
      // A persisted NON-spam verdict means the reclassification committed
      // its decision and died before cancellation — complete the cancel
      // instead of re-quarantining a message the operator already cleared.
      if (row.classification && row.classification !== 'spam') {
        try {
          // Atomically CLAIM the stale row for recovery before acting — an
          // admin retry's stale takeover CASes on the same staleness
          // predicate, so exactly one side wins (the loser's update matches
          // zero rows) and the replay can never run concurrently with the
          // route's own re-execution (duplicate leads, racing cancels). A
          // crash after this refresh re-ages past the grace window and the
          // next sweep retries.
          const recoveryClaimed = await db('emails')
            .where({ id: row.id, auto_action: 'spam_reclassifying' })
            .where('updated_at', '<', claimGraceCutoff)
            .update({ auto_action: 'spam_reclassifying', updated_at: new Date() });
          if (!recoveryClaimed) continue;
          // Same unblock-first commit as the live route and stranded-cancel
          // recovery — a crash between verdict and unblock must not leave
          // the sender's Gmail filter trash-routing forever.
          const blocked = await db('blocked_email_senders')
            .whereRaw('LOWER(email_address) = ?', [String(row.from_address || '').toLowerCase()])
            .where({ reason: 'spam_auto' })
            .first();
          if (blocked) {
            const { unblockSender } = require('./spam-blocker');
            const unblock = await unblockSender(blocked.id).catch((e) => ({ error: e.message }));
            if (!unblock?.success) {
              logger.warn(`[inbox-hygiene] stale-reclass unblock failed (email ${row.id}) — claim retained for retry`);
              continue;
            }
          }
          // The crashed request may have died between persisting the verdict
          // and running its auto-action — replay it (handlers carry their
          // own claims/idempotency, so a completed action no-ops). The
          // reclassify route persisted the FULL classification object into
          // extracted_data at verdict commit — replay with that payload, not
          // a bare { category }: handleLeadInquiry would read an empty
          // extraction as low-confidence and park the lead for review, and
          // vendor-invoice processing would lose its extracted fields.
          try {
            const fullRow = await db('emails').where({ id: row.id }).first();
            const { executeAutoAction } = require('./email-actions');
            let stored = null;
            try {
              const raw = (fullRow || row).extracted_data;
              stored = typeof raw === 'string' ? JSON.parse(raw) : raw;
            } catch (parseErr) { stored = null; }
            // extracted_data can also carry vendor metadata from sync —
            // only trust it as the classification when categories match.
            const classification = (stored && stored.category === row.classification)
              ? stored
              : { category: row.classification, confidence: (fullRow || row).classification_confidence ?? null };
            // A failed replay RETAINS the claim (skip the cancel below) —
            // clearing the quarantine over an action that never ran would
            // strip this sweep of its only retry marker. The refreshed
            // claim re-ages past the grace window for the next sweep.
            const outcome = await executeAutoAction(fullRow || row, classification);
            if (!outcome?.ok) {
              logger.warn(`[inbox-hygiene] stale-reclass action replay failed (email ${row.id}) — claim retained for retry: ${outcome?.error || 'unknown'}`);
              continue;
            }
          } catch (e) {
            logger.warn(`[inbox-hygiene] stale-reclass action replay failed (email ${row.id}) — claim retained for retry: ${e.message}`);
            continue;
          }
          // Same handler-outcome-based restore decision as the live route:
          // a newsletter verdict whose handler SKIPPED (authenticated known
          // sender) must go back to the inbox, not strand in All Mail.
          let restoreInbox = true;
          if (row.classification === 'marketing_newsletter') {
            const postAction = await db('emails').where({ id: row.id }).first();
            restoreInbox = !/^newsletter_(unsubscribed|unsub_attempted|archived|processing)/.test(postAction?.auto_action || '');
          }
          await cancelQuarantine(row, { restoreInbox });
        } catch (e) {
          logger.warn(`[inbox-hygiene] stale-reclass cancel completion failed (email ${row.id}): ${e.message}`);
        }
        continue;
      }
      // quarantined_at distinguishes the origin state: ambiguous rows never
      // carried the stamp, and reverting one to plain 'spam_quarantined'
      // (null stamp) would make it invisible to every recovery pass. The
      // staleness predicate keeps this CAS off an admin takeover that
      // refreshed the claim between our select and this write.
      await db('emails').where({ id: row.id, auto_action: 'spam_reclassifying' })
        .where('updated_at', '<', claimGraceCutoff)
        .update({
          auto_action: row.quarantined_at ? 'spam_quarantined' : 'spam_quarantine_ambiguous',
          updated_at: new Date(),
        });
    }
    if (staleReclass.length) logger.info(`[inbox-hygiene] reverted ${staleReclass.length} stale reclassification claim(s)`);
  } catch (e) {
    logger.warn(`[inbox-hygiene] stale reclassify-claim revert failed: ${e.message}`);
  }

  // Cancellations stranded mid-commit: a reclassification's new handler
  // overwrote auto_action, then the process died before cancelQuarantine —
  // the row keeps quarantined_at + the Gmail label but no quarantine-lane
  // auto_action, so no other recovery can see it. quarantined_at is the
  // authoritative marker: finish the cancellation.
  try {
    const strandedCancels = await db('emails')
      .whereNotNull('quarantined_at')
      .whereNotIn('auto_action', [
        'spam_quarantined', 'spam_quarantine_ambiguous', 'spam_trashing', 'spam_reclassifying',
        // trash-lane outcomes are committed spam, not stranded cancels
        // (their quarantined_at also clears at settle — this is the belt)
        'spam_trashed_block_pending', 'spam_trashed_blocking', 'spam_trashed_after_quarantine', 'spam_blocked',
      ])
      .select('id', 'gmail_id', 'from_address', 'classification');
    for (const row of strandedCancels) {
      try {
        // Same COMMIT sequence as the live reclassification path: sender
        // unblock first; only when it succeeds (or no block exists) does the
        // cancellation clear the retry marker.
        const blocked = await db('blocked_email_senders')
          .whereRaw('LOWER(email_address) = ?', [String(row.from_address || '').toLowerCase()])
          .where({ reason: 'spam_auto' })
          .first();
        if (blocked) {
          const { unblockSender } = require('./spam-blocker');
          const unblock = await unblockSender(blocked.id).catch((e) => ({ error: e.message }));
          if (!unblock?.success) {
            logger.warn(`[inbox-hygiene] stranded-cancel unblock failed (email ${row.id}) — marker retained for retry`);
            continue;
          }
        }
        // Same category rule as the live cancellation path: a newsletter's
        // handler archived it on purpose — recovery must not resurface it.
        await cancelQuarantine(row, { restoreInbox: row.classification !== 'marketing_newsletter' });
      } catch (e) {
        logger.warn(`[inbox-hygiene] stranded-cancel completion failed (email ${row.id}): ${e.message}`);
      }
    }
    if (strandedCancels.length) logger.info(`[inbox-hygiene] completed ${strandedCancels.length} stranded quarantine cancellation(s)`);
  } catch (e) {
    logger.warn(`[inbox-hygiene] stranded-cancel scan failed: ${e.message}`);
  }

  // Retry sender blocks that failed after a successful trash on a prior
  // sweep — 'spam_trashed_block_pending' is the retryable state.
  // Includes crashed 'spam_trashed_blocking' claims past the grace period —
  // settleDeferredBlock re-claims from block_pending, so revert those first.
  try {
    const staleBlocking = await db('emails')
      .where('auto_action', 'spam_trashed_blocking')
      .where('updated_at', '<', claimGraceCutoff)
      .select('id');
    for (const row of staleBlocking) {
      await db('emails').where({ id: row.id, auto_action: 'spam_trashed_blocking' })
        .update({ auto_action: 'spam_trashed_block_pending', updated_at: new Date() });
    }
  } catch (e) {
    logger.warn(`[inbox-hygiene] stale blocking-claim revert failed: ${e.message}`);
  }
  const blockPending = await db('emails')
    .where('auto_action', 'spam_trashed_block_pending')
    .where('updated_at', '<', claimGraceCutoff)
    .select('id', 'gmail_id', 'from_address');
  for (const row of blockPending) {
    await settleDeferredBlock(row);
  }

  // Reconcile AMBIGUOUS quarantine attempts (label swap timed out — did it
  // apply?) against live Gmail labels: applied → adopt as quarantined with a
  // fresh 24h window; not applied → failed + visible again in the portal.
  const ambiguous = await db('emails')
    .where('auto_action', 'spam_quarantine_ambiguous')
    .select('id', 'gmail_id');
  for (const row of ambiguous) {
    try {
      const labels = await gmailClient.getMessageLabels(row.gmail_id);
      const applied = labels.includes(quarantineLabelId) && !labels.includes('INBOX');
      await db('emails').where({ id: row.id, auto_action: 'spam_quarantine_ambiguous' })
        .update(applied
          ? { auto_action: 'spam_quarantined', quarantined_at: new Date(), is_archived: true, updated_at: new Date() }
          : { auto_action: 'spam_quarantine_failed', quarantined_at: null, is_archived: false, updated_at: new Date() });
    } catch (e) {
      logger.warn(`[inbox-hygiene] ambiguous-quarantine reconcile failed (email ${row.id}): ${e.message}`);
    }
  }

  const rows = await db('emails')
    .where('auto_action', 'spam_quarantined')
    .where('quarantined_at', '<', cutoff)
    .select('id', 'gmail_id', 'from_address', 'authentication_results');
  for (const row of rows) {
    try {
      // The sender may have BECOME a customer/live lead during the undo
      // window (or a resync backfilled their auth header) — re-run the
      // authenticated known-sender check before anything destructive and
      // restore instead of trash.
      const verdict = await isKnownSender(row.from_address);
      if (verdict.known && hasAlignedAuth(row.authentication_results, domainFromAddress(row.from_address))) {
        try {
          await gmailClient.modifyLabels(row.gmail_id, ['INBOX'], [quarantineLabelId]);
        } catch (e) {
          // Restore failed — keep the retryable quarantine state; clearing
          // it now would strand the message outside INBOX unguarded. The
          // next sweep re-runs this branch.
          logger.warn(`[inbox-hygiene] known-sender restore label failed (email ${row.id}) — quarantine retained for retry: ${e.message}`);
          continue;
        }
        restored += await db('emails')
          .where({ id: row.id, auto_action: 'spam_quarantined' })
          .update({ auto_action: 'quarantine_restored_known_sender', quarantined_at: null, is_archived: false, updated_at: new Date() });
        continue;
      }

      // Live-label veto check: back in INBOX or off the Quarantine label
      // means the operator rescued it — clear the quarantine state.
      const labels = await gmailClient.getMessageLabels(row.gmail_id);
      const rescuedByOperator = labels.includes('INBOX') || !labels.includes(quarantineLabelId);
      if (rescuedByOperator) {
        // Finish whichever half the operator's veto left undone: a
        // label-only removal needs INBOX restored; an INBOX drag-back needs
        // the lingering Quarantine label removed (or rescued mail piles up
        // under a label that is supposed to mean pending-deletion).
        const addLabels = labels.includes('INBOX') ? [] : ['INBOX'];
        const removeLabels = labels.includes(quarantineLabelId) ? [quarantineLabelId] : [];
        if (addLabels.length || removeLabels.length) {
          try {
            await gmailClient.modifyLabels(row.gmail_id, addLabels, removeLabels);
          } catch (e) {
            logger.warn(`[inbox-hygiene] veto restore failed (email ${row.id}) — quarantine state retained for retry: ${e.message}`);
            continue;
          }
        }
        restored += await db('emails')
          .where({ id: row.id, auto_action: 'spam_quarantined' })
          .update({ auto_action: 'quarantine_restored', quarantined_at: null, is_archived: false, updated_at: new Date() });
        continue;
      }
      // Atomic claim BEFORE the destructive call.
      const claimed = await db('emails')
        .where({ id: row.id, auto_action: 'spam_quarantined' })
        .update({ auto_action: 'spam_trashing', updated_at: new Date() });
      if (!claimed) continue;
      try {
        await gmailClient.trashMessage(row.gmail_id);
        // Settle to a BLOCK-PENDING state first; only a successful sender
        // block completes the workflow. A transient block failure stays
        // retryable (recovered below on the next sweep) instead of being
        // silently marked done.
        trashed += await db('emails')
          .where({ id: row.id, auto_action: 'spam_trashing' })
          .update({ auto_action: 'spam_trashed_block_pending', quarantined_at: null, updated_at: new Date() });
        await settleDeferredBlock(row);
      } catch (trashErr) {
        // AMBIGUOUS: the trash may have committed before the error surfaced.
        // Keep the 'spam_trashing' claim — reverting would let the next
        // sweep read a trashed message as operator-restored and skip the
        // deferred sender block. The stuck-claim recovery pass reconciles it
        // against live Gmail labels tomorrow.
        throw trashErr;
      }
    } catch (e) {
      logger.warn(`[inbox-hygiene] quarantine sweep failed for email ${row.id}: ${e.message}`);
    }
  }
  if (trashed || restored) logger.info(`[inbox-hygiene] quarantine sweep: ${trashed} trashed, ${restored} operator-restored`);
  return { trashed, restored };
}

/**
 * Complete a trashed row's deferred sender block: only a successful block
 * settles the workflow; failure keeps 'spam_trashed_block_pending' for the
 * next sweep's retry pass.
 */
async function settleDeferredBlock(row) {
  try {
    // CAS the row into a short-lived 'blocking' claim BEFORE the external
    // Gmail filter mutation — an operator's restore+reclassify CAS
    // (spam_reclassifying) landing first makes this a no-op instead of
    // racing a fresh filter against their veto.
    const claimed = await db('emails')
      .where({ id: row.id, auto_action: 'spam_trashed_block_pending' })
      .update({ auto_action: 'spam_trashed_blocking', updated_at: new Date() });
    if (!claimed) return;
    try {
      const { blockSpamSender } = require('./spam-blocker');
      await blockSpamSender(row);
      await db('emails').where({ id: row.id, auto_action: 'spam_trashed_blocking' })
        .update({ auto_action: 'spam_trashed_after_quarantine', quarantined_at: null, updated_at: new Date() });
    } catch (blockErr) {
      await db('emails').where({ id: row.id, auto_action: 'spam_trashed_blocking' })
        .update({ auto_action: 'spam_trashed_block_pending', updated_at: new Date() })
        .catch(() => {});
      throw blockErr;
    }
  } catch (blockErr) {
    logger.warn(`[inbox-hygiene] deferred sender block failed (email ${row.id}) — retrying next sweep: ${blockErr.message}`);
  }
}

/**
 * True when Gmail's own Authentication-Results header shows the message
 * actually authenticated as the domain it claims: DKIM pass whose d= aligns
 * with the From domain, or SPF pass whose validated domain aligns. A From
 * header is attacker-typed text — without aligned authentication, "rescuing"
 * a spam-foldered message would let anyone spoof a customer or Stripe and
 * have Gmail's phishing verdict reversed automatically.
 */
function hasAlignedAuth(authResults, fromDomain) {
  const auth = String(authResults || '').toLowerCase();
  const domain = String(fromDomain || '').toLowerCase();
  if (!auth || !domain) return false;
  // Relaxed (organizational-domain) alignment, mirroring DMARC: sibling
  // subdomains of one org domain align (news.example.com vs
  // mailer.example.com). Org domain is public-suffix-aware (psl) — a naive
  // last-two-labels cut would call attacker.co.uk and customer.co.uk
  // "aligned" (both reduce to co.uk). A domain that IS a public suffix has
  // no org domain (psl.get → null) and can only align on exact match.
  const orgDomain = (d) => psl.get(String(d || '')) || null;
  const fromOrg = orgDomain(domain);
  const aligned = (value) => value === domain
    || (fromOrg !== null && orgDomain(value) === fromOrg);
  const dkim = auth.match(/dkim=pass[^;]*/g) || [];
  for (const clause of dkim) {
    // header.i may carry a full identity (user@domain); align on the domain.
    const d = clause.match(/header\.[di]=(?:[^@\s;]*@)?([a-z0-9.-]+)/);
    if (d && aligned(d[1])) return true;
  }
  const spf = auth.match(/spf=pass[^;]*/g) || [];
  for (const clause of spf) {
    const d = clause.match(/(?:smtp\.mailfrom|smtp\.helo)=(?:[^@\s;]*@)?([a-z0-9.-]+)/);
    if (d && aligned(d[1])) return true;
  }
  return false;
}

/**
 * Rescue known senders out of Gmail's spam folder. Recent window only —
 * Gmail purges spam at 30 days and yesterday's sweep covered yesterday.
 * Rescue REQUIRES aligned SPF/DKIM evidence; a known-looking sender without
 * it gets a review notification instead of a move (spoof containment).
 */
async function rescueSpamFolder(now = new Date()) {
  // Scan window reaches back to the last SUCCESSFUL sweep (+1d overlap),
  // capped at Gmail's ~30d spam retention — a fixed 2d query would age
  // buried customer mail past rescue after two failed runs (OAuth or
  // provider outage). No watermark yet = first run scans the full window.
  const syncState = await db('email_sync_state').first().catch(() => null);
  const lastScanAt = syncState?.last_spam_scan_at ? new Date(syncState.last_spam_scan_at).getTime() : 0;
  const windowDays = lastScanAt
    ? Math.min(30, Math.max(2, Math.ceil((now.getTime() - lastScanAt) / 86400000) + 1))
    : 30;
  const counts = { scanned: 0, rescued: 0, customers: 0, unauthenticated: 0 };
  let perMessageFailures = 0;
  // A prior run that hit the batch backstop persisted the oldest epoch it
  // reached — this run continues INTO the older remainder (`before:`
  // partition) instead of re-scanning the same newest page forever (Gmail
  // lists newest-first, and unrescued junk stays in Spam).
  const beforeEpoch = Number(syncState?.spam_scan_before_epoch) || null;
  const query = beforeEpoch
    ? `in:spam newer_than:${windowDays}d before:${beforeEpoch}`
    : `in:spam newer_than:${windowDays}d`;
  // Drain the WHOLE window in 500-id batches — a junk burst bigger than one
  // batch must not hide older buried mail behind the cap, and an undrained
  // pass must not advance the watermark (which would shrink the next window
  // past the unscanned remainder). MAX_BATCHES is a runaway backstop far
  // above observed volume; hitting it persists the continuation epoch below
  // so the NEXT run still makes forward progress.
  const MAX_BATCHES = 20;
  let pageToken = null;
  let undrained = false;
  let oldestReceivedMs = null;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const { messages, truncated, nextPageToken } = await gmailClient.listAllMessages(query, 500, { includeSpamTrash: true, pageToken });
    for (const m of messages || []) {
      counts.scanned += 1;
      try {
        const full = await gmailClient.getMessage(m.id);
        const receivedMs = full?.received_at ? new Date(full.received_at).getTime() : NaN;
        if (Number.isFinite(receivedMs)) {
          oldestReceivedMs = oldestReceivedMs === null ? receivedMs : Math.min(oldestReceivedMs, receivedMs);
        }
        const fromAddress = full?.from_address;
        const verdict = await isKnownSender(fromAddress);
        if (!verdict.known) continue;
        if (!hasAlignedAuth(full?.authentication_results, domainFromAddress(fromAddress))) {
          // Looks like someone we know but did not authenticate as them —
          // exactly what a phish looks like. Never auto-reverse Gmail's
          // verdict; park a review notification instead.
          counts.unauthenticated += 1;
          // Idempotent across sweeps: the same message sits in the 2-day
          // window for two runs and retries — one review bell per Gmail id.
          const already = await db('notifications')
            .where('category', 'email_rescue_review')
            .whereRaw("metadata::jsonb ->> 'gmail_message_id' = ?", [m.id])
            .first()
            .catch(() => null);
          if (already) continue;
          // This bell is the ONLY surfaced outcome for an unverified
          // known-looking sender (the message stays in Spam) — a failed
          // insert PROPAGATES to the per-message failure count so the
          // watermark holds and a later sweep retries the alert.
          await db('notifications').insert({
            recipient_type: 'admin',
            category: 'email_rescue_review',
            title: 'Spam-foldered mail claims a known sender (unverified)',
            body: `A message claiming to be ${full.from_name || fromAddress} ("${(full.subject || '(no subject)').slice(0, 60)}") is in Gmail Spam but failed sender authentication — left in Spam. Review it in Gmail if expected.`,
            icon: '⚠️',
            link: '/admin/email',
            metadata: JSON.stringify({ gmail_message_id: m.id }),
            created_at: new Date(),
          });
          continue;
        }
        await gmailClient.modifyLabels(m.id, ['INBOX', 'IMPORTANT'], ['SPAM']);
        counts.rescued += 1;
        if (verdict.kind === 'customer') {
          counts.customers += 1;
          await db('notifications').insert({
            recipient_type: 'admin',
            category: 'email_rescue',
            title: 'Customer email rescued from Spam',
            body: `${full.from_name || fromAddress}: "${(full.subject || '(no subject)').slice(0, 80)}" was in Gmail Spam — moved back to the inbox and marked important.`,
            icon: '\u{1F6DF}',
            link: '/admin/email',
            created_at: new Date(),
          }).catch(() => {});
        }
        logger.info(`[inbox-hygiene] rescued ${verdict.kind} email from spam (${m.id})`);
      } catch (e) {
        perMessageFailures += 1;
        logger.warn(`[inbox-hygiene] spam rescue failed for message ${m.id}: ${e.message}`);
      }
    }
    if (!truncated) break;
    pageToken = nextPageToken;
    if (batch === MAX_BATCHES - 1) {
      undrained = true;
      logger.warn(`[inbox-hygiene] spam rescue stopped after ${MAX_BATCHES * 500} messages — continuation persisted so the next run reaches the remainder`);
    }
  }
  // Every message failing is not N isolated blips — it's a systemic Gmail
  // failure (quota/token/permission) and the run must not read as success.
  if (counts.scanned > 0 && perMessageFailures === counts.scanned) {
    throw new Error(`spam rescue failed on all ${counts.scanned} message(s) — systemic Gmail failure`);
  }
  if (syncState) {
    if (undrained && Number.isFinite(oldestReceivedMs)) {
      // Persist forward progress: the next run partitions on the oldest
      // epoch reached (+1s so a same-second sibling is re-scanned rather
      // than skipped — rescue is idempotent). This marker is the ONLY path
      // to the older remainder, so a failed write FAILS the run — recording
      // success without it would strand everything past the cap while each
      // day re-scans the same newest page.
      try {
        await db('email_sync_state').where('id', syncState.id)
          .update({ spam_scan_before_epoch: Math.floor(oldestReceivedMs / 1000) + 1 });
      } catch (e) {
        throw new Error(`spam-scan continuation persist failed — run marked failed for retry: ${e.message}`);
      }
    } else if (!undrained && beforeEpoch) {
      // Partition drained — clear the continuation; the next run does a
      // normal full-window pass (watermark still held until it completes).
      // A failed clear also FAILS the run: a stuck marker re-partitions
      // forever and permanently blocks the watermark.
      try {
        await db('email_sync_state').where('id', syncState.id)
          .update({ spam_scan_before_epoch: null });
      } catch (e) {
        throw new Error(`spam-scan continuation clear failed — run marked failed for retry: ${e.message}`);
      }
    } else if (perMessageFailures === 0 && !undrained && !beforeEpoch) {
      // Watermark advances ONLY on a fully clean, fully drained,
      // UNPARTITIONED pass — anything else keeps the next scan wide so
      // missed messages are re-scanned.
      await db('email_sync_state').where('id', syncState.id)
        .update({ last_spam_scan_at: now })
        .catch((e) => logger.warn(`[inbox-hygiene] spam-scan watermark update failed: ${e.message}`));
    }
  }
  return counts;
}

/**
 * Inbound conversation mail with no outbound reply — digest fodder, capped
 * so one noisy day can't turn the digest into a triage queue.
 */
async function collectUnansweredNudges(now = new Date(), limit = 5) {
  const newest = new Date(now.getTime() - NUDGE_AFTER_DAYS * 86400000);
  const oldest = new Date(now.getTime() - NUDGE_WINDOW_DAYS * 86400000);
  // Thread grouping happens IN SQL (latest inbound row per thread) BEFORE
  // any cap — a chatty thread or a pile of answered rows can never consume
  // the candidate window and hide other unanswered customers.
  // The latest-inbound-per-thread pick runs over the WHOLE lookback window;
  // the nudge age bound applies AFTER, to that latest row — otherwise a
  // thread whose customer wrote again yesterday would be represented by an
  // older message and nudged prematurely.
  // Inner pick = the thread's latest INBOUND message of any classification;
  // eligibility (category/archive/age) applies OUTSIDE to that latest row.
  // A thread whose newest inbound was classified 'other' or archived is
  // therefore represented by that message (and correctly skipped) instead
  // of resurrecting an older eligible one. LIMIT 100 (not 40): answered
  // threads consume candidate slots before the Gmail sent-check, so the
  // window must comfortably exceed the 5-nudge target.
  // Paged: answered threads still satisfy the DB predicates and are only
  // filtered by the live Gmail check below, so one page of answered history
  // must not starve the digest — keep paging until the target is met or
  // candidates run out (bounded to 3 pages of 100 to cap Gmail calls).
  const pageSize = 100;
  const deduped = [];
  for (let page = 0; page < 3; page += 1) {
    const res = await db.raw(
      `SELECT * FROM (
         SELECT DISTINCT ON (gmail_thread_id)
           id, gmail_id, gmail_thread_id, from_address, from_name, subject, received_at,
           classification, is_archived
         FROM emails
         WHERE received_at >= ?
           AND NOT (label_ids \\? 'SENT')
           AND NOT (label_ids \\? 'DRAFT')
           AND LOWER(from_address) <> ?
         ORDER BY gmail_thread_id, received_at DESC
       ) latest_per_thread
       WHERE classification = ANY(?)
         AND is_archived = false
         AND received_at <= ?
       ORDER BY received_at ASC
       LIMIT ${pageSize} OFFSET ${page * pageSize}`,
      [oldest, normalizeAddress(process.env.GMAIL_USER_EMAIL || 'contact@wavespestcontrol.com'), NUDGE_CATEGORIES, newest]
    );
    const rows = res?.rows || [];
    deduped.push(...rows);
    if (rows.length < pageSize) break;
    if (page === 2) logger.warn('[inbox-hygiene] nudge candidates hit the 300-thread page cap — oldest unanswered threads may be deferred');
  }

  const nudges = [];
  for (const email of deduped) {
    if (nudges.length >= limit) break;
    try {
      const thread = await gmailClient.getThread(email.gmail_thread_id);
      const receivedAt = new Date(email.received_at).getTime();
      const answered = (thread?.messages || []).some((msg) => {
        const isSent = (msg.labelIds || []).includes('SENT');
        const at = Number(msg.internalDate || 0);
        return isSent && at > receivedAt;
      });
      if (!answered) nudges.push(email);
    } catch (e) {
      logger.warn(`[inbox-hygiene] nudge thread check failed for email ${email.id}: ${e.message}`);
    }
  }
  return nudges;
}

/**
 * Scheduled recovery for draft claims orphaned by a crash: 'pending' rows
 * with an hour-old draft_claimed_at either settle against an existing
 * thread draft or release back to NULL for a clean retry.
 */
async function reconcilePendingDrafts(now = new Date()) {
  const staleCutoff = new Date(now.getTime() - 3600000);
  const rows = await db('emails')
    .where('draft_gmail_id', 'pending')
    .where('draft_claimed_at', '<', staleCutoff)
    .select('id', 'gmail_id', 'gmail_thread_id', 'from_address', 'from_name', 'subject', 'body_text', 'snippet', 'label_ids', 'classification', 'message_id', 'reply_to', 'received_at');
  const counts = { settled: 0, released: 0, redrafted: 0 };
  for (const row of rows) {
    try {
      const thread = await gmailClient.getThread(row.gmail_thread_id);
      const msgs = thread?.messages || [];
      const hasDraft = msgs.some((m) => (m.labelIds || []).includes('DRAFT'));
      // A SENT reply newer than the inbound message settles the thread —
      // never release-and-redraft over an operator's own answer.
      const inboundAt = new Date(row.received_at || 0).getTime();
      const hasNewerSent = msgs.some((m) => (m.labelIds || []).includes('SENT') && Number(m.internalDate || 0) > inboundAt);
      const patch = hasDraft
        ? { draft_gmail_id: 'reconciled_existing_draft' }
        : (hasNewerSent
          ? { draft_gmail_id: 'reconciled_replied' }
          : { draft_gmail_id: null, draft_claimed_at: null });
      // Re-assert STALENESS in the update — a concurrent draftReplyForEmail
      // takeover refreshes draft_claimed_at, and releasing that ACTIVE claim
      // would let another worker mint a duplicate draft mid-flight.
      const n = await db('emails')
        .where({ id: row.id, draft_gmail_id: 'pending' })
        .where('draft_claimed_at', '<', staleCutoff)
        .update({ ...patch, updated_at: new Date() });
      if (n) counts[(hasDraft || hasNewerSent) ? 'settled' : 'released'] += 1;
      // A release is only useful if something retries — classification and
      // auto-actions ran once at insert, so re-draft eligible rows here
      // (draftReplyForEmail re-claims atomically and no-ops when the gate is
      // off or the row is non-inbound). Lazy require: email-actions requires
      // this module.
      if (n && !hasDraft && !hasNewerSent && ['customer_request', 'scheduling', 'complaint'].includes(row.classification)) {
        try {
          const { draftReplyForEmail } = require('./email-actions');
          const customer = await db('customers').where('email', normalizeAddress(row.from_address)).first();
          // Returns a real draft id only when a Gmail draft was created —
          // null covers gate-off and internally handled failures; counting
          // those would report recoveries that never happened.
          const draftId = await draftReplyForEmail(row, { customer, tone: row.classification === 'complaint' ? 'complaint' : 'service' });
          if (draftId) counts.redrafted += 1;
        } catch (e) {
          logger.warn(`[inbox-hygiene] released-claim redraft failed (email ${row.id}): ${e.message}`);
        }
      }
    } catch (e) {
      logger.warn(`[inbox-hygiene] pending-draft reconcile failed (email ${row.id}): ${e.message}`);
    }
  }
  // Newsletter claims stranded by a crash: hand them back through
  // handleNewsletter, whose claim predicate accepts hour-old 'processing'
  // rows (the unsubscribe attempt log keeps live requests once-per-email).
  const staleNewsletters = await db('emails')
    .where('auto_action', 'newsletter_processing')
    .where('updated_at', '<', new Date(now.getTime() - 3600000))
    .select('id', 'gmail_id', 'from_address', 'from_name', 'subject', 'body_text', 'body_html', 'snippet', 'list_unsubscribe', 'list_unsubscribe_post', 'authentication_results', 'auto_action');
  for (const row of staleNewsletters) {
    try {
      const { executeAutoAction } = require('./email-actions');
      const outcome = await executeAutoAction(row, { category: 'marketing_newsletter' });
      // Count only real recoveries — a failed handler leaves the stale
      // claim for the next reconcile pass.
      if (outcome?.ok) counts.newslettersRecovered = (counts.newslettersRecovered || 0) + 1;
    } catch (e) {
      logger.warn(`[inbox-hygiene] stale newsletter claim recovery failed (email ${row.id}): ${e.message}`);
    }
  }

  if (counts.settled || counts.released) {
    logger.info(`[inbox-hygiene] draft reconcile: ${counts.settled} settled, ${counts.released} released`);
  }
  return counts;
}

module.exports = {
  QUARANTINE_LABEL,
  QUARANTINE_HOURS,
  isKnownSender,
  hasAlignedAuth,
  quarantineMessage,
  cancelQuarantine,
  settleDeferredBlock,
  sweepQuarantine,
  rescueSpamFolder,
  collectUnansweredNudges,
  reconcilePendingDrafts,
};
