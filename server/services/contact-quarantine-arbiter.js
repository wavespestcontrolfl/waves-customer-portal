/**
 * Contact-quarantine arbiter — second opinion on dictated contact fields the
 * decoder could not confirm.
 *
 * The contact-dictation decoder fails closed: when its transcripts disagree
 * ("golf" vs "gulf"), it demotes the email to email_raw and the customer
 * profile ships with NO email until a human resolves the review card. Owner
 * ruling (2026-07-09): a quarantined field should not sit empty when
 * independent evidence can settle it — a second agent rules on the candidates
 * using findings the transcripts can't provide.
 *
 * Division of labor:
 *   - THIS MODULE gathers the hard evidence deterministically (DNS MX/A per
 *     candidate domain, cross-customer ownership) — the model rules on
 *     evidence, it never fetches or invents it.
 *   - The DEEP-tier model weighs coherence (does the domain match the business
 *     the caller named?) and phonetic plausibility LAST, and returns a verdict.
 *   - Deterministic gates re-check the verdict before anything is written: the
 *     chosen value must be one of the candidates we sent, syntactically valid,
 *     on a domain that can actually receive mail, and not on file for another
 *     customer. A verdict that fails any gate degrades to "review" — the LLM's
 *     output never reaches a write path unchecked (same contract as
 *     sanitizeEmailCandidates in contact-dictation.js).
 *
 * Verdicts:
 *   - adopt                   — decisive evidence; stored, review card closes.
 *   - adopt_with_confirmation — passes every hard gate and clearly ahead, but
 *     circumstantial; stored so the profile is never empty and promised sends
 *     go out, AND the review card stays open with a read-back question.
 *   - review                  — all candidates fail hard gates, the winner is
 *     owned by another customer, or a true coin flip; nothing stored, the
 *     arbiter's findings ride the review card so the human starts from them.
 *
 * Fail-open everywhere: any DNS/model/parse failure returns null and the
 * pipeline behaves exactly as before this module existed (quarantine stands).
 * Dark-shipped: CONTACT_QUARANTINE_ARBITER_ENABLED=true turns it on.
 */

const dns = require('dns').promises;
const logger = require('./logger');
const MODELS = require('../config/models');
const { createDeepMessage } = require('./llm/deep');
const { cleanValidEmailOrNull, looksGarbledTranscriptEmail } = require('../utils/intake-normalize');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const ENABLED = () => process.env.CONTACT_QUARANTINE_ARBITER_ENABLED === 'true';

// Arbitration is post-call and latency-tolerant, but it sits inside the
// recording processor's run — bound it so a hung provider can't stall the
// customer/lead writes behind it.
const DNS_TIMEOUT_MS = 4000;
const MODEL_TIMEOUT_MS = 60000;
// Deterministic floors UNDER the model's self-reported confidence: a decisive
// "adopt" below ADOPT_CONFIDENCE_FLOOR degrades to adopt_with_confirmation
// (card stays open); ANY storing verdict below STORE_CONFIDENCE_FLOOR
// degrades to review — a low-confidence guess is exactly what quarantine
// exists to keep out of send paths, whatever label the model puts on it.
const ADOPT_CONFIDENCE_FLOOR = 0.9;
const STORE_CONFIDENCE_FLOOR = 0.6;

// Google is the one major provider that ignores dots in the local part:
// local-part dot-variants on these domains are literally the same mailbox.
// Do NOT extend this to other providers (dots are significant elsewhere),
// and do NOT strip +tags anywhere (a tag is deliberate, not a mishear).
const GOOGLE_DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Canonical mailbox for Google's dot-insensitivity, or null when the rule
 * does not apply. googlemail.com aliases gmail.com, so both collapse to the
 * same canonical key.
 */
function gmailCanonicalMailbox(email) {
  const [local, domain] = String(email || '').toLowerCase().split('@');
  if (!local || !domain || !GOOGLE_DOT_INSENSITIVE_DOMAINS.has(domain)) return null;
  // Strip dots only from the mailbox name BEFORE any +tag: the tag is the
  // deliberate part (filters can key on its exact text), so tag spellings
  // that differ by a dot stay distinct candidates for the model to weigh.
  const plusAt = local.indexOf('+');
  const mailbox = plusAt === -1 ? local : local.slice(0, plusAt);
  const tag = plusAt === -1 ? '' : local.slice(plusAt);
  return `${mailbox.replace(/\./g, '')}${tag}@gmail.com`;
}

