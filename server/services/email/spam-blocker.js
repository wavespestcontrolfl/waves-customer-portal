const { google } = require('googleapis');
const db = require('../../models/db');
const logger = require('../logger');

const SHARED_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'gmail',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'bellsouth.net',
  'tampabay.rr.com',
  'sbcglobal.net',
  'cox.net',
  'frontier.com',
  'netzero.net',
  'duck.com',
  'pm.me',
  'passmail.net',
  'proton.me',
  'protonmail.com',
]);

const OPERATIONAL_EMAIL_DOMAINS = new Set([
  'google.com',
  'googleapis.com',
  'googleusercontent.com',
  'gserviceaccount.com',
  'wavespestcontrol.com',
  'www.wavespestcontrol.com',
  'portal.wavespestcontrol.com',
  'waveslawncare.com',
  'wavespestcontrolbradenton.com',
  'wavespestcontrolparrish.com',
  'wavespestcontrolsarasota.com',
  'wavespestcontrolvenice.com',
  'bradentonflexterminator.com',
  'bradentonflpestcontrol.com',
  'palmettoexterminator.com',
  'palmettoflpestcontrol.com',
  'parrishexterminator.com',
  'parrishpestcontrol.com',
  'sarasotaflexterminator.com',
  'sarasotaflpestcontrol.com',
  'veniceexterminator.com',
  'veniceflpestcontrol.com',
  'northportflpestcontrol.com',
  'bradentonfllawncare.com',
  'sarasotafllawncare.com',
  'venicelawncare.com',
  'facebook.com',
  'business.facebook.com',
  'meta.com',
  'stripe.com',
  'sendgrid.net',
  'sendgrid.com',
  'cloudflare.com',
  'railway.app',
  'twilio.com',
  'namecheap.com',
  'anthropic.com',
  // Business-critical partners: the liability insurance broker and the
  // marina whose COI requirement gates on-site work (2026-07-28 — the
  // renewal thread was buried in a 1,900-item inbox while the policy
  // lapsed; these can never be classified into a destructive action).
  'flhins.com',
  'rdmarina.com',
]);

// Mirrors inbox-hygiene / email-actions (which mirror CLOSED_STATUSES in
// intelligence-bar/leads-tools.js). Local copy — inbox-hygiene requires this
// module, so importing from it would be circular.
const TERMINAL_LEAD_STATUSES = ['won', 'lost', 'disqualified', 'duplicate', 'unresponsive'];

function normalizeAddress(value) {
  return value ? String(value).trim().toLowerCase() : '';
}

function domainFromAddress(value) {
  const normalized = normalizeAddress(value);
  const at = normalized.lastIndexOf('@');
  return at > -1 ? normalized.slice(at + 1) : '';
}

function domainMatches(domain, roots) {
  const normalized = String(domain || '').trim().toLowerCase();
  if (!normalized) return false;
  for (const root of roots) {
    if (normalized === root || normalized.endsWith(`.${root}`)) return true;
  }
  return false;
}

function isProtectedDomain(domain) {
  return domainMatches(domain, SHARED_EMAIL_DOMAINS) || domainMatches(domain, OPERATIONAL_EMAIL_DOMAINS);
}

function isOperationalDomain(domain) {
  return domainMatches(domain, OPERATIONAL_EMAIL_DOMAINS);
}

function redactEmail(value) {
  const normalized = normalizeAddress(value);
  const [local, domain] = normalized.split('@');
  if (!local || !domain) return 'unknown';
  return `${local.slice(0, 1)}***@${domain}`;
}

