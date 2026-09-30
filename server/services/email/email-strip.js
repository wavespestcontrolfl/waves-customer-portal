'use strict';

// Strips quoted history and signature blocks from a plain-text email body
// BEFORE it reaches the extractor — the grounding check in sms-operational-
// extractor.js's groundExtraction requires every quoted obligation/fact to
// be a literal substring of the text the model saw, so this must produce
// the SAME text passed as message_body to extractSmsOperations, never a
// second, separately-stripped copy (coordinator correction #7).
//
// Owner diagnostic, 2026-09-29 (production dry run, 9 real emails, 0
// obligations found): real Gmail plain-text bodies do NOT wrap the quoted
// history/signature onto their own lines the way a hand-written fixture
// does — the whole thing (customer's reply, "On ... wrote:", the quoted
// thread, Waves' own multi-line signature) runs together as ONE long
// paragraph with no reliable line breaks, and the "On ... wrote:" marker
// itself is HTML-entity-encoded (`&lt;`/`&gt;` around the quoted sender's
// address). Every marker below is therefore matched INLINE (never
// line-anchored `^...$`), against text that has ALREADY been through
// decodeEntities. A real body ran 10k-20k+ chars raw; without a real cut
// here every one of them blew past extractSmsOperations' 6000-char email
// ceiling and was silently dropped before any model call ever ran.
//
// Heuristic, not exhaustive: erring toward stripping too much only means an
// obligation is missed (the existing "a missed bell is the worse failure"
// posture elsewhere in this codebase is reversed here on purpose — a
// stripped-away sentence never reaches the model, so nothing is captured
// from it; under-stripping risks extracting a quoted OLDER message as if it
// were said today, which is worse). Known gap: an unusual client's quote
// header or a free-form signature this does not recognize passes through
// unstripped; extractSmsOperations' own 600/6000-char body cap and the
// model's own read of "the CURRENT message" are the remaining backstops.
const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const ENTITY_RE = /&lt;|&gt;|&amp;|&quot;|&#39;|&nbsp;/g;
function decodeEntities(text) {
  return String(text || '').replace(ENTITY_RE, (m) => ENTITIES[m]);
}

// Every pattern is searched INLINE (no `^`/`$` anchors that would require a
// real line break) — matches only its OWN cut point; the earliest match
// across all of them wins.
const CUT_PATTERNS = [
  // Gmail/most clients, weekday OR numeric-date form, decoded-entity email
  // address tolerated: "On Tue, Sep 22, 2026 at 3:21 PM, Jane <jane@x.com>
  // wrote:" / "On 09/09/2026 8:29 AM, Jane <jane@x.com> wrote:". Bounded gap
  // so an unrelated later "wrote:" elsewhere in a long body never anchors here.
  // Any-case "On" (clients vary), and the header span (up to the FIRST
  // "wrote:") must carry a digit or an '@' — a date or an address — so ordinary prose like
  // "on Tuesday the tech wrote: we are coming" is never read as a quote header
  // (audit, 2026-09-30).
  /\bOn\s(?=.{0,150}?\swrote:)(?:(?!\swrote:).){0,150}?[\d@]/i,
  // Outlook: a long underscore rule immediately before the quoted header
  // block, e.g. "________________________________\nFrom: Jane <jane@x.com>".
  /_{10,}\s*From:/i,
  /-{2,}\s*Original Message\s*-{2,}/i,
  /-{2,}\s*Forwarded message\s*-{2,}/i,
  // A quote marker: a line starting with '>' (optional leading whitespace),
  // or an inline " > " — real bodies run the quote marker directly into the
  // "On ... wrote:" text with no line break at all ("...1563 > On 09/09...").
  /(?:^[ \t]*>|[ \t]>[ \t])/m,
  // Waves' own signature block (the office phone line), so a staff reply's
  // own boilerplate never rides along as part of a captured promise's quote.
  /\*?\s*Office:\s*\(941\)/i,
  // RFC 3676 signature delimiter — a line that is exactly "--".
  /^[ \t]*--[ \t]*$/m,
];
// Mobile client sign-off — removed outright (not a cut point: it is
// typically the very last line already, so slicing before it and removing
// it read the same either way, but this stays a removal for a signature
// that appears mid-body on some clients).
const SENT_FROM = /^[ \t]*Sent from my (?:iPhone|iPad|Android|Galaxy|Samsung|Waves).*$/im;

