/**
 * Intelligence Bar — unblock one blocked email sender or domain
 * server/services/intelligence-bar/unblock-sender-tools.js
 *
 * Owner ask 2026-10-28 (IB gap #6: "unblock an email sender from the bar"): the other half of block_sender
 * (email-tools.js), a card that replays the Email page's own Unblock.
 *
 *   unblock_sender — the Email page "Unblock" (DELETE /admin/email/blocked/:id), run through
 *                    services/email/spam-blocker.js unblockSender: the SAME function the route and the
 *                    inbox-hygiene recovery call, so every rule and refusal is the page's own.
 *
 * What the unblock writes (read end to end, spam-blocker.js unblockSender): when the blocklist row has a Gmail filter
 * id, the Gmail filter that sends the sender's mail to Trash is deleted first (a filter Gmail already lost counts as
 * gone; a missing Gmail connection or any other Gmail failure refuses and keeps the row, so the sender is never
 * reported unblocked while Gmail still trashes it); then the blocklist row is deleted. Mail already in Trash is NOT
 * moved back. The automatic spam check can block an address again if it flags new mail from it. It sends NO text,
 * email or call.
 *
 * Always a confirm card (write-gates.js two-step), admin only (the Email routes are requireAdmin), never
 * owner-direct, platform path only, dark behind GATE_IB_UNBLOCK_SENDER (which needs GATE_IB_PLATFORM).
 *
 *   unconfirmed -> a PREVIEW: nothing is written. Its `_version` pins the blocklist row the card showed (id,
 *                  address, domain, reason, when it was blocked, its block count, the Gmail filter). The model
 *                  never supplies a pin.
 *   confirmed   -> re-derives the preview, then unblockSender re-reads the row FOR UPDATE inside its own transaction
 *                  and refuses (preview_changed) if the row changed or is gone, before the Gmail filter is touched.
 */
const logger = require('../logger');
const db = require('../../models/db');
const { UUID_RE } = require('./task-context');

function unblockSenderLive() {
  return require('../../config/feature-gates').ibUnblockSenderLive() === true;
}

const UNBLOCK_SENDER_TOOLS = [
  {
    name: 'unblock_sender',
    description: `Unblock ONE blocked email sender or domain: the Email page's blocklist "Unblock" button. The other half of block_sender. The first call returns a PREVIEW and writes nothing: the address or domain, when and why it was blocked, how many messages the block caught, and exactly what unblocking does. The operator approves on the confirmation card; the confirmed run re-checks the blocklist entry and refuses if it changed or is gone.
Effects: the Gmail filter that sends this sender's mail to Trash is removed (when one is on file) and the blocklist entry is deleted, so new mail from it is no longer auto-trashed and is checked like any other mail. Mail already in Trash stays there. The automatic spam check can block an address again if it flags new mail from it. If Gmail can't be reached or the filter can't be removed, nothing changes and the sender stays blocked. Nothing is sent to anyone.
Give exactly one of blocked_id (the entry id from get_blocked_senders), email_address (a blocked address) or domain (a blocked domain). Refused with the reason: entry not found. Admin only.
Use for: "unblock spamsite.com", "unblock that sender", "take sales@vendor.com off the blocklist", "I blocked the wrong sender, undo it", "remove the block on this domain".`,
    input_schema: {
      type: 'object',
      properties: {
        blocked_id: { type: 'string', format: 'uuid', description: 'The blocklist entry id (from get_blocked_senders)' },
        email_address: { type: 'string', description: 'A blocked sender address (use instead of blocked_id)' },
        domain: { type: 'string', description: 'A blocked domain, e.g. spamsite.com (use instead of blocked_id)' },
      },
    },
    _sideEffects: true,
  },
];

const refusal = (error, code, extra = {}) => ({ error, code, ...extra });
const COLUMNS = ['id', 'email_address', 'domain', 'reason', 'blocked_count', 'created_at', 'gmail_filter_id'];
const REASON_CHARS = 120;

const reasonText = (reason) => {
  const plain = String(reason || '').replace(/\s+/g, ' ').trim();
  if (!plain) return 'no reason recorded';
  if (plain === 'spam_auto') return 'the automatic spam check';
  return plain.length > REASON_CHARS ? `${plain.slice(0, REASON_CHARS - 1).trimEnd()}…` : plain;
};

