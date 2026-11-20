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
 * tabs and line breaks inside the URL it holds), or an unbroken run of text elsewhere. Two kinds of spelling are hidden:
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
 * An /careers/interview/ link is not on that path and is left alone. Out of reach of any pattern: a token a person has to
 * put back together from pieces (split by spaces, or by a line break in plain text); no browser opens that as a link.
 */

const { decodeHTML } = require('entities');
const { portalUrl } = require('./portal-url');

const HIDDEN = '[link hidden]';
const SENT_LINK_RE = /(\/careers\/offer\/)([0-9a-fA-F]{64})/g;
const TOKEN_SEGMENT_RE = /^([0-9a-f]{64})(?![0-9a-f])/;
// The route word, also after punctuation that opens the unit ("(careers", url=careers); a host such as x.careers is not.
const CAREERS_SEGMENT_RE = /(?:^|[^a-z0-9.-])careers$/;
const UNIT_RE = /=\s*(?:"[^"]*"|'[^']*')|(?:(?!=\s*["'])\S)+/g;

function percentDecode(seq) {
  try {
    return decodeURIComponent(seq);
  } catch {
    return seq.replace(/%([0-9a-f]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

// The unit as a browser or a reader resolves it. Decoding repeats, so a double-encoded spelling resolves too.
function readable(unit) {
  let out = unit;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = decodeHTML(out).replace(/(?:%[0-9a-f]{2})+/gi, percentDecode);
    if (next === out) break;
    out = next;
  }
  return out.normalize('NFKC').replace(/[\t\n\r]|\p{Cf}/gu, '').replace(/\\/g, '/').toLowerCase();
}

// Walks path segments as a browser resolves them: a "." segment is skipped, ".." drops the segment before it (an empty
// one too), and an empty segment is kept. A segment that opens with a 64-hex token right after "careers" and "offer"
// holds a token; empty segments between those are passed over, as a reader reads "//" as "/". Each stack entry keeps
// the last two named segments at its depth, so the walk stays linear.
function pathTokens(segments, { single, double, name }) {
  const tokens = [];
  const stack = [];
  for (const raw of segments) {
    if (double(raw)) stack.pop();
    else if (!single(raw)) {
      const segment = name(raw);
      const [last, before] = stack.at(-1) || ['', ''];
      const token = last === 'offer' && CAREERS_SEGMENT_RE.test(before) && TOKEN_SEGMENT_RE.exec(segment);
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

// The path segments a browser opens from `text`: tabs and line breaks dropped, backslashes read as slashes, cut at the
// first "?" or "#".
function browserSegments(text) {
  const view = text.replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
  const end = view.search(/[?#]/);
  return (end === -1 ? view : view.slice(0, end)).split('/');
}

// The offer tokens a unit holds in any reading, each once, in the order they appear in the reader's text.
function offerTokensOf(unit) {
  const seen = readable(unit);
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

// One pass, unit by unit, so each hidden link and its token keep the same order for redaction and for pinning.
function scan(text) {
  const tokens = [];
  const redacted = text.replace(UNIT_RE, (unit) => {
    const sent = [];
    const kept = unit.replace(SENT_LINK_RE, (m, path, token) => {
      sent.push(token.toLowerCase());
      return `${path}${HIDDEN}`;
    });
    if (!offerTokensOf(kept).length) {
      tokens.push(...sent);
      return kept;
    }
    const found = offerTokensOf(unit);
    tokens.push(...found);
    const links = found.map(() => portalUrl(`/careers/offer/${HIDDEN}`)).join(' ');
    const quoted = /^=\s*(["'])/.exec(unit);
    return quoted ? `${quoted[0]}${links}${quoted[1]}` : links;
  });
  return { redacted, tokens };
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
