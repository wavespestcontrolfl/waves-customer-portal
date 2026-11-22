/**
 * Pest Insider "A tool we'd use": the token, and who gets the block at send time.
 *
 * The shared issue body (render.js) carries one token, {{pi-tool}}, in the
 * HTML part only, just before the "Your home" tokens. The sender fills it per
 * reader with the tool block (render.js toolBlock), or with '' for a reader
 * who may not have it. Every surface that shows a stored body with no reader
 * (archive, RSS feed, blog export, touchpoint body, the send check, the
 * owner's FYI/proof copy, the sample script) removes the token through
 * referral-line.js neutralizeIssueTokens, so the Amazon link never reaches
 * the archive or a reader who did not opt in.
 *
 * The block is HTML only. The campaign send tracks clicks in the text part on
 * purpose (sendgrid-mail.js sendBatch, enable_text: true, which the sunset
 * lane reads), so every URL in a text part goes through the click host, and
 * the repo has no way to keep one text URL out of that. An Amazon link must
 * reach the reader as written, so the text part has no token and no tool.
 *
 * No page of Amazon is read, before the build or at send time: Amazon's
 * Conditions of Use and Associates policies forbid robot reads of its pages
 * (owner decision 2026-11-22, "A"). A tool is usable when its registry row is
 * active now (tools.js).
 *
 * This file is a leaf like home.js: the token helpers load nothing heavy, and
 * the renderer, the registry, the gates and the proof module are required only
 * when a batch runs. Amazon's rule for email links is that the email is
 * "solicited (i.e., opted into by the receiving customer)", and nobody at
 * Waves may buy through the links (Associates policy).
 */
const { PEST_INSIDER_TYPE } = require('../../config/newsletter-types');

const TOOL_TOKEN = '{{pi-tool}}';

// The one exact spelling is the token (no case or spacing variants), like the
// "Your home" and referral tokens: a spelling the sender cannot fill must stay
// visible as text on every surface instead of being mailed as a raw token.
const hasToolToken = (content) => String(content || '').includes(TOOL_TOKEN);

const neutralizeToolToken = (content) => String(content || '').split(TOOL_TOKEN).join('');

const normalized = (value) => String(value ?? '').trim().toLowerCase();

const stampMs = (value) => (value ? new Date(value).getTime() : NaN);

// Opt-in evidence on the subscriber's row NOW: proof that the READER clicked the
// confirm link for the very address being mailed. Two stamps are written only by the
// reader's own confirm click (newsletter-subscribers.js confirmByToken and
// confirmResignupToken): reader_confirmed_at and reader_confirmed_email (the row's
// address, lowercased, at that click). confirmation_sent_at and confirmed_at are not
// proof: a trusted add promotes a pending row (confirmed_at, no click), and the email
// fanout moves a row to a new address and keeps both stamps. The rule, all of:
// - the row is active, and its address is the address mailed, and the address the
//   reader confirmed (a moved row fails here);
// - confirmed_at is set and reader_confirmed_at is not before it (a later trusted
//   re-activation writes a later confirmed_at, which voids the click);
// - no opt-out or sunset stamp (unsubscribed_at, deactivated_at) is at or after the
//   click (an unreadable stamp fails closed).
// Nothing is backfilled: history cannot tell a click from a trusted add, so a row has
// the proof only from its first click after the columns shipped. The Beehiiv import
// rows (`beehiiv_migration`, `beehiiv_migration_orphan`) never clicked, so they never
// qualify. One accepted case: a sunset comeback (the reader answers the win-back quiz)
// clears deactivated_at without a new confirm click. The reader's own click for this
// address is still the evidence, and sunset is list hygiene, not an opt-out.
function optedIn(row, subscriber) {
  if (!row || row.status !== 'active') return false;
  const confirmedAt = stampMs(row.confirmed_at);
  const readerAt = stampMs(row.reader_confirmed_at);
  if (!Number.isFinite(confirmedAt) || !Number.isFinite(readerAt) || readerAt < confirmedAt) return false;
  const address = normalized(subscriber.email);
  if (!address || normalized(row.email) !== address || normalized(row.reader_confirmed_email) !== address) return false;
  return [row.unsubscribed_at, row.deactivated_at].every((stamp) => !stamp || stampMs(stamp) < readerAt);
}

