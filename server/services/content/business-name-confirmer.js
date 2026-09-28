/**
 * business-name-confirmer.js — lists every home-service COMPANY a blog draft
 * names, links or references (owner rulings 2026-09-27 D2 + 2026-09-28: an
 * unattended competitor blog may name only the six owner-approved
 * competitors in competitor-facts OWNER_APPROVED_AUTOPUBLISH_IDS).
 *
 * Why a model and not a detector: whether a phrase is a company ("Bug Out
 * competes with local providers", "Lawn Doctor" used both as a company and
 * as a generic term, a /hulett-alternatives/ slug) is a language judgement
 * no word list converges on (Codex r1–r3 on #5146). The comparison-table
 * gate keeps its deterministic curated / operator / link detection for the
 * named-competitor FLAG and the audit trail; this extraction only ADDS
 * names, which namedCompetitorListVerdict holds to the owner list.
 *
 * One structured FAST-tier call per unattended blog draft (about ten a
 * week), on the fastStructured two-provider policy, lane
 * business_name_confirm. The input is every text field of the frontmatter
 * that ships (the publisher's own normalizer) plus the writer's raw
 * frontmatter and top-level metadata, the link destinations, and the body,
 * bounded to MAX_INPUT_CHARS.
 *
 * Result: { ok: true, key, companies: [canonical name…], checked_at } or
 * { ok: false, key, reason, retryable }. `key` hashes the exact input sent;
 * a stored result with the same key is returned without a call, so the
 * merge-time poller never re-calls and a Codex fix that leaves the text
 * unchanged reuses the run's extraction. Never throws.
 */

const crypto = require('node:crypto');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');
const competitorFacts = require('./competitor-facts');

// A supporting blog runs ~10–15k characters; anything past this bound is
// not a normal draft and is not truncated (a name past the cut would be
// unseen) — it fails closed instead.
const MAX_INPUT_CHARS = 60_000;
const CALL_TIMEOUT_MS = 30_000;
const PROMPT_VERSION = 'company-extraction-v2';

