/**
 * Newsletter validation gate — pre-send checks for the content engine.
 */

const { getNewsletterType, isFlagshipType, requiresClaimValidation } = require('../config/newsletter-types');
const { validateVoice } = require('../config/voice-profiles');
const { containsAffiliateMaterial } = require('./content/content-guardrails');
const { findUnverifiedClaims } = require('./email-division/fact-register');

// Phrases the flagship draft is NOT allowed to make up. The events_raw
// table doesn't store admission, and the newsletter is an events guide
// (not a service pitch), so any pricing or pest-control efficacy claim
// in AI-generated commentary is a hallucination. These match against
// the rendered body text and hard-block the send.
const HALLUCINATED_CLAIM_PATTERNS = [
  // Pricing / admission language — admission isn't in our DB, so the
  // model can't substantiate any specific cost claim.
  { pattern: /\$\s?\d/, label: 'dollar amount in body' },
  { pattern: /\bfree\s+(?:admission|entry|event|tickets?|to\s+attend|to\s+enter|for\s+kids?|for\s+children)\b/i, label: '"free" admission claim' },
  // Inverted phrasing — "admission is free", "tickets are free", "entry is free", "the event is free".
  { pattern: /\b(?:admission|entry|tickets?|the\s+event|this\s+event|the\s+show|parking)\s+(?:is|are|'?s)\s+free\b/i, label: 'inverted free claim' },
  { pattern: /\b(?:no\s+cost|no\s+charge|complimentary|free\s+of\s+charge)\b/i, label: 'admission/no-cost claim' },
  { pattern: /\b(?:tickets?\s+(?:are|cost|start|begin)\s+(?:at\s+)?\$?\d)/i, label: 'ticket pricing claim' },
  // Pest-control efficacy / safety guarantees — legal/EPA risk in any
  // customer-facing AI copy, even in an events newsletter.
  { pattern: /\b(?:guaranteed|100\s*%)\s+(?:safe|effective|results?|kill|elimination)\b/i, label: 'efficacy guarantee' },
  { pattern: /\bpet[-\s]safe\b/i, label: '"pet-safe" claim' },
  { pattern: /\bchild[-\s]safe\b/i, label: '"child-safe" claim' },
  { pattern: /\bsafe\s+for\s+(?:pets?|dogs?|cats?|kids?|children)\b/i, label: 'absolute people/pet safety claim' },
  { pattern: /\b(?:non[-\s]?toxic|chemical[-\s]?free|harmless|no\s+risk|pesticide[-\s]?free)\b/i, label: 'absolute treatment safety claim' },
  { pattern: /\b(?:eliminat(?:e[sd]?|ing|ion)|eradicat(?:e[sd]?|ing|ion)|pest[-\s]?free|permanent\s+solution|one[-\s]?time\s+fix)\b/i, label: 'absolute efficacy claim' },
  { pattern: /\b(?:re[-\s]?entry|return(?:ing)?\s+(?:inside|indoors?|home))\b.{0,30}\b(?:\d+\s*(?:minutes?|mins?|hours?|hrs?)|safe)\b/i, label: 'fixed/safe re-entry claim' },
  { pattern: /\bEPA[-\s]approved\b/i, label: '"EPA-approved" claim' },
];

// Decode the HTML entities a claim could hide behind so they can't slip
// past the regexes — e.g. "Tickets are &#36;15" or "admission&nbsp;is&nbsp;free"
// render to customers as the literal claim. Mirrors decodeHtmlEntities in
// ai-property-lookup.js; numeric/named decoders run after &amp; so a
// double-encoded "&amp;#36;" collapses to "$" too.
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&dollar;/gi, '$')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/**
 * Scan customer-facing body copy (HTML and/or plain text) for
 * AI-hallucinated factual claims the draft pipeline can't substantiate
 * from the DB. Returns one error string per distinct claim type detected
 * (deduped on label so a draft mentioning "$10" three times doesn't
 * produce three error rows). HTML tags are stripped and entities decoded
 * before matching; plain text passes through unchanged.
 */
function findHallucinatedClaims(body, lockedPrices = [], mode = 'text') {
  if (!body) return [];
  const normPrice = (v) => decodeEntities(String(v || '')).normalize('NFKC').replace(/\s+/g, ' ').trim();
  // Entries are {eventId, price} pairs (lockedPricesForSend) or bare
  // strings (legacy/tests). Text excision uses the VALUES; the HTML span
  // exemption requires the event/price PAIR to match.
  const priceEntries = (Array.isArray(lockedPrices) ? lockedPrices : [])
    .map((e) => (typeof e === 'string' ? { eventId: null, price: e } : (e || {})))
    .filter((e) => typeof e.price === 'string' && e.price.trim());
  const lockedSet = new Set(priceEntries.map((e) => normPrice(e.price)).filter(Boolean));
  const priceByEvent = new Map(priceEntries
    .filter((e) => e.eventId)
    .map((e) => [String(e.eventId).toLowerCase(), normPrice(e.price)]));
  // NFKC folds Unicode look-alikes (fullwidth '＄', fullwidth digits, etc.)
  // down to their ASCII forms so a homoglyph "＄15" / "ｆｒｅｅ" can't render as
  // the claim to subscribers while slipping past the ASCII regexes.
  let bodyText = decodeEntities(String(body)
    // Structural exemption FIRST — and PAIR-verified: an assembler-
    // emitted price span carries its event id, and it vanishes only when
    // its decoded content matches THAT event's own locked price. A
    // hand-edited value ($25 → $250, or Event A wearing Event B's real
    // price) keeps the sentinel but loses the pair match, falls through
    // to the scan, and blocks. Spans without an id never exempt.
    .replace(/<span data-db-price="([^"]*)">([\s\S]*?)<\/span>/gi, (m, id, inner) => (
      priceByEvent.get(String(id).toLowerCase()) === normPrice(inner) ? ' ' : ` ${inner} `
    ))
    .replace(/<span data-db-price>([\s\S]*?)<\/span>/gi, (m, inner) => ` ${inner} `)
    .replace(/<[^>]+>/g, ' '))
    .normalize('NFKC')
    .replace(/\s+/g, ' ');
  // DB-locked prices in HTML are STRUCTURALLY identified: the assembler
  // wraps them in <span data-db-price>…</span>, a tag model prose can
  // never produce (markdownToHtml escapes HTML before markdown), so
  // stripping the span — done above, before tag-strip — exempts exactly
  // the renderer's own field and nothing else.
  //
  // The plain-text body has no markup, but the renderer's facts line is
  // immediately followed by that event's OWN {{evclick:<eventId>}} token
  // ("Tickets & info: …"), so the text exemption binds the event/price
  // pair too — mode 'text' only: "Tickets: <price>" excises ONLY when
  // the same event's evclick token follows within the renderer's
  // distance. Editing Event A's facts line to Event B's real price
  // leaves A's token adjacent, the pair mismatches, and it blocks.
  // Boundary-bound so a locked "$25" can't hollow an invented "$250";
  // model prose repeating a claim appears in the HTML segment too,
  // where no text excision exists. Entries WITHOUT an eventId (bare
  // strings — unit-test convenience; lockedPricesForSend always sets
  // ids) excise unbound.
  if (mode === 'text') {
    for (const entry of priceEntries) {
      const norm = normPrice(entry.price);
      if (!norm) continue;
      const esc = norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = entry.eventId
        ? new RegExp(`Tickets:\\s*${esc}(?![\\w])(?=[\\s\\S]{0,200}?\\{\\{evclick:${String(entry.eventId).toLowerCase()}\\}\\})`, 'gu')
        : new RegExp(`Tickets:\\s*${esc}(?![\\w])`, 'gu');
      bodyText = bodyText.replace(re, ' ');
    }
  }
  const seen = new Set();
  const errors = [];
  for (const { pattern, label } of HALLUCINATED_CLAIM_PATTERNS) {
    const match = bodyText.match(pattern);
    if (match && !seen.has(label)) {
      seen.add(label);
      const sample = (match[0] || '').trim().slice(0, 80);
      errors.push(`Hallucinated claim (${label}): "${sample}" — facts are locked from DB; AI cannot make this claim`);
    }
  }
  return errors;
}

