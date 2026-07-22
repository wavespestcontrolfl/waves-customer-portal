/**
 * AI-written "What we applied today" narrative (owner 2026-07-21: the
 * template sentence was weak — the customer should hear WHY each product was
 * chosen for what we found, WHAT it does in plain mechanism language, and the
 * BENEFIT to expect). Generated once per (service record, inputs) with the
 * report writer policy (GPT-5.6 Sol → Claude Opus), banned-copy validated,
 * cached in service_report_ai_summaries, and ALWAYS falling back to the
 * deterministic buildTreatmentSummary sentence — a report never renders
 * without an applied-solutions line because a model was down.
 */
const crypto = require('crypto');
const db = require('../../models/db');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');
const { buildTreatmentSummary, METHOD_PHRASES } = require('./treatment-summary');
const { findBannedCustomerCopy } = require('./activity-indicators');

const PROMPT_VERSION = 'treatment_narrative_v1';

// Request-path budget: a report read ships the deterministic sentence after
// this long and lets generation finish in the background.
const REQUEST_BUDGET_MS = 4000;

// Same over-claim vocabulary the other customer-copy validators enforce,
// plus rate/registration leakage ("2 oz", "EPA Reg. No.").
const FORBIDDEN = [
  /\b(safe|non-?toxic|harmless|eliminated?|eradicated?|guaranteed?|pest-?free|cure[sd]?|permanent(ly)?)\b/i,
  // Confirmed-diagnosis vocabulary — the narrative stays signals-scoped even
  // if the vision observations leak an overclaim (codex P2 2026-07-22).
  /\b(infestation|infested|infection|infected|diseased)\b/i,
  /\bchemicals?\b/i,
  /\b\d+(\.\d+)?\s*(oz|ounces?|ml|gal|gallons?|lbs?|pounds?)\b/i,
  /\bepa\b/i,
  /\$\s?\d/,
];

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function cleanLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

// Products are identified to the model by ACTIVE INGREDIENT (label
// percentage stripped) or kind — never the trade name, so the model cannot
// echo a brand into the customer copy (codex P2 2026-07-22).
function activeIdentifier(p = {}) {
  const active = cleanLine(p.activeIngredient).replace(/\s*\d+(\.\d+)?\s*%.*$/, '').trim();
  if (active) return active.toLowerCase();
  if (p.kind && p.kind !== 'other') return `a ${p.kind.replace(/_/g, ' ')} product`;
  return 'a treatment product';
}

function productFactLines(products = []) {
  return products.map((p) => {
    const parts = [
      p.kind && p.kind !== 'other' ? p.kind.replace(/_/g, ' ') : null,
      p.method ? `method: ${METHOD_PHRASES[String(p.method).toLowerCase()] || cleanLine(p.method).replace(/_/g, ' ')}` : null,
      (p.targets || []).length ? `targets: ${p.targets.map(cleanLine).join(', ')}` : null,
      p.whatItDoes ? `role: ${cleanLine(p.whatItDoes)}` : null,
    ].filter(Boolean);
    return `- ${activeIdentifier(p)}${parts.length ? ` — ${parts.join('; ')}` : ''}`;
  }).join('\n');
}

function buildTreatmentNarrativePrompt({ serviceLine, products, findingsText, photoSummary }) {
  const lineNoun = serviceLine === 'lawn' ? 'lawn' : serviceLine === 'tree_shrub' ? 'landscape plants (trees, shrubs, palms, and beds)' : 'property';
  return `You are writing the "What we applied today" section of a customer-facing service report for Waves Pest Control & Lawn Care in Southwest Florida. The reader is the homeowner; the subject is their ${lineNoun}.

Explain the treatment like a knowledgeable, friendly plant-health professional:
- WHY each product was chosen, tied directly to what was found on this visit.
- WHAT each product does, in plain mechanism language (for example: absorbed by the roots and carried through the plant so pests that feed on it are controlled; a contact spray that coats the leaves; stops insects from feeding within days).
- The BENEFIT the customer should expect and roughly when — what should improve over the coming weeks, and what they might still see in the meantime.

Rules:
- 3 to 5 sentences, one paragraph, plain text only. No headings, bullets, greeting, or sign-off.
- NEVER use brand or trade names. Refer to each product by its active ingredient in plain language (e.g. "a dinotefuran soil drench", "a spirotetramat foliar treatment") — the product cards elsewhere on the report carry the brand names.
- NEVER include application rates, quantities, prices, EPA details, or the word "chemical".
- Never say safe, non-toxic, eliminated, guaranteed, pest-free, or cured. Never promise results — use "designed to", "should", "you can expect".
- Ground every claim in the findings and products below. Do not invent findings, pests, or products.

What we found on this visit:
${findingsText || '[routine visit — no significant findings recorded]'}

Products applied:
${productFactLines(products)}

Photo observations (context): ${cleanLine(photoSummary) || '[none]'}

Return only the paragraph.`;
}

const GENERIC_NAME_TOKENS = new Set([
  'insecticide', 'herbicide', 'fungicide', 'fertilizer', 'granular', 'liquid',
  'concentrate', 'spray', 'nonionic', 'surfactant', 'miticide', 'insect',
  'control', 'plus', 'pro', 'max', 'maxx', 'lawn', 'turf', 'palm', 'tree',
  'shrub', 'weed', 'grass', 'pest', 'oil', 'emulsion', 'systemic',
]);