// A freshly created Gmail filter whose DB record failed AND whose rollback
// could not be CONFIRMED deleted (Gmail auth unavailable, or the delete
// itself failed) would be permanently untracked — silently blocking the
// sender past any unblock (pre-push r21 P1). Persist it to the dedupe
// orphan ledger so the ops sweep (spam-block-orphan-filter-sweep.js)
// recovers it; best-effort — a ledger miss still logs the filter id loudly.
async function ledgerUnconfirmedFilter({ filterId, blockEmail = null, blockDomain = null, reason }) {
  if (!filterId) return;
  try {
    const hasLedger = await db.schema.hasTable('blocked_email_senders_dedupe_orphans');
    if (!hasLedger) throw new Error('ledger table missing');
    await db('blocked_email_senders_dedupe_orphans').insert({
      email_address: blockEmail,
      domain: blockDomain,
      gmail_filter_id: filterId,
      source_row_id: `rollback:${reason}`,
    });
    logger.warn(`[spam-blocker] unconfirmed filter rollback (${reason}) — filter ${filterId} ledgered for the ops sweep`);
  } catch (ledgerErr) {
    logger.error(`[spam-blocker] ORPHANED Gmail filter ${filterId} (${reason}) could not be ledgered — delete it manually: ${ledgerErr.message}`);
  }
}

async function blockSpamSender(email) {
  const fromAddress = normalizeAddress(email.from_address);
  const domain = domainFromAddress(fromAddress);
  if (!domain) return;
  const redactedFrom = redactEmail(fromAddress);

  // Never let an automatic classifier decision suppress Waves-owned or
  // critical platform mail. These senders carry customer replies, account
  // security notices, GBP, GSC, calendar, and infrastructure alerts.
  if (isOperationalDomain(domain)) return;

  // Don't block known good domains
  const isVendor = await db('vendor_email_domains').where('domain', domain).first();
  if (isVendor) return;

  // Don't block customer emails (stored casing may differ)
  const isCustomer = await db('customers').whereRaw('LOWER(email) = ?', [fromAddress]).first();
  if (isCustomer) return;

  // Don't block live leads either — a prospect whose first email tripped
  // the classifier must stay reachable while the lead is OPEN. Closed leads
  // (lost/disqualified/duplicate/unresponsive) get no exemption.
  const isLead = await db('leads')
    .whereRaw('LOWER(email) = ?', [fromAddress])
    .whereNull('deleted_at')
    .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
    .first();
  if (isLead) return;

  // Check if already blocked
  const existingQuery = db('blocked_email_senders').where('email_address', fromAddress);
  if (!isProtectedDomain(domain)) existingQuery.orWhere('domain', domain);
  const existing = await existingQuery.first();

  if (existing) {
    await db('blocked_email_senders').where({ id: existing.id }).increment('blocked_count', 1);
    return;
  }

  // Auto-spam decisions block the exact sender. Domain-wide blocks stay manual
  // because one bad shared-domain sender should not trash unrelated customers.
  let filterId = null;
  try {
    const gmailClient = require('./gmail-client');
    const auth = await gmailClient.getAuthClient();
    if (auth) {
      const gmail = google.gmail({ version: 'v1', auth });
      const filter = await gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria: { from: fromAddress },
          action: { removeLabelIds: ['INBOX'], addLabelIds: ['TRASH'] },
        },
      });
      filterId = filter.data.id;
      logger.info(`[spam-blocker] Gmail filter created for ${redactedFrom}: ${filterId}`);
    }
  } catch (err) {
    logger.warn(`[spam-blocker] Gmail filter creation failed for ${redactedFrom}: ${err.message}`);
  }

  try {
    await db('blocked_email_senders').insert({
      domain: null,
      email_address: fromAddress,
      gmail_filter_id: filterId,
      reason: 'spam_auto',
    });
  } catch (insertErr) {
    // The Gmail filter already exists but we failed to record it — roll the
    // filter back (best effort) so a retry recreates BOTH atomically enough,
    // instead of stacking orphaned filters no unblock can ever find.
    if (filterId) {
      let rolledBack = false;
      try {
        const gmailClient = require('./gmail-client');
        const auth = await gmailClient.getAuthClient();
        if (auth) {
          const gmail = google.gmail({ version: 'v1', auth });
          await gmail.users.settings.filters.delete({ userId: 'me', id: filterId });
          logger.info(`[spam-blocker] rolled back unrecorded Gmail filter ${filterId}`);
          rolledBack = true;
        }
      } catch (rollbackErr) {
        logger.warn(`[spam-blocker] filter rollback failed (${filterId}): ${rollbackErr.message}`);
      }
      if (!rolledBack) await ledgerUnconfirmedFilter({ filterId, blockEmail: fromAddress, reason: 'auto_insert_failed' });
    }
    // Unique-scope race lost (pre-push r18 P1): count the hit on the row
    // that won, exactly as the existing-row branch above would have.
    if (insertErr && insertErr.code === '23505') {
      await db('blocked_email_senders').where('email_address', fromAddress)
        .increment('blocked_count', 1).catch(() => {});
      return;
    }
    throw insertErr;
  }

  logger.info(`[spam-blocker] Blocked sender: ${redactedFrom}`);
}

