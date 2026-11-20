/**
 * The job-offer link (/careers/offer/<64-hex token>) is the applicant's signing credential: whoever holds it can read the
 * offer and sign, decline or ask for another date as the applicant (GATE_JOB_OFFERS). The provider gets the full body,
 * but every STORED copy of an offer text or email (sms_log, the unified messages rows, the messaging audit preview, the
 * email ledger, the deferred queue row, comms_history) keeps the path with the token hidden, so no staff reader, shared
 * inbox, scheduled-message list or tool can show it. Applied at each write point; a body with no offer link is returned
 * unchanged (unless it is still encoded past the decoding budget, below), so no other message is affected. A deferred text is rebuilt with the real links from the job_offers rows
 * at replay time (messaging/deferred-replay-registry.js replayBodyFor): the offer text by its pinned offer, any other
 * held text (an owner reply that pastes a link) by the offers its links were pinned to when it was queued.
 *
 * The text is read in units, each what a browser takes as one link: a quoted HTML attribute value (a browser drops
 * tabs and line breaks inside the URL it holds), or an unbroken run of text elsewhere, which ends at a tag, so the
 * markup around a hidden link stays. Two kinds of spelling are hidden:
 * - The link as it is sent (/careers/offer/<token>): only the token is hidden, so the host and the words around it stay.
 * - Any other spelling a browser or a reader can turn back into the link. Each unit is read three ways. Twice as a
 *   browser reads it, as typed and with its HTML character references decoded once: tabs and line breaks dropped,
 *   backslashes read as slashes, the path ending at the first "?" or "#", "." and ".." segments resolved (also written
 *   with %2e; an empty segment counts, as in a browser), any other percent-encoding kept, and each segment decoded and
 *   lowercased only to compare it, as the page router does. Once as a reader can: character references and
 *   percent-encoding undone (repeated up to four times, for double encoding), full-width forms folded, invisible characters dropped,
 *   lowercase, and each part between a "?" and a "#" read as a path. A unit in which any reading holds
 *   /careers/offer/<64-hex token> (a repeated slash read as one) is replaced as a whole by the standard link with the
 *   token hidden, once for each such token in the order they appear, so the replay can rebuild each one as the link
 *   the page opens. Only those tokens are pinned: another 64-hex value (a query value) is not a link.
 * - Any other copy of a token found on an offer path anywhere in the text: the token is the credential wherever it
 *   appears. A unit whose reader's text still holds one after the steps above (a copy in the link's own query or
 *   fragment, or anywhere else) is replaced as a whole: by the standard hidden link for each offer-path token it holds,
 *   or by the bare marker when it holds none. The bare marker is not a link, so the replay leaves it as it is.
 * - A link or a copy split by anything a reader does not see. A reader sees a shown or copied link run together:
 *   markup, white space (raw or written as a character reference such as &nbsp;), controls and other invisible
 *   characters drop out (a <wbr> or a <span> inside it, a quoted reply that wraps it). So for copies each unit's reader
 *   text is read with all of those dropped, and the units are also read joined, with nothing between them: once with
 *   every unit, as plain text shows it, and once with the units outside tags only, as an email shows it. There
 *   "careers" may end a longer word, and the token is the 64 hex after "offer/" whatever follows. A token on an offer
 *   path there counts as found. A unit that holds a found token whole in that reading is replaced as above; a found
 *   token split over several units is hidden in all of them: the bare marker in the first (or the standard hidden link
 *   for an offer-path token that unit holds whole, as above) and nothing in the rest. Tags and spaces between units
 *   stay, so the bare marker never forms the hidden link the replay rebuilds.
 * - A copy is looked for at every stage of decoding, not only at its end: as typed, and after the character references
 *   and the percent escapes of each pass. A step can use up part of a token (a "%" or "&#" before some of its hex
 *   digits), while the stored text still shows it whole.
 * - A unit still encoded after four decoding passes (it may hide a route word or a token): the text fails closed. That
 *   unit is replaced as a whole by the bare marker, and so is every unit that a run of 64 or more hex touches in the
 *   joined reading, split as above.
 * - Texts stored together as one record (an email's subject, html and text: redactOfferLinksTogether): the tokens
 *   found on an offer path in any of them, and a unit past the decoding budget in any of them, count for all of them,
 *   so a copy of a token in the subject is hidden when its link is only in the body.
 * An /careers/interview/ link is not on that path and is left alone. Out of reach: a token mixed with characters a
 * reader sees (a dash every few letters), or split by text the email hides by style; a person has to edit such a text,
 * or craft it, to use the token. A bare 64-hex word in a message that holds no link to it in any part is not known to
 * be a token, so it stays.
 */