function validateNarrative(text, productNames = []) {
  const t = String(text || '').trim();
  if (!t) return 'empty';
  if (t.length > 1200) return 'too_long';
  if (FORBIDDEN.some((re) => re.test(t))) return 'forbidden_copy';
  // Brand-name echo check: any distinctive token of a recorded product name
  // appearing in the copy fails the actives-only contract (codex P3).
  const hay = t.toLowerCase();
  const echoed = productNames.some((name) => String(name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !GENERIC_NAME_TOKENS.has(token))
    .some((token) => hay.includes(token)));
  if (echoed) return 'trade_name';
  const banned = findBannedCustomerCopy(t);
  if (banned.length) return `banned:${banned.join(',')}`;
  return null;
}

/**
 * Returns the narrative string (AI when available+valid, else the
 * deterministic template). Never throws; never returns '' when the visit
 * had classified products.
 */
async function buildTreatmentNarrative({
  serviceRecordId,
  serviceLine,
  treatment,
  findingsText = '',
  photoSummary = '',
  knex = db,
} = {}) {
  const fallback = buildTreatmentSummary(treatment);
  if (!fallback) return null;
  const products = (treatment?.products || []);
  if (!serviceRecordId) return fallback;

  try {
    const facts = {
      serviceLine,
      products: products.map((p) => ({
        name: p.name, kind: p.kind, activeIngredient: p.activeIngredient,
        method: p.method, targets: p.targets, whatItDoes: p.whatItDoes,
      })),
      findingsText: cleanLine(findingsText),
      photoSummary: cleanLine(photoSummary),
    };
    const inputHash = crypto.createHash('sha256').update(stableStringify(facts)).digest('hex');
    const keyWhere = { service_record_id: serviceRecordId, input_hash: inputHash, prompt_version: PROMPT_VERSION };
    const existing = await knex('service_report_ai_summaries')
      .where(keyWhere)
      .first()
      .catch(() => null);
    if (existing?.summary_json) {
      // 'pending' rows carry the deterministic text — another read owns the
      // in-flight generation, so serve what's there and never fan out a
      // duplicate model call (pre-push audit P1 2026-07-21).
      const parsed = typeof existing.summary_json === 'string' ? JSON.parse(existing.summary_json) : existing.summary_json;
      if (parsed?.text) return parsed.text;
      return fallback;
    }

    // Atomically claim the cache key: exactly ONE reader generates.
    const claimed = await knex('service_report_ai_summaries').insert({
      ...keyWhere,
      model: null,
      status: 'pending',
      summary_json: JSON.stringify({ text: fallback, mode: 'pending' }),
      validation_json: JSON.stringify({ problem: null }),
      generated_at: new Date(),
    }).onConflict(['service_record_id', 'input_hash', 'prompt_version']).ignore().returning('service_record_id').catch(() => []);
    if (!Array.isArray(claimed) || !claimed.length) return fallback;

    const generate = (async () => {
      const prompt = buildTreatmentNarrativePrompt({
        serviceLine,
        products,
        findingsText: facts.findingsText,
        photoSummary: facts.photoSummary,
      });
      const productNames = products.map((p) => p.name).filter(Boolean);
      const generated = await dispatchWithFallback(
        MODELS.TEXT_POLICIES.report,
        { text: prompt, jsonMode: false, maxTokens: 400 },
        { validate: (result) => validateNarrative(result.text, productNames) },
      );
      const text = generated.ok ? String(generated.text || '').trim() : '';
      const problem = text ? validateNarrative(text, productNames) : 'generation_failed';
      const finalText = problem ? fallback : text;
      await knex('service_report_ai_summaries').where(keyWhere).update({
        model: problem ? null : 'text_policy:report',
        status: problem ? 'fallback' : 'ok',
        summary_json: JSON.stringify({ text: finalText, mode: problem ? 'deterministic_fallback' : 'ai' }),
        validation_json: JSON.stringify({ problem: problem || null }),
        generated_at: new Date(),
      }).catch(() => {});
      return finalText;
    })();

    // The report read never waits more than a few seconds (the dispatcher
    // alone can spend minutes): AI within budget ships on this read;
    // otherwise the deterministic sentence ships NOW and the generation
    // finishes in the background — the cache row serves the AI text to
    // every later read (pre-push audit P1 2026-07-21).
    let timer;
    const timed = await Promise.race([
      generate.catch(() => fallback),
      new Promise((resolve) => { timer = setTimeout(resolve, REQUEST_BUDGET_MS, null); }),
    ]);
    clearTimeout(timer);
    generate.catch(() => {});
    return timed || fallback;
  } catch {
    return fallback;
  }
}

/**
 * PDF cache-key component (audit P2 2026-07-22): the narrative can ship its
 * deterministic fallback inside the request budget and land the AI text in
 * the cache moments later — a PDF stored against the fallback must re-render
 * once the final text exists. status+generated_at of the LATEST row for this
 * record changes exactly then.
 */
async function treatmentNarrativePdfSignature(serviceRecordId, knex = db) {
  try {
    if (!serviceRecordId) return '';
    const row = await knex('service_report_ai_summaries')
      .where({ service_record_id: serviceRecordId, prompt_version: PROMPT_VERSION })
      .orderBy('generated_at', 'desc')
      .first('status', 'generated_at');
    if (!row) return '';
    const stamp = new Date(row.generated_at || 0).getTime();
    return `-tn${row.status || 'x'}${Number.isFinite(stamp) ? stamp : 0}`;
  } catch {
    return '';
  }
}

module.exports = {
  treatmentNarrativePdfSignature,
  PROMPT_VERSION,
  buildTreatmentNarrative,
  buildTreatmentNarrativePrompt,
  validateNarrative,
};