const MANUAL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MANUAL_DOMAIN_RE = /^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}$/i;

// Operator-confirmed manual block — the ONE manual sender/domain blocker
// (GH r9 P1: admin-email POST /block and the IB block_sender card both call
// this; never grow a parallel copy). Unlike the auto-classifier path above
// — which blocks only the exact sender and silently declines vendors/
// customers/open leads — a manual block honors the operator's approved
// scope exactly: an email_address blocks that one sender; a domain (only
// when no address is given) blocks the whole domain, refused for
// protected/shared provider domains.
// Scope normalization + validation shared by the executor AND the IB
// proposal (GH r21 P2): a card must never promise a block manualBlockSender
// deterministically rejects (missing scope, malformed input, protected
// domain). Returns { error } or { blockEmail, blockDomain }.
function validateManualBlockScope({ email_address, domain } = {}) {
  const blockEmail = email_address ? normalizeAddress(email_address) : null;
  const blockDomain = !blockEmail && domain
    ? String(domain).trim().toLowerCase().replace(/^@/, '') : null;
  if (!blockEmail && !blockDomain) return { error: 'email_address or domain required' };
  if (blockEmail && !MANUAL_EMAIL_RE.test(blockEmail)) return { error: 'Invalid email address' };
  if (blockDomain && !MANUAL_DOMAIN_RE.test(blockDomain)) return { error: 'Invalid domain' };
  if (blockDomain && isProtectedDomain(blockDomain)) {
    return { error: 'Protected domains cannot be blocked domain-wide. Block a specific sender address instead.' };
  }
  return { blockEmail, blockDomain };
}