// Did the caller actually SAY a dot IN THE LOCAL PART? A dotted candidate is
// dictation-faithful only when the word was spoken there — otherwise the dot
// is transcription punctuation leaking into the address (a spoken initial
// "W" rendered as "W." became charlesw.robb@ on a real call, 2026-07-13).
// The domain's own separators don't count: nearly every dictation ends
// "... at gmail dot com", so only the portion before the spoken "at" is
// evidence about the local part. With no spoken "at" to anchor on, ignore
// domain-suffix mentions ("dot com") before testing.
function dotSpokenInDictation(rawSpoken) {
  let s = String(rawSpoken || '');
  // Anchor on the LAST spoken "at"/"@" — the separator before the domain. An
  // earlier "at" can be prepositional ("reach me at jane dot doe at gmail"),
  // and slicing there would hide a genuinely dictated local-part dot.
  const separators = [...s.matchAll(/\s(?:at|@)\s/gi)];
  if (separators.length) s = s.slice(0, separators[separators.length - 1].index);
  // Domain-suffix mentions are never local-part evidence, whether the "at"
  // anchor existed or not (trailing chatter can keep "gmail dot com" inside
  // the sliced prefix: "... at gmail dot com, reach me at that address").
  // Dot tokens mirror the decoder's own rule set ("dot"/"period"/"point" all
  // convert to "." in an email context — contact-dictation EMAIL RULES #4).
  s = s.replace(/\b(?:dot|period|point)\s+(?:com|net|org|edu|gov|co|io|us|biz|info)\b/gi, '');
  return /\b(?:dot|period|point)\b/i.test(s);
}

// ── Evidence gathering (deterministic, no model) ─────────────────────────────

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref?.()),
  ]);
}

// Authoritative "this name can never receive mail" answers. ENOTFOUND /
// ENODATA / NXDOMAIN say the records don't exist; EBADNAME says the name
// itself is malformed (e.g. "bad..com" — regex-valid but not a DNS name), so
// it can never resolve on any retry. Anything else (timeout, SERVFAIL,
// EAI_AGAIN, refused) is a resolver hiccup, not evidence about the domain —
// it must never eliminate a candidate.
const AUTHORITATIVE_NEGATIVE_CODES = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'EBADNAME']);

/**
 * DNS facts per candidate email domain: can this domain receive mail at all?
 * An authoritative NXDOMAIN / no-MX-no-A is a hard eliminator — a domain that
 * does not exist cannot be anyone's email, no matter how confident the
 * transcription sounded. `deliverable` is three-valued:
 *   true  — MX or A records exist
 *   false — authoritative negative on both lookups
 *   null  — unknown (transient resolver error); the verdict gate caps an
 *           unknown-deliverability adopt at adopt_with_confirmation, it never
 *           treats unknown as a negative.
 */