// A mailbox as one key: a Google address is its mailbox identity (dots and the +tag
// dropped, googlemail.com read as gmail.com: customer-comms-lock.js
// googleMailboxIdentity), every other address is itself, trimmed and lowercased. A
// plus tag on a non-Google address is a different mailbox. Required here, when it
// runs: that module loads nothing at the top.
function mailboxKey(value) {
  const address = normalized(value);
  return address ? (require('../../utils/customer-comms-lock').googleMailboxIdentity(address) || address) : '';
}

// Waves addresses as mailbox keys: the internal allowlist (internal-email-recipients.js),
// the proof and approver addresses as they are now, every address a copy of THIS issue's
// FYI went to (the issue row's diagnostics.fyiTo, newsletter-proof.js issueFyiAddresses:
// the proof address can change between the FYI copy and the send or a resume, and a
// mailbox that got the owner's copy stays a Waves mailbox for this issue), and the login
// email of every staff user (technicians: `email`, and `google_email` for the Google
// sign-in). Nobody at Waves may buy through these links, and the owner's copies must not
// carry them. The Waves domains are matched by wavesDomain, and any other configured
// internal domain by isInternalEmailRecipient. A family
// member's address cannot be told from data: such a reader who opted in gets the block,
// and the owner keeps that rule by not buying.
// The addresses a copy of this issue's FYI went to (the issue row's diagnostics.fyiTo, written
// by newsletter-proof.js recordFyiRecipient as { address: true }). No record means no copy
// went out. A record that is not exactly that shape (bad JSON, a non-object, a key that is no
// address, a value that is not true) throws, and the caller gives every reader of the batch
// '': an unreadable list must not read as "nobody". The error names no content of the
// record (it can hold addresses).
function fyiAddresses(issue) {
  const unreadable = () => new Error("the issue's FYI recipient record is unreadable");
  let diagnostics = issue?.diagnostics;
  if (typeof diagnostics === 'string') {
    try { diagnostics = JSON.parse(diagnostics); } catch { throw unreadable(); }
  }
  if (diagnostics == null) return [];
  if (typeof diagnostics !== 'object' || Array.isArray(diagnostics)) throw unreadable();
  const recorded = diagnostics.fyiTo;
  if (recorded == null) return [];
  if (typeof recorded !== 'object' || Array.isArray(recorded)) throw unreadable();
  const { isValidEmail } = require('../../utils/internal-email-recipients');
  if (!Object.entries(recorded).every(([address, went]) => went === true && isValidEmail(address))) throw unreadable();
  return require('../newsletter-proof').issueFyiAddresses({ diagnostics });
}

async function wavesMailboxes(db, issue) {
  const proof = require('../newsletter-proof');
  const { internalEmailAllowlist } = require('../../utils/internal-email-recipients');
  const staff = await db('technicians').select('email', 'google_email');
  return new Set([
    ...internalEmailAllowlist(),
    proof.proofRecipient(), proof.syncedApprovalMailbox(), ...proof.approvalSenders(),
    ...fyiAddresses(issue),
    ...staff.flatMap((s) => [s.email, s.google_email]),
  ].map(mailboxKey).filter(Boolean));
}

// An address on a Waves-owned domain (internal-email-recipients.js DEFAULT_INTERNAL_DOMAINS),
// whatever INTERNAL_EMAIL_DOMAINS says: that setting REPLACES the defaults for
// isInternalEmailRecipient, and a list that leaves a Waves domain out must not let an
// address on it get the Amazon link.
function wavesDomain(email) {
  const { DEFAULT_INTERNAL_DOMAINS } = require('../../utils/internal-email-recipients');
  return DEFAULT_INTERNAL_DOMAINS.includes(normalized(email).split('@')[1]);
}

