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
 * business_name_confirm. The input is the title, slug / URL path, meta
 * description, body and link destinations, bounded to MAX_INPUT_CHARS.
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
const PROMPT_VERSION = 'company-extraction-v1';
const OWN_BRAND_RE = /\bwaves\b/i;

const SYSTEM_PROMPT = [
  'You review a blog draft written for Waves Pest Control, a Florida pest control and lawn care company.',
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

/** extractionInput(draft) → the exact text sent (null when over the bound). */
function extractionInput(draft) {
  const fm = draft?.frontmatter || {};
  const body = String(draft?.body || draft?.content || '');
  const links = [...new Set(body.match(LINK_RE) || [])];
  const text = [
    `TITLE: ${draft?.title || fm.title || ''}`,
    `SLUG / URL: ${[fm.slug, draft?.slug, draft?.url].filter(Boolean).join(' ')}`,
    `META DESCRIPTION: ${draft?.meta_description || fm.meta_description || ''}`,
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
    if (!nm || OWN_BRAND_RE.test(nm)) continue;
    out.add(competitorFacts.findCompetitor(nm)?.name || nm);
  }
  return [...out].sort();
}

/**
 * extractCompanyNames(draft, { prior }) — see the module header.
 * `retryable: true` marks provider / output failures (an outage should
 * delay the post); an over-long draft is `retryable: false`.
 */
async function extractCompanyNames(draft, { prior = null } = {}) {
  const text = extractionInput(draft);
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
  _internals: { SYSTEM_PROMPT, MAX_INPUT_CHARS, extractionInput, inputKey, canonicalCompanies },
};