// Our OWN names, matched as exact whole names (case/punctuation-insensitive)
// — never "contains the word Waves" (pre-push r4: "Making Waves Pest
// Control" is somebody else). Sources: the company name, each GBP profile
// ("Waves Pest Control <location>", config/locations.js), and every fleet
// site's brand label + domain (content-astro/spoke-sites.js).
function normalizeOwnName(value) {
  return String(value || '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
    .replace(/^the\s+/, '').replace(/[^a-z0-9.]+/g, ' ').trim();
}
let OWN_NAMES = null;
function ownNames() {
  if (OWN_NAMES) return OWN_NAMES;
  const names = ['Waves', 'Waves Pest Control', 'Waves Pest Control, LLC'];
  try {
    for (const loc of require('../../config/locations').WAVES_LOCATIONS || []) {
      if (loc && loc.name) names.push(`Waves Pest Control ${loc.name}`);
    }
  } catch { /* locations unavailable — the fixed names still apply */ }
  try {
    for (const site of require('../content-astro/spoke-sites').SPOKE_SITES || []) {
      names.push(site.key);
      if (site.group !== 'Hub' && site.label) names.push(site.label);
    }
  } catch { /* fleet unavailable — the fixed names still apply */ }
  OWN_NAMES = new Set(names.map(normalizeOwnName).filter(Boolean));
  return OWN_NAMES;
}

const SYSTEM_PROMPT = [
  'You review a blog draft written for Waves Pest Control, a Florida pest control and lawn care company that also publishes under local site names such as "Sarasota Pest Control" and "Bradenton Lawn Care".',
  'List every pest control, lawn care, landscaping, termite, mosquito, wildlife, or other home-service COMPANY that the draft names, links to, or refers to — in the title, slug/URL, meta description, body, or link destinations.',
  'Include a company even when it is named only once, only in a link or URL slug, or only in a heading, and include it if ANY use in the draft refers to the company (a name used generically in one sentence and as a company in another is still a company).',
  'Do NOT list: Waves Pest Control or its own websites; retailers (e.g. Home Depot, Lowe\'s, Amazon); universities, extension services, government bodies, and laws; product or chemical brands; publications and news outlets; generic service phrases or methods ("pest control", "Biological Pest Control", "Yard Mosquito Control").',
  'Return each company once, spelled as the draft spells it. Return an empty list when the draft names no such company.',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['companies'],
  properties: {
    companies: { type: 'array', items: { type: 'string' } },
  },
};

const LINK_RE = /https?:\/\/[^\s)"'<>\]]+/gi;

// Every string (and string inside an array or object) of a frontmatter
// value, as `path: value` lines. Dates / numbers / booleans are skipped.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;
function textFields(value, path, out) {
  if (typeof value === 'string') {
    if (value.trim() && !ISO_DATE_RE.test(value.trim())) out.push(`${path}: ${value.trim()}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => textFields(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) textFields(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

// The frontmatter that SHIPS: the publisher's own normalizer
// (astro-publisher normalizeAutonomousBlogFrontmatter — the whitelist
// publishOrUpdatePage commits, including brief-derived defaults such as
// primary_keyword from the brief's target keyword), so a field added there
// is scanned without touching this module. The writer's raw frontmatter and
// top-level metadata are scanned too (pre-push r7), since the two shapes can
// disagree. Normalizer unavailable → raw fields only, still every field.
function publishedFrontmatter(draft, brief) {
  const fm = draft?.frontmatter || {};
  try {
    const { _internals } = require('../content-astro/astro-publisher');
    const slug = String(fm.slug || draft?.url || '').replace(/^\/+|\/+$/g, '');
    return _internals.normalizeAutonomousBlogFrontmatter(fm, brief || {}, String(draft?.body || ''), { slug, canonical: fm.canonical });
  } catch (_) {
    return {};
  }
}

/** extractionInput(draft, brief) → the exact text sent (null when over the bound). */
function extractionInput(draft, brief = null) {
  const body = String(draft?.body || draft?.content || '');
  const links = [...new Set(body.match(LINK_RE) || [])];
  const topLevel = {
    title: draft?.title, meta_description: draft?.meta_description, url: draft?.url, slug: draft?.slug,
    metaTitle: draft?.metaTitle, metaDescription: draft?.metaDescription,
  };
  const lines = [...new Set([
    ...textFields(publishedFrontmatter(draft, brief), '', []),
    ...textFields(draft?.frontmatter || {}, '', []),
    ...textFields(topLevel, '', []),
  ])];
  const text = [
    `FRONTMATTER AND METADATA:\n${lines.join('\n')}`,
    `LINK DESTINATIONS:\n${links.join('\n')}`,
    `BODY:\n${body}`,
  ].join('\n\n');
  return text.length > MAX_INPUT_CHARS ? null : text;
}

function inputKey(text) {
  return crypto.createHash('sha256').update(`${PROMPT_VERSION}\u0000${text}`).digest('hex');
}

// Canonical curated name when the extraction names a curated competitor
// (alias spellings like "Massey" → "Massey Services"), else the name as
// written. Own-brand mentions are dropped.
function canonicalCompanies(names) {
  const out = new Set();
  for (const raw of names) {
    const nm = String(raw || '').trim();
    if (!nm || ownNames().has(normalizeOwnName(nm))) continue;
    out.add(competitorFacts.findCompetitor(nm)?.name || nm);
  }
  return [...out].sort();
}

/**
 * extractCompanyNames(draft, { prior }) — see the module header.
 * `retryable: true` marks provider / output failures (an outage should
 * delay the post); an over-long draft is `retryable: false`.
 */
async function extractCompanyNames(draft, { prior = null, brief = null } = {}) {
  const text = extractionInput(draft, brief);
  if (text === null) return { ok: false, key: null, reason: 'draft_too_long_for_extraction', retryable: false };
  const key = inputKey(text);
  if (prior && prior.ok === true && prior.key === key && Array.isArray(prior.companies)) return prior;
  try {
    const result = await dispatchWithFallback(
      MODELS.TEXT_POLICIES.fastStructured,
      {
        laneId: 'business_name_confirm',
        maxTokens: 800,
        jsonMode: true,
        jsonSchema: RESPONSE_SCHEMA,
        timeoutMs: CALL_TIMEOUT_MS,
        system: SYSTEM_PROMPT,
        text,
      },
      { validate: (r) => (Array.isArray(r?.json?.companies) && r.json.companies.every((c) => typeof c === 'string') ? null : 'missing_companies') },
    );
    const companies = result?.json?.companies;
    if (!result?.ok || !Array.isArray(companies) || !companies.every((c) => typeof c === 'string')) {
      const reason = String(result?.reason || 'invalid_json').slice(0, 200);
      logger.warn(`[business-name-confirmer] extraction failed (${reason}) — draft deferred`);
      return { ok: false, key, reason, retryable: true };
    }
    return { ok: true, key, companies: canonicalCompanies(companies), checked_at: new Date().toISOString() };
  } catch (err) {
    logger.warn(`[business-name-confirmer] extraction threw (${err.message}) — draft deferred`);
    return { ok: false, key, reason: `threw:${String(err.message).slice(0, 180)}`, retryable: true };
  }
}

module.exports = {
  extractCompanyNames,
  _internals: { SYSTEM_PROMPT, MAX_INPUT_CHARS, extractionInput, inputKey, canonicalCompanies, ownNames, normalizeOwnName },
};