async function manualBlockSender({ email_address, domain, reason } = {}) {
  const scope = validateManualBlockScope({ email_address, domain });
  if (scope.error) return { error: scope.error };
  const { blockEmail, blockDomain } = scope;
  const filterFrom = blockEmail || `@${blockDomain}`;

  // Reuse an existing block of the SAME scope instead of stacking a second
  // row + Gmail filter (GH r12 P2, mirrors the auto path's existing-row
  // check): duplicates make unblocking a lie — removing one row deletes one
  // filter and leaves the sender still blocked by the other. A row whose
  // filter is missing (recorded under the Gmail-unavailable warning) gets
  // the filter re-applied onto the SAME row instead.
  const existing = blockEmail
    ? await db('blocked_email_senders').where('email_address', blockEmail).first()
    // Pure domain rows only (pre-push r20 P1): a legacy row storing BOTH an
    // address and its domain is an address block — matching it here would
    // report the whole domain blocked without any domain filter existing.
    : await db('blocked_email_senders').where('domain', blockDomain).whereNull('email_address').first();
  if (existing && existing.gmail_filter_id) {
    logger.info(`[spam-blocker] Manual block requested for already-blocked ${blockEmail ? `sender ${redactEmail(blockEmail)}` : `domain @${blockDomain}`} — existing block kept`);
    return {
      success: true,
      entry: existing,
      already_blocked: true,
      ...(blockEmail ? { blocked_address: blockEmail } : { blocked_domain: blockDomain }),
    };
  }

  let filterId = null;
  try {
    const gmailClient = require('./gmail-client');
    const auth = await gmailClient.getAuthClient();
    if (auth) {
      const gmail = google.gmail({ version: 'v1', auth });
      const filter = await gmail.users.settings.filters.create({
        userId: 'me',
        requestBody: {
          criteria: { from: filterFrom },
          action: { removeLabelIds: ['INBOX'], addLabelIds: ['TRASH'] },
        },
      });
      filterId = filter.data.id;
    }
  } catch (err) {
    logger.warn(`[spam-blocker] manual Gmail filter creation failed: ${err.message}`);
  }

  if (existing) {
    // Existing row, missing filter: repair in place — record the fresh
    // filter (if Gmail was reachable) on the row every unblock path
    // already knows about. Same orphan-filter rollback contract as the
    // insert branches (GH r13 P2): a filter recorded nowhere is invisible
    // to every unblock path, and a retry would stack another.
    let entry = existing;
    if (filterId) {
      const rollbackFilter = async (reason) => {
        let rolledBack = false;
        try {
          const gmailClient = require('./gmail-client');
          const auth = await gmailClient.getAuthClient();
          if (auth) {
            const gmail = google.gmail({ version: 'v1', auth });
            await gmail.users.settings.filters.delete({ userId: 'me', id: filterId });
            rolledBack = true;
          }
        } catch (rollbackErr) {
          logger.warn(`[spam-blocker] repair filter rollback (${reason}) failed (${filterId}): ${rollbackErr.message}`);
        }
        if (!rolledBack) await ledgerUnconfirmedFilter({ filterId, blockEmail, blockDomain, reason: `repair_${reason}` });
      };
      try {
        // CAS: only the FIRST repair records its filter (pre-push r18 P1) —
        // a concurrent repair that already recorded one makes this update
        // match zero rows, and OUR fresh filter rolls back instead of
        // living untracked where no unblock can ever find it.
        [entry] = await db('blocked_email_senders').where({ id: existing.id })
          .whereNull('gmail_filter_id')
          .update({ gmail_filter_id: filterId }).returning('*');
      } catch (updateErr) {
        await rollbackFilter('update-failed');
        throw updateErr;
      }
      if (!entry) {
        await rollbackFilter('cas-lost');
        entry = await db('blocked_email_senders').where({ id: existing.id }).first() || existing;
      }
    }
    logger.info(`[spam-blocker] Manual re-block ${filterId ? 'repaired the missing Gmail filter for' : 'found no Gmail filter and could not create one for'} ${blockEmail ? `sender ${redactEmail(blockEmail)}` : `domain @${blockDomain}`}`);
    return {
      success: true,
      entry,
      already_blocked: true,
      ...(blockEmail ? { blocked_address: blockEmail } : { blocked_domain: blockDomain }),
      ...(entry && entry.gmail_filter_id ? {} : {
        warning: 'Blocklist row recorded, but the Gmail auto-trash filter could NOT be created (Gmail unavailable) — messages may stay visible in Gmail until the block is re-applied.',
      }),
    };
  }

  let entry = null;
  try {
    [entry] = await db('blocked_email_senders').insert({
      email_address: blockEmail,
      domain: blockDomain,
      gmail_filter_id: filterId,
      reason: reason || 'Manual block',
      blocked_count: 0,
    }).returning('*');
  } catch (insertErr) {
    // Same orphan-filter rollback contract as the auto path: a filter with
    // no record is invisible to every unblock path.
    if (filterId) {
      let rolledBack = false;
      try {
        const gmailClient = require('./gmail-client');
        const auth = await gmailClient.getAuthClient();
        if (auth) {
          const gmail = google.gmail({ version: 'v1', auth });
          await gmail.users.settings.filters.delete({ userId: 'me', id: filterId });
          rolledBack = true;
        }
      } catch (rollbackErr) {
        logger.warn(`[spam-blocker] manual filter rollback failed (${filterId}): ${rollbackErr.message}`);
      }
      if (!rolledBack) await ledgerUnconfirmedFilter({ filterId, blockEmail, blockDomain, reason: 'manual_insert_failed' });
    }
    // Unique-scope race lost (pre-push r18 P1): a concurrent block landed
    // first — that IS the block; return it as already_blocked.
    if (insertErr && insertErr.code === '23505') {
      const winner = blockEmail
        ? await db('blocked_email_senders').where('email_address', blockEmail).first()
        : await db('blocked_email_senders').where('domain', blockDomain).whereNull('email_address').first();
      if (winner) {
        logger.info(`[spam-blocker] concurrent manual block won for ${blockEmail ? `sender ${redactEmail(blockEmail)}` : `domain @${blockDomain}`} — reusing it`);
        return {
          success: true,
          entry: winner,
          already_blocked: true,
          ...(blockEmail ? { blocked_address: blockEmail } : { blocked_domain: blockDomain }),
          ...(winner.gmail_filter_id ? {} : {
            warning: 'Blocklist row recorded, but the Gmail auto-trash filter could NOT be created (Gmail unavailable) — messages may stay visible in Gmail until the block is re-applied.',
          }),
        };
      }
    }
    throw insertErr;
  }
  logger.info(`[spam-blocker] Manually blocked ${blockEmail ? `sender ${redactEmail(blockEmail)}` : `domain @${blockDomain}`}`);
  return {
    success: true,
    entry,
    ...(blockEmail ? { blocked_address: blockEmail } : { blocked_domain: blockDomain }),
    // The card's effect promises "Gmail filter + blocklist row" — a missing
    // filter must surface, never a bare Done (GH r9 P2). The blocklist row
    // still trash-routes via app-level processing once sync runs.
    ...(filterId ? {} : {
      warning: 'Blocklist row recorded, but the Gmail auto-trash filter could NOT be created (Gmail unavailable) — messages may stay visible in Gmail until the block is re-applied.',
    }),
  };
}