function blockedAtEt(value) {
  const at = value ? new Date(value) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const { formatETDate, formatETTime, TZ } = require('../../utils/datetime-et');
  const year = at.toLocaleDateString('en-US', { year: 'numeric', timeZone: TZ });
  return `${formatETDate(at)}, ${year}, ${formatETTime(at)} ET`;
}

// The facts the card shows and Confirm re-checks, from one blocklist row (a pure function, so the locked re-read in
// the unblock's own transaction builds the identical pin).
function versionOf(row, overlap = null) {
  return {
    blocked_id: row.id,
    email_address: row.email_address || null,
    domain: row.domain || null,
    reason: row.reason || null,
    blocked_count: Number(row.blocked_count) || 0,
    blocked_ms: row.created_at ? new Date(row.created_at).getTime() : null,
    gmail_filter_id: row.gmail_filter_id || null,
    // The other blocks this unblock leaves in place (null when there are none), pinned like the row itself.
    overlap,
  };
}

const OVERLAP_CAP = 50;
const domainOfAddress = (address) => String(address || '').split('@').pop().trim().toLowerCase();

// The OTHER blocklist entries that keep acting on what this unblock is about (the bar never removes them):
//  - an address row: a pure domain block on the address's own domain. Its Gmail filter and the blocklist's own domain check
//    (spam-blocker.js isBlocked) still send the address's mail to Trash after the address entry is gone.
//  - a domain row: individual address blocks at that domain, each still in force.
// `lock` holds those rows FOR SHARE inside the unblock's transaction, so one cannot appear or go between the check and the write.
async function overlapOf(row, conn = db, { lock = false } = {}) {
  if (row.email_address) {
    const domain = domainOfAddress(row.email_address);
    if (!domain) return null;
    const q = conn('blocked_email_senders').whereRaw('LOWER(domain) = ?', [domain]).whereNull('email_address').whereNot({ id: row.id }).orderBy('id');
    const other = await (lock ? q.forShare() : q).first('id');
    return other ? { kind: 'domain_block', domain, id: other.id } : null;
  }
  const domain = String(row.domain || '').trim().toLowerCase();
  if (!domain) return null;
  const q = conn('blocked_email_senders').whereRaw('LOWER(email_address) LIKE ?', [`%@${domain}`]).whereNot({ id: row.id }).orderBy('id').limit(OVERLAP_CAP);
  const others = await (lock ? q.forShare() : q).select('id');
  return others.length ? { kind: 'address_blocks', domain, count: others.length } : null;
}

// The one blocklist row the call names: exactly one of blocked_id / email_address / domain.
async function resolveRow(input) {
  const rawId = String(input?.blocked_id || '').trim().toLowerCase();
  const rawAddress = String(input?.email_address || '').trim().toLowerCase();
  const rawDomain = String(input?.domain || '').trim().toLowerCase().replace(/^@/, '');
  if ([rawId, rawAddress, rawDomain].filter(Boolean).length !== 1) {
    return refusal('Give exactly one of blocked_id, email_address or domain', 'invalid_target');
  }
  if (rawId && !UUID_RE.test(rawId)) return refusal('A valid blocked_id is required', 'invalid_target');
  const q = db('blocked_email_senders');
  if (rawId) q.where({ id: rawId });
  else if (rawAddress) q.whereRaw('LOWER(email_address) = ?', [rawAddress]);
  // Pure domain rows only, like manualBlockSender: a legacy address row that also stored its domain is an address block.
  else q.whereRaw('LOWER(domain) = ?', [rawDomain]).whereNull('email_address');
  const rows = await q.orderBy('created_at', 'desc').limit(2).select(...COLUMNS);
  if (!rows.length) return refusal('No blocklist entry matches that. Nothing was changed.', 'block_not_found');
  if (rows.length > 1) return refusal('More than one blocklist entry matches that. Ask which one, then pass its blocked_id (get_blocked_senders lists them).', 'ambiguous_block');
  return { row: rows[0] };
}