async function gatherEmailDomainEvidence(candidates, deps = {}) {
  const resolveMx = deps.resolveMx || ((d) => dns.resolveMx(d));
  const resolve4 = deps.resolve4 || ((d) => dns.resolve4(d));
  const resolve6 = deps.resolve6 || ((d) => dns.resolve6(d));
  const byDomain = new Map();
  const evidence = [];
  for (const value of candidates) {
    const domain = String(value).split('@')[1]?.toLowerCase() || '';
    if (!byDomain.has(domain)) {
      let mxRecords = 0;
      let aRecords = 0;
      let mxError = null;
      let aError = null;
      let nullMx = false;
      try {
        const mx = await withTimeout(resolveMx(domain), DNS_TIMEOUT_MS);
        // RFC 7505 Null MX ("MX 0 .") is the domain explicitly declaring it
        // accepts NO mail — the opposite of deliverable, and it overrides the
        // implicit-MX A-record fallback too.
        const usable = mx.filter((r) => r?.exchange && r.exchange !== '.');
        mxRecords = usable.length;
        nullMx = mx.length > 0 && usable.length === 0;
      } catch (err) {
        mxError = err.code || err.message;
      }
      // Implicit-MX fallback applies only when the MX answer was
      // AUTHORITATIVE no-records. After a transient MX failure the domain's
      // mail setup is simply unknown — an A/AAAA hit must not upgrade it to
      // deliverable:true, or an adopt could bypass the unknown cap on the
      // strength of a web server record.
      const mxTransient = !!mxError && !AUTHORITATIVE_NEGATIVE_CODES.has(mxError);
      if (!mxRecords && !nullMx && !mxTransient) {
        // Mail can still deliver to an apex address record (implicit MX) —
        // A or AAAA (an IPv6-only apex is still deliverable). Only a domain
        // with none of them is deliverability-dead, and only when BOTH
        // lookups answered authoritatively.
        try {
          aRecords = (await withTimeout(resolve4(domain), DNS_TIMEOUT_MS)).length;
        } catch (err) {
          aError = err.code || err.message;
        }
        if (!aRecords) {
          try {
            aRecords = (await withTimeout(resolve6(domain), DNS_TIMEOUT_MS)).length;
            if (aRecords) aError = null;
          } catch (err) {
            // Keep the stricter signal: a transient error on EITHER family
            // means we cannot prove nonexistence.
            const code = err.code || err.message;
            if (!AUTHORITATIVE_NEGATIVE_CODES.has(code)) aError = code;
            else if (!aError) aError = code;
          }
        }
      }
      const hasRecords = mxRecords > 0 || aRecords > 0;
      const authoritativeNegative = !hasRecords
        && (nullMx
          || (AUTHORITATIVE_NEGATIVE_CODES.has(mxError) && AUTHORITATIVE_NEGATIVE_CODES.has(aError)));
      byDomain.set(domain, {
        domain,
        mx_records: mxRecords,
        a_records: aRecords,
        deliverable: hasRecords ? true : (authoritativeNegative ? false : null),
        dns_error: hasRecords ? null : (nullMx ? 'NULL_MX' : (mxError || aError)),
      });
    }
    evidence.push({ value, ...byDomain.get(domain) });
  }
  return evidence;
}

// ── Arbiter prompt ────────────────────────────────────────────────────────────

function buildArbiterPrompt({ fieldType, quarantineReason, rawSpoken, candidates, evidence, transcripts, callerContext }) {
  return `You are the CONTACT-QUARANTINE ARBITER for Waves Pest Control's call pipeline. A first-pass decoder extracted a dictated contact field (${fieldType}) from a phone call but QUARANTINED it: transcription passes disagreed, multiple candidates emerged, or a risk was flagged. Issue a VERDICT on which candidate (if any) is the caller's real contact detail — based on the independent evidence provided, not on which transcription "sounds right."

FIELD_TYPE: ${fieldType}
QUARANTINE_REASON: ${quarantineReason}
RAW_SPOKEN (verbatim dictation evidence): ${JSON.stringify(rawSpoken || null)}

CANDIDATES (from the decoder, with its confidence and declared risks):
${JSON.stringify(candidates, null, 2)}

EVIDENCE (gathered outside the transcripts — DNS facts per candidate domain, cross-customer ownership):
${JSON.stringify(evidence, null, 2)}

CALLER_CONTEXT (name, organization mentioned on the call, call summary):
${JSON.stringify(callerContext, null, 2)}

PRIMARY TRANSCRIPT (diarized):
"""
${transcripts.primary || ''}
"""
${transcripts.contactPass ? `SECOND-PASS TRANSCRIPT (dictation-focused, same audio — independent hearing):
"""
${transcripts.contactPass}
"""
` : ''}
HOW TO DECIDE — evidence hierarchy, strongest first:
1. HARD EXTERNAL FACTS beat everything. A candidate email domain with no DNS records (deliverable: false) cannot receive mail — eliminate it. deliverable: null means DNS could not be checked (transient resolver error) — treat it as UNKNOWN, never as a negative.
2. COHERENCE with the call. If the caller names their business or organization and a candidate's domain plainly matches that name, the candidate is corroborated. A near-miss variant that also resolves is NOT automatically right — note when it plausibly belongs to an unrelated entity.
2b. INDEPENDENT EXTRACTOR AGREEMENT. CALLER_CONTEXT.v2_email (when present) is the same call extracted by a SEPARATE schema-validated model. Exact agreement with a candidate corroborates that candidate; it is stronger than phonetic plausibility but weaker than hard external facts.
3. THE CALLER'S OWN SPELLING beats agent read-backs and call summaries. A read-back is one more chance to mishear; trust it only when the caller explicitly confirmed it.
4. PHONETIC PLAUSIBILITY last. Use "which mishear is more likely" only when facts and coherence do not separate the candidates.

HARD RULES:
- NEVER choose a value marked owned_by_other_customer: true — mail-the-wrong-person is the worst failure this system has. If the only viable candidate is owned elsewhere, the verdict is "review".
- NEVER invent a value. chosen_value must be one of the CANDIDATES verbatim.
- If ALL candidates fail hard checks (no deliverable domain), verdict = "review" with chosen_value null. Storing a dead value is worse than an empty field with a good follow-up question.
- "adopt" means the value is written to the customer profile and live send paths use it. Issue it only when the evidence would convince a careful human reviewer.

VERDICT SEMANTICS:
- "adopt" — decisive independent evidence (e.g. exactly one candidate's domain is deliverable AND it matches the caller's stated business). Stored; review card closes.
- "adopt_with_confirmation" — best candidate passes every hard check and is clearly ahead, but the evidence is circumstantial. Stored so the profile is never empty, AND the review card stays open with your confirmation_question.
- "review" — you cannot responsibly choose. Nothing is stored; your findings ride the review card.

Return ONLY JSON:
{
  "verdict": "adopt" | "adopt_with_confirmation" | "review",
  "chosen_value": string | null,
  "confidence": 0.0-1.0,
  "eliminated": [ { "value": "", "reason": "" } ],
  "evidence_used": [ "" ],
  "reasoning": "2-4 sentences citing the decisive evidence",
  "confirmation_question": string | null
}`;
}

