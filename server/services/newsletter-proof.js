/**
 * Newsletter proof-approval flow.
 *
 * When the weekly autopilot drafts the flagship newsletter and the draft
 * passes the same validation gate the manual Send button enforces, a proof
 * copy is emailed to the owner (contact@) with an "ACT: [PROOF-<token>]" subject.
 * Replying "approved" to that email — from an allowlisted owner address —
 * queues the issue for its linked Tuesday 6:00 AM ET target. Any other reply
 * (or no reply) leaves the draft untouched: the flow fails closed, and the
 * eventual list send still happens through the same atomic draft→sending
 * claim as a manual send.
 *
 * Everything is gated behind GATE_NEWSLETTER_PROOF_APPROVAL (default OFF).
 * Kill switch: unset the gate — no proofs go out and approval replies are
 * ignored.
 *
 * GATE_NEWSLETTER_AUTO_SEND (default OFF; owner 2026-10-30, option A): the
 * weekly flagship that passes every check here gets an FYI copy instead of
 * a proof, and queues itself for its Tuesday 6:00 AM ET target once that
 * copy went out. A HOLD reply to the copy skips the week. Unset the switch
 * and the issue waits for an APPROVED reply again.
 *
 * GATE_PEST_INSIDER_AUTO_SEND (default OFF): the same FYI-and-queue path for a
 * Waves Pest Insider issue the planner built (services/pest-insider/
 * schedule.js links it from its pest_insider_issues row). It queues for the
 * issue's own Thursday 7:00 AM ET, and a HOLD reply holds that issue.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const NewsletterSender = require('./newsletter-sender');
const { wrapNewsletter, bodyIsDarkAware } = require('./email-template');
const { validateNewsletterDraft, lockedPricesForSend } = require('./newsletter-validator');
const { requiresClaimValidation, isFlagshipType, PEST_INSIDER_TYPE } = require('../config/newsletter-types');
const { isFlagshipTargetForWeek } = require('./event-freshness');
const { validateFlagshipEventSelection, parseLockedEventIds } = require('./newsletter-event-selection');
const { reverifyEvents } = require('./event-reverify');
const { pestInsiderProofLive, newsletterAutoSendLive, pestInsiderAutoSendLive } = require('../config/feature-gates');
const { issueContextForSend, moveIssueForSend } = require('./pest-insider/schedule');

/**
 * Internal diagnostics panel rendered ABOVE the recipient preview in the
 * proof email (owner spec 2026-07-28): lineup scores and coverage, pool
 * stats, alternates, and the top rejected candidates with reasons — so a
 * sip-and-shop beating a convention is visible at approval time.
 * Best-effort: any failure returns '' and never blocks the proof.
 */
