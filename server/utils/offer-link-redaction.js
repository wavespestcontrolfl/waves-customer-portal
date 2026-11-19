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
 * - Any other spelling a browser or a reader can turn back into the link. A browser decodes HTML character
 *   references (named ones too), removes dot segments, reads backslashes as slashes and drops tabs and line breaks; a
 *   reader can also undo percent-encoding, letter case, repeated slashes, full-width forms and invisible characters.
 *   A unit whose path, read that way, holds /careers/offer/<64-hex token> is replaced as a whole by the standard link
 *   with the token hidden, once for each such token in the order they appear, so the replay can rebuild each one as
 *   the link the page opens. Only tokens on that path are pinned: another 64-hex value (a query value) is not a link.
 * An /careers/interview/ link is not on that path and is left alone. Out of reach of any pattern: a token a person has to
 * put back together from pieces (split by spaces, or by a line break in plain text); no browser opens that as a link.
 */

const { decodeHTML } = require('entities');
const { portalUrl } = require('./portal-url');

const HIDDEN = '[link hidden]';
const SENT_LINK_RE = /(\/careers\/offer\/)([0-9a-fA-F]{64})/g;
const OFFER_PATH_TOKEN_RE = /\/careers\/offer\/([0-9a-f]{64})(?![0-9a-f])/g;
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

// The offer tokens on a read unit's path, with its dot segments removed and repeated slashes read as one.
function offerTokensIn(seen) {
  let path = seen.replace(/\/{2,}/g, '/');
  for (let before = ''; before !== path;) {
    before = path;
    path = path.replace(/\/\.(?=\/|$)/g, '').replace(/\/(?!\.\.(?:\/|$))[^/]+\/\.\.(?=\/|$)/g, '');
  }
  return Array.from(path.matchAll(OFFER_PATH_TOKEN_RE), (m) => m[1]);
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
    if (!offerTokensIn(readable(kept)).length) {
      tokens.push(...sent);
      return kept;
    }
    const found = offerTokensIn(readable(unit));
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