async function unblockSender(id) {
  const blocked = await db('blocked_email_senders').where({ id }).first();
  if (!blocked) return { error: 'Not found' };

  if (blocked.gmail_filter_id) {
    try {
      const gmailClient = require('./gmail-client');
      const auth = await gmailClient.getAuthClient();
      if (!auth) {
        // A stored filter id with no Gmail connection means the filter is
        // STILL routing this sender to Trash — deleting our record would
        // report an unblock that never happened.
        return { error: 'Gmail not connected — filter cannot be removed; retry after reconnecting' };
      }
      {
        const gmail = google.gmail({ version: 'v1', auth });
        await gmail.users.settings.filters.delete({ userId: 'me', id: blocked.gmail_filter_id });
        logger.info(`[spam-blocker] Gmail filter removed: ${blocked.gmail_filter_id}`);
      }
    } catch (err) {
      // 404 = the filter is already gone (idempotent success); anything else
      // means Gmail is STILL trash-routing this sender — deleting our record
      // would report an unblock that never happened and lose the filter id.
      const gone = err.code === 404 || err.response?.status === 404;
      if (!gone) {
        logger.warn(`[spam-blocker] Gmail filter removal failed — block record retained for retry: ${err.message}`);
        return { error: 'Gmail filter removal failed — sender is still blocked; retry the unblock' };
      }
      logger.info(`[spam-blocker] Gmail filter already gone: ${blocked.gmail_filter_id}`);
    }
  }

  await db('blocked_email_senders').where({ id }).del();
  return { success: true, unblocked: blocked.domain || blocked.email_address };
}

/**
 * Remove a stale spam_auto block (Gmail filter + row) for a sender who has
 * since become an identity we protect, recovering any mail the filter
 * already buried. Ordered stages — the row is deleted LAST, only after both
 * the filter removal and the Trash recovery succeed, so any failure keeps
 * the row as the retry token: the sender's next message (via isBlocked) or
 * the daily reconcile re-runs the FULL recovery. Recovery searches Trash
 * for everything from this sender (not just the triggering message) —
 * earlier mail the filter buried before sync ever saw it comes back too.
 */
