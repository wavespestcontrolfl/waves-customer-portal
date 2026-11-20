/**
 * The job-offer link (/careers/offer/<64-hex token>) is the applicant's signing credential: whoever holds it can read the
 * offer and sign, decline or ask for another date as the applicant (GATE_JOB_OFFERS). The provider gets the full body,
 * but every STORED copy of an offer text or email (sms_log, the unified messages rows, the messaging audit preview, the
 * email ledger, the deferred queue row, comms_history) keeps the path with the token hidden, so no staff reader, shared
 * inbox, scheduled-message list or tool can show it. Applied at each write point; a body with no offer link is returned
 * unchanged, so no other message is affected. A deferred text is rebuilt with the real links from the job_offers rows
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
 *   percent-encoding undone (repeated, for double encoding), full-width forms folded, invisible characters dropped,
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
 * An /careers/interview/ link is not on that path and is left alone. Out of reach: a token mixed with characters a
 * reader sees (a dash every few letters), or split by text the email hides by style; a person has to edit such a text,
 * or craft it, to use the token.
 */

const { decodeHTML } = require('entities');
const { portalUrl } = require('./portal-url');

const HIDDEN = '[link hidden]';
const SENT_LINK_RE = /(\/careers\/offer\/)([0-9a-fA-F]{64})/g;
const TOKEN_SEGMENT_RE = /^([0-9a-f]{64})(?![0-9a-f])/;
// The route word, also after punctuation that opens the unit ("(careers", url=careers); a host such as x.careers is not.
const CAREERS_SEGMENT_RE = /(?:^|[^a-z0-9.-])careers$/;
const UNIT_RE = /=\s*(?:"[^"]*"|'[^']*')|(?:(?!=\s*["'])[^\s<>])+/g;
// An HTML tag or comment: the units inside it (its name and attributes) are not text a reader sees.
const TAG_RE = /<!--[\s\S]*?-->|<[!/?]?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi;

function percentDecode(seq) {
  try {
    return decodeURIComponent(seq);
  } catch {
    return seq.replace(/%([0-9a-f]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

const decodeOnce = (text) => decodeHTML(text).replace(/(?:%[0-9a-f]{2})+/gi, percentDecode);
const DECODE_PASSES = 4;

// The unit as a browser or a reader resolves it. Decoding repeats, so a double-encoded spelling resolves too, up to
// DECODE_PASSES. `undecided`: the reading would still decode further, so it may hide a route word (see scan).
function reading(unit) {
  let out = unit;
  for (let pass = 0; pass < DECODE_PASSES; pass += 1) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  const seen = out.normalize('NFKC').replace(/[\t\n\r]|\p{Cf}/gu, '').replace(/\\/g, '/').toLowerCase();
  return { seen, undecided: decodeOnce(seen) !== seen };
}
const readable = (unit) => reading(unit).seen;

// A reading as a reader sees it run together: every character with no mark of its own dropped (white space, raw or
// decoded from a character reference, controls, format and other default-ignorable characters, the blank braille
// pattern).
const compact = (seen) => seen.replace(/[\s\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu, '');

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
  const at = (token) => {
    const i = seen.indexOf(token);
    return i === -1 ? seen.length : i;
  };
  return [...found].sort((a, b) => at(a) - at(b));
}

// The units of `text` in order: each with where it starts, its reader's text, whether that reading is undecided, and
// whether it sits inside a tag.
function unitsOf(text) {
  const tags = [...text.matchAll(TAG_RE)].map((m) => [m.index, m.index + m[0].length]);
  let t = 0;
  return [...text.matchAll(UNIT_RE)].map((m) => {
    while (t < tags.length && tags[t][1] <= m.index) t += 1;
    const { seen, undecided } = reading(m[0]);
    return { text: m[0], at: m.index, seen, flat: compact(seen), undecided, inTag: t < tags.length && tags[t][0] <= m.index };
  });
}

// The units' compact reader text run together, with nothing between them, so a link or a token split by markup or by
// anything invisible reads as one: once with every unit (plain text), once with the units outside tags only (an email
// as it shows). Each view keeps where each unit's text starts and ends in it.
function joinedViews(units) {
  return [units, units.filter((u) => !u.inTag)].map((list) => {
    let text = '';
    const spans = list.map((u) => {
      const start = text.length;
      text += u.flat;
      return { u, start, end: text.length };
    });
    return { text, spans };
  });
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

// Each found token split over several units of a view: the first of those units is marked 'first', the rest 'rest'.
// A token whole inside one unit is left to that unit's own reading.
function splitMarks(views, linked) {
  const marks = new Map();
  for (const { text, spans } of views) {
    for (const token of linked) {
      for (let at = text.indexOf(token); at !== -1; at = text.indexOf(token, at + 1)) {
        const parts = overlapping(spans, at, at + token.length);
        if (parts.length < 2) continue;
        parts.forEach(({ u }, k) => {
          if (k === 0) marks.set(u.at, 'first');
          else if (!marks.has(u.at)) marks.set(u.at, 'rest');
        });
      }
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
    const seen = kept === u.text ? u.seen : readable(kept);
    const flat = kept === u.text ? u.flat : compact(seen);
    if (!offerTokensOf(kept, seen).length && ![...linked].some((token) => flat.includes(token))) {
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

// First the tokens on an offer path anywhere in the text, unit by unit and in the joined views. Then one pass, unit by
// unit, so each hidden link and its token keep the same order for redaction and for pinning.
function scan(text) {
  const units = unitsOf(text);
  const views = joinedViews(units);
  const linked = new Set();
  for (const u of units) {
    for (const match of u.text.matchAll(SENT_LINK_RE)) linked.add(match[2].toLowerCase());
    for (const token of offerTokensOf(u.text, u.seen)) linked.add(token);
  }
  for (const view of views) for (const token of joinedTokens(view)) linked.add(token);
  // A unit still encoded past the decoding budget may hide a route word, so such a text fails closed: that unit is
  // hidden whole, and every run of 64 hex in the text counts as a found token, so each unit holding one is hidden too.
  const undecided = units.some((u) => u.undecided);
  if (undecided) for (const view of views) for (const m of view.text.matchAll(/[0-9a-f]{64}/g)) linked.add(m[0]);
  if (!linked.size && !undecided) return { redacted: text, tokens: [] };
  const marks = splitMarks(views, linked);
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

module.exports = { redactOfferLinks, offerLinkTokens, OFFER_LINK_HIDDEN: HIDDEN };
