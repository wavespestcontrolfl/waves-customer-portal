/**
 * Newsletter validation gate — pre-send checks for the content engine.
 */

const { getNewsletterType, isFlagshipType, requiresClaimValidation } = require('../config/newsletter-types');
const { validateVoice } = require('../config/voice-profiles');

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
function findHallucinatedClaims(body) {
  if (!body) return [];
  // NFKC folds Unicode look-alikes (fullwidth '＄', fullwidth digits, etc.)
  // down to their ASCII forms so a homoglyph "＄15" / "ｆｒｅｅ" can't render as
  // the claim to subscribers while slipping past the ASCII regexes.
  const bodyText = decodeEntities(body.replace(/<[^>]+>/g, ' '))
    .normalize('NFKC')
    .replace(/\s+/g, ' ');
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
      const bodyText = send.html_body.replace(/<[^>]+>/g, '').toLowerCase();
      if (!['homeowner minute', 'homeowner tip', 'quick tip', 'before heading out'].some((s) => bodyText.includes(s))) {
        warnings.push('No Homeowner Minute section detected');
      }
      if (!['schedule service', 'book', 'call us', 'reply to this email', 'wavespestcontrol.com'].some((s) => bodyText.includes(s))) {
        warnings.push('No Waves CTA detected');
      }
      if (!send.html_body.includes('<h2>') && !send.html_body.includes('<strong>')) {
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
    const combinedBody = [send.subject, send.preview_text, send.html_body, send.text_body]
      .filter(Boolean).join('\n');
    if (combinedBody) errors.push(...findHallucinatedClaims(combinedBody));
  }

  return { errors, warnings };
}

module.exports = { validateNewsletterDraft, findHallucinatedClaims };