async function removeStaleAutoBlock(normalizedAddress, { untrashGmailId = null } = {}) {
  try {
    const row = await db('blocked_email_senders')
      .whereRaw('LOWER(email_address) = ?', [normalizedAddress])
      .where({ reason: 'spam_auto' })
      .first();
    if (!row) return { success: true };
    const gmailClient = require('./gmail-client');
    // 1. Delete the Gmail filter — stops future burials. 404 = already gone
    //    (a prior attempt got this far), which makes retries idempotent.
    if (row.gmail_filter_id) {
      const auth = await gmailClient.getAuthClient();
      if (!auth) {
        logger.warn(`[spam-blocker] stale auto-block removal deferred — Gmail not connected (${redactEmail(normalizedAddress)})`);
        return { success: false };
      }
      try {
        const gmail = google.gmail({ version: 'v1', auth });
        await gmail.users.settings.filters.delete({ userId: 'me', id: row.gmail_filter_id });
        logger.info(`[spam-blocker] stale-block Gmail filter removed: ${row.gmail_filter_id}`);
      } catch (err) {
        const gone = err.code === 404 || err.response?.status === 404;
        if (!gone) {
          logger.warn(`[spam-blocker] stale-filter removal failed — block row retained for retry: ${err.message}`);
          return { success: false };
        }
      }
    }
    // 2. Recover what the BLOCK buried — nothing else. Two precise sources:
    //    (a) rows this sync itself trashed ('blocked_sender_trashed') —
    //        these exist filter or no filter, since a DB-level block
    //        trashes each arriving message;
    //    (b) when a Gmail FILTER existed, a Trash search scoped to the
    //        block's lifetime (after: created_at) — filter burials during
    //        a sync outage leave no DB row. An unscoped from: search would
    //        resurrect operator-deleted mail predating the block, and a
    //        filterless block can't have buried anything sync didn't record.
    //    A failure here keeps the row even though the filter is gone
    //    (step 1 tolerates the resulting 404).
    const ids = new Set();
    if (untrashGmailId) ids.add(untrashGmailId);
    const syncTrashed = await db('emails')
      .whereRaw('LOWER(from_address) = ?', [normalizedAddress])
      .where('auto_action', 'blocked_sender_trashed')
      .select('gmail_id');
    for (const r of syncTrashed || []) if (r.gmail_id) ids.add(r.gmail_id);
    let truncated = false;
    if (row.gmail_filter_id) {
      const afterEpoch = row.created_at
        ? Math.floor(new Date(row.created_at).getTime() / 1000) - 1
        : null;
      const query = afterEpoch !== null
        ? `in:trash from:${normalizedAddress} after:${afterEpoch}`
        : `in:trash from:${normalizedAddress} newer_than:30d`;
      const searched = await gmailClient.listAllMessages(query, 100, { includeSpamTrash: true });
      for (const m of searched.messages || []) ids.add(m.id);
      truncated = !!searched.truncated;
    }
    let recovered = 0;
    for (const id of ids) {
      let labels;
      try {
        labels = await gmailClient.getMessageLabels(id);
      } catch (err) {
        // Gmail purges Trash after 30 days: a 404 here means the buried
        // message is permanently gone — "nothing left to recover", not a
        // retryable failure. Without this, one purged burial makes the
        // unwind fail forever (the daily reconcile looped on exactly this
        // for a week). Same 404 tolerance as the filter delete above; any
        // other error still aborts and keeps the row as the retry token.
        const gone = err.code === 404 || err.response?.status === 404;
        if (gone) continue;
        throw err;
      }
      if (labels.includes('TRASH')) {
        await gmailClient.modifyLabels(id, ['INBOX'], ['TRASH']);
        recovered += 1;
      }
    }
    if (recovered) logger.info(`[spam-blocker] recovered ${recovered} message(s) buried by the stale block`);
    // A truncated search means more buried mail remains — keep the row so
    // the next pass drains the rest (already-recovered messages no longer
    // match in:trash, so successive passes page through naturally).
    if (truncated) {
      logger.warn('[spam-blocker] stale-block recovery truncated at 100 messages — row retained; next pass continues');
      return { success: false };
    }
    // 3. Fully unwound — only now does the retry token go away.
    await db('blocked_email_senders').where({ id: row.id }).del();
    logger.info(`[spam-blocker] removed stale auto-block for now-protected sender ${redactEmail(normalizedAddress)}`);
    return { success: true };
  } catch (e) {
    logger.warn(`[spam-blocker] stale auto-block removal failed for ${redactEmail(normalizedAddress)} — row retained for retry: ${e.message}`);
    return { success: false };
  }
}