// ── Verdict enforcement (deterministic, no model) ────────────────────────────

function parseArbiterResponse(rawText) {
  const cleaned = String(rawText || '').replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  const verdict = ['adopt', 'adopt_with_confirmation', 'review'].includes(parsed.verdict) ? parsed.verdict : 'review';
  return {
    verdict,
    chosen_value: typeof parsed.chosen_value === 'string' ? parsed.chosen_value.trim().toLowerCase() : null,
    confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
    eliminated: (Array.isArray(parsed.eliminated) ? parsed.eliminated : []).slice(0, 5)
      .map((e) => ({ value: String(e?.value || '').slice(0, 200), reason: String(e?.reason || '').slice(0, 300) })),
    evidence_used: (Array.isArray(parsed.evidence_used) ? parsed.evidence_used : []).slice(0, 8).map((s) => String(s).slice(0, 300)),
    reasoning: String(parsed.reasoning || '').slice(0, 1000),
    confirmation_question: parsed.confirmation_question ? String(parsed.confirmation_question).slice(0, 300) : null,
  };
}

/**
 * Second-agent verdict on a quarantined email dictation.
 *
 * @param {object} opts
 *   entry            — decoder email entry ({ raw_spoken, candidates, confirmation_question })
 *   demotedEmail     — the value the primary extraction stored before demotion (extra candidate)
 *   transcripts      — { primary, contactPass }
 *   callerContext    — { first_name, last_name, organization, call_summary, phone,
 *                        v2_email: the schema-valid V2 extraction's caller email (independent second opinion) }
 *   ownCustomerId    — caller's own customer id (exempt from the ownership gate)
 *   deps             — test injection: { resolveMx, resolve4, ownedByOther, createMessage }
 * @returns {object|null} { verdict, chosenValue, confidence, reasoning, eliminated,
 *   evidenceUsed, confirmationQuestion, domainEvidence } — null when disabled,
 *   nothing to arbitrate, or any failure (quarantine stands, fail-open).
 */
