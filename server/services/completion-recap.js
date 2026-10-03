const { DEFAULT_ACTIVITY_SCALE } = require('./pest-pressure/label');
const MODELS = require('../config/models');
const logger = require('./logger');
const { savepointRead } = require('../utils/savepoint-read');
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
  // Scale names from the active Pest Pressure labels when the caller has
  // them, so the recap matches the report gauge.
  const scale = Array.isArray(input.pestActivityScale) && input.pestActivityScale.length === 6
    ? input.pestActivityScale
    : DEFAULT_ACTIVITY_SCALE;

  return `Write one customer-facing SMS recap for a Waves Pest Control service visit.

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
Technician notes: ${notes || 'not specified'}${observations.length ? `\nTechnician observations (what was found on site — describe in plain language):\n${observations.map((o) => `- ${o}`).join('\n')}` : ''}${recommendations.length ? `\nTechnician recommendations (future advice — frame as recommended next steps, never as completed work):\n${recommendations.map((r) => `- ${r}`).join('\n')}` : ''}${rating != null ? `\nPest activity the technician observed, on a 0 (${scale[0]}) to 5 (${scale[5]}) scale: ${rating} (${scale[rating]}) — reflect the level in plain reassuring language, never quote the number or the scale.` : ''}${products.length ? `\nSolutions the technician applied (context only — describe the work in plain language, NEVER name these products or chemicals to the customer):\n${productPromptLines(products)}` : ''}${String(input.visitContext || '').trim() ? `\nVisit context (season, weather, expectations — use to set accurate plain-language expectations; do not copy verbatim):\n${String(input.visitContext).trim()}` : ''}${input.commsContext ? `\n\nRecent customer communications (context only — never quote them back):\n${input.commsContext}` : ''}

Return only the recap text.`;
}