const { decodeHTML } = require('entities');
const { portalUrl } = require('./portal-url');

const HIDDEN = '[link hidden]';
const SENT_LINK_RE = /(\/careers\/offer\/)([0-9a-fA-F]{64})/g;
const TOKEN_SEGMENT_RE = /^([0-9a-f]{64})(?![0-9a-f])/;
// The route word, also after punctuation that opens the unit ("(careers", url=careers); a host such as x.careers is not.
const CAREERS_SEGMENT_RE = /(?:^|[^a-z0-9.-])careers$/;
const UNIT_RE = /=\s*(?:"[^"]*"|'[^']*')|(?:(?!=\s*["'])[^\s<>])+/g;
// An HTML tag or comment: the units inside it (its name and attributes) are not text a reader sees. A comment runs from
// "<!--" to the first "-->"; a tag from "<" before a letter (after an optional "!", "/" or "?") to the first ">" outside
// a quoted value, and a quote that never closes means no tag. Anything else is text.
const TAG_START_RE = /<[!/?]?[a-z]/iy;

// The [start, end) spans of the tags and comments in `text`, in one linear pass, so a body of unfinished tag starts
// cannot make the scan rescan the rest of the text from each one. close[p] is where a tag body read from p ends (the
// index of its ">"), quoted values skipped, or -1 when it never ends; it is filled from the end of the text back.
function tagSpans(text) {
  const n = text.length;
  const close = new Int32Array(n + 1).fill(-1);
  let nextDouble = -1;
  let nextSingle = -1;
  for (let p = n - 1; p >= 0; p -= 1) {
    const c = text[p];
    if (c === '>') close[p] = p;
    else if (c === '"') [close[p], nextDouble] = [nextDouble === -1 ? -1 : close[nextDouble + 1], p];
    else if (c === "'") [close[p], nextSingle] = [nextSingle === -1 ? -1 : close[nextSingle + 1], p];
    else close[p] = close[p + 1];
  }
  const spans = [];
  let commentsClose = true; // false once a "<!--" has no "-->" after it: none after it can have one either
  for (let i = text.indexOf('<'); i !== -1;) {
    let end = -1;
    if (commentsClose && text.startsWith('<!--', i)) {
      const at = text.indexOf('-->', i + 4);
      if (at === -1) commentsClose = false;
      else end = at + 3;
    }
    TAG_START_RE.lastIndex = i;
    if (end === -1 && TAG_START_RE.test(text) && close[i + 1] !== -1) end = close[i + 1] + 1;
    if (end === -1) i = text.indexOf('<', i + 1);
    else {
      spans.push([i, end]);
      i = text.indexOf('<', end);
    }
  }
  return spans;
}