function planEffects({ row, who, scopeText, overlap }) {
  const domainBlock = overlap?.kind === 'domain_block' ? overlap.domain : null;
  const addressBlocks = overlap?.kind === 'address_blocks' ? overlap : null;
  return [
    row.gmail_filter_id
      ? { kind: 'operational', text: `The Gmail filter that sends ${scopeText} to Trash is removed.` }
      : { kind: 'operational', text: 'No Gmail filter is on file for this block, so only the blocklist entry is deleted.' },
    { kind: 'operational', text: `The blocklist entry for ${who} is deleted.` },
    domainBlock
      ? { kind: 'operational', text: `Mail from ${who} STAYS BLOCKED: the domain @${domainBlock} is blocked too, so its Gmail filter and the blocklist keep sending this address's mail to Trash. This card removes only the address entry and never the domain block. To let mail through, unblock @${domainBlock} separately.` }
      : { kind: 'operational', text: `New mail from ${scopeText}${addressBlocks ? ' (except the addresses listed below)' : ''} is no longer auto-trashed. It is checked like any other mail and reaches the inbox unless the spam check flags it.` },
    addressBlocks
      ? { kind: 'operational', text: `${addressBlocks.count >= OVERLAP_CAP ? `${OVERLAP_CAP} or more` : addressBlocks.count} address ${addressBlocks.count === 1 ? 'block' : 'blocks'} at @${addressBlocks.domain} stay in place, so ${addressBlocks.count === 1 ? 'that address stays' : 'those addresses stay'} blocked. Unblock each separately.` }
      : null,
    { kind: 'operational', text: 'Mail already in Trash stays there. Unblocking does not move it back.' },
    { kind: 'operational', text: 'If Gmail cannot be reached or the filter cannot be removed, nothing changes and the sender stays blocked.' },
    row.email_address
      ? { kind: 'operational', text: 'The automatic spam check can block this address again if it flags new mail from it. To undo, block it again from the bar or the Email page.' }
      : { kind: 'operational', text: 'To undo, block the domain again from the bar or the Email page.' },
    { kind: 'comms', text: 'Nothing is sent: no text, email or call goes to anyone.' },
  ].filter(Boolean);
}

function planOf(row, overlap) {
  const who = row.email_address ? row.email_address : `@${row.domain}`;
  const scopeText = row.email_address ? row.email_address : `any sender at @${row.domain}`;
  const stillBlockedBy = overlap?.kind === 'domain_block' ? `@${overlap.domain}` : null;
  return {
    preview: true,
    tool: 'unblock_sender',
    blocked_id: row.id,
    blocked_target: who,
    scope: row.email_address ? 'one sender address' : 'a whole domain',
    blocked_on_et: blockedAtEt(row.created_at),
    reason: reasonText(row.reason),
    blocked_count: Number(row.blocked_count) || 0,
    gmail_filter: row.gmail_filter_id ? 'on file' : 'none on file',
    // Non-null when mail from this address keeps being blocked after the unblock (the domain block stays).
    still_blocked_by: stillBlockedBy,
    other_blocks_stay: overlap?.kind === 'address_blocks' ? overlap.count : 0,
    effects: planEffects({ row, who, scopeText, overlap }),
    sends_to_customer: false,
    _version: versionOf(row, overlap),
    note: 'PREVIEW ONLY — nothing was changed. Confirm unblocks exactly this entry; if it changed it refuses.',
  };
}

async function buildPlan(input) {
  const found = await resolveRow(input);
  if (found.error) return found;
  const { row } = found;
  if (!row.email_address && !row.domain) return refusal('That blocklist entry names no address or domain, so the bar will not unblock it. Use the Email page.', 'unsupported_entry');
  return planOf(row, await overlapOf(row));
}

async function verifiedPlan(input, pinned) {
  if (!pinned) return { refusal: refusal('Use the confirmation card to approve this unblock.', 'approval_required') };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true } };
  if (JSON.stringify(plan._version) !== JSON.stringify(pinned)) {
    return { refusal: { error: 'The blocklist entry changed after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.', code: 'preview_changed', preview_changed: true } };
  }
  return { plan };
}

// Whether the blocklist row is still there after a failed unblock: 'present', 'gone' (a read that SUCCEEDED and found
// no row), or 'unknown' (the read itself failed, which says nothing about the row and is never read as "gone").
async function blockState(id) {
  try {
    return (await db('blocked_email_senders').where({ id }).first('id')) ? 'present' : 'gone';
  } catch {
    return 'unknown';
  }
}