/**
 * Email-division fact register: hard-block a small set of known-false or
 * overreaching claim shapes (e.g. a storm-triggered "second" termite swarm
 * — the September 2026 Pest Insider draft's actual error) that no fact in
 * the register supports. Scans the same segments as the
 * hallucinated-claim check, deduped by rule so one draft never reports the
 * same claim twice.
 */
// Inline tags render with no gap: "pet-<strong>safe</strong>" reads
// "pet-safe" to a subscriber, so the scan removes them without a space
// (codex round 10 P1). Block-level closers and <br> end a sentence; any
// other tag is a space.
const BLOCK_BREAK_TAG = /<\/(?:p|li|h[1-6]|div|tr|td|th|blockquote|section|article|ul|ol|table)\s*>|<br\s*\/?>/gi;
const INLINE_TAG = /<\/?(?:strong|em|b|i|u|s|span|a|mark|small|sup|sub|code|font|abbr|del|ins|q|cite|time|label)\b[^>]*>/gi;
// Markdown emphasis in text_body: "pet-**safe**", "sec*ond*", "_pet_-safe",
// "`safe`". An asterisk touching a letter or digit is emphasis even inside
// a word; an underscore is a marker only where it opens or closes a word,
// so snake_case identifiers and URL underscores are left alone.
const MARKDOWN_PAIR = /\*\*|__|~~|`/g;
const MARKDOWN_SINGLE = /(?<=[\p{L}\p{N}])\*+|\*+(?=[\p{L}\p{N}])|(?<![\p{L}\p{N}])_+(?=[\p{L}\p{N}])|(?<=[\p{L}\p{N}])_+(?![\p{L}\p{N}])/gu;

function claimScanText(body) {
  return decodeEntities(String(body)
    .replace(BLOCK_BREAK_TAG, '. ')
    .replace(INLINE_TAG, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:rsquo|lsquo|#8217|#8216);/gi, "'")
    .replace(/&(?:rdquo|ldquo|#8221|#8220);/gi, '"'))
    .normalize('NFKC')
    .replace(MARKDOWN_PAIR, '')
    .replace(MARKDOWN_SINGLE, '');
}

function scanUnverifiedClaims(send) {
  const errors = [];
  const seen = new Set();
  // subject_b is what variant-B recipients actually see, so it is scanned
  // like the subject.
  for (const body of [send.subject, send.subject_b, send.preview_text, send.html_body, send.text_body]) {
    if (!body) continue;
    // Block-level tags end a sentence (a heading glued to the paragraph
    // under it must not read as one sentence — the register's denial
    // windows are sentence- and clause-bound); inline tags vanish; every
    // other tag is a space. Then the same normalisation as the
    // hallucinated-claim scan: an entity-encoded or homoglyph "&#115;econd"
    // / "ｓecond swarm" / "don&rsquo;t" renders as the claim to subscribers
    // and must not slip past the rules; Markdown emphasis markers go too.
    const bodyText = claimScanText(body);
    // The Pest Insider is all treatment copy; the weekly events guide is
    // not, so its safety/re-entry rules apply only to sentences about a
    // treatment (codex round 15 P1) — the pest-fact rules apply in full.
    const treatmentContextOnly = send.newsletter_type !== 'pest-insider-monthly';
    for (const { rule, excerpt } of findUnverifiedClaims(bodyText, { treatmentContextOnly })) {
      if (seen.has(rule)) continue;
      seen.add(rule);
      errors.push(`Unverified claim (${rule}): "${excerpt}" — not supported by the email-division fact register (server/services/email-division/fact-register.js)`);
    }
  }
  return errors;
}

/**
 * Fetch the DB-locked price strings for a send's own lineup — the only
 * strings the claim scan may excise. Callers pass the result as
 * opts.lockedPrices; fail-open to [] (scan stays maximally strict).
 */
async function lockedPricesForSend(send, knex) {
  try {
    const ids = Array.isArray(send?.event_ids) ? send.event_ids : JSON.parse(send?.event_ids || '[]');
    if (!Array.isArray(ids) || !ids.length || !knex) return [];
    const rows = await knex('events_raw').whereIn('id', ids).select('id', 'price_text');
    return rows
      .filter((r) => typeof r.price_text === 'string' && r.price_text.trim())
      .map((r) => ({ eventId: String(r.id).toLowerCase(), price: r.price_text.trim() }));
  } catch {
    return [];
  }
}

function validateNewsletterDraft(send, opts = {}) {
  const errors = [];
  const warnings = [];

  if (!send.subject || !send.subject.trim()) errors.push('Subject line is required');
  if ((!send.html_body || !send.html_body.trim()) && (!send.text_body || !send.text_body.trim())) {
    errors.push('Body is required (HTML or plain text)');
  }
  if (opts.recipientCount === 0) errors.push('Segment matches 0 active subscribers');

  const typeConfig = getNewsletterType(send.newsletter_type);

  if (typeConfig?.voiceProfile) {
    const voiceResult = validateVoice(
      { subject: send.subject, htmlBody: send.html_body, textBody: send.text_body },
      typeConfig.voiceProfile,
    );
    warnings.push(...voiceResult.warnings);
  }

  if (send.subject && send.subject.length > 80) {
    warnings.push(`Subject line is ${send.subject.length} chars (recommended max 80)`);
  }
  if (!send.preview_text || !send.preview_text.trim()) {
    warnings.push('Preview text is empty');
  }

  if (isFlagshipType(send.newsletter_type)) {
    if (send.html_body) {
      const bodyText = send.html_body.replace(/<[^>]+>/g, ' ').toLowerCase();
      if (!['schedule service', 'book', 'call us', 'reply to this email', 'wavespestcontrol.com'].some((s) => bodyText.includes(s))) {
        warnings.push('No Waves CTA detected');
      }
      if (!send.html_body.includes('<h2') && !send.html_body.includes('<strong>')) {
        warnings.push('No event structure detected');
      }
    }
  }

  // Scan ALL customer-facing copy on every AI-generated type (flagship +
  // Pest Insider — `claimValidation` in newsletter-types.js), not just
  // the flagship. SendGrid delivers text_body to text-only clients, so a
  // clean HTML body with a hallucinated claim in the plain-text fallback
  // must still hard-block the send. Subject and preview text are scanned
  // too: they're the first copy a subscriber sees, and an unverifiable
  // "$500 prize" in the subject would otherwise sail through a body-only
  // gate. Manually-authored types (service-promo) stay exempt — they
  // quote prices legitimately.
  if (requiresClaimValidation(send.newsletter_type)) {
    // Segment-scoped scanning: subject/preview and HTML get NO string
    // excision (HTML's exemption is the structural data-db-price span;
    // a subject like "🎟️ From $25 in prizes" always blocks). Only the
    // plain-text segment excises its renderer shape ("Tickets: <price>").
    const claimSeen = new Set();
    const scanSegment = (body, lockedPrices, mode) => {
      if (!body) return;
      for (const err of findHallucinatedClaims(body, lockedPrices, mode)) {
        if (!claimSeen.has(err)) { claimSeen.add(err); errors.push(err); }
      }
    };
    scanSegment([send.subject, send.subject_b, send.preview_text].filter(Boolean).join('\n'), [], 'none');
    scanSegment(send.html_body, opts.lockedPrices || [], 'html');
    scanSegment(send.text_body, opts.lockedPrices || [], 'text');

    // The register's rules are the Pest Insider's grounding: the weekly

    // events flagship keeps its own claim patterns (an event blurb saying

    // "family-safe fun" is not a pesticide claim and must not hold the week).

    // Every claim-validated type: the weekly flagship sources the same
    // register facts as the Pest Insider now, and the safety / re-entry /
    // second-swarm rules are AGENTS.md rules for all customer copy
    // (pre-push audit P1 on e0dd938596).
    errors.push(...scanUnverifiedClaims(send));
  }

  // Affiliate links are WEB-ONLY (owner monetization pilot 2026-08-31: the
  // rendered blog page is the only approved channel — several affiliate
  // programs, e.g. DoMyOwn/Awin, restrict or void email placements, and
  // the newsletter has no review queue, so this must hard-block in code).
  // Scanned on EVERY newsletter type, manual included — no legitimate send
  // carries an affiliate/tracking URL.
  for (const [segment, label] of [
    [send.subject, 'subject'], [send.subject_b, 'subject B'], [send.preview_text, 'preview text'],
    [send.html_body, 'HTML body'], [send.text_body, 'plain-text body'],
  ]) {
    if (segment && containsAffiliateMaterial(segment)) {
      errors.push(`AFFILIATE_LINK_IN_UNAPPROVED_CHANNEL: ${label} contains affiliate material (an <AffiliateLink>, a registered affiliate URL, or a tracking-network URL) — affiliate links publish on the blog only, never by email`);
      break;
    }
  }

  return { errors, warnings };
}

module.exports = {
  lockedPricesForSend, validateNewsletterDraft, findHallucinatedClaims };