function percentDecode(seq) {
  try {
    return decodeURIComponent(seq);
  } catch {
    return seq.replace(/%([0-9a-f]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

const decodeOnce = (text) => decodeHTML(text).replace(/(?:%[0-9a-f]{2})+/gi, percentDecode);
// Only a character reference (&) or a percent escape (%) decodes, so text with neither is read as it is.
const decodable = (text) => /[&%]/.test(text);
const DECODE_PASSES = 4;

// A reading as a reader sees it run together: every character with no mark of its own dropped (white space, raw or
// decoded from a character reference, controls, format and other default-ignorable characters, the blank braille
// pattern).
const compact = (seen) => seen.replace(/[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, '');
// Text as a reader reads it: full-width forms folded, tabs, line breaks and format characters dropped, backslashes as
// slashes, lowercase.
const seenOf = (text) => text.normalize('NFKC').replace(/[\t\n\r]|\p{Cf}/gu, '').replace(/\\/g, '/').toLowerCase();

// The unit as a browser or a reader resolves it. Decoding repeats, so a double-encoded spelling resolves too, up to
// DECODE_PASSES. `undecided`: the reading would still decode further, so it may hide a route word (see scan).
// `stages`: every text a person can read on the way, run together: as typed, then after the character references and
// after the percent escapes of each pass. A step can use up part of a token (a "%" before two of its hex digits), so
// a copy is looked for at every stage, not only in the last one.
function reading(unit) {
  const stages = [compact(seenOf(unit))];
  const add = (text) => {
    const flat = compact(seenOf(text));
    if (!stages.includes(flat)) stages.push(flat);
  };
  let out = unit;
  for (let pass = 0; pass < DECODE_PASSES && decodable(out); pass += 1) {
    const html = decodeHTML(out);
    add(html);
    const next = html.replace(/(?:%[0-9a-f]{2})+/gi, percentDecode);
    add(next);
    if (next === out) break;
    out = next;
  }
  const seen = seenOf(out);
  return { seen, stages, undecided: decodable(seen) && decodeOnce(seen) !== seen };
}
const readable = (unit) => reading(unit).seen;

// Walks path segments as a browser resolves them: a "." segment is skipped, ".." drops the segment before it (an empty
// one too), and an empty segment is kept. A segment that opens with a 64-hex token right after "careers" and "offer"
// holds a token; empty segments between those are passed over, as a reader reads "//" as "/". Each stack entry keeps
// the last two named segments at its depth, so the walk stays linear.
function pathTokens(segments, { single, double, name, careers = CAREERS_SEGMENT_RE, token: tokenRe = TOKEN_SEGMENT_RE }) {
  const tokens = [];
  const stack = [];
  for (const raw of segments) {
    if (double(raw)) stack.pop();
    else if (!single(raw)) {
      const segment = name(raw);
      const [last, before] = stack.at(-1) || ['', ''];
      const token = last === 'offer' && careers.test(before) && tokenRe.exec(segment);
      if (token) tokens.push(token[1]);
      stack.push(segment ? [segment, last] : [last, before]);
    }
  }
  return tokens;
}

// A browser: "." and ".." count also when written with %2e. Any other percent-encoding stays part of its segment (an
// encoded "?" or "/" is no delimiter); the segment is decoded and lowercased only to compare it.
const BROWSER = {
  single: (s) => /^(?:\.|%2e)$/i.test(s),
  double: (s) => /^(?:\.|%2e){2}$/i.test(s),
  name: (s) => percentDecode(s).toLowerCase(),
};
// A reader: the text is already decoded, so only plain dots count.
const READER = { single: (s) => s === '.', double: (s) => s === '..', name: (s) => s };
// A reader of the joined text (see joinedViews): words run together there, so "careers" may end a longer word (a host
// such as x.careers still does not count), and the token is the first 64 hex after "offer/" whatever follows.
const JOINED = { ...READER, careers: /(?:^|[^.-])careers$/, token: /^([0-9a-f]{64})/ };

// The path segments a browser opens from `text`: tabs and line breaks dropped, backslashes read as slashes, cut at the
// first "?" or "#".
function browserSegments(text) {
  const view = text.replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
  const end = view.search(/[?#]/);
  return (end === -1 ? view : view.slice(0, end)).split('/');
}

// The offer tokens a unit holds in any reading, each once, in the order they appear in the reader's text.
function offerTokensOf(unit, seen = readable(unit)) {
  // Decoding and folding never remove the letters of "careers" or "offer", so a unit whose reader's text lacks either
  // holds no token in any reading.
  if (!seen.includes('careers') || !seen.includes('offer')) return [];
  const found = new Set([
    ...pathTokens(browserSegments(unit), BROWSER),
    ...pathTokens(browserSegments(decodeHTML(unit)), BROWSER),
    ...seen.split(/[?#]/).flatMap((part) => pathTokens(part.split('/'), READER)),
  ]);
  // Each token's first place in the reader's text, from one pass over its runs of hex (foundAt), not a search per
  // comparison: one unit may hold thousands of links.
  const first = new Map();
  for (const at of foundAt(seen, found)) {
    const token = seen.slice(at, at + 64);
    if (!first.has(token)) first.set(token, at);
  }
  const place = (token) => (first.has(token) ? first.get(token) : seen.length);
  return [...found].sort((a, b) => place(a) - place(b));
}

// The units of `text` in order: each with where it starts, its reader's text, whether that reading is undecided, and
// whether it sits inside a tag.
function unitsOf(text) {
  const tags = tagSpans(text);
  let t = 0;
  return [...text.matchAll(UNIT_RE)].map((m) => {
    while (t < tags.length && tags[t][1] <= m.index) t += 1;
    const { seen, stages, undecided } = reading(m[0]);
    return { text: m[0], at: m.index, seen, flat: compact(seen), stages, undecided, inTag: t < tags.length && tags[t][0] <= m.index };
  });
}

// The units' compact reader text run together, with nothing between them, so a link or a token split by markup or by
// anything invisible reads as one: once with every unit (plain text), once with the units outside tags only (an email
// as it shows). Each is read at the end of decoding and at each stage on the way (a unit past its last stage stays
// at it); a view the same as one before is read once. Each view keeps where each unit's text starts and ends in it.
function joinedViews(units) {
  const depth = units.reduce((most, u) => Math.max(most, u.stages.length), 1);
  const views = [];
  const seenTexts = new Set();
  for (const list of [units, units.filter((u) => !u.inTag)]) {
    for (let k = -1; k < depth; k += 1) {
      let text = '';
      const spans = list.map((u) => {
        const start = text.length;
        text += k < 0 ? u.flat : u.stages[Math.min(k, u.stages.length - 1)];
        return { u, start, end: text.length };
      });
      if (!seenTexts.has(text)) {
        seenTexts.add(text);
        views.push({ text, spans });
      }
    }
  }
  return views;
}

function joinedTokens({ text }) {
  if (!text.includes('careers') || !text.includes('offer')) return [];
  return text.split(/[?#]/).flatMap((part) => pathTokens(part.split('/'), JOINED));
}

// The spans of a view that the text from `from` to `to` overlaps (spans are in order and touch end to start).
function overlapping(spans, from, to) {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (spans[mid].end <= from) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let k = lo; k < spans.length && spans[k].start < to; k += 1) out.push(spans[k]);
  return out;
}

// Where a found token occurs in `text` (lowercase, as every reading is). A token is 64 hex, so only the runs of 64 or
// more hex are read, and each 64-hex window of a run is looked up in the set once: one pass over the text, however many
// tokens were found.
function* foundAt(text, linked) {
  for (const run of text.matchAll(/[0-9a-f]{64,}/g)) {
    for (let k = 0; k + 64 <= run[0].length; k += 1) {
      if (linked.has(run[0].slice(k, k + 64))) yield run.index + k;
    }
  }
}
const holdsFound = (text, linked) => !foundAt(text, linked).next().done;

// The units a piece of a view covers: the first is marked 'first', the rest 'rest'.
function markParts(marks, parts) {
  parts.forEach(({ u }, k) => {
    if (k === 0) marks.set(u.at, 'first');
    else if (!marks.has(u.at)) marks.set(u.at, 'rest');
  });
}

// Each found token split over several units of a view is marked. A token whole inside one unit is left to that unit's
// own reading.
function splitMarks(views, linked) {
  const marks = new Map();
  for (const { text, spans } of views) {
    for (const at of foundAt(text, linked)) {
      const parts = overlapping(spans, at, at + 64);
      if (parts.length > 1) markParts(marks, parts);
    }
  }
  return marks;
}

// One unit as stored. Unmarked and decided: the link as sent keeps its host with the token hidden, and a unit with no
// other offer link and no copy of a found token stays. Otherwise the unit is replaced as a whole: by the standard
// hidden link for each offer-path token it holds (pinned in order), else by the bare marker, or by nothing for the
// later parts of a split token.
function storedUnit(u, mark, linked, tokens) {
  if (!mark && !u.undecided) {
    const sent = [];
    const kept = u.text.replace(SENT_LINK_RE, (m, path, token) => {
      sent.push(token.toLowerCase());
      return `${path}${HIDDEN}`;
    });
    const { seen, stages } = kept === u.text ? u : reading(kept);
    if (!offerTokensOf(kept, seen).length && !stages.some((flat) => holdsFound(flat, linked))) {
      tokens.push(...sent);
      return kept;
    }
  }
  const found = offerTokensOf(u.text, u.seen);
  tokens.push(...found);
  let hidden = mark === 'rest' ? '' : HIDDEN;
  if (found.length) hidden = found.map(() => portalUrl(`/careers/offer/${HIDDEN}`)).join(' ');
  const quoted = /^=\s*(["'])/.exec(u.text);
  return quoted ? `${quoted[0]}${hidden}${quoted[1]}` : hidden;
}

// What a text holds that makes copies hidden: the tokens on an offer path anywhere in it, unit by unit and in the
// joined views, and whether any unit is past the decoding budget.
function findingsOf(units, views) {
  const linked = new Set();
  for (const u of units) {
    for (const match of u.text.matchAll(SENT_LINK_RE)) linked.add(match[2].toLowerCase());
    for (const token of offerTokensOf(u.text, u.seen)) linked.add(token);
  }
  for (const view of views) for (const token of joinedTokens(view)) linked.add(token);
  return { linked, undecided: units.some((u) => u.undecided) };
}

const NO_FINDINGS = { linked: new Set(), undecided: false };

// First the findings: the text's own and, for a text stored with others (`shared`), theirs. Then one pass, unit by
// unit, so each hidden link and its token keep the same order for redaction and for pinning.
function scan(text, shared = NO_FINDINGS) {
  const units = unitsOf(text);
  const views = joinedViews(units);
  const own = findingsOf(units, views);
  const linked = new Set([...own.linked, ...shared.linked]);
  const undecided = own.undecided || shared.undecided;
  if (!linked.size && !undecided) return { redacted: text, tokens: [] };
  const marks = splitMarks(views, linked);
  // A unit still encoded past the decoding budget may hide a route word, so such a text fails closed: that unit is
  // hidden whole (storedUnit), and so is every unit that a run of 64 or more hex touches in either view.
  if (undecided) {
    for (const { text: joined, spans } of views) {
      for (const m of joined.matchAll(/[0-9a-f]{64,}/g)) markParts(marks, overlapping(spans, m.index, m.index + m[0].length));
    }
  }
  const tokens = [];
  let redacted = '';
  let last = 0;
  for (const u of units) {
    redacted += text.slice(last, u.at) + storedUnit(u, marks.get(u.at), linked, tokens);
    last = u.at + u.text.length;
  }
  return { redacted: redacted + text.slice(last), tokens };
}

function redactOfferLinks(text) {
  if (typeof text !== 'string' || !text) return text;
  return scan(text).redacted;
}

// The link tokens in `text`, in the order redactOfferLinks hides them (lowercase hex, as job_offers.token stores them).
function offerLinkTokens(text) {
  if (typeof text !== 'string' || !text) return [];
  return scan(text).tokens;
}

// Texts stored together as one record, each redacted with the findings of all of them (see the header): an email's
// subject, html and text, so a copy of a token in one part is hidden when its link is in another. Returns the texts in
// the same order; a part that is not a non-empty string comes back as it is.
function redactOfferLinksTogether(texts) {
  const parts = texts.map((t) => (typeof t === 'string' && t ? t : null));
  const shared = { linked: new Set(), undecided: false };
  for (const part of parts) {
    if (part === null) continue;
    const units = unitsOf(part);
    const found = findingsOf(units, joinedViews(units));
    for (const token of found.linked) shared.linked.add(token);
    shared.undecided = shared.undecided || found.undecided;
  }
  return texts.map((t, i) => (parts[i] === null ? t : scan(parts[i], shared).redacted));
}

module.exports = { redactOfferLinks, redactOfferLinksTogether, offerLinkTokens, OFFER_LINK_HIDDEN: HIDDEN };