async function buildProofDiagnosticsHtml(send, lineupEvents, scheduledFor) {
  try {
    const { effectiveScore, unmetConstraints, isWeekend } = require('./newsletter-portfolio');
    const { heroScoreFloor, featureScoreFloor } = require('./event-scoring');
    const { getActiveNewsletterTuesday } = require('./event-freshness');
    const { parseETDateTime, addETDays, etDateString } = require('../utils/datetime-et');

    const ids = (lineupEvents || []).map((e) => String(e.id));
    if (!ids.length) return '';
    const rows = await db('events_raw')
      .whereIn('id', ids)
      .select('id', 'title', 'editorial_score', 'score_breakdown', 'novelty_type',
        'audience_tags', 'region_zone', 'city', 'family_friendly', 'is_free',
        'price_text', 'start_at', 'venue_name', 'admin_status', 'event_url');
    const byId = new Map(rows.map((r) => [String(r.id), r]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

    const issueTuesday = getActiveNewsletterTuesday(scheduledFor || new Date());
    const windowStart = parseETDateTime(`${issueTuesday}T00:00:00`);
    const windowEnd = parseETDateTime(`${etDateString(addETDays(windowStart, 6))}T23:59:59`);
    // The REAL eligible pool — same pipeline the autopilot plans from
    // (routine/repeated/featured-history/eligibility filters applied), so
    // the approver never sees an inflated count of usable alternatives.
    // Lazy require: autopilot requires this module lazily, so no cycle.
    const { buildDigestPlan } = require('./newsletter-autopilot');
    const plan = await buildDigestPlan({ reference: scheduledFor || new Date() });
    const pool = plan.scored || [];
    const qualifiedPool = pool.filter((r) => effectiveScore(r) >= featureScoreFloor()).length;

    const rejected = await db('events_raw')
      .where({ admin_status: 'pending' })
      .whereNotNull('curated_at')
      .whereNull('merged_into')
      .where('start_at', '>=', windowStart)
      .where('start_at', '<=', windowEnd)
      .orderByRaw('editorial_score DESC NULLS LAST')
      .limit(5)
      .select('title', 'editorial_score', 'curation_note');

    let alternates = [];
    try {
      const altIds = parseLockedEventIds(send?.alternate_event_ids)
        .filter((id) => !ids.includes(String(id)));
      if (altIds.length) {
        const altRows = await db('events_raw').whereIn('id', altIds).select('id', 'title', 'editorial_score');
        // whereIn does not preserve input order — rebuild in the stored
        // RANKED order (the panel presents these as ranked).
        const altById = new Map(altRows.map((r) => [String(r.id), r]));
        alternates = altIds.map((id) => altById.get(String(id))).filter(Boolean);
      }
    } catch { /* omit alternates */ }

    const scores = ordered.map((r) => effectiveScore(r));
    const unmet = unmetConstraints(ordered).map((c) => c.label);
    const zones = [...new Set(ordered.map((r) => (r.region_zone || r.city || '')).filter(Boolean))];
    const weekendCount = ordered.filter((r) => isWeekend(r)).length;
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const lineupRows = ordered.map((r) => {
      const score = effectiveScore(r);
      const tier = r.admin_status === 'featured' ? 'STAR' : (score >= heroScoreFloor() ? 'hero' : 'feature');
      return `<tr><td style="padding:2px 8px 2px 0;">${esc(r.title)}</td><td style="padding:2px 8px;">${score}</td><td style="padding:2px 8px;">${tier}</td><td style="padding:2px 8px;">${esc(r.region_zone || r.city || '—')}</td><td style="padding:2px 0;">${esc(r.novelty_type || '—')}</td></tr>`;
    }).join('');
    const rejectedRows = rejected.map((r) => `<li>${esc(r.title)} — ${r.editorial_score ?? 'unscored'}${r.curation_note ? ` (${esc(r.curation_note)})` : ''}</li>`).join('');
    const altLine = alternates.length
      ? alternates.map((a) => `${esc(a.title)} (${a.editorial_score ?? '—'})`).join(' · ')
      : 'none stored';

    return `<div class="dm-box" style="margin:0 0 20px 0;padding:14px 16px;background:#EEF3F8;border:1px solid #C9D6E2;border-radius:8px;font-family:monospace;font-size:12px;line-height:1.6;color:#26364A;">
<div style="font-weight:700;margin-bottom:6px;">INTERNAL DIAGNOSTICS — not sent to subscribers</div>
<div style="margin-bottom:6px;">Scores shown are the STORED rubric scores; the lineup order already reflects any listwise nudge (±3, in-memory at selection time).</div>
Selected: ${ordered.length} &nbsp;·&nbsp; Qualified pool (≥${featureScoreFloor()}): ${qualifiedPool} of ${pool.length} approved &nbsp;·&nbsp; Weekend events: ${weekendCount} &nbsp;·&nbsp; Zones: ${zones.length} (${esc(zones.join(', ') || '—')})<br/>
Lowest selected: ${scores.length ? Math.min(...scores) : '—'} &nbsp;·&nbsp; Top: ${scores.length ? Math.max(...scores) : '—'} &nbsp;·&nbsp; Unmet: ${unmet.length ? esc(unmet.join('; ')) : 'none'}<br/>
Alternates: ${altLine}
<table style="margin-top:8px;border-collapse:collapse;">${lineupRows}</table>
${rejectedRows ? `<div style="margin-top:8px;font-weight:700;">Top rejected/pending in window:</div><ul style="margin:2px 0 0 16px;padding:0;">${rejectedRows}</ul>` : ''}
</div>`;
  } catch (err) {
    logger.warn(`[newsletter-proof] diagnostics build failed (omitting): ${err.message}`);
    return '';
  }
}

/**
 * Named replacements for a dead locked event: the ranked alternates the
 * autopilot stored on the send row (newsletter_sends.alternate_event_ids).
 * Best-effort — a lookup failure just omits the suggestion line.
 */
async function alternateSuggestionLine(send) {
  try {
    // Draft edits can promote an alternate into the locked lineup without
    // resyncing alternate_event_ids — never suggest an event that is
    // already locked (it would be recommended as its own replacement).
    const locked = new Set(parseLockedEventIds(send?.event_ids).map(String));
    const ids = parseLockedEventIds(send?.alternate_event_ids)
      .filter((id) => !locked.has(String(id)));
    if (!ids.length) return null;
    const rows = await db('events_raw').whereIn('id', ids).select('id', 'title');
    if (!rows.length) return null;
    const byId = new Map(rows.map((r) => [String(r.id), r.title]));
    const titles = ids.map((id) => byId.get(String(id))).filter(Boolean);
    return titles.length ? `Suggested replacements (ranked): ${titles.join(' · ')}` : null;
  } catch {
    return null;
  }
}
const { assertInternalEmailRecipient, normalizeEmail } = require('../utils/internal-email-recipients');

const PROOF_SUBJECT_RE = /\[PROOF-([0-9a-f]{8})\]/i;
const DEFAULT_PROOF_RECIPIENT = 'contact@wavespestcontrol.com';

function isProofApprovalEnabled() {
  return process.env.GATE_NEWSLETTER_PROOF_APPROVAL === 'true';
}

function proofRecipient() {
  return normalizeEmail(process.env.NEWSLETTER_PROOF_EMAIL || DEFAULT_PROOF_RECIPIENT);
}

async function resolveFlagshipCalendarContext(send) {
  if (!isFlagshipType(send?.newsletter_type) && send?.newsletter_type !== null) {
    return { flagship: false, linkedCalendar: null, scheduledFor: null, valid: true };
  }
  const linkedCalendar = send?.id
    ? await db('newsletter_calendar').where({ send_id: send.id }).first()
    : null;
  const flagship = isFlagshipType(send?.newsletter_type)
    || (send?.newsletter_type === null && Boolean(linkedCalendar));
  if (!flagship) {
    return { flagship: false, linkedCalendar: null, scheduledFor: null, valid: true };
  }
  const scheduledFor = linkedCalendar?.target_send_at
    ? new Date(linkedCalendar.target_send_at)
    : null;
  const valid = Boolean(
    linkedCalendar
    && scheduledFor
    && !Number.isNaN(scheduledFor.getTime())
    && scheduledFor.getTime() > Date.now()
    && isFlagshipTargetForWeek(scheduledFor, linkedCalendar.week_of),
  );
  return { flagship: true, linkedCalendar, scheduledFor, valid };
}

// A Waves Pest Insider issue the planner built is linked from its
// pest_insider_issues row; null for every other send, including a Pest Insider
// draft made by hand in the composer (it keeps the old approval path).
async function resolvePestInsiderIssueContext(send) {
  if (send?.newsletter_type !== PEST_INSIDER_TYPE) return null;
  return issueContextForSend(send);
}

// "Thursday, December 3 at 7:00 AM ET": when a planned issue sends.
function issueSendTimeCopy(issueContext) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' })
    .format(issueContext.scheduledFor);
  return `${day} at 7:00 AM ET`;
}

/**
 * The mailbox the Gmail sync actually watches — approval replies MUST land
 * there or maybeHandleProofApproval never sees them. Reply-To on the proof
 * is forced to this address so a proof recipient reading from a personal
 * address still routes the approval back into the synced inbox.
 */
function syncedApprovalMailbox() {
  return normalizeEmail(process.env.GMAIL_USER_EMAIL || DEFAULT_PROOF_RECIPIENT);
}

/**
 * Addresses whose "approved" reply is allowed to release the list send.
 * FAIL CLOSED: no default. The obvious default (contact@) is the shared
 * inbox non-owner staff work from, and approval is From-address-based —
 * so the operator must explicitly name the approver address(es) via
 * NEWSLETTER_PROOF_APPROVERS before any reply can release a broadcast.
 */
function approvalSenders() {
  return String(process.env.NEWSLETTER_PROOF_APPROVERS || '')
    .split(',')
    .map(normalizeEmail)
    .filter(Boolean);
}

/** PII-safe form of an email address for log lines: "co***@domain.com". */
function maskEmail(email) {
  const n = normalizeEmail(email);
  const at = n.indexOf('@');
  if (at <= 0) return '(invalid)';
  return `${n.slice(0, Math.min(2, at))}***@${n.slice(at + 1)}`;
}

/** Extract the proof token from an email subject ("Re: [PROOF-ab12cd34] …"). */
function parseProofToken(subject) {
  const m = PROOF_SUBJECT_RE.exec(String(subject || ''));
  return m ? m[1].toLowerCase() : null;
}

/** A token as sendNewsletterProof makes it (8 hex characters), the only form a reply's subject can carry. */
function isProofToken(token) {
  return /^[0-9a-f]{8}$/i.test(String(token || ''));
}

/**
 * Keep only the freshly-typed part of a reply: drop quoted lines and
 * everything below the first reply-quote separator so an "approved" that
 * merely appears inside the quoted proof banner can't trigger a send.
 */
function extractTopReplyText(bodyText) {
  const lines = String(bodyText || '').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) continue;
    if (/^On .{0,200}wrote:\s*$/i.test(trimmed)) break;
    if (/^-{2,}\s*(Original|Forwarded) Message/i.test(trimmed)) break;
    if (/^From:\s/i.test(trimmed)) break;
    if (/^_{5,}\s*$/.test(trimmed)) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * Convert an HTML-only reply into text WITHOUT destroying the quote
 * structure. A naive strip-tags pass flattens the quoted proof banner
 * ("Reply APPROVED…") into the same line as the typed reply, letting a
 * non-approval reply match. So: drop quoted containers entirely
 * (blockquote / gmail_quote / yahoo_quoted), keep block boundaries as
 * newlines, THEN strip tags — extractTopReplyText still runs after this
 * as the text-path defense.
 */
function htmlReplyToText(html) {
  let s = String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  // innermost-first so nested quote blocks all disappear; bounded loop
  for (let i = 0; i < 10 && /<blockquote/i.test(s); i++) {
    s = s.replace(/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote>/gi, '\n');
  }
  // Gmail/Yahoo wrap the whole quoted thread in a marker div — drop from
  // the marker to the end (the typed reply always precedes it). Class
  // attributes may be double-quoted, single-quoted, or bare.
  s = s.replace(/<div[^>]*class\s*=\s*(?:"[^"]*(?:gmail_quote|yahoo_quoted)[^"]*"|'[^']*(?:gmail_quote|yahoo_quoted)[^']*'|[^\s>]*(?:gmail_quote|yahoo_quoted)[^\s>]*)[\s\S]*$/i, '\n');
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    // Decode entities BEFORE the approval matcher runs: "don&rsquo;t" /
    // "can&#8217;t" must become don't/can't or the negation guard never
    // sees them (numeric first, then named; &amp; strictly last).
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ' '; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
    .replace(/&(rsquo|lsquo|apos);/gi, "'")
    .replace(/&(rdquo|ldquo|quot);/gi, '"')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .trim();
}

/**
 * Fail-closed approval matcher: the un-quoted reply text must contain
 * "approve"/"approved" and must not negate it.
 */
function isApprovalReply(text) {
  // Normalize smart apostrophes first — iOS/macOS type "don’t"/"can’t"
  // with U+2019, which would sail past ASCII-only negation alternatives.
  const t = String(text || '').toLowerCase().replace(/[‘’ʼ]/g, "'");
  if (!/\bapproved?\b/.test(t)) return false;
  // Negation guard: a negating/hold word ANYWHERE in the typed reply fails
  // closed — "not approved", "can't approve yet", and equally "approved?
  // no" / "approved — wait, don't send" must all leave the draft alone.
  // Ambiguity always loses; the owner can reply a clean "approved".
  if (/\b(not|no|nope|don'?t|do\s+not|can'?t|cannot|can\s+not|won'?t|isn'?t|never|nevermind|never\s+mind|hold|wait|stop|reject|cancel|abort|disregard|revoke)\b/.test(t)) return false;
  return true;
}

/**
 * HOLD matcher for an issue the auto-send switch queued. A hold word
 * anywhere in the un-quoted reply stops the week: stopping is the safe side,
 * so a reply that only quotes the banner ("Reply HOLD to skip…") also holds.
 */
function isHoldReply(text) {
  const t = String(text || '').toLowerCase().replace(/[‘’ʼ]/g, "'");
  return /\b(hold|stop|cancel|pause|abort|skip|don'?t\s+send|do\s+not\s+send)\b/.test(t);
}

// An issue the auto-send switch queued carries proof_approved_at with no
// approving email: a reply approval always stores the email id it came in on
// (email-sync passes the stored emails row).
function isAutoQueued(send) {
  return Boolean(send?.proof_approved_at) && !send.proof_approval_email_id;
}

/** A Gmail label list, from a parsed message (an array) or a stored emails row (jsonb). */
function labelList(labelIds) {
  if (Array.isArray(labelIds)) return labelIds;
  try {
    const parsed = JSON.parse(labelIds || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Every address a copy of a planned issue's FYI went to, recorded with its row before each copy
 * went out (recordFyiRecipient), as `diagnostics.fyiTo` { address: true }. A retry after a failed
 * attempt keeps the token and may go to another address, so each one may HOLD the issue.
 */
function issueFyiAddresses(issue) {
  let diagnostics = issue?.diagnostics;
  if (typeof diagnostics === 'string') {
    try { diagnostics = JSON.parse(diagnostics); } catch { diagnostics = null; }
  }
  const recorded = diagnostics?.fyiTo;
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)) return [];
  return Object.keys(recorded).map(normalizeEmail).filter(Boolean);
}

// Records the address a planned issue's FYI copy is about to go to, before it goes out.
function recordFyiRecipient(sendId, to) {
  return db('pest_insider_issues').where({ send_id: sendId }).update({
    diagnostics: db.raw(
      "coalesce(diagnostics, '{}'::jsonb) || jsonb_build_object('fyiTo', coalesce(diagnostics->'fyiTo', '{}'::jsonb) || jsonb_build_object(?::text, true))",
      [normalizeEmail(to)],
    ),
  });
}

/** Who may HOLD a planned issue, before the sender is verified: an approver, or an address its FYI copy went to (the current proof address when none was recorded). */
function holdAddresses(fyiTos) {
  return new Set([...approvalSenders(), ...(fyiTos.length ? fyiTos : [proofRecipient()])]);
}

/**
 * Whether a reply's sender may HOLD a planned issue, verified rather than read from the From line
 * a sender types: this mailbox's own account (Gmail's SENT label, which no outside sender can set),
 * on mail addressed to this mailbox (a reply to the FYI copy goes to its Reply-To, this mailbox; a
 * forward to someone else does not count; INBOX is not needed, since Send & Archive removes it), or
 * one of holdAddresses (an approver, or an address the issue's FYI copy went to) whose message
 * Gmail itself authenticated for its From domain (aligned DKIM or SPF pass in Google's own
 * Authentication-Results, read strictly: inbox-hygiene.hasAlignedAuth). A draft never counts.
 */
function verifiedHoldSender(email, fyiTos) {
  const labels = labelList(email?.label_ids);
  if (labels.includes('DRAFT')) return false;
  if (labels.includes('SENT')) {
    const { extractEmailAddresses } = require('./email/email-customer-link');
    return extractEmailAddresses([email.to_address, email.cc_address, email.bcc_address].filter(Boolean).join(','))
      .includes(syncedApprovalMailbox());
  }
  const from = normalizeEmail(email?.from_address);
  if (!from || !holdAddresses(fyiTos).has(from)) return false;
  const { hasAlignedAuth } = require('./email/inbox-hygiene');
  const { domainFromAddress } = require('./email/spam-blocker');
  return hasAlignedAuth(email.authentication_results, domainFromAddress(from), { strict: true });
}

/**
 * A planned issue's HOLD, read one way by the reply handler and the send-time check: a reply to its
 * FYI copy, not a forward of it (email-strip.isForwardSubject: a forward passes the copy on, and its
 * note, such as "please hold this for review", is not an answer to it), whose own text asks to stop.
 */
function isPlannedHoldReply(email) {
  const { isForwardSubject } = require('./email/email-strip');
  return !isForwardSubject(email?.subject)
    && isHoldReply(extractTopReplyText(email?.body_text || htmlReplyToText(email?.body_html)));
}

/** A HOLD reply to the FYI copy with this token (isPlannedHoldReply), from a verified sender. */
function isVerifiedHold(email, token, fyiTos) {
  return parseProofToken(email?.subject) === token && isPlannedHoldReply(email) && verifiedHoldSender(email, fyiTos);
}

/** More messages than this carrying one FYI copy's token: the search did not read them all. */
const HOLD_SEARCH_CAP = 50;

/**
 * The send-time HOLD check for a planned issue whose FYI copy offered HOLD: is there a HOLD reply
 * to any copy of it (every copy carries one token) from a verified sender (verifiedHoldSender)?
 * The reply handler applies a HOLD as it reads one; this finds one it could not apply then (the
 * proof gate off, the FYI address outside NEWSLETTER_PROOF_APPROVERS, a write that failed, a
 * self-reply archived before the sync, which stores it as outbound, or mail the sync never
 * stored). It reads two witnesses, the stored inbox (emails) and the mailbox itself (a Gmail
 * search for the copy's token, Spam and Trash included), so a reply counts whether or not the
 * sync stored it, through one rule. Throws when it cannot answer in full (a send with no valid
 * token, Gmail not connected, an API error, more than HOLD_SEARCH_CAP results), so it never
 * answers "no HOLD" without reading. `issue`: the planned issue row (the addresses its FYI copies went to).
 */
async function holdReplyOnRecord(send, issue = null) {
  // Only this form can reach the Gmail query, and a reply names the issue by it.
  if (!isProofToken(send?.proof_token)) throw new Error('its FYI copy has no valid token');
  const token = send.proof_token.toLowerCase();
  const fyiTos = issueFyiAddresses(issue);
  // Every FYI copy of this draft carries its token (a retry keeps it), so the search starts at the
  // draft, not at the latest copy; an hour of margin covers clock differences.
  const since = send.created_at ? new Date(new Date(send.created_at).getTime() - 60 * 60 * 1000) : null;
  const stored = db('emails').where('subject', 'ilike', `%[PROOF-${token}]%`);
  if (since) stored.where('received_at', '>=', since);
  const rows = await stored.select('from_address', 'to_address', 'cc_address', 'bcc_address', 'subject', 'body_text', 'body_html', 'label_ids', 'authentication_results');
  if (rows.some((email) => isVerifiedHold(email, token, fyiTos))) return true;
  const gmail = require('./email/gmail-client');
  const query = `subject:"PROOF-${token}"${since ? ` after:${Math.floor(since.getTime() / 1000)}` : ''}`;
  // Spam and Trash too: a HOLD the spam filter moved, or one deleted after it was sent, still holds.
  const { messages, truncated } = await gmail.listAllMessages(query, HOLD_SEARCH_CAP, { includeSpamTrash: true });
  if (truncated) throw new Error(`more than ${HOLD_SEARCH_CAP} messages carry its FYI copy's token`);
  const found = await Promise.all((messages || []).map(({ id }) => gmail.getMessage(id)));
  return found.some((email) => isVerifiedHold(email, token, fyiTos));
}

/**
 * Render a send the way the live broadcast will look for one internal
 * recipient: same wrapper, all merge tags ({{greeting-name}}, {{city}},
 * {{grass-type}}) resolved from the recipient's subscriber row, quiz tokens
 * neutralized (no per-recipient delivery row exists to build live quiz
 * links from). Shared by the operator test-send route and the proof email
 * so the two previews can never drift apart.
 */
async function renderSendPreview(send, toEmail) {
  const {
    GREETING_NAME_TOKEN, greetingNameValueFor,
    CITY_TOKEN, GRASS_TYPE_TOKEN, DEFAULT_CITY_LABEL, DEFAULT_GRASS_LABEL,
  } = require('./newsletter-draft');
  const { neutralizeQuizTokens } = require('./newsletter-quiz');

  // Demo unsubscribe URL — won't resolve to a real subscriber but the link
  // renders correctly and Gmail/Apple Mail will show the native unsub UI.
  const demoUrl = sendgrid.unsubscribeUrl('test-' + send.id);
  // Same reaction-footer ensure step the live sender runs, so a proof/test
  // of a hand-composed campaign shows the footer the broadcast will carry
  // (neutralized to inert chips below — no per-recipient token here).
  const { ensureFeedbackToken } = require('./newsletter-feedback');
  const ensured = ensureFeedbackToken({ html: send.html_body || '', text: send.text_body });
  // Event click-tracking tokens resolve to the DIRECT event URLs in
  // proofs/tests — the reader clicks straight through, untracked.
  const { resolveEvclickDirect, eventUrlMapForSend } = require('./newsletter-event-clicks');
  let evUrlById = new Map();
  try {
    evUrlById = await eventUrlMapForSend(send);
  } catch { /* fail-open: tokens resolve to the homepage fallback */ }
  ensured.html = resolveEvclickDirect(ensured.html, evUrlById);
  if (ensured.text) ensured.text = resolveEvclickDirect(ensured.text, evUrlById);
  let html = wrapNewsletter({
    body: ensured.html,
    unsubscribeUrl: demoUrl,
    preheader: send.preview_text || undefined,
    newsletterType: send.newsletter_type || undefined,
    preferredSourcesCta: true,
    // Same web-version permalink the live campaign gets — but only once
    // the archive can actually serve it (getPostBySlug requires
    // sending/sent). A pre-send draft proof omits the link rather than
    // handing the owner a guaranteed 404.
    webVersionUrl: (send.slug && ['sending', 'sent', 'failed'].includes(send.status))
      ? `https://www.wavespestcontrol.com/newsletter/archive/${send.slug}`
      : undefined,
    // Legacy bodies (persisted before the dark-mode layer) stay light.
    // Inspect ONLY the persisted body: the composed preview prepends the
    // proof banner/diagnostics, which carry their own dm-box hooks and
    // would make every legacy draft look dark-capable.
    darkAwareBody: bodyIsDarkAware(send.html_body),
  });

  const testSub = await db('newsletter_subscribers')
    .whereRaw('LOWER(email) = ?', [String(toEmail).toLowerCase()])
    .first();
  const greetingValue = greetingNameValueFor(testSub?.first_name);
  let cityValue = DEFAULT_CITY_LABEL;
  let grassValue = DEFAULT_GRASS_LABEL;
  if (testSub?.customer_id) {
    const pctx = (await NewsletterSender.loadPersonalizationContext([testSub])).get(testSub.customer_id);
    if (pctx) {
      cityValue = pctx.city || DEFAULT_CITY_LABEL;
      grassValue = pctx.grassLabel || DEFAULT_GRASS_LABEL;
    }
  }
  const { neutralizeFeedbackTokens } = require('./newsletter-feedback');
  const applyTokens = (s) => neutralizeFeedbackTokens(neutralizeQuizTokens(
    String(s)
      .split(GREETING_NAME_TOKEN).join(greetingValue)
      .split(CITY_TOKEN).join(cityValue)
      .split(GRASS_TYPE_TOKEN).join(grassValue),
  ));
  html = applyTokens(html);
  const text = ensured.text ? applyTokens(ensured.text) : undefined;
  return { html, text, unsubscribeUrl: demoUrl };
}

// The flagship's calendar-linked target is a future Tuesday 6:00 AM ET —
// approval only QUEUES it, the scheduler tick dispatches it later. Every
// other type (Pest Insider included) schedules for approval time itself
// (newsletter-proof.js's own `scheduledFor = new Date()` when
// !eventSelection.flagship), so the very next scheduler tick — at most a
// minute later — sends it. Codex P1: the banner promised the Tuesday
// target unconditionally, so an approver of a non-flagship proof could
// think they had until Tuesday and instead broadcast within a minute.
function proofTimingCopy(flagship) {
  return flagship ? 'Tuesday at 6:00 AM ET' : 'immediately (the next scheduler check, usually within a minute)';
}

function proofBannerHtml(recipientCount, flagship) {
  return `<div class="dm-box" style="border:2px solid #04395E;border-radius:8px;padding:14px 16px;margin:0 0 20px;background:#f4f8fb;font-family:Arial,Helvetica,sans-serif;">
<p style="margin:0 0 6px;font-size:15px;font-weight:bold;color:#04395E;">Proof — not yet sent to the list</p>
<p style="margin:0;font-size:14px;color:#1f2937;">Reply <strong>APPROVED</strong> to send this issue <strong>${proofTimingCopy(flagship)}</strong> to <strong>${recipientCount}</strong> active subscribers. Any other reply — or no reply — and it stays a draft in the composer.</p>
</div>\n`;
}

function proofBannerText(recipientCount, flagship) {
  return `PROOF — NOT YET SENT TO THE LIST\nReply APPROVED to send this issue ${proofTimingCopy(flagship)} to ${recipientCount} active subscribers. Any other reply (or no reply) and it stays a draft.\n\n----------------------------------------\n\n`;
}

// The owner's copy of an issue the auto-send switch queued: FYI, no reply
// needed. HOLD (or Cancel schedule in History) skips the week.
function autoSendBannerHtml(recipientCount) {
  return `<div class="dm-box" style="border:2px solid #04395E;border-radius:8px;padding:14px 16px;margin:0 0 20px;background:#f4f8fb;font-family:Arial,Helvetica,sans-serif;">
<p style="margin:0 0 6px;font-size:15px;font-weight:bold;color:#04395E;">Sends by itself — no reply needed</p>
<p style="margin:0;font-size:14px;color:#1f2937;">This issue goes to <strong>${recipientCount}</strong> active subscribers <strong>Tuesday at 6:00 AM ET</strong>. To skip this week, reply <strong>HOLD</strong>, or press Cancel schedule in Newsletter → History.</p>
</div>\n`;
}

function autoSendBannerText(recipientCount) {
  return `SENDS BY ITSELF — NO REPLY NEEDED\nThis issue goes to ${recipientCount} active subscribers Tuesday at 6:00 AM ET. To skip this week, reply HOLD, or press Cancel schedule in Newsletter → History.\n\n----------------------------------------\n\n`;
}

// The owner's copy of a Waves Pest Insider issue the auto-send switch queued. The HOLD deadline is
// half an hour before the 7:00 AM send, so the reply has reached the mailbox when the send-time
// check reads it (holdReplyOnRecord).
function pestInsiderBannerHtml(recipientCount, issueContext) {
  return `<div class="dm-box" style="border:2px solid #04395E;border-radius:8px;padding:14px 16px;margin:0 0 20px;background:#f4f8fb;font-family:Arial,Helvetica,sans-serif;">
<p style="margin:0 0 6px;font-size:15px;font-weight:bold;color:#04395E;">Sends by itself — no reply needed</p>
<p style="margin:0;font-size:14px;color:#1f2937;">This Waves Pest Insider issue goes to <strong>${recipientCount}</strong> readers <strong>${issueSendTimeCopy(issueContext)}</strong>. To skip this issue, reply <strong>HOLD</strong> by 6:30 AM ET that day, or press Cancel schedule in Newsletter → History.</p>
</div>\n`;
}

function pestInsiderBannerText(recipientCount, issueContext) {
  return `SENDS BY ITSELF — NO REPLY NEEDED\nThis Waves Pest Insider issue goes to ${recipientCount} readers ${issueSendTimeCopy(issueContext)}. To skip this issue, reply HOLD by 6:30 AM ET that day, or press Cancel schedule in Newsletter → History.\n\n----------------------------------------\n\n`;
}

// Internal panel for a planned Waves Pest Insider issue (proof email only):
// what the planner picked and who it goes to.
function pestInsiderDiagnosticsHtml(issueContext) {
  const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const { issue } = issueContext;
  let diagnostics = issue.diagnostics || {};
  if (typeof diagnostics === 'string') { try { diagnostics = JSON.parse(diagnostics); } catch { diagnostics = {}; } }
  const audience = diagnostics.audience;
  const audienceLine = audience
    ? `Readers: ${esc(audience.recipients)} (${esc(audience.warm)} opened a Waves email in the last 90 days; ${esc(audience.heldOut)} customers held out to measure the issue)`
    : 'Readers: count not recorded';
  return `<div class="dm-box" style="margin:0 0 20px 0;padding:14px 16px;background:#EEF3F8;border:1px solid #C9D6E2;border-radius:8px;font-family:monospace;font-size:12px;line-height:1.6;color:#26364A;">
<div style="font-weight:700;margin-bottom:6px;">INTERNAL DIAGNOSTICS — not sent to subscribers</div>
Issue ${esc(issueContext.issueDate)} · sends ${esc(issueSendTimeCopy(issueContext))} (not after 10:00 AM ET)<br/>
Fact ${esc(issue.fact_id || '—')} · What's this? ${esc(issue.species_slug || '—')} · Tool ${esc(issue.tool_id || 'none')}<br/>
${audienceLine}
</div>`;
}

async function countRecipients(send) {
  // Shared preflight (codex #3472 r3): runs the archived-link relink sweep
  // before counting, so a proof approval can't block on stale links the
  // send itself would repair.
  return NewsletterSender.countSegmentRecipients(send.segment_filter);
}

// Returns whether the notification was actually delivered — a caller that
// records "the owner was told" must not take a swallowed failure for a
// delivery (Pest Insider catch-up, codex round 6 P1). `options`, when given,
// go to triggerNotification (a dedupeKey: a retry finds the row already written).
async function notifyProof(type, payload, options = null) {
  try {
    const { triggerNotification } = require('./notification-triggers');
    const result = await (options ? triggerNotification(type, payload, options) : triggerNotification(type, payload));
    // triggerNotification resolves with the delivery outcome rather than
    // throwing — { bellWritten: false, push: null, prefsUnavailable: true }
    // is a failure. Delivered = a bell row was written or a push went out.
    return !!(result && (result.bellWritten === true || Number(result.push?.sent) > 0));
  } catch (e) {
    logger.warn(`[newsletter-proof] ${type} notification failed: ${e.message}`);
    return false;
  }
}

// Token-scoped release of a refused approval's proof claim, so the
// corrected draft can get a FRESH proof (sendNewsletterProof skips any row
// with proof_sent_at set). proof_refused_at is the durable sign that a proof
// WAS sent and an approval was refused (every refusal release sets it; cancel
// and reset paths clear it), which the Pest Insider catch-up reads to
// re-proof a corrected draft after its day-10 cutoff. Never throws: the
// refusal itself already stands.
async function releaseRefusedProofClaim(sendId, token, reason) {
  try {
    await db('newsletter_sends')
      .where({ id: sendId, proof_token: token })
      .update({ proof_token: null, proof_sent_at: null, proof_refused_at: new Date(), updated_at: new Date() });
  } catch (clearErr) {
    logger.error(`[newsletter-proof] failed to release proof claim after ${reason} for ${sendId}: ${clearErr.message}`);
  }
}

/**
 * What the proof step emails the owner. Default: a proof that waits for an
 * APPROVED reply. GATE_NEWSLETTER_AUTO_SEND (owner 2026-10-30, option A): a
 * weekly issue that passed every check gets an FYI copy and is queued once
 * the copy went out (queueAutoSendIssue).
 */
function proofDelivery(calendarContext, recipientCount, issueContext = null) {
  // A planned Waves Pest Insider issue: sendNewsletterProof proofs it only with its switch on.
  if (issueContext) {
    return {
      autoSend: true,
      prefix: 'FYI',
      bannerHtml: pestInsiderBannerHtml(recipientCount, issueContext),
      bannerText: pestInsiderBannerText(recipientCount, issueContext),
    };
  }
  if (calendarContext.flagship && newsletterAutoSendLive()) {
    return { autoSend: true, prefix: 'FYI', bannerHtml: autoSendBannerHtml(recipientCount), bannerText: autoSendBannerText(recipientCount) };
  }
  return {
    autoSend: false,
    prefix: 'ACT',
    bannerHtml: proofBannerHtml(recipientCount, calendarContext.flagship),
    bannerText: proofBannerText(recipientCount, calendarContext.flagship),
  };
}

/**
 * Queue an auto-send issue for its Tuesday target once the owner's FYI copy
 * went out. Until then the proof claim is a draft the dispatcher never picks
 * up, so a crash or a run near 6:00 AM cannot send an issue the owner got no
 * copy of. Bound to the claim (token, draft, no edit since the claim): an
 * issue that changed in between stays unqueued and the owner is told.
 * No approving email id: that is how the dispatcher and the reply handler
 * tell an auto-queued issue from a reply-approved one.
 */
async function queueAutoSendIssue(send, token, claimedAt, calendarContext, issueContext = null) {
  const queueSend = (conn) => conn('newsletter_sends')
    .where({ id: send.id, proof_token: token, status: 'draft' })
    .whereNull('proof_approved_at')
    .whereRaw("date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ?::timestamptz)", [claimedAt])
    .update({
      status: 'scheduled',
      scheduled_for: issueContext ? issueContext.scheduledFor : calendarContext.scheduledFor,
      proof_approved_at: new Date(),
      proof_approval_email_id: null,
      proof_refused_at: null,
      updated_at: new Date(),
    });
  let queued = 0;
  try {
    if (issueContext) {
      // A planned Waves Pest Insider issue is queued together with its planned row, in one
      // transaction: the dispatcher sends only an issue whose row is scheduled, so a send queued
      // alone would be stopped on Thursday after its FYI copy said it goes out. A row that is no
      // longer drafted rolls the queueing back, and the owner is told below.
      queued = await db.transaction(async (trx) => {
        const moved = await queueSend(trx);
        if (moved && !(await moveIssueForSend(send.id, ['drafted'], 'scheduled', { database: trx }))) {
          throw new Error('its planned issue is no longer drafted');
        }
        return moved;
      });
    } else {
      queued = await queueSend(db);
      if (queued) await db('newsletter_calendar').where({ id: calendarContext.linkedCalendar.id }).update({ status: 'scheduled', updated_at: new Date() });
    }
  } catch (err) {
    logger.error(`[newsletter-proof] queueing auto-send issue ${send.id} failed: ${err.message}`);
  }
  let notified = false;
  if (!queued) {
    notified = await notifyProof('newsletter_proof_blocked', { sendId: send.id,
      subject: send.subject,
      errors: [`The FYI copy went out, but the issue changed before it could be queued, so it will not send ${issueContext ? 'by itself' : 'this week'}.`],
    });
  }
  return { queued: Boolean(queued), notified };
}

/**
 * Send the proof email for a draft. Idempotent: a send that already has
 * proof_sent_at (or isn't a draft anymore) is skipped, so the Monday/early-
 * Tuesday catch-up jobs can call this safely every tick.
 *
 * @returns {{ sent?: boolean, skipped?: boolean, reason?: string, notified?: boolean }} — `notified`
 *   says whether the owner's blocked notice was actually delivered.
 */
async function sendNewsletterProof(sendId) {
  if (!isProofApprovalEnabled()) return { skipped: true, reason: 'gate_off' };
  // Fail closed when no explicit approver is configured: a proof whose
  // approval reply can never be honored would just mislead the owner.
  if (approvalSenders().length === 0) {
    logger.warn('[newsletter-proof] gate is on but NEWSLETTER_PROOF_APPROVERS is unset — no proof sent (fail closed)');
    return { skipped: true, reason: 'no_approvers_configured' };
  }
  if (!sendgrid.isConfigured()) return { skipped: true, reason: 'sendgrid_not_configured' };

  const send = await db('newsletter_sends').where({ id: sendId }).first();
  if (!send) return { skipped: true, reason: 'not_found' };
  if (send.status !== 'draft') return { skipped: true, reason: `status_${send.status}` };
  if (send.proof_sent_at) return { skipped: true, reason: 'proof_already_sent' };
  if (!send.html_body && !send.text_body) return { skipped: true, reason: 'empty_body' };

  const to = assertInternalEmailRecipient(proofRecipient());

  // Same gate the manual Send button enforces — a draft that would be
  // blocked from sending gets no proof, it gets a "fix me" notification.
  const recipientCount = await countRecipients(send);
  if (recipientCount === 0) {
    const notified = await notifyProof('newsletter_proof_blocked', { sendId: send.id,
      subject: send.subject,
      errors: ['Segment matches 0 active subscribers'],
    });
    return { skipped: true, reason: 'zero_recipients', notified };
  }
  if (requiresClaimValidation(send.newsletter_type)) {
    const lockedPrices = await lockedPricesForSend(send, db);
    const { errors } = validateNewsletterDraft(send, { recipientCount, lockedPrices });
    if (errors.length > 0) {
      const notified = await notifyProof('newsletter_proof_blocked', { sendId: send.id, subject: send.subject, errors });
      return { skipped: true, reason: 'validation_failed', errors, notified };
    }
  }
  const calendarContext = await resolveFlagshipCalendarContext(send);
  const issueContext = await resolvePestInsiderIssueContext(send);
  // A held or skipped week stays skipped: a fresh proof would queue it again
  // under GATE_NEWSLETTER_AUTO_SEND, or let a reply approve a retired issue.
  if (calendarContext.linkedCalendar?.status === 'skipped') return { skipped: true, reason: 'week_skipped' };
  // The same for a held Waves Pest Insider issue.
  if (issueContext?.issue.status === 'held') return { skipped: true, reason: 'issue_held' };
  // A planned issue is only ever proofed as an FYI copy, so its replies always follow the FYI
  // rules (handlePlannedIssueReply). With its switch off nothing proofs or queues it.
  if (issueContext && !pestInsiderAutoSendLive()) return { skipped: true, reason: 'auto_send_off' };
  if (!calendarContext.valid) {
    const errors = ['The linked calendar must target its own future issue Tuesday at exactly 6:00 AM ET.'];
    const notified = await notifyProof('newsletter_proof_blocked', { sendId: send.id, subject: send.subject, errors });
    return { skipped: true, reason: 'calendar_target_invalid', errors, notified };
  }
  if (issueContext && !issueContext.valid) {
    const errors = ['This Waves Pest Insider issue must go out on its own issue Thursday at 7:00 AM ET, and that time has passed.'];
    const notified = await notifyProof('newsletter_proof_blocked', { sendId: send.id, subject: send.subject, errors });
    return { skipped: true, reason: 'issue_target_invalid', errors, notified };
  }
  const selectionReference = calendarContext.flagship ? calendarContext.scheduledFor : new Date();
  const eventSelection = await validateFlagshipEventSelection(send, { reference: selectionReference });
  if (!eventSelection.valid) {
    const notified = await notifyProof('newsletter_proof_blocked', { sendId: send.id, subject: send.subject, errors: eventSelection.errors });
    return { skipped: true, reason: 'event_selection_invalid', errors: eventSelection.errors, notified };
  }
  // Live official-page recheck (dark behind NEWSLETTER_LIVE_REVERIFY):
  // don't proof a lineup carrying a confirmed-dead event — the owner
  // would approve a broken issue.
  const proofRecheck = await reverifyEvents(eventSelection.events);
  if (!proofRecheck.ok) {
    const errors = proofRecheck.failures.map((f) => `Locked event failed live recheck: ${f.title} — ${f.reason}`);
    const suggestion = await alternateSuggestionLine(send);
    if (suggestion) errors.push(suggestion);
    const notified = await notifyProof('newsletter_proof_blocked', { sendId: send.id, subject: send.subject, errors });
    return { skipped: true, reason: 'live_reverify_failed', errors, notified };
  }

  // Atomic proof claim BEFORE the external SendGrid call: overlapping
  // autopilot/catch-up workers must not both email proofs (the second
  // token would overwrite the first, making its reply a dead letter).
  // One `now` for both stamps so the approval-time staleness check
  // (updated_at > proof_sent_at) has an exact baseline. The claim is also
  // version-guarded on the fetched row's updated_at: an admin edit between
  // our read and this write would otherwise be silently overwritten with
  // updated_at === proof_sent_at — masking the edit from the staleness
  // gate while we email a proof rendered from the pre-edit body.
  // A planned issue keeps the token an earlier FYI attempt left (the failure release below keeps
  // it), so every copy of its FYI carries one token: a copy SendGrid accepted before an error
  // still names this issue, for the reply handler and for the send-time HOLD check.
  const token = issueContext && isProofToken(send.proof_token)
    ? send.proof_token.toLowerCase()
    : crypto.randomBytes(4).toString('hex');
  const now = new Date();
  const delivery = proofDelivery(calendarContext, recipientCount, issueContext);
  const claimQuery = db('newsletter_sends')
    .where({ id: send.id, status: 'draft' })
    .whereNull('proof_sent_at');
  // Millisecond-truncated comparison: DB-defaulted rows carry microsecond
  // updated_at while node-pg hands back millisecond Dates — an exact
  // equality guard would spuriously fail the very first proof of a fresh
  // draft.
  if (send.updated_at) {
    claimQuery.whereRaw(
      "date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ?::timestamptz)",
      [send.updated_at],
    );
  }
  const claimed = await claimQuery.update({ proof_token: token, proof_sent_at: now, updated_at: now });
  if (!claimed) return { skipped: true, reason: 'proof_claimed_elsewhere' };

  try {
    // Every address a copy of a planned issue's FYI goes to may HOLD it (verifiedHoldSender), so it
    // is recorded with its row before the copy goes out; a write that fails sends nothing.
    if (issueContext) await recordFyiRecipient(send.id, to);
    // Internal diagnostics render between the proof banner and the
    // recipient preview — proof email ONLY, never the list send.
    const diagnosticsHtml = issueContext
      ? pestInsiderDiagnosticsHtml(issueContext)
      : await buildProofDiagnosticsHtml(send, eventSelection.events, calendarContext.scheduledFor);
    const { html, text } = await renderSendPreview({
      ...send,
      html_body: delivery.bannerHtml + diagnosticsHtml + (send.html_body || ''),
      text_body: send.text_body ? delivery.bannerText + send.text_body : send.text_body,
    }, to);

    const result = await sendgrid.sendOne({
      to,
      fromEmail: send.from_email,
      fromName: send.from_name,
      // ACT: / FYI: prefix per the ops-email convention (an auto-queued
      // issue needs no reply); PROOF_SUBJECT_RE matches the token anywhere
      // in the subject, so reply recognition is unaffected.
      subject: `${delivery.prefix}: [PROOF-${token}] ${send.subject}`,
      html,
      text,
      // The reply must land in the mailbox the Gmail sync watches or the
      // approval handler never sees it — Reply-To is always the synced
      // inbox, even when the proof recipient is a different address.
      replyTo: syncedApprovalMailbox(),
      categories: ['newsletter_proof', `send_${send.id}`],
      // Deliberately NO ASM group: the proof is an internal control
      // message; newsletter unsub/suppression state must never be able to
      // silently swallow it.
    });

    // The "reply APPROVED" bell is for a proof that waits on the owner; an
    // auto-send issue needs no one (its FYI copy is the record).
    const queue = delivery.autoSend ? await queueAutoSendIssue(send, token, now, calendarContext, issueContext) : null;
    const queued = Boolean(queue && queue.queued);
    if (!delivery.autoSend) {
      await notifyProof('newsletter_proof_sent', { sendId: send.id,
        subject: send.subject,
        recipient: maskEmail(to),
        recipientCount,
      });
    }

    logger.info(`[newsletter-proof] proof sent for ${send.id} (token ${token}, queued ${queued}, messageId ${result?.messageId || 'n/a'})`);
    // An FYI copy that could not queue its issue also says whether the alert about that reached
    // the owner (the Pest Insider planner's last tick reads it).
    return { sent: true, token, queued, ...(queue && !queued ? { notified: queue.notified } : {}) };
  } catch (sendErr) {
    // Release OUR claim (token-scoped) so the catch-up tick can retry a
    // transient SendGrid failure instead of the week silently losing its
    // proof (an auto-send issue is not queued yet, so nothing else to undo).
    // A planned issue keeps its token: SendGrid may have accepted the copy
    // before the error (a timeout), and a HOLD reply to that copy must still
    // name this issue. Its retry sends the same token.
    try {
      await db('newsletter_sends')
        .where({ id: send.id, proof_token: token })
        .update({ ...(issueContext ? {} : { proof_token: null }), proof_sent_at: null, updated_at: new Date() });
    } catch (clearErr) {
      logger.error(`[newsletter-proof] failed to release proof claim for ${send.id}: ${clearErr.message}`);
    }
    logger.error(`[newsletter-proof] proof send failed for ${send.id}: ${sendErr.message}`);
    return { skipped: true, reason: 'proof_send_failed' };
  }
}

// A HOLD reply is read once (the inbox sync never retries it). When its writes fail, nothing
// changed, so the owner is told that the issue may still send and how to stop it by hand.
async function notifyHoldFailed(send, err) {
  logger.error(`[newsletter-proof] HOLD for send ${send.id} failed: ${err.message}`);
  await notifyProof('newsletter_proof_blocked', { sendId: send.id,
    subject: send.subject,
    errors: [`The HOLD reply could not be applied (${String(err.message).slice(0, 200)}), so this issue may still send. To stop it, press Cancel schedule in Newsletter → History, or Delete if it shows as a draft.`],
  });
}

// A hold word to a planned issue that stops nothing: in a forward of its FYI copy ('forwarded'), or
// from a sender Gmail could not verify ('unverified'). The owner is told once per send and kind, so a
// real HOLD sent that way (a forward, a relay that breaks DKIM) is not lost silently.
const IGNORED_HOLD = {
  forwarded: {
    log: 'came in a forward of its FYI copy',
    text: (who) => `A forward of the FYI copy from ${who} asks to hold this issue, but only a reply to the FYI copy holds it, so this issue still sends. To skip it, reply HOLD to the FYI copy, or press Cancel schedule in Newsletter → History`,
  },
  unverified: {
    log: 'failed sender verification',
    text: (who) => `A HOLD reply from ${who} was ignored: Gmail could not verify that this address sent it, so this issue still sends. If you sent it, reply HOLD from the inbox the FYI copy reached, or press Cancel schedule in Newsletter → History`,
  },
};
async function ignorePlannedHold(send, from, kind) {
  logger.warn(`[newsletter-proof] HOLD for planned issue send ${send.id} from ${maskEmail(from)} ${IGNORED_HOLD[kind].log} — ignored`);
  await notifyProof('newsletter_proof_blocked', { sendId: send.id,
    subject: send.subject,
    errors: [IGNORED_HOLD[kind].text(maskEmail(from))],
    outcome: true,
  }, { dedupeKey: `pest-insider-${kind}-hold:${send.id}` });
  return true;
}

/**
 * HOLD reply on an auto-queued issue: back to draft and the week skipped, so
 * neither the catch-up nor the Monday autopilot proofs or queues it again
 * (sendNewsletterProof skips a skipped week). The proof token is cleared, so
 * a later reply on the thread is ordinary mail and can never approve the
 * held issue. Too late once the send is claimed.
 */
async function holdAutoQueuedIssue(send, token, from) {
  if (send.status !== 'scheduled') {
    logger.info(`[newsletter-proof] HOLD for send ${send.id} arrived while it was ${send.status} — nothing to stop`);
    return true;
  }
  // One transaction: the send goes back to draft only together with its skipped week and its held
  // planned issue, so a failed write never leaves an issue queued under a draft.
  const held = await db.transaction(async (trx) => {
    const reverted = await trx('newsletter_sends')
      .where({ id: send.id, proof_token: token, status: 'scheduled' })
      .whereNotNull('proof_approved_at')
      .whereNull('proof_approval_email_id')
      .update({ status: 'draft', scheduled_for: null, proof_token: null, proof_approved_at: null, updated_at: new Date() });
    if (!reverted) return false;
    await trx('newsletter_calendar').where({ send_id: send.id }).update({ status: 'skipped', updated_at: new Date() });
    // A held Waves Pest Insider issue stays held: the planner never proofs or queues it again.
    if (send.newsletter_type === PEST_INSIDER_TYPE) {
      await moveIssueForSend(send.id, ['drafted', 'scheduled'], 'held', { reason: 'HOLD reply from the owner', database: trx });
    }
    return true;
  }).catch(async (err) => { await notifyHoldFailed(send, err); return null; });
  if (held === null) return true;
  if (!held) {
    logger.info(`[newsletter-proof] HOLD for send ${send.id} lost a race with the send — nothing to stop`);
    return true;
  }
  logger.info(`[newsletter-proof] send ${send.id} held by ${maskEmail(from)} — week skipped`);
  return true;
}

/**
 * A reply to a planned Waves Pest Insider issue's FYI copy (its pest_insider_issues row links the
 * send). The issue sends itself on its own Thursday, so the copy offers HOLD only, and an issue
 * the switch already queued was handled by holdAutoQueuedIssue. HOLD on a send that is not queued
 * yet holds the planned row: the queueing needs that row drafted, so one still in flight rolls
 * back, and a send queued in between goes back to draft here. APPROVED never sends it at another
 * time, and the owner is told that the reply changed nothing.
 */
async function handlePlannedIssueReply(send, token, from, replyText) {
  if (send.status !== 'draft') {
    logger.info(`[newsletter-proof] reply for planned issue send ${send.id} arrived while it was ${send.status} — no change`);
    return true;
  }
  if (isHoldReply(replyText)) {
    // One transaction, the send row locked first, as the queueing locks it: a queueing in flight
    // either commits first (and both rows go back here) or rolls back on the held row.
    const held = await db.transaction(async (trx) => {
      await trx('newsletter_sends').where({ id: send.id }).forUpdate().first('id');
      const moved = await moveIssueForSend(send.id, ['drafted', 'scheduled'], 'held', { reason: 'HOLD reply from the owner', database: trx });
      if (moved) {
        await trx('newsletter_sends')
          .where({ id: send.id, proof_token: token, status: 'scheduled' })
          .whereNotNull('proof_approved_at')
          .whereNull('proof_approval_email_id')
          .update({ status: 'draft', scheduled_for: null, proof_token: null, proof_approved_at: null, updated_at: new Date() });
      }
      return moved;
    }).catch(async (err) => { await notifyHoldFailed(send, err); return null; });
    if (held === null) return true;
    logger.info(`[newsletter-proof] HOLD for planned issue send ${send.id} by ${maskEmail(from)}: ${held ? 'held' : 'nothing to hold'}`);
    return true;
  }
  if (isApprovalReply(replyText)) {
    await notifyProof('newsletter_proof_blocked', { sendId: send.id,
      subject: send.subject,
      errors: ['Approved, but an APPROVED reply does not send a Waves Pest Insider issue: it sends only by itself, on its Thursday at 7:00 AM ET, once it is queued. Nothing changed.'],
    });
  }
  logger.info(`[newsletter-proof] reply for planned issue send ${send.id} is not HOLD — no change`);
  return true;
}

/**
 * Inbound-email hook (called from the Gmail sync on every newly stored
 * email). Detects a reply to a proof email and, when it is an allowlisted
 * owner saying "approved", queues the list send for Tuesday at 6:00 AM ET.
 * On an issue the auto-send switch already queued, a HOLD reply skips the
 * week instead.
 *
 * Returns true when the email was recognized as proof-approval traffic
 * (whether or not it resulted in a send); false = not ours, continue the
 * normal pipeline.
 */
async function maybeHandleProofApproval(email) {
  if (!isProofApprovalEnabled()) return false;

  const token = parseProofToken(email?.subject);
  if (!token) return false;

  const from = normalizeEmail(email?.from_address);
  const send = await db('newsletter_sends').where({ proof_token: token }).first();

  // HTML-only replies go through the quote-aware converter — a naive tag
  // strip would flatten the quoted proof banner ("Reply APPROVED…") into
  // the checked text and let a non-approval reply match.
  const replyText = extractTopReplyText(email.body_text || htmlReplyToText(email.body_html));

  // A planned Waves Pest Insider issue sends itself on its own Thursday: its own rules below. Its
  // HOLD follows the send-time check's rules (isPlannedHoldReply, verifiedHoldSender): a reply, not
  // a forward, from a verified sender, also an FYI address outside the approvers. A hold word from
  // an approver or an FYI address in a forward, or in a message Gmail could not verify (anyone can
  // type such an address into a From line), stops nothing, and the owner is told once.
  const planned = send ? await resolvePestInsiderIssueContext(send) : null;
  if (planned && isHoldReply(replyText)) {
    const fyiTos = issueFyiAddresses(planned.issue);
    const verified = verifiedHoldSender(email, fyiTos);
    if (!verified && !holdAddresses(fyiTos).has(from)) {
      logger.info(`[newsletter-proof] ignoring a HOLD for planned issue send ${send.id} from ${maskEmail(from)}, who may not hold it`);
      return false;
    }
    if (!isPlannedHoldReply(email)) return ignorePlannedHold(send, from, 'forwarded');
    if (!verified) return ignorePlannedHold(send, from, 'unverified');
  } else if (!approvalSenders().includes(from)) {
    // Ignore our own outbound proof (SendGrid copies can sync back in):
    // a proof has no "Re:" and comes FROM the newsletter address — the
    // send-side guard below (approved-text required) already makes it inert,
    // but the sender allowlist is the real boundary. Sender is logged
    // masked — full addresses in logs are PII.
    logger.info(`[newsletter-proof] ignoring [PROOF-${token}] email from non-approver ${maskEmail(from)}`);
    return false;
  }

  if (!send) {
    logger.warn(`[newsletter-proof] approval reply with unknown token ${token}`);
    return false;
  }

  // HOLD on an issue the auto-send switch queued skips the week (owner
  // 2026-10-30, option A). Checked before the duplicate guard below: an
  // auto-queued issue already carries proof_approved_at.
  if (isAutoQueued(send) && isHoldReply(replyText)) return holdAutoQueuedIssue(send, token, from);

  if (planned) return handlePlannedIssueReply(send, token, from, replyText);

  if (send.proof_approved_at) {
    logger.info(`[newsletter-proof] send ${send.id} already approved — ignoring duplicate reply`);
    return true;
  }

  if (!isApprovalReply(replyText)) {
    logger.info(`[newsletter-proof] reply for send ${send.id} did not say "approved" — leaving draft untouched`);
    return true;
  }

  // The Pest Insider kill switch governs APPROVAL, not only proofing. A
  // proof that went out while GATE_PEST_INSIDER_PROOF was on must not be
  // approvable once the gate is off: off means draft-only. The draft and
  // its proof are left untouched, so turning the gate back on and replying
  // again approves the same proof.
  if (send.newsletter_type === PEST_INSIDER_TYPE && !pestInsiderProofLive()) {
    logger.info(`[newsletter-proof] send ${send.id} is a Pest Insider issue and GATE_PEST_INSIDER_PROOF is off — approval refused, draft untouched`);
    await notifyProof('newsletter_proof_blocked', { sendId: send.id,
      subject: send.subject,
      errors: ['Approved, but Pest Insider proof approval is switched off — nothing sent and the draft is unchanged. Turn the switch back on and reply APPROVED again, or send the issue from the Newsletter page.'],
    });
    return true;
  }

  // Drafts ONLY. A 'scheduled' row means the operator already picked a
  // future send time — an approval reply must not overwrite that schedule
  // and broadcast immediately.
  if (send.status !== 'draft') {
    logger.info(`[newsletter-proof] send ${send.id} is ${send.status} — approval reply is a no-op`);
    return true;
  }

  // Staleness gate: the proof stamps proof_sent_at === updated_at in one
  // write, so ANY later edit (composer PATCH bumps updated_at) means the
  // owner approved content that was never proofed. Refuse, invalidate the
  // stale proof, and immediately issue a fresh one for the edited draft.
  if (send.proof_sent_at && send.updated_at
      && new Date(send.updated_at).getTime() > new Date(send.proof_sent_at).getTime()) {
    logger.info(`[newsletter-proof] send ${send.id} was edited after its proof — refusing stale approval, re-proofing`);
    await notifyProof('newsletter_proof_blocked', { sendId: send.id,
      subject: send.subject,
      errors: ['Draft was edited after the proof went out — approval refused. A fresh proof of the edited draft is on its way; reply APPROVED to that one.'],
    });
    try {
      await db('newsletter_sends')
        .where({ id: send.id, proof_token: token })
        .update({ proof_token: null, proof_sent_at: null, proof_refused_at: new Date(), updated_at: new Date() });
      await sendNewsletterProof(send.id);
    } catch (reproofErr) {
      logger.error(`[newsletter-proof] re-proof after stale approval failed for ${send.id}: ${reproofErr.message}`);
    }
    return true;
  }

  // Re-run the manual Send button's gates at approval time — the draft may
  // have been edited between proof and approval.
  const recipientCount = await countRecipients(send);
  if (recipientCount === 0) {
    await notifyProof('newsletter_proof_blocked', { sendId: send.id,
      subject: send.subject,
      errors: ['Approved, but segment matches 0 active subscribers — nothing sent'],
    });
    return true;
  }
  if (requiresClaimValidation(send.newsletter_type)) {
    const lockedPrices = await lockedPricesForSend(send, db);
    const { errors } = validateNewsletterDraft(send, { recipientCount, lockedPrices });
    if (errors.length > 0) {
      await notifyProof('newsletter_proof_blocked', { sendId: send.id,
        subject: send.subject,
        errors: ['Approved, but validation now fails — nothing sent', ...errors],
      });
      // Release the proof claim (token-scoped, as the live-recheck branch
      // below does): a fact withdrawn or the claim scan tightened since the
      // proof means the CORRECTED draft needs a fresh proof, and
      // sendNewsletterProof skips any row with proof_sent_at set (codex
      // round 17 P2).
      await releaseRefusedProofClaim(send.id, token, 'validation failure');
      return true;
    }
  }

  const calendarContext = await resolveFlagshipCalendarContext(send);
  if (!calendarContext.valid) {
    await notifyProof('newsletter_proof_blocked', { sendId: send.id,
      subject: send.subject,
      errors: ['Approved, but the linked calendar must target its own future issue Tuesday at exactly 6:00 AM ET. The draft was left unscheduled.'],
    });
    return true;
  }
  const selectionReference = calendarContext.flagship ? calendarContext.scheduledFor : new Date();
  const eventSelection = await validateFlagshipEventSelection(send, { reference: selectionReference });
  if (!eventSelection.valid) {
    await notifyProof('newsletter_proof_blocked', { sendId: send.id,
      subject: send.subject,
      errors: ['Approved, but the locked event lineup is no longer eligible — nothing scheduled', ...eventSelection.errors],
    });
    // Release the proof claim like the validation and live-recheck refusals
    // do: the corrected lineup needs a FRESH proof, and sendNewsletterProof
    // skips any row with proof_sent_at set (audit 2026-10-30, NEWS-07).
    await releaseRefusedProofClaim(send.id, token, 'lineup refusal');
    return true;
  }
  // Same live recheck at approval time — the proof may be hours old.
  const approvalRecheck = await reverifyEvents(eventSelection.events);
  if (!approvalRecheck.ok) {
    const errors = [
      'Approved, but a locked event failed the live page recheck — nothing scheduled',
      ...approvalRecheck.failures.map((f) => `${f.title} — ${f.reason}`),
    ];
    const suggestion = await alternateSuggestionLine(send);
    if (suggestion) errors.push(suggestion);
    await notifyProof('newsletter_proof_blocked', { sendId: send.id, subject: send.subject, errors });
    // Invalidate the proof claim (token-scoped, same shape as the
    // stale-approval branch): the draft needs an event swap and a FRESH
    // proof, but sendNewsletterProof skips any row with proof_sent_at set —
    // leaving the claim in place would strand the whole proof workflow.
    await releaseRefusedProofClaim(send.id, token, 'recheck failure');
    return true;
  }

  let scheduledFor = new Date();
  let linkedCalendar = null;
  if (eventSelection.flagship) {
    linkedCalendar = calendarContext.linkedCalendar;
    scheduledFor = calendarContext.scheduledFor;
  }

  // Atomic approval claim: two synced copies of the same reply (or a race
  // with a manual Send click) can't both dispatch. Version-guarded on the
  // exact row this approval was checked against — token, status, AND
  // updated_at — so an edit or re-proof landing between the staleness
  // check above and this write turns the claim into a 0-row no-op instead
  // of broadcasting content the owner never proofed.
  // The claim also flips the row to 'scheduled'. Flagship approval uses the
  // linked calendar's future Tuesday 6:00 AM ET target — never approval time:
  // the scheduler's processScheduledSends tick is the durable executor. A
  // process crash after this commit cannot strand an approved campaign.
  const approvalClaim = db('newsletter_sends')
    .where({ id: send.id, proof_token: token, status: send.status })
    .whereNull('proof_approved_at');
  // ms-truncated for the same node-pg precision reason as the proof claim
  if (send.updated_at) {
    approvalClaim.whereRaw(
      "date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', ?::timestamptz)",
      [send.updated_at],
    );
  }
  const claimed = await approvalClaim.update({
    proof_approved_at: new Date(),
    proof_approval_email_id: email.id || null,
    proof_refused_at: null,
    status: 'scheduled',
    scheduled_for: scheduledFor,
    updated_at: new Date(),
  });
  if (!claimed) {
    logger.info(`[newsletter-proof] approval claim for send ${send.id} lost a race (edit/re-proof/duplicate) — no dispatch`);
    return true;
  }

  if (linkedCalendar) {
    await db('newsletter_calendar').where({ id: linkedCalendar.id }).update({
      status: 'scheduled',
      updated_at: new Date(),
    });
  }

  logger.info(`[newsletter-proof] send ${send.id} approved by ${maskEmail(from)} — scheduled for ${scheduledFor.toISOString()}`);

  // The weekly flagship always waits for Tuesday's scheduler tick, and so
  // does a Pest Insider issue: processScheduledSends re-reads the row, re-runs
  // the gates and the validator against what is stored THEN, and a PATCH
  // that lands after this approval has already returned the row to 'draft'
  // (off the scheduler's 'scheduled' query). Dispatching straight from here
  // could hand sendCampaign an edited, unapproved row — it accepts draft or
  // scheduled and does not re-validate. Preserve the legacy fast path only
  // for any other non-flagship proof flow.
  if (!eventSelection.flagship && send.newsletter_type !== PEST_INSIDER_TYPE) {
    NewsletterSender.sendCampaign(send.id).catch((err) => {
      logger.error(`[newsletter-proof] approved campaign ${send.id} failed: ${err.message}`, { stack: err.stack });
    });
  }

  await notifyProof('newsletter_proof_approved', {
    subject: send.subject,
    approvedBy: maskEmail(from),
    recipientCount,
    scheduledFor: scheduledFor.toISOString(),
  });

  return true;
}

module.exports = {
  isProofApprovalEnabled,
  proofRecipient,
  syncedApprovalMailbox,
  approvalSenders,
  resolveFlagshipCalendarContext,
  maskEmail,
  parseProofToken,
  isProofToken,
  extractTopReplyText,
  htmlReplyToText,
  isApprovalReply,
  isHoldReply,
  holdReplyOnRecord,
  renderSendPreview,
  sendNewsletterProof,
  maybeHandleProofApproval,
  notifyProof,
};