/**
 * Daily belt for stale auto-blocks: a blocked sender who has SINCE become a
 * customer/open lead (or whose domain joined the operational set) gets the
 * block unwound even if they never email again — without this, recovery of
 * already-buried mail waits on their next inbound message to trip isBlocked.
 */
async function reconcileStaleAutoBlocks() {
  const counts = { reconciled: 0, failed: 0 };
  const rows = await db('blocked_email_senders')
    .where({ reason: 'spam_auto' })
    .select('id', 'email_address');
  for (const row of rows) {
    const normalized = normalizeAddress(row.email_address || '');
    if (!normalized) continue;
    try {
      const domain = domainFromAddress(normalized);
      const identity = (domain && isOperationalDomain(domain))
        || !!(await db('customers').whereRaw('LOWER(email) = ?', [normalized]).whereNull('deleted_at').first())
        || !!(await db('leads')
          .whereRaw('LOWER(email) = ?', [normalized])
          .whereNull('deleted_at')
          .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
          .first());
      if (!identity) continue;
      const result = await removeStaleAutoBlock(normalized);
      counts[result?.success ? 'reconciled' : 'failed'] += 1;
    } catch (e) {
      counts.failed += 1;
      logger.warn(`[spam-blocker] stale-block reconcile failed for ${redactEmail(normalized)}: ${e.message}`);
    }
  }
  return counts;
}

async function isBlocked(fromAddress, { gmailId = null } = {}) {
  if (!fromAddress) return false;
  const normalized = normalizeAddress(fromAddress);
  const domain = domainFromAddress(normalized);
  if (!domain) return false;

  // Identity checks come FIRST — a stale exact block recorded before a
  // sender became a customer/open lead, or before their domain joined the
  // operational set, must not keep auto-trashing their mail. (Shared
  // mailbox providers like gmail.com are NOT identity — exact blocks on
  // those still apply below.) The DB fail-open alone is not enough: a
  // stored gmail_filter_id keeps trash-routing at GMAIL level, so the stale
  // auto-block (row + filter) is actively removed; a failed removal keeps
  // the row for the next message's retry.
  const exactBlocked = await db('blocked_email_senders')
    .where('email_address', normalized)
    .first();

  const identity = isOperationalDomain(domain)
    // Live customers only — a soft-deleted customer is no longer a protected
    // identity (mirrors isKnownSender), so their block stays enforced.
    || !!(await db('customers').whereRaw('LOWER(email) = ?', [normalized]).whereNull('deleted_at').first())
    || !!(await db('leads')
      .whereRaw('LOWER(email) = ?', [normalized])
      .whereNull('deleted_at')
      .where((q) => q.whereNull('status').orWhereNotIn('status', TERMINAL_LEAD_STATUSES))
      .first());
  if (identity) {
    // A MANUAL exact block on a protected address is an explicit admin
    // decision and stays honored; only stale AUTOMATIC blocks are removed.
    if (exactBlocked && exactBlocked.reason !== 'spam_auto') {
      await db('blocked_email_senders').where({ id: exactBlocked.id }).increment('blocked_count', 1);
      return true;
    }
    if (exactBlocked) await removeStaleAutoBlock(normalized, { untrashGmailId: gmailId });
    return false;
  }

  // Exact sender blocks still outrank the vendor-DOMAIN fail-open (a domain
  // is not an identity — one bad sender at a vendor domain stays blocked).
  if (exactBlocked) {
    await db('blocked_email_senders').where({ id: exactBlocked.id }).increment('blocked_count', 1);
    return true;
  }

  const isVendor = await db('vendor_email_domains').where('domain', domain).first();
  if (isVendor) return false;

  if (isProtectedDomain(domain)) return false;

  const blocked = await db('blocked_email_senders').where('domain', domain).first();

  if (blocked) {
    await db('blocked_email_senders').where({ id: blocked.id }).increment('blocked_count', 1);
    return true;
  }
  return false;
}

module.exports = {
  blockSpamSender,
  manualBlockSender,
  validateManualBlockScope,
  unblockSender,
  reconcileStaleAutoBlocks,
  isBlocked,
  domainFromAddress,
  domainMatches,
  isProtectedDomain,
  isOperationalDomain,
  normalizeAddress,
};
