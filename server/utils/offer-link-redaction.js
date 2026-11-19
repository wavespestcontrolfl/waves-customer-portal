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
 * Two kinds of spelling are hidden:
 * - The link as it is sent (/careers/offer/<token>): only the token is hidden, so the host and the words around it stay.
 * - Any other spelling a browser or a reader can turn back into the link. A browser removes dot segments and reads
 *   backslashes as slashes; a reader can undo percent-encoding, HTML character references, letter case, full-width
 *   forms and invisible characters. Each unbroken run of text is read that way. A run that then names both "careers"
 *   and "offer" and holds a 64-hex token is replaced as a whole by the standard link with the token hidden, once for
 *   each token, so the replay can rebuild every one as the link the page opens.
 * An /careers/interview/ link has no "offer" and is left alone. Out of reach of any pattern: a token a person has to put
 * back together from pieces (split by spaces, line breaks or other characters); it is not a link and is not covered.
 */

const { portalUrl } = require('./portal-url');

const HIDDEN = '[link hidden]';
const SENT_LINK_RE = /(\/careers\/offer\/)([0-9a-fA-F]{64})/g;
const TOKEN_RE = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;
const UNBROKEN_RUN_RE = /\S+/g;

const charOf = (code, raw) => (code <= 0x10ffff ? String.fromCodePoint(code) : raw);
function percentDecode(seq) {
  try {
    return decodeURIComponent(seq);
  } catch {
    return seq.replace(/%([0-9a-f]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

// The run as a browser or a reader resolves it. Decoding repeats, so a double-encoded spelling resolves too.
function readable(run) {
  let out = run;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out
      .replace(/&#x([0-9a-f]{1,6});?|&#(\d{1,7});?/gi, (m, hex, dec) => charOf(hex ? parseInt(hex, 16) : Number(dec), m))
      .replace(/&amp;/gi, '&')
      .replace(/(?:%[0-9a-f]{2})+/gi, percentDecode);
    if (next === out) break;
    out = next;
  }
  return out.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/\\/g, '/').toLowerCase();
}

// One pass, run by run, so each hidden link and its token keep the same order for redaction and for pinning.
function scan(text) {
  const tokens = [];
  const redacted = text.replace(UNBROKEN_RUN_RE, (run) => {
    const sent = [];
    const kept = run.replace(SENT_LINK_RE, (m, path, token) => {
      sent.push(token.toLowerCase());
      return `${path}${HIDDEN}`;
    });
    const seen = readable(kept);
    const other = seen.includes('careers') && seen.includes('offer') ? seen.match(TOKEN_RE) || [] : [];
    const found = [...sent, ...other];
    tokens.push(...found);
    return other.length ? found.map(() => portalUrl(`/careers/offer/${HIDDEN}`)).join(' ') : kept;
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
