const MODELS = require('../config/models');
const logger = require('./logger');
const { dispatchWithFallback } = require('./llm/call');

// Outcomes that always skip the AI path. These are customer-sensitive
// situations where generated wording could go off-tone or contradict the
// recorded outcome — we want predictable copy. customer_concern and
// incomplete are included so an AI outage doesn't fall back to the
// "Today we completed your service" default branch (Codex P2 on PR #588).
const DETERMINISTIC_OUTCOMES = new Set([
  'inspection_only',
  'customer_declined',
  'follow_up_needed',
  'customer_concern',
  'incomplete',
]);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeOutcome(value) {
  return cleanText(value || 'completed').toLowerCase();
}

function safeAreas(areas) {
  return Array.isArray(areas)
    ? areas.map(cleanText).filter(Boolean).slice(0, 12)
    : [];
}

function sentenceJoin(parts) {
  return parts.map(cleanText).filter(Boolean).join(' ');
}

const SMS_RECAP_MAX_CHARS = 232;

// Trim to `maxLength`, preferring the last sentence boundary so copy never ends
// mid-thought; falls back to a clean word boundary. Only applied to SMS-sized copy.
function clampRecap(text, maxLength) {
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, maxLength);
  const lastStop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  if (lastStop >= Math.floor(maxLength / 2)) return slice.slice(0, lastStop + 1).trim();
  return slice.replace(/\s+\S*$/, '').trim();
}