async function commitUnblock(input) {
  const { plan, refusal: refused } = await verifiedPlan(input, input._verified_unblock_sender_version);
  if (refused) return refused;
  const base = { blocked_id: plan.blocked_id };
  let result;
  try {
    // The row is re-read FOR UPDATE inside unblockSender's transaction and compared to the card before the Gmail
    // filter is touched; a difference returns { changed } with nothing removed.
    result = await require('../email/spam-blocker').unblockSender(plan.blocked_id, {
      verifyLocked: async (row, trx) => Boolean(row)
        && JSON.stringify(versionOf(row, await overlapOf(row, trx, { lock: true }))) === JSON.stringify(plan._version),
    });
  } catch (err) {
    logger.error(`[intelligence-bar:unblock-sender] unblock failed (${err?.code || err?.name || 'error'})`);
    if ((await blockState(plan.blocked_id)) === 'gone') {
      return { ...base, success: true, warning: true, sent_to_customer: false,
        note: `${plan.blocked_target} is off the blocklist, but a later step reported a problem. Check the Email page.` };
    }
    return { ...base, outcome_unknown: true, code: 'execution_interrupted',
      error: 'The unblock was interrupted — it may or may not have happened. Check the Email page blocklist before trying again.' };
  }
  if (result?.changed) {
    return { ...base, failed: true, code: 'preview_changed', preview_changed: true,
      error: 'The blocklist entry changed or is gone after the card was shown, so nothing was changed. Ask again for a fresh confirmation card.' };
  }
  if (!result?.success) {
    // The page answers 502 here: the block record is kept and the sender is STILL blocked.
    return { ...base, failed: true, code: 'unblock_refused',
      error: `The sender was not unblocked: ${result?.error || 'the Email page refused it'}. It is still blocked.` };
  }
  logger.info(`[intelligence-bar:unblock-sender] blocklist entry ${plan.blocked_id} removed`);
  const filterNote = plan.gmail_filter === 'on file' ? ' Its Gmail trash filter is removed.' : '';
  const after = plan.still_blocked_by
    ? ` Mail from it is STILL blocked by the domain block ${plan.still_blocked_by}; that block was not touched.`
    : ` New mail from it is no longer auto-trashed${plan.other_blocks_stay ? ', except the addresses blocked on their own' : ''}.`;
  return { ...base, success: true, sent_to_customer: false, still_blocked_by: plan.still_blocked_by,
    note: `${plan.blocked_target} is unblocked.${filterNote}${after} Mail already in Trash stays there. Nothing was sent to anyone.` };
}

// ── card lines (authorization-contract.js) ──────────────────────

function cardLines(toolName, preview) {
  if (toolName !== 'unblock_sender' || !preview || preview.preview !== true) return [];
  return [
    { kind: 'operational', text: `Unblock ${preview.blocked_target} (${preview.scope})` },
    ...(preview.still_blocked_by ? [{ kind: 'operational', text: `STILL BLOCKED after this: the domain block ${preview.still_blocked_by} stays, so mail from ${preview.blocked_target} keeps going to Trash` }] : []),
    { kind: 'operational', text: `Blocked ${preview.blocked_on_et || 'on an unrecorded date'}, by ${preview.reason}` },
    { kind: 'operational', text: `The block has caught ${preview.blocked_count} ${preview.blocked_count === 1 ? 'message' : 'messages'}. Gmail filter: ${preview.gmail_filter}.` },
    ...(preview.effects || []).map(({ kind, text }) => ({ kind, text })),
  ];
}

async function executeUnblockSenderTool(toolName, input = {}, actionContext = {}) {
  if (!UNBLOCK_SENDER_TOOLS.some((t) => t.name === toolName)) return { error: `Unknown tool: ${toolName}` };
  // Admin only, like the Email page (requireAdmin); the confirmed run needs a positive admin flag.
  if (actionContext?.isAdmin === false || (input.confirmed === true && actionContext?.isAdmin !== true)) {
    return refusal('Unblocking a sender is limited to admin accounts', 'permission_denied');
  }
  if (!unblockSenderLive()) return refusal('Unblocking a sender from the bar is switched off.', 'gate_off');
  try {
    // Only /confirm-action sets confirmed (route-derived, never a model param).
    return input.confirmed === true ? await commitUnblock(input) : await buildPlan(input);
  } catch (err) {
    logger.error(`[intelligence-bar:unblock-sender] ${toolName} failed (${err?.code || err?.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The unblock was interrupted — it may or may not have happened. Check the Email page blocklist before trying again.' }
      : { error: 'Could not prepare the unblock' };
  }
}

module.exports = {
  UNBLOCK_SENDER_TOOLS,
  executeUnblockSenderTool,
  unblockSenderLive,
  cardLines,
  versionOf,
};