async function arbitrateQuarantinedEmail({ entry, demotedEmail = null, transcripts = {}, callerContext = {}, ownCustomerId = null, deps = {} } = {}) {
  if (!ENABLED()) return null;
  try {
    // Candidate set = decoder candidates + the demoted value, deduped, each
    // through the same syntactic gate the decoder's own candidates pass.
    const seen = new Set();
    const candidates = [];
    for (const c of [...(entry?.candidates || []), ...(demotedEmail ? [{ value: demotedEmail, confidence: null, basis: ['primary extraction (demoted)'], risks: [] }] : [])]) {
      const value = cleanValidEmailOrNull(c?.value);
      if (!value || looksGarbledTranscriptEmail(value) || seen.has(value)) continue;
      seen.add(value);
      candidates.push({ value, decoder_confidence: c.confidence ?? null, basis: c.basis || [], risks: c.risks || [] });
    }
    if (!candidates.length) return null;

    const domainEvidence = await gatherEmailDomainEvidence(candidates.map((c) => c.value), deps);

    const ownedByOther = deps.ownedByOther
      || ((email, own) => require('./email-bounce-recovery').correctedAddressOwnedByOther(email, own));
    const evidence = [];
    for (const ev of domainEvidence) {
      // Ownership fails CLOSED per candidate (mirrors bounce-recovery): if we
      // can't verify it isn't someone else's, the arbiter is told it is.
      const owned = await Promise.resolve(ownedByOther(ev.value, ownCustomerId)).catch(() => true);
      evidence.push({ ...ev, owned_by_other_customer: owned });
    }

    // ── Same-mailbox short-circuit (deterministic, no model) ──
    // When EVERY candidate collapses to the same Google mailbox, the "coin
    // flip" is illusory: whichever spelling is stored, mail reaches the same
    // inbox, so mail-the-wrong-person risk is zero and a read-back question
    // would ask the caller to pick between equals. Adopt without consulting
    // the model, preferring the spelling with independent support: exact
    // agreement from the schema-valid V2 extraction first, else the
    // dictation-faithful form (dotted only if the caller actually spoke
    // "dot"), else the decoder's top candidate. Hard gates still apply —
    // an ownership hit or dead domain falls through to the model path.
    // Gmail-canonical ownership probe, shared by the short-circuit and the
    // verdict gate below: the per-candidate exact-string checks above cannot
    // see dot/tag ALIASES of the same inbox (another customer on file as
    // johndoe@ while this call spelled john.doe@), so Google addresses get a
    // second, inbox-identity lookup. Fails closed like every ownership check.
    const gmailInboxOwnedByOther = deps.gmailInboxOwnedByOther
      || ((value, own) => require('./email-bounce-recovery').gmailMailboxOwnedByOther(value, own));

    if (candidates.length > 1) {
      const canonicals = new Set(candidates.map((c) => gmailCanonicalMailbox(c.value)));
      // Decoder risk/confidence still gates the collapse: dot-equivalence
      // proves the candidates share ONE inbox, not that the inbox is the
      // CALLER'S. A risk-flagged or uniformly weak candidate set stays on
      // the model/review path — same reason quarantine exists at all.
      const groupRisky = candidates.some((c) => (c.risks || []).length > 0);
      const bestDecoderConfidence = Math.max(0, ...candidates.map(
        (c) => (typeof c.decoder_confidence === 'number' ? c.decoder_confidence : 0)));
      if (!canonicals.has(null) && canonicals.size === 1
          && !groupRisky && bestDecoderConfidence >= STORE_CONFIDENCE_FLOOR) {
        const v2Email = cleanValidEmailOrNull(callerContext?.v2_email);
        const dotSpoken = dotSpokenInDictation(entry?.raw_spoken);
        const pick = (v2Email && candidates.find((c) => c.value === v2Email))
          || candidates.find((c) => c.value.split('@')[0].includes('.') === dotSpoken)
          || candidates[0];
        const ev = evidence.find((e) => e.value === pick.value);
        // Ownership gates the WHOLE canonical group, not just the picked
        // spelling: these candidates were just proven to be one mailbox, so
        // another customer owning ANY variant owns the inbox every variant
        // delivers to — adopting the unflagged spelling would still mail
        // their inbox. Any hit falls through to the model path (whose own
        // verdict gate applies the same group rule below). The canonical
        // probe extends the gate to variants we never generated as
        // candidates (dot/tag aliases already on file).
        const groupOwned = evidence.some((e) => e.owned_by_other_customer)
          || await Promise.resolve(gmailInboxOwnedByOther(pick.value, ownCustomerId)).catch(() => true);
        if (ev && ev.deliverable !== false && !groupOwned) {
          logger.info(`[quarantine-arbiter] Same-mailbox collapse (gmail dot-equivalence): adopted deterministically without model`);
          return {
            // Unknown deliverability keeps the read-back card, mirroring the
            // model-path cap on non-decisive adopts.
            verdict: ev.deliverable === null ? 'adopt_with_confirmation' : 'adopt',
            chosenValue: pick.value,
            confidence: 0.95,
            reasoning: 'All candidates differ only by local-part dots on a Google domain — the same mailbox, not a coin flip. '
              + (v2Email === pick.value
                ? 'Stored the spelling the independent V2 extraction also produced.'
                : `Stored the dictation-faithful form (the caller ${dotSpoken ? 'spoke' : 'never spoke'} "dot").`),
            eliminated: [],
            evidenceUsed: ['gmail local-part dot-equivalence: all candidates are one mailbox'],
            confirmationQuestion: ev.deliverable === null ? (entry?.confirmation_question || null) : null,
            domainEvidence: evidence.map(({ value, domain, deliverable, dns_error, owned_by_other_customer }) => ({
              value, domain, deliverable, dns_error, owned_by_other_customer,
            })),
            model: null,
          };
        }
      }
    }

    const prompt = buildArbiterPrompt({
      fieldType: 'email',
      quarantineReason: entry?.candidates?.length > 1
        ? 'transcription passes produced conflicting candidates'
        : 'decoder could not confirm the dictated value',
      rawSpoken: entry?.raw_spoken || null,
      candidates,
      evidence,
      transcripts,
      callerContext,
    });

    let createMessage = deps.createMessage;
    if (!createMessage) {
      if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: MODEL_TIMEOUT_MS, maxRetries: 1 });
      createMessage = (params) => createDeepMessage(client, params);
    }
    const response = await createMessage({
      model: MODELS.DEEP,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = response?.content?.find((b) => b.type === 'text')?.text;
    if (!text) return null;
    const ruling = parseArbiterResponse(text);

    // ── Deterministic gates over the model's verdict ──
    let { verdict } = ruling;
    let chosenValue = ruling.chosen_value;
    let downgrade = null;
    if (verdict !== 'review') {
      const match = evidence.find((e) => e.value === chosenValue);
      if (!match) {
        downgrade = 'chosen value was not among the candidates';
      } else if (match.deliverable === false) {
        downgrade = 'chosen domain has no MX/A records (authoritative)';
      } else if (match.owned_by_other_customer) {
        downgrade = 'chosen address is on file for another customer';
      } else if (gmailCanonicalMailbox(match.value)
          && evidence.some((e) => e.owned_by_other_customer
            && gmailCanonicalMailbox(e.value) === gmailCanonicalMailbox(match.value))) {
        // Google dot-equivalence: a same-mailbox variant owned by another
        // customer means the chosen spelling delivers to that customer's
        // inbox too — the flag on the variant IS a flag on the choice.
        downgrade = 'a same-mailbox variant of the chosen address is on file for another customer';
      } else if (gmailCanonicalMailbox(match.value)
          && await Promise.resolve(gmailInboxOwnedByOther(match.value, ownCustomerId)).catch(() => true)) {
        // ...and the inbox can be on file under an alias that was never a
        // candidate (johndoe@ vs this call's john.doe@) — the canonical probe
        // catches those. Fails closed like every ownership check.
        downgrade = 'the gmail inbox behind the chosen address is on file for another customer';
      } else if (ruling.confidence < STORE_CONFIDENCE_FLOOR) {
        downgrade = `confidence ${ruling.confidence} below storing floor`;
      }
      if (downgrade) {
        logger.warn(`[quarantine-arbiter] Downgraded ${verdict} to review: ${downgrade}`);
        verdict = 'review';
        chosenValue = null;
      } else if (verdict === 'adopt'
          && (ruling.confidence < ADOPT_CONFIDENCE_FLOOR || match.deliverable === null)) {
        // Not decisive: low self-reported confidence, or DNS couldn't confirm
        // the domain (transient resolver error → unknown, never a negative).
        verdict = 'adopt_with_confirmation';
      }
    }
    if (verdict === 'review') chosenValue = null;

    return {
      verdict,
      chosenValue,
      confidence: ruling.confidence,
      reasoning: downgrade ? `${ruling.reasoning} [downgraded: ${downgrade}]` : ruling.reasoning,
      eliminated: ruling.eliminated,
      evidenceUsed: ruling.evidence_used,
      confirmationQuestion: ruling.confirmation_question || entry?.confirmation_question || null,
      domainEvidence: evidence.map(({ value, domain, deliverable, dns_error, owned_by_other_customer }) => ({
        value, domain, deliverable, dns_error, owned_by_other_customer,
      })),
      model: response?.model || null,
    };
  } catch (err) {
    logger.warn(`[quarantine-arbiter] failed open: ${err.message}`);
    return null;
  }
}

module.exports = {
  arbitrateQuarantinedEmail,
  gatherEmailDomainEvidence,
  buildArbiterPrompt,
  parseArbiterResponse,
  gmailCanonicalMailbox,
  dotSpokenInDictation,
  ADOPT_CONFIDENCE_FLOOR,
  STORE_CONFIDENCE_FLOOR,
};