// Normalize a recap. By default returns the FULL text (no length cap) — this is
// what we store and render on the service report. Pass { maxLength } for
// SMS-sized copy. The 232-char cap was previously UNCONDITIONAL, which chopped
// the stored recap mid-sentence and surfaced on the report ("...noticed some.").
function sanitizeRecap(value, { maxLength = null } = {}) {
  // Normalize dashes first so an em-dash signoff ("text — Waves") is recognized.
  let text = cleanText(value).replace(/[–—]/g, '-');
  // Strip wrapping quotes BOTH before and after removing the "- Waves" signoff.
  // A pasted, already-signed + quoted recap ("text." - Waves) hides its closing
  // quote behind the signoff, so a single pre-strip would leave it dangling once
  // the signoff is removed (Codex P3); a recap quoted AROUND the signoff
  // ("text - Waves") needs the pre-strip so the signoff is then at the edge.
  // Smart→straight runs last so a smart-quoted recap keeps its (converted) quotes
  // rather than being unwrapped.
  text = text.replace(/^["']+|["']+$/g, '');
  text = text.replace(/\s*-\s*Waves\s*$/i, '').trim();
  text = text
    .replace(/^["']+|["']+$/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
  if (typeof maxLength === 'number' && maxLength > 0) text = clampRecap(text, maxLength);
  return text ? `${text} - Waves` : '';
}

// SMS-sized recap: complete-sentence copy capped for messaging. The service
// report uses the full recap; the completion SMS gets this tightened version.
function smsRecap(value) {
  return sanitizeRecap(value, { maxLength: SMS_RECAP_MAX_CHARS });
}

function deterministicRecap(input = {}) {
  const outcome = normalizeOutcome(input.visitOutcome);
  const serviceType = cleanText(input.serviceType) || 'service';
  const areas = safeAreas(input.areasTreated || input.areasServiced);

  if (outcome === 'inspection_only') {
    return sentenceJoin([
      `Today we completed an inspection for your ${serviceType}.`,
      areas.length ? `We checked ${areas.join(', ')} and noted the current conditions.` : 'We checked the accessible areas and noted the current conditions.',
      'No treatment was needed during this visit.',
    ]);
  }

  if (outcome === 'customer_declined') {
    return sentenceJoin([
      `Today we stopped by for your scheduled ${serviceType}, but service was not completed at the property.`,
      'We documented the visit so the office can help with the next step.',
      'Please reply if you would like us to reschedule.',
    ]);
  }

  if (outcome === 'follow_up_needed') {
    return sentenceJoin([
      `Today we completed the available work for your ${serviceType}.`,
      areas.length ? `We focused on ${areas.join(', ')}.` : 'We documented the areas that need continued attention.',
      'A follow-up is recommended so we can check progress and finish any remaining items.',
    ]);
  }

  if (outcome === 'customer_concern') {
    return sentenceJoin([
      `Today we visited for your ${serviceType} and noted a concern that came up.`,
      'We documented it so the office can follow up with the next step.',
      'Please reply with any additional details and we will be in touch.',
    ]);
  }

  if (outcome === 'incomplete') {
    return sentenceJoin([
      `Today we started your ${serviceType} but were not able to finish the full visit.`,
      areas.length ? `We focused on ${areas.join(', ')}.` : 'We documented what was done so we can pick up where we left off.',
      'We will reach out about scheduling the remaining work.',
    ]);
  }

  return sentenceJoin([
    `Today we completed your ${serviceType}.`,
    areas.length ? `We treated ${areas.join(', ')}.` : 'We treated the accessible service areas.',
    'You may continue to see normal activity for a short period as the service takes effect.',
    'Reply to this message if anything needs attention before your next visit.',
  ]);
}

// Tech-chosen solutions, normalized for the prompt (owner directive
// 2026-07-21: the products the tech records must feed the AI recap on every
// line — pest, lawn, mosquito, T&S). Context only: the output rules still
// forbid naming products/chemicals to the customer. Accepts both the panel
// shape ({name, applicationMethod, targets}) and the recap-modal shape
// ({product_name, product_category}).
function safeProducts(products) {
  if (!Array.isArray(products)) return [];
  return products
    .map((p) => {
      const name = cleanText(p?.name || p?.product_name).slice(0, 80);
      if (!name) return null;
      const method = cleanText(p?.applicationMethod || p?.application_method).slice(0, 40);
      const targets = Array.isArray(p?.targets)
        ? p.targets.map(cleanText).filter(Boolean).slice(0, 6)
        : [];
      return { name, method, targets };
    })
    .filter(Boolean)
    .slice(0, 10);
}

function productPromptLines(products) {
  return products.map((p) => {
    const parts = [p.method, p.targets.length ? `targets: ${p.targets.join(', ')}` : ''].filter(Boolean);
    return `- ${p.name}${parts.length ? ` (${parts.join('; ')})` : ''}`;
  }).join('\n');
}

function safeTextList(value, { maxItems = 8, maxItemChars = 200 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item).slice(0, maxItemChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

function buildPrompt(input = {}) {
  const serviceType = cleanText(input.serviceType) || 'service';
  const areas = safeAreas(input.areasTreated || input.areasServiced);
  const notes = cleanText(input.notes || input.technicianNotes);
  const outcome = normalizeOutcome(input.visitOutcome);
  const products = safeProducts(input.products);
  // Structured closeout fields ground the recap the same way they ground
  // the AI report (owner 2026-07-30): what was found, what's next, and the
  // tech's activity read.
  const observations = safeTextList(input.observations);
  const recommendations = safeTextList(input.recommendations);
  const rating = Number.isInteger(input.pestActivityRating)
    && input.pestActivityRating >= 0 && input.pestActivityRating <= 5
    ? input.pestActivityRating
    : null;

  return `Write one customer-facing SMS recap for a Waves Pest Control & Lawn Care service visit.

Rules:
- 2 to 4 short sentences.
- Friendly, plain-language, professional.
- Never mention product names, chemical names, application rates, prices, or EPA details.
- Mention treated areas in plain language when provided.
- When the applied-solutions context tags specific targets (e.g. ghost ants, chinch bugs, brown patch), name the main one(s) in plain language instead of a generic "pests" — never a target that isn't tagged.
- Do not say eliminated, guaranteed, pest-free, eradicated, or solved forever.
- Do not blame the customer.
- Stay neutral if the visit was declined, incomplete, or follow-up only.
- Plain text only. No markdown. No greeting, bullets, or headings.
- End with " - Waves".

Inputs:
Service type: ${serviceType}
Visit outcome: ${outcome}
Areas treated: ${areas.length ? areas.join(', ') : 'not specified'}
Technician notes: ${notes || 'not specified'}${observations.length ? `\nTechnician observations (what was found on site — describe in plain language):\n${observations.map((o) => `- ${o}`).join('\n')}` : ''}${recommendations.length ? `\nTechnician recommendations (future advice — frame as recommended next steps, never as completed work):\n${recommendations.map((r) => `- ${r}`).join('\n')}` : ''}${rating != null ? `\nPest activity the technician observed, on a 0 (none) to 5 (severe) scale: ${rating} — reflect the level in plain reassuring language, never quote the number or the scale.` : ''}${products.length ? `\nSolutions the technician applied (context only — describe the work in plain language, NEVER name these products or chemicals to the customer):\n${productPromptLines(products)}` : ''}${String(input.visitContext || '').trim() ? `\nVisit context (season, weather, expectations — use to set accurate plain-language expectations; do not copy verbatim):\n${String(input.visitContext).trim()}` : ''}${input.commsContext ? `\n\nRecent customer communications (context only — never quote them back):\n${input.commsContext}` : ''}

Return only the recap text.`;
}

async function aiRecap(input = {}) {
  // Customer-facing recap → Sonnet VOICE, with OpenAI Terra as the independent
  // provider fallback. Only the happy-path "completed"
  // outcome reaches here; sensitive outcomes (concern/incomplete/declined/etc.)
  // skip AI entirely via DETERMINISTIC_OUTCOMES above, so no escalation needed.
  const result = await dispatchWithFallback(MODELS.TEXT_POLICIES.customerCopy, {
    text: buildPrompt(input),
    jsonMode: false,
    maxTokens: 220,
  });
  return result.ok ? cleanText(result.text) : null;
}

// True when the generated copy mentions any recorded product by name —
// matches on each name token of 4+ letters ("Talstar", "Suspend") so partial
// echoes ("we applied Talstar around...") are caught too.
// Short formulation suffixes (SE/SC/EC/WDG …) are label codes, not brand
// identity — they never gate copy on their own (codex r35 on #3420).
const FORMULATION_SUFFIX_TOKENS = new Set([
  'se', 'sc', 'ec', 'wp', 'wdg', 'wsp', 'me', 'ew', 'cs', 'sg', 'df', 'gr',
  'xl', 'ii', 'iii', 'iv', 'lo', 'hi', 'g', 'l', 'd', 'f', 't', 'e',
]);
function containsProductName(text, products, { extraGenericTokens = null, wholeWord = false } = {}) {
  const hay = String(text || '').toLowerCase();
  if (!hay) return false;
  // wholeWord: match tokens on word boundaries — 'drive' (Drive XLR8) must
  // not match "driveway" (codex r31 on #3420). The recap path keeps its
  // stricter substring contract by default.
  const hayWords = wholeWord ? hay.split(/[^a-z0-9]+/).filter(Boolean) : null;
  const wordSet = wholeWord ? new Set(hayWords) : null;
  const normHay = wholeWord ? ` ${hayWords.join(' ')} ` : null;
  return safeProducts(products).some((p) => {
    const nameTokens = String(p.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const isGeneric = (token) => GENERIC_NAME_TOKENS.has(token)
      // Callers may widen the generic set (e.g. the generate-report guard
      // ignores pest-target nouns like "cockroach" that appear in catalog
      // names but legitimately belong in report copy — codex r21 on #3420).
      || (extraGenericTokens && extraGenericTokens.has(token));
    const longDistinctive = nameTokens.filter((token) => token.length >= 4 && !isGeneric(token));
    if (longDistinctive.some((token) => (wholeWord ? wordSet.has(token) : hay.includes(token)))) {
      return true;
    }
    if (!wholeWord) return false;
    // Abbreviated echoes gate too — even when the full name carries another
    // distinctive token the copy omitted ("Green Flo" for "LESCO Green Flo",
    // codex r38): adjacent token pairs with identity match as phrases below
    // for EVERY name. Distinctive short acronyms (2-3 chars) additionally
    // match as whole words, but only for names whose long tokens are all
    // generic ("PGF Complete") — widening that to every name would let a
    // lone formulation acronym reject ordinary copy (codex r35).
    const shortDistinctive = (longDistinctive.length ? [] : nameTokens).filter((token) => token.length >= 2
      && token.length <= 3
      && !/^\d+$/.test(token)
      && !FORMULATION_SUFFIX_TOKENS.has(token)
      && !isGeneric(token));
    if (shortDistinctive.some((token) => wordSet.has(token))) return true;
    if (nameTokens.length >= 2) {
      const phrase = ` ${nameTokens.join(' ')} `;
      if (normHay.includes(phrase)) return true;
      // Abbreviated echoes drop the formulation suffix ("T-Zone" for
      // "T-Zone SE") — adjacent token pairs match as phrases too, when the
      // pair carries at least one token that isn't generic vocabulary, a
      // formulation suffix, or a pure number, so ordinary "zone" alone
      // still passes (codex r36 #3420).
      for (let i = 0; i < nameTokens.length - 1; i += 1) {
        const pair = [nameTokens[i], nameTokens[i + 1]];
        // A single-letter/suffix token still carries identity INSIDE a
        // phrase ("t zone") — only fully-generic pairs are skipped.
        const hasIdentity = pair.some((token) => !isGeneric(token)
          && !/^\d+$/.test(token));
        if (hasIdentity && normHay.includes(` ${pair[0]} ${pair[1]} `)) return true;
      }
      // Brand-stem echoes for ALL-generic names ("Advance Termite Bait
      // Station" → "Advance bait stations"): the leading name token acts as
      // the stem and pairs with ANY other name token in the copy, so
      // ordinary lone uses ("in advance of the visit") still pass
      // (codex r43).
      if (!longDistinctive.length && nameTokens.length >= 2) {
        const stem = nameTokens[0];
        if (stem.length >= 4 && !/^\d+$/.test(stem)) {
          for (const other of nameTokens.slice(1)) {
            if (/^\d+$/.test(other) || FORMULATION_SUFFIX_TOKENS.has(other)) continue;
            if (normHay.includes(` ${stem} ${other} `) || normHay.includes(` ${stem} ${other}s `)) return true;
          }
        }
      }
    }
    return false;
  });
}
const GENERIC_NAME_TOKENS = new Set([
  'insecticide', 'herbicide', 'fungicide', 'fertilizer', 'granular', 'liquid',
  'concentrate', 'spray', 'nonionic', 'surfactant', 'miticide', 'insect',
  'control', 'plus', 'pro', 'max', 'maxx', 'lawn', 'turf', 'palm', 'tree',
  'shrub', 'weed', 'grass', 'pest', 'bait', 'dust', 'emulsion',
]);

async function generateRecap(input = {}) {
  const outcome = normalizeOutcome(input.visitOutcome);
  if (DETERMINISTIC_OUTCOMES.has(outcome)) {
    return { recap: sanitizeRecap(deterministicRecap(input)), source: 'deterministic' };
  }

  try {
    const recap = await aiRecap(input);
    // The prompt forbids product names, but the contract is enforced here:
    // a generated recap that echoes any recorded product name falls back to
    // the deterministic copy (codex P3 2026-07-22).
    if (recap && containsProductName(recap, input.products)) {
      logger.warn('[completion-recap] AI recap echoed a product name — using fallback');
    } else if (recap) {
      return { recap: sanitizeRecap(recap), source: 'ai' };
    }
  } catch (err) {
    logger.warn(`[completion-recap] AI recap failed, using fallback: ${err.message}`);
  }

  return { recap: sanitizeRecap(deterministicRecap(input)), source: 'fallback' };
}

function composeCompletionSmsPreview({ recap, willInvoice, willReview }) {
  return [
    smsRecap(recap),
    willInvoice ? '[pay link inserted]' : '',
    willReview && !willInvoice ? '[review link inserted]' : '',
  ].filter(Boolean).join('\n\n');
}

// Request-specific trade-name screen shared by the generate-report output
// gate and the COMPLETION-TIME acceptance of a technician report body
// (codex r48 #3420): generation screens per-request, but a post-generation
// inline edit reaches completion where only static banned-word checks ran —
// the same visit-scoped guard must rerun there. Pest-target/formulation
// nouns appear in catalog names ("Advion Cockroach Gel Bait") but
// legitimately belong in report copy — only distinctive brand tokens may
// reject (codex r21/r28/r32-r34 on #3420).
const REPORT_GENERIC_PRODUCT_TOKENS = new Set([
  'cockroach', 'cockroaches', 'roach', 'roaches', 'termite', 'termites',
  'rodent', 'rodents', 'mosquito', 'mosquitos', 'mosquitoes', 'ants',
  'flea', 'fleas', 'tick', 'ticks', 'spider', 'spiders', 'wasp', 'wasps',
  'hornet', 'hornets', 'bees', 'mice', 'rats', 'wildlife', 'station',
  'stations', 'trap', 'traps', 'perimeter', 'barrier', 'outdoor',
  'indoor', 'yard', 'granular', 'granules',
  'wetting', 'agent', 'sprayable', 'spreader', 'sticker', 'adjuvant',
  'care', 'guard', 'shield', 'defense', 'complete', 'advance', 'advanced',
  'zone', 'zones', 'select', 'super', 'total', 'ultra', 'prime',
  'green', 'blue', 'red', 'black', 'white', 'gold', 'silver',
]);
// Builds a screen(text) predicate for THIS visit's recorded products.
// Generic tokens widen with the visit's own recorded treatment targets and
// (via db) catalog actives/formulations — active ingredients are permitted
// report wording even when the trade name IS the active. Products carrying
// only a productId are name-hydrated from the catalog so they are screened
// too. Chunked by 10 so safeProducts' cap never leaves an entry
// unscreened. Catalog lookup failure keeps the guard strict.
async function buildReportTradeNameScreen({ products = [], extraNames = [], db = null } = {}) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  let hydrated = list;
  const genericTokens = new Set(REPORT_GENERIC_PRODUCT_TOKENS);
  for (const prod of list) {
    for (const target of Array.isArray(prod?.targets) ? prod.targets : []) {
      String(target || '').toLowerCase().split(/[^a-z0-9]+/)
        .filter((tok) => tok.length >= 4)
        .forEach((tok) => genericTokens.add(tok));
    }
  }
  if (db) {
    try {
      const ids = list.map((p) => p?.productId).filter(Boolean);
      if (ids.length) {
        const rows = await db('products_catalog')
          .whereIn('id', ids)
          .select('id', 'name', 'active_ingredient', 'formulation')
          .catch(() => []);
        const nameById = new Map((rows || []).map((r) => [String(r.id), r.name]));
        hydrated = list.map((p) => (p && !p.name && !p.product_name && p.productId
          ? { ...p, name: nameById.get(String(p.productId)) || null }
          : p));
        for (const row of rows || []) {
          `${row.active_ingredient || ''} ${row.formulation || ''}`
            .toLowerCase().split(/[^a-z0-9]+/)
            .filter((tok) => tok.length >= 4)
            .forEach((tok) => genericTokens.add(tok));
        }
      }
    } catch { /* strict guard on failure */ }
  }
  const seen = new Set();
  const guarded = [
    ...extraNames.map((name) => ({ name })),
    ...hydrated,
  ].filter((p) => {
    const key = String(p?.name || '').toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const chunks = [];
  for (let i = 0; i < guarded.length; i += 10) chunks.push(guarded.slice(i, i + 10));
  return (text) => chunks.some((chunk) => containsProductName(text, chunk, { extraGenericTokens: genericTokens, wholeWord: true }));
}

module.exports = {
  buildPrompt,
  buildReportTradeNameScreen,
  containsProductName,
  composeCompletionSmsPreview,
  deterministicRecap,
  generateRecap,
  normalizeOutcome,
  sanitizeRecap,
  smsRecap,
  SMS_RECAP_MAX_CHARS,
};