// The readers of this batch who may have the block, and the block. A thrown
// read is the caller's to catch.
async function readersWithBlock({ send, subscribers, planned, db }) {
  const none = { ids: new Set(), html: '' };
  // The block rides the same gate as "Your home": an issue a person sends or resumes by
  // hand while GATE_PEST_INSIDER_AUTO_SEND is off carries no tool.
  if (!planned || send?.newsletter_type !== PEST_INSIDER_TYPE || !require('../../config/feature-gates').pestInsiderAutoSendLive()) return none;
  const issue = await db('pest_insider_issues').where({ send_id: send.id }).first('tool_id', 'diagnostics');
  // Usable NOW: registry row active, green, Amazon, every tools.js check.
  const tool = issue?.tool_id ? require('./tools').toolById(issue.tool_id) : null;
  if (!tool) return none;
  const [rows, waves] = await Promise.all([
    db('newsletter_subscribers').whereIn('id', subscribers.map((s) => s.id))
      .select('id', 'email', 'status', 'confirmed_at', 'reader_confirmed_at', 'reader_confirmed_email', 'unsubscribed_at', 'deactivated_at'),
    wavesMailboxes(db, issue),
  ]);
  const { isInternalEmailRecipient } = require('../../utils/internal-email-recipients');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = new Set(subscribers
    .filter((s) => optedIn(byId.get(s.id), s) && !wavesDomain(s.email) && !isInternalEmailRecipient(s.email) && !waves.has(mailboxKey(s.email)))
    .map((s) => s.id));
  if (!ids.size) return none;
  // Checked once for the batch, before any reader gets it.
  const { toolBlock, toolBlockErrors } = require('./render');
  const block = toolBlock(tool);
  const errors = toolBlockErrors(block, tool);
  if (errors.length) throw new Error(`the tool block was refused by the send check: ${errors[0]}`);
  return { ids, html: block.html };
}

/**
 * The {{pi-tool}} substitution of ONE batch of `send` whose mailed parts are
 * `html` and `text`: read once for the batch. A body with no token in its HTML
 * gives every reader no key and reads nothing. A body with the token gives
 * every reader the key (a missing key would mail the raw token): the block
 * for a reader who passes all of
 * 1. the HTML holds the token, and the text part does not (a substitution
 *    applies to every part, and the block is HTML only);
 * 2. a Waves Pest Insider send with a planned audience, GATE_PEST_INSIDER_AUTO_SEND on;
 * 3. the issue row of this send (pest_insider_issues.send_id) names a tool that is usable now;
 * 4. the reader's own confirm click is on the row now, for the address mailed (optedIn);
 * 5. the reader's mailbox is not a Waves mailbox (wavesMailboxes: Gmail aliases count as one mailbox);
 * and '' for any other. A read that throws, or a block the send check refuses,
 * logs one warning and gives every reader ''. Never throws.
 * @param {{ send: object, html: string, text?: string, subscribers: {id: *, email: string}[], planned: boolean, db: Function }} batch
 * @returns {Promise<{ forReader: (subscriber: object) => Record<string, string> }>}
 */
async function toolBlockForBatch({ send, html, text, subscribers, planned, db }) {
  if (!hasToolToken(html) && !hasToolToken(text)) return { forReader: () => ({}) };
  let shown = { ids: new Set(), html: '' };
  try {
    if (!hasToolToken(text)) shown = await readersWithBlock({ send, subscribers, planned, db });
  } catch (err) {
    require('../logger').warn(`[newsletter] send ${send?.id} "A tool we'd use" block failed, no reader of this batch gets it: ${err.message}`);
  }
  return { forReader: (subscriber) => ({ [TOOL_TOKEN]: shown.ids.has(subscriber.id) ? shown.html : '' }) };
}

module.exports = { TOOL_TOKEN, hasToolToken, neutralizeToolToken, toolBlockForBatch };