async function aiRecap(input = {}) {
  // Customer-facing recap → Sonnet VOICE, with OpenAI Terra as the independent
  // provider fallback. Only the happy-path "completed"
  // outcome reaches here; sensitive outcomes (concern/incomplete/declined/etc.)
  // skip AI entirely via DETERMINISTIC_OUTCOMES above, so no escalation needed.
  const result = await dispatchWithFallback(MODELS.TEXT_POLICIES.customerCopy, {
    laneId: 'completion_recap',
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
// Ordinary English words and functional/form vocabulary inside brand names
// ("Drive XLR8 Post Emergent Liquid Herbicide") reject legitimate prose
// ("help drive crabgrass pressure down") — they step aside ONLY when the
// name still keeps at least one genuinely distinctive long token, so
// protection never vanishes (codex r62 #3420).
const COMMON_PRODUCT_NAME_WORDS = new Set([
  'drive', 'post', 'emergent', 'liquid', 'herbicide', 'insecticide',
  'fungicide', 'concentrate', 'granule', 'granular', 'spray', 'plus',
  'turf', 'lawn', 'weed', 'grass', 'power', 'rapid', 'quick', 'control',
  'brush', 'clean', 'clear', 'fresh', 'first', 'final', 'dual', 'triple',
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
  // A short all-letter collapse is an ordinary word, not a brand: "I/T"
  // (Bifen I/T) collapsed to "it" and matched nearly every report. A short
  // collapse with a digit stays a designation ("G4" for Tree-Age G-4), and
  // the spaced phrase (" i t ") and the long tokens still match.
  const collapsedEcho = (word) => (word.length >= 4 || /\d/.test(word)) && wordSet.has(word);
  return safeProducts(products).some((p) => {
    const nameTokens = String(p.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const isGeneric = (token) => GENERIC_NAME_TOKENS.has(token)
      || ORDINARY_NAME_WORDS.has(token)
      // Callers may widen the generic set (e.g. the generate-report guard
      // ignores pest-target nouns like "cockroach" that appear in catalog
      // names but legitimately belong in report copy — codex r21 on #3420).
      || (extraGenericTokens && extraGenericTokens.has(token));
    const longCandidates = nameTokens.filter((token) => token.length >= 4 && !isGeneric(token));
    const trulyDistinctive = longCandidates.filter((token) => !COMMON_PRODUCT_NAME_WORDS.has(token));
    // common words step aside only while a genuinely distinctive token
    // still protects the name (codex r62)
    const longDistinctive = trulyDistinctive.length ? trulyDistinctive : longCandidates;
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
      // Punctuation-collapsed echoes match as a single word too —
      // "BoraCare" for "Bora-Care" (codex r82).
      if (normHay.includes(phrase) || collapsedEcho(nameTokens.join(''))) return true;
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
        // ... and the pair collapses to one word the same way ("TZone"
        // for "T-Zone SE", codex r82).
        if (hasIdentity && (normHay.includes(` ${pair[0]} ${pair[1]} `)
          || collapsedEcho(`${pair[0]}${pair[1]}`))) return true;
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
  'pesticide', 'application',
]);
// Ordinary English words inside a catalog name are never its brand: "LESCO
// 24-0-11 with PolyPlus" must not make every sentence with "with" read as a
// trade name, and "Waves" (a yard-sign sticker reads "Serviced by Waves") is
// our own name, which every report may say (prod 2026-10-02: every draft of a
// visit whose notes said "along with" was refused, so the report failed).
const ORDINARY_NAME_WORDS = new Set([
  'with', 'from', 'into', 'onto', 'over', 'under', 'that', 'this', 'these',
  'those', 'your', 'their', 'them', 'they', 'have', 'will', 'were', 'been',
  'when', 'then', 'than', 'also', 'only', 'each', 'most', 'more', 'some',
  'such', 'very', 'just', 'about', 'after', 'before', 'where', 'which',
  'while', 'until', 'upon', 'without', 'within', 'through', 'other', 'there',
  'here', 'what', 'both', 'even', 'back', 'around', 'along', 'across',
  'between', 'among', 'every', 'made', 'make', 'used', 'using', 'waves',
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
  'rodent', 'rodents', 'mosquito', 'mosquitos', 'mosquitoes', 'ant', 'ants',
  'flea', 'fleas', 'tick', 'ticks', 'spider', 'spiders', 'wasp', 'wasps',
  'hornet', 'hornets', 'bee', 'bees', 'mouse', 'mice', 'rat', 'rats', 'wildlife', 'station',
  'stations', 'trap', 'traps', 'perimeter', 'barrier', 'outdoor',
  'indoor', 'yard', 'granular', 'granules', 'gel',
  'wetting', 'agent', 'sprayable', 'spreader', 'sticker', 'adjuvant',
  'care', 'guard', 'shield', 'defense', 'complete', 'advance', 'advanced',
  'zone', 'zones', 'select', 'super', 'total', 'ultra', 'prime',
  'green', 'blue', 'red', 'black', 'white', 'gold', 'silver',
]);
// Catalog-wide brand screen (writer rules: no product may be named, not only
// this visit's). A catalog name that is NOT one of this visit's is matched
// far more narrowly than the visit's own, because most words inside catalog
// names are ordinary report vocabulary ("snap", "trap", "distance",
// "southern"):
//   - the name, its leading two tokens, or a hyphenated single-letter
//     designation anywhere in it ("T-Rex"), as a phrase ("Demand CS",
//     "T-Zone") or as one collapsed word ("BoraCare"), any case; and
//   - its brand word alone (the first word, "Termidor", "Trapper", or the
//     second when a maker's name comes first, "Talak" in "Atticus Talak")
//     only where the text writes it capitalized in the middle of a sentence. A
//     lowercase or sentence-opening use ("Suspend watering for 24 hours",
//     "keep your distance") is ordinary wording and passes; and
//   - two capitalized words side by side anywhere in it ("Green Flo"), as
//     the catalog writes them.
// In an all-capitals line every word is capitalized, so a brand word inside
// it is caught and an ordinary use there ("PLEASE SUSPEND WATERING") is too.
// A product the prompt itself names is the caller's to add to the visit's
// own full screen (extraNames), as before this screen existed.
// Known limit, accepted: a brand word the prompt never names that opens a
// sentence, or is written lowercase, is not caught by this screen.
const REPORT_SECTION_HEADINGS = new Set([
  'WHAT WE FOUND', 'WHAT WE DID', 'WHAT WE DID AND WHY', 'WHAT TO EXPECT', 'WHATS NEXT',
]);
const screenTokens = (value) => String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const screenCasedWords = (value) => String(value || '').match(/[A-Za-z0-9]+/g) || [];
// Punctuation-collapsed echoes are one word in the copy: "BoraCare" for
// "Bora-Care", "TZone" for "T-Zone SE" (the visit screen's collapsedEcho
// rule: four letters or more, or a digit).
const screenCollapsible = (word) => word.length >= 4 || /\d/.test(word);
// A label as the catalog cases it, or in all capitals; two words or more.
function screenAsWritten(label) {
  const cased = screenCasedWords(label).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (cased.length < 2) return null;
  const forms = [...new Set([cased, cased.map((word) => word.toUpperCase())].map((words) => words.join('[\\s-]+')))];
  return new RegExp(`(?<![A-Za-z0-9])(?:${forms.join('|')})(?![A-Za-z0-9])`);
}
// Which words of a catalog name are plain report vocabulary.
function catalogPlainTests(rows, genericTokens) {
  const generic = new Set(genericTokens);
  for (const row of rows) {
    screenTokens(row?.active_ingredient).filter((tok) => tok.length >= 4).forEach((tok) => generic.add(tok));
  }
  const isPlain = (token) => generic.has(token) || GENERIC_NAME_TOKENS.has(token)
    || COMMON_PRODUCT_NAME_WORDS.has(token) || /^\d+$/.test(token);
  // A name made only of plain words ("Non-ionic Surfactant", where the pair
  // collapses to the generic "nonionic"; "Advance Termite Bait Station") is
  // ordinary copy in lowercase and a name only as the catalog writes it.
  const whollyPlain = (tokens) => tokens.every((token, i) => isPlain(token)
    || (i + 1 < tokens.length && isPlain(`${token}${tokens[i + 1]}`))
    || (i > 0 && isPlain(`${tokens[i - 1]}${token}`)));
  return { isPlain, whollyPlain };
}
const aliasLabel = (alias) => String(alias || '').split(':').pop().trim();
// Returns a test: does the prompt write this alias out, in any case?
function promptAliasTest(promptText) {
  const promptHay = ` ${screenTokens(promptText).join(' ')} `;
  return (alias) => {
    const tokens = screenTokens(aliasLabel(alias));
    return tokens.length > 0 && promptHay.includes(` ${tokens.join(' ')} `);
  };
}
// Every label the catalog knows a product by.
function catalogScreenLabels(rows) {
  const named = [];
  for (const row of rows) {
    // Signs, stickers and stakes are not products.
    if (isSupplyCategory(row?.category)) continue;
    // The short display name is what a technician sees on the product card
    // ("Arena 0.25G Granular" for the Nufarm row): it is a name of the same
    // product and is screened as one.
    const labels = new Set([row?.name, row?.display_name].filter(Boolean));
    for (const label of labels) named.push({ name: row.name, label, alias: false });
    // Registered aliases ("Talstar P" for Atticus Talak) name the product
    // too. They are shorthand typed by staff or copied from a protocol
    // ("Premium: Dispatch wetting agent", "Dismiss if sedge", "Organic
    // acidifier"), so an alias is matched only as written, capitals and
    // all, or by its brand word; a note before a colon is dropped.
    for (const alias of new Set(Array.isArray(row?.aliases) ? row.aliases : [])) {
      const label = aliasLabel(alias);
      if (label && !labels.has(label)) named.push({ name: row.name, label, alias: true });
    }
  }
  return named;
}
// Two capitalized words side by side anywhere in the name ("Green Flo" in
// "LESCO Green Flo 6-0-0 10% Ca") are a name as the catalog writes them,
// unless both are plain. Lowercase copy ("rat snap traps") passes.
function capitalizedPairs(label, whollyPlain) {
  const words = screenCasedWords(label);
  const pairs = [];
  for (let i = 0; i + 1 < words.length; i += 1) {
    const pair = [words[i], words[i + 1]];
    if (!pair.every((word) => /^[A-Z][A-Za-z]+$/.test(word))) continue;
    if (!whollyPlain(pair.map((word) => word.toLowerCase()))) pairs.push(screenAsWritten(pair.join(' ')));
  }
  return pairs;
}
// The any-case phrases and collapsed words of a catalog name.
function addNamePhrases(entry, label, tokens, { isPlain, whollyPlain }) {
  const add = (parts) => {
    entry.phrases.push(` ${parts.join(' ')} `);
    if (screenCollapsible(parts.join(''))) entry.collapsed.push(parts.join(''));
  };
  if (tokens.length >= 2) add(tokens);
  // The leading pair is a name only when it opens on the brand or a short
  // designation ("T-Zone", "PGF Complete"); a pair that opens on a plain
  // word ("termite protection", "yard sign") is ordinary copy.
  if (tokens.length >= 2 && !isPlain(tokens[0])) add(tokens.slice(0, 2));
  // A hyphenated designation anywhere in the name is an alias of its own
  // ("T-Rex" in "Trapper T-Rex Rat Snap Trap", "G-4"): a single letter
  // joined to a word is a coined term, never ordinary copy. Compounds of
  // whole words ("pre-emergent", "three-way") are not.
  for (const compound of String(label).match(/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g) || []) {
    const parts = screenTokens(compound);
    if (parts.some((part) => /^[a-z]$/.test(part)) && !whollyPlain(parts)) add(parts);
  }
}
// What one label is screened by, or null when nothing in it is a name.
function catalogBrandEntry({ name, label, alias }, plain, promptHay) {
  const tokens = screenTokens(label);
  if (!tokens.length) return null;
  const entry = { name, brands: [], phrases: [], collapsed: [], pairs: [], exact: null, stem: null };
  const allPlain = plain.whollyPlain(tokens);
  // An alias the prompt itself writes out is screened in any case: the copy
  // was written from a note that names it.
  if (alias && (tokens.length >= 2 || !allPlain) && promptHay.includes(` ${tokens.join(' ')} `)) {
    entry.phrases.push(` ${tokens.join(' ')} `);
    if (tokens.length >= 2 && screenCollapsible(tokens.join(''))) entry.collapsed.push(tokens.join(''));
  }
  if (allPlain) {
    // The label as the catalog cases it ("Advance Termite Bait Station"),
    // or its capitalized first word mid-sentence followed by another word
    // of the name ("installed Advance bait stations"). Lowercase copy ("a
    // non-ionic surfactant", "in advance of") passes.
    entry.exact = screenAsWritten(label);
    if (entry.exact) {
      entry.stem = { lead: tokens[0], followers: tokens.slice(1).filter((tok) => tok.length >= 3 && !/^\d+$/.test(tok)) };
    }
    return entry.exact || entry.phrases.length ? entry : null;
  }
  // The brand word is the name's first word, or its second when a maker's
  // name comes first ("Talak" in "Atticus Talak", "Polyzone" in "Suspend
  // Polyzone"). An alias gives its first word only: what follows may be a
  // protocol note ("Topchoice fall app", "Headway ONLY if severe").
  entry.brands = tokens.slice(0, alias ? 1 : 2).filter((token) => token.length >= 4 && !plain.isPlain(token));
  entry.pairs = capitalizedPairs(label, plain.whollyPlain);
  if (alias) {
    entry.exact = screenAsWritten(label);
    return entry.exact || entry.brands.length || entry.pairs.length || entry.phrases.length ? entry : null;
  }
  addNamePhrases(entry, label, tokens, plain);
  return entry;
}
// Whether the capitalized word at index opens its line, a sentence or a list
// item (it then reads as an ordinary word), or sits in a section heading.
function opensSentence(raw, index) {
  const lineStart = raw.lastIndexOf('\n', index) + 1;
  const lineEndAt = raw.indexOf('\n', index);
  const line = raw.slice(lineStart, lineEndAt === -1 ? raw.length : lineEndAt);
  // The report's own section headings are not sentences. Any other
  // all-capitals line is copy and is read like the rest.
  if (REPORT_SECTION_HEADINGS.has(line.replace(/[^A-Za-z ]+/g, '').trim().replace(/\s+/g, ' ').toUpperCase())) return true;
  const before = raw.slice(lineStart, index).replace(/[\s"'“”‘’(\[*_•\-–—]+$/u, '');
  return !before || /[.!?:;]$/.test(before) || /^\d+$/.test(before);
}
// One read of a text: its words, and the words it writes capitalized in the
// middle of a sentence.
function readScreenText(text) {
  const raw = String(text || '');
  const words = screenTokens(raw);
  const midSentenceCapitalized = new Set();
  // "<capitalized mid-sentence word> <the word after it>", both lowercased.
  const midSentencePairs = new Set();
  const wordRe = /[A-Za-z0-9]+/g;
  let match;
  while ((match = wordRe.exec(raw)) !== null) {
    if (!/^[A-Z]/.test(match[0]) || opensSentence(raw, match.index)) continue;
    midSentenceCapitalized.add(match[0].toLowerCase());
    const next = /^[^A-Za-z0-9\n]*([A-Za-z0-9]+)/.exec(raw.slice(match.index + match[0].length));
    if (next) midSentencePairs.add(`${match[0].toLowerCase()} ${next[1].toLowerCase()}`);
  }
  return {
    raw, normHay: ` ${words.join(' ')} `, wordSet: new Set(words), midSentenceCapitalized, midSentencePairs,
  };
}
function entryNamedIn(entry, read) {
  if (entry.phrases.some((phrase) => read.normHay.includes(phrase))) return true;
  if (entry.collapsed.some((word) => read.wordSet.has(word))) return true;
  if (entry.brands.some((brand) => read.midSentenceCapitalized.has(brand))) return true;
  if (entry.exact !== null && entry.exact.test(read.raw)) return true;
  if (entry.pairs.some((pair) => pair.test(read.raw))) return true;
  return entry.stem !== null && entry.stem.followers.some((tok) => read.midSentencePairs.has(`${entry.stem.lead} ${tok}`)
    || read.midSentencePairs.has(`${entry.stem.lead} ${tok}s`));
}
// mentionedText is the prompt the copy was written from, when there is one.
function buildCatalogBrandScreen(rows, genericTokens, mentionedText = '') {
  const plain = catalogPlainTests(rows, genericTokens);
  const promptHay = ` ${screenTokens(mentionedText).join(' ')} `;
  const entries = catalogScreenLabels(rows)
    .map((labelled) => catalogBrandEntry(labelled, plain, promptHay))
    .filter(Boolean);
  // The maker's name ("Syngenta", "BASF") is a brand too: capitalized
  // mid-sentence, or in any case when the prompt itself writes it.
  const makers = [...new Set(rows.flatMap((row) => screenTokens(row?.manufacturer)))]
    .filter((token) => token.length >= 4 && !plain.isPlain(token));
  if (makers.length) {
    entries.push({
      name: 'manufacturer',
      brands: makers,
      phrases: makers.filter((maker) => promptHay.includes(` ${maker} `)).map((maker) => ` ${maker} `),
      collapsed: [], pairs: [], exact: null, stem: null,
    });
  }
  return (text) => {
    if (!text) return false;
    const read = readScreenText(text);
    return entries.some((entry) => entryNamedIn(entry, read));
  };
}

// Catalog rows for the catalog-wide screen, each carrying its registered
// product_aliases names as row.aliases.
function withCatalogAliases(catalogRows, aliasRows) {
  const byProduct = new Map();
  for (const alias of Array.isArray(aliasRows) ? aliasRows : []) {
    if (!alias?.product_id || !alias?.alias_name) continue;
    const key = String(alias.product_id);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(alias.alias_name);
  }
  return (Array.isArray(catalogRows) ? catalogRows : [])
    .map((row) => ({ ...row, aliases: byProduct.get(String(row?.id)) || [] }));
}

async function readCatalogScreenRows(db) {
  if (!db) throw new Error('catalog-wide trade-name screen needs a catalog read');
  return withCatalogAliases(
    await savepointRead(db, (k) => k('products_catalog').select('id', 'name', 'display_name', 'active_ingredient', 'category', 'manufacturer')),
    await savepointRead(db, (k) => k('product_aliases').select('product_id', 'alias_name')),
  );
}

// Builds a screen(text) predicate for THIS visit's recorded products.
// Generic tokens widen with the visit's own recorded treatment targets and
// (via db) catalog actives/formulations — active ingredients are permitted
// report wording even when the trade name IS the active. Products carrying
// only a productId are name-hydrated from the catalog so they are screened
// too. Chunked by 10 so safeProducts' cap never leaves an entry
// unscreened. Catalog lookup failure keeps the guard strict.
// The catalog's non-product rows (yard signs, stakes, stickers).
const isSupplyCategory = (category) => String(category || '').trim().toLowerCase() === 'supplies';

// wholeCatalog adds the catalog-wide brand screen above; catalogRows lets a
// caller that already read the catalog pass it in (withCatalogAliases rows);
// mentionedText is the prompt the copy was written from, so an alias the
// prompt writes out is screened in any case. A failed catalog read
// throws: the screen cannot run complete, so the caller fails closed.
async function buildReportTradeNameScreen({ wholeCatalog = false, catalogRows = null, mentionedText = '', ...visit } = {}) {
  const { visitScreen, genericTokens } = await buildVisitTradeNameScreen(visit);
  if (!wholeCatalog) return visitScreen;
  const rows = catalogRows || await readCatalogScreenRows(visit.db);
  const catalogScreen = buildCatalogBrandScreen(rows, genericTokens, mentionedText);
  return (text) => visitScreen(text) || catalogScreen(text);
}

// This visit's own products, screened in full.
async function buildVisitTradeNameScreen({ products = [], extraNames = [], db = null } = {}) {
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
    let rows = [];
    try {
      const ids = list.map((p) => p?.productId).filter(Boolean);
      rows = ids.length
        ? await savepointRead(db, (k) => k('products_catalog')
          .whereIn('id', ids)
          .select('id', 'name', 'active_ingredient', 'formulation', 'category'))
        : [];
    } catch (err) {
      // A failed lookup loses two different things: exemption tokens
      // (guard gets STRICTER — safe to continue) and hydrated names for
      // id-only entries (guard gets WEAKER — their trade names would go
      // unscreened). When any entry depends on hydration for its name the
      // error must propagate so the caller drops the copy instead of
      // approving it (codex r49); otherwise continue exemption-less.
      if (list.some((p) => p && !p.name && !p.product_name && p.productId)) throw err;
      rows = [];
    }
    const nameById = new Map((rows || []).map((r) => [String(r.id), r.name]));
    // A supply recorded on the visit (a yard sign, its stake or sticker) is
    // no product a report could name, and its words ("pesticide application
    // sign") are ordinary report words.
    const supplyIds = new Set((rows || []).filter((r) => isSupplyCategory(r.category)).map((r) => String(r.id)));
    hydrated = list
      .filter((p) => !(p?.productId && supplyIds.has(String(p.productId))))
      .map((p) => (p && !p.name && !p.product_name && p.productId
        ? { ...p, name: nameById.get(String(p.productId)) || null }
        : p));
    for (const row of rows || []) {
      `${row.active_ingredient || ''} ${row.formulation || ''}`
        .toLowerCase().split(/[^a-z0-9]+/)
        .filter((tok) => tok.length >= 4)
        .forEach((tok) => genericTokens.add(tok));
    }
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
  const visitScreen = (text) => chunks.some((chunk) => containsProductName(text, chunk, { extraGenericTokens: genericTokens, wholeWord: true }));
  return { visitScreen, genericTokens };
}

module.exports = {
  buildPrompt,
  buildReportTradeNameScreen,
  containsProductName,
  isSupplyCategory,
  composeCompletionSmsPreview,
  deterministicRecap,
  generateRecap,
  normalizeOutcome,
  promptAliasTest,
  sanitizeRecap,
  smsRecap,
  SMS_RECAP_MAX_CHARS,
  withCatalogAliases,
};
