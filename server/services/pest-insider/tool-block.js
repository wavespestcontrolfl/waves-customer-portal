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

// Opt-in evidence on the subscriber's row NOW: active, a confirmation email
// was sent, and the reader's confirm came after it, for the very address the
// batch mails. The Beehiiv import rows (`beehiiv_migration`,
// `beehiiv_migration_orphan`) have confirmed_at backfilled and no
// confirmation_sent_at, so they never qualify: that is intended.
function optedIn(row, subscriber) {
  if (!row || row.status !== 'active') return false;
  const sent = row.confirmation_sent_at ? new Date(row.confirmation_sent_at).getTime() : NaN;
  const confirmed = row.confirmed_at ? new Date(row.confirmed_at).getTime() : NaN;
  return Number.isFinite(sent) && Number.isFinite(confirmed) && confirmed >= sent
    && normalized(row.email) === normalized(subscriber.email);
}

// Waves addresses: the internal domains and allowlist, the proof and approver
// addresses (newsletter-proof.js), and the login email of every staff user
// (technicians: `email`, and `google_email` for the Google sign-in). Nobody at
// Waves may buy through these links, and the owner's copies must not carry
// them. A family member's address cannot be told from data: such a reader who
// opted in gets the block, and the owner keeps that rule by not buying.
async function wavesAddresses(db) {
  const proof = require('../newsletter-proof');
  const staff = await db('technicians').select('email', 'google_email');
  return new Set([
    proof.proofRecipient(), proof.syncedApprovalMailbox(), ...proof.approvalSenders(),
    ...staff.flatMap((s) => [s.email, s.google_email]),
  ].map(normalized).filter(Boolean));
}

// The readers of this batch who may have the block, and the block. A thrown
// read is the caller's to catch.
async function readersWithBlock({ send, subscribers, planned, db }) {
  const none = { ids: new Set(), html: '' };
  // The block rides the same gate as "Your home": an issue a person sends or resumes by
  // hand while GATE_PEST_INSIDER_AUTO_SEND is off carries no tool.
  if (!planned || send?.newsletter_type !== PEST_INSIDER_TYPE || !require('../../config/feature-gates').pestInsiderAutoSendLive()) return none;
  const issue = await db('pest_insider_issues').where({ send_id: send.id }).first('tool_id');
  // Usable NOW: registry row active, green, Amazon, every tools.js check.
  const tool = issue?.tool_id ? require('./tools').toolById(issue.tool_id) : null;
  if (!tool) return none;
  const [rows, waves] = await Promise.all([
    db('newsletter_subscribers').whereIn('id', subscribers.map((s) => s.id))
      .select('id', 'email', 'status', 'confirmation_sent_at', 'confirmed_at'),
    wavesAddresses(db),
  ]);
  const { isInternalEmailRecipient } = require('../../utils/internal-email-recipients');
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = new Set(subscribers
    .filter((s) => optedIn(byId.get(s.id), s) && !isInternalEmailRecipient(s.email) && !waves.has(normalized(s.email)))
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
 * 4. the reader has opt-in evidence now, for the address mailed (optedIn);
 * 5. the reader's address is not a Waves address (wavesAddresses);
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