function stripQuotedAndSignature(bodyText) {
  const decoded = decodeEntities(bodyText).replace(/\r\n/g, '\n');
  const indices = CUT_PATTERNS.map((re) => {
    const m = re.exec(decoded);
    return m ? m.index : null;
  }).filter((i) => i != null);
  let text = decoded;
  // A marker at the very start cuts too: a body that OPENS with quoted
  // history or a forwarded header has no new text of its own, and keeping
  // the history would let an old ask or promise be recorded with THIS
  // email's timestamp (pre-push audit, 2026-09-30). An empty result means
  // no obligations — the under-stripping posture above.
  if (indices.length) text = decoded.slice(0, Math.min(...indices));
  // A trailing run of '>'-quoted lines the cut above did not reach (a
  // bottom-poster's own new text always precedes these).
  const lines = text.split('\n');
  while (lines.length && /^[ \t]*>/.test(lines[lines.length - 1])) lines.pop();
  text = lines.join('\n').replace(SENT_FROM, '');
  return text.trim();
}

// The text of an email row: body_text, or its HTML converted when
// body_text is empty. Portal sends (admin Email tab, Intelligence Bar) are
// text/html-only, so Gmail sync stores them in body_html with body_text
// empty. Same conversion email-reply-context.js uses (quoted blocks
// dropped). Required lazily: newsletter-proof loads the send stack.
function emailPlainText(row) {
  const text = String(row?.body_text || '');
  if (text.trim()) return text;
  const html = String(row?.body_html || '');
  return html.trim() ? require('../newsletter-proof').htmlReplyToText(html) : '';
}

// A reply's subject counts as its own words only when it is new text: not
// the thread's subject again behind "Re:" (every reply carries
// that, so it would make an empty reply look like an answer). Returns the
// subject without its reply prefixes, or '' when it says nothing new.
// Reply and forward prefixes, English and the common localized clients'
// (German AW/WG, Spanish/Italian RE/RV/R/I, French TR, Dutch Antw/Doorst,
// Nordic SV/VS/VB/VL, Portuguese ENC).
const FORWARD_WORDS = String.raw`fwd?|wg|rv|tr|enc|doorst|vb|vl`;
const REPLY_PREFIX = new RegExp(String.raw`^\s*(?:re|aw|sv|vs|antw|${FORWARD_WORDS})\s*(?:\[\d+\])?\s*:\s*`, 'i');
function withoutReplyPrefixes(subject) {
  let text = decodeEntities(subject).trim();
  while (REPLY_PREFIX.test(text)) text = text.replace(REPLY_PREFIX, '');
  return text.replace(/\s+/g, ' ').trim();
}
// A forwarded subject is someone else's words, never the sender's: "Fwd:
// Please cancel service" asks nothing of its own.
const FORWARD_PREFIX = new RegExp(String.raw`^\s*(?:(?:re|aw|sv|vs|antw)\s*(?:\[\d+\])?\s*:\s*)*(?:${FORWARD_WORDS})\s*(?:\[\d+\])?\s*:`, 'i');
function ownReplySubject(subject, threadSubjects = []) {
  if (FORWARD_PREFIX.test(decodeEntities(subject))) return '';
  const own = withoutReplyPrefixes(subject);
  if (!own) return '';
  const seen = new Set(threadSubjects.map((s) => withoutReplyPrefixes(s).toLowerCase()));
  return seen.has(own.toLowerCase()) ? '' : own;
}
// The same rule against the stored thread, for many emails in one read.
// Only messages sent BEFORE each one count: a later reply repeats its
// subject behind "Re:", and would otherwise blank the subject of the very
// email that first wrote it. Returns Map(email id -> own subject or '').
const THREAD_SUBJECT_ROWS = 50;
async function ownSubjectsInThreads(conn, rows) {
  const own = new Map();
  const threadIds = [...new Set(rows.filter((r) => String(r?.subject || '').trim() && r.gmail_thread_id && r.received_at)
    .map((r) => r.gmail_thread_id))];
  // Each thread's oldest messages first, capped per thread, so the subject a
  // thread started with is always read and no long thread starves another.
  const stored = threadIds.length ? await conn.select('id', 'gmail_thread_id', 'subject', 'received_at')
    .from(conn('emails').whereIn('gmail_thread_id', threadIds).whereNotNull('subject')
      .select('id', 'gmail_thread_id', 'subject', 'received_at',
        conn.raw('row_number() over (partition by gmail_thread_id order by received_at, id) as thread_seq'))
      .as('thread_subjects'))
    .where('thread_seq', '<=', THREAD_SUBJECT_ROWS) : [];
  const at = (r) => new Date(r.received_at).getTime();
  for (const row of rows) {
    if (!String(row?.subject || '').trim()) { own.set(row?.id, ''); continue; }
    const earlier = row.gmail_thread_id && row.received_at ? stored.filter((o) => o.gmail_thread_id === row.gmail_thread_id
      && String(o.id) !== String(row.id)
      && (at(o) < at(row) || (at(o) === at(row) && String(o.id) < String(row.id)))).map((o) => o.subject) : [];
    own.set(row.id, ownReplySubject(row.subject, earlier));
  }
  return own;
}

module.exports = { stripQuotedAndSignature, decodeEntities, emailPlainText, ownReplySubject, ownSubjectsInThreads };
