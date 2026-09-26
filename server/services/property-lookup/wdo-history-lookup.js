/**
 * WDO treatment / permit history lookup. A focused Claude web_search call that
 * researches a property's prior wood-destroying-organism treatment (fumigation,
 * soil/bait treatment), re-roof permits (roof age), and other relevant building
 * permits, to pre-fill FDACS-13645 Section 4 (Notice of Inspection and Treatment
 * Information). Suggestions only — a licensed inspector verifies on site.
 *
 * Mirrors ai-property-lookup.js: lazy SDK require, web_search tool, JSON-only
 * response, graceful null when the key is missing / nothing is found. Logs are
 * prefixed `[wdo-history]`.
 *
 * Env: WDO_HISTORY_TIMEOUT_MS (default 60000), WDO_HISTORY_MAX_SEARCHES (8).
 */

const logger = require('../logger');
const MODELS = require('../../config/models');
const { ledgerCall, ledgerCallRejected } = require('../llm-dispatch-metrics');

const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_MAX_SEARCHES = 8;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function buildHistoryPrompt(address) {
  return `You are researching the wood-destroying-organism (WDO) and treatment history of a specific Florida property for a licensed pest-control inspector preparing an FDACS-13645 report.

Address: ${address}

Use web_search aggressively (multiple times) across:
1. County building-permit portals — Manatee (manateepao.gov, Manatee County permitting), Sarasota (sc-pa.com, Sarasota County Smart Permits), Charlotte (ccappraiser.com, Charlotte County permits). Look for: fumigation / tent permits, termite or WDO treatment permits, re-roof permits, and additions.
2. Listing history & remarks — zillow.com, redfin.com, realtor.com, homes.com (descriptions mentioning "termite bond", "tented", "fumigated", "WDO", "active warranty", "transferable bond").
3. Pest-control / fumigation notices or records naming the property or a prior operator.

Determine:
- Whether there is EVIDENCE of previous WDO treatment (fumigation, soil treatment, bait, etc.).
- Details: organism, fumigant/product, amount, date, treating company, and any posted-notice info.
- Roof age: the most recent re-roof permit year, if any.
- Any other permits relevant to a WDO inspection.

Respond with ONLY a JSON object — no preamble, no markdown fences:
{
  "previousTreatment": "yes" | "no" | "unknown",
  "treatmentNotes": "<concise factual summary, or empty>",
  "fumigation": { "date": "", "fumigant": "", "company": "", "notes": "" } | null,
  "roofPermitYear": <integer or null>,
  "permits": [ { "type": "", "date": "", "description": "" } ],
  "sources": ["<url>", "..."],
  "confidence": "high" | "medium" | "low"
}

Rules:
- Return "yes" ONLY with a concrete source (permit, listing remark, posted notice); otherwise "unknown". Use "no" only if a source affirmatively indicates no prior treatment.
- Never fabricate. Use empty strings / null / [] when unknown.
- This feeds a legal report that a licensed inspector will verify on site, so be conservative and cite sources.`;
}

function parseJson(text) {
  const cleaned = String(text || '').replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function str(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// Only keep http(s) URLs — the model's `sources` come from searched pages and
// could be prompt-injected to a javascript:/data: URI that would execute when
// an admin clicks the rendered source link.
function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// The two verdict fields every answer must carry. Without them (e.g. `{}`)
// normalizeHistory would synthesize an all-unknown result that gets cached as
// a resolved lookup — that is a failed answer, not "nothing found".
function hasHistoryVerdict(parsed) {
  return !!parsed
    && ['yes', 'no', 'unknown'].includes(String(parsed.previousTreatment || '').trim().toLowerCase())
    && ['high', 'medium', 'low'].includes(String(parsed.confidence || '').trim().toLowerCase());
}

// Nested evidence is copied into the FDACS-13645 Section 4 fields, so it must
// be text as given: str() used to turn an object into "[object Object]" on the
// legal form, and any number > 1800 passed as a roof permit year (Codex r21 on
// #4884). A present off-contract value fails the lookup (retryable).
const isEvidenceText = (v) => v === undefined || v === null || typeof v === 'string'
  || (typeof v === 'number' && Number.isFinite(v));
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function permitYear(value) {
  if (value === undefined || value === null || value === '') return null;
  const year = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(year) && year >= 1900 && year <= new Date().getUTCFullYear() + 1 ? year : undefined;
}
function nestedEvidenceValid(parsed) {
  if (!isEvidenceText(parsed.treatmentNotes)) return false;
  if (parsed.fumigation != null && !(isPlainObject(parsed.fumigation)
    && ['date', 'fumigant', 'company', 'notes'].every((k) => isEvidenceText(parsed.fumigation[k])))) return false;
  if (parsed.permits != null && !(Array.isArray(parsed.permits)
    && parsed.permits.every((p) => isPlainObject(p) && ['type', 'date', 'description'].every((k) => isEvidenceText(p[k]))))) return false;
  return permitYear(parsed.roofPermitYear) !== undefined;
}

function normalizeHistory(parsed) {
  if (!hasHistoryVerdict(parsed)) return null;
  if (!nestedEvidenceValid(parsed)) return null;
  const pt = String(parsed.previousTreatment || '').trim().toLowerCase();
  const conf = String(parsed.confidence || '').trim().toLowerCase();
  const fum = parsed.fumigation && typeof parsed.fumigation === 'object' ? parsed.fumigation : null;
  const sources = Array.isArray(parsed.sources)
    ? parsed.sources.map((s) => str(s, 300)).filter(isHttpUrl).slice(0, 8)
    : [];
  // The prompt allows "yes" ONLY with a concrete source and "no" only when a
  // source affirmatively shows no prior treatment; an uncited verdict would be
  // cached and pre-fill the legal FDACS-13645 filing, so it is a failed
  // lookup (retryable), not a verdict. "unknown" is the evidence-free result
  // (Codex r20 on #4884).
  if ((pt === 'yes' || pt === 'no') && !sources.length) return null;
  return {
    previousTreatment: ['yes', 'no'].includes(pt) ? pt : 'unknown',
    treatmentNotes: str(parsed.treatmentNotes, 1000),
    fumigation: fum && (fum.date || fum.fumigant || fum.company || fum.notes)
      ? {
        date: str(fum.date, 40),
        fumigant: str(fum.fumigant, 80),
        company: str(fum.company, 120),
        notes: str(fum.notes, 300),
      }
      : null,
    roofPermitYear: permitYear(parsed.roofPermitYear),
    permits: Array.isArray(parsed.permits)
      ? parsed.permits.slice(0, 10).map((p) => ({
        type: str(p?.type, 60),
        date: str(p?.date, 40),
        description: str(p?.description, 200),
      })).filter((p) => p.type || p.description)
      : [],
    sources,
    confidence: ['high', 'medium', 'low'].includes(conf) ? conf : 'low',
  };
}

/**
 * Web-search the property's treatment/permit history.
 * Contract: returns the normalized history object on success (a successful
 * "nothing found" is previousTreatment:false, NOT null); returns null only
 * when the lookup was SKIPPED (no API key / unusable address); THROWS
 * (err.code='lookup_failed') when the lookup ran and failed.
 */
async function lookupWdoHistory(address, options = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.info('[wdo-history] skipped — ANTHROPIC_API_KEY not set');
    return null;
  }
  if (!address || typeof address !== 'string' || address.trim().length < 5) {
    logger.warn('[wdo-history] skipped — address missing or too short');
    return null;
  }
  const timeoutMs = positiveInt(options.timeoutMs || process.env.WDO_HISTORY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxSearches = positiveInt(options.maxSearches || process.env.WDO_HISTORY_MAX_SEARCHES, DEFAULT_MAX_SEARCHES);
  const t0 = Date.now();
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    // maxRetries: 0 — an SDK retry re-runs the whole web_search budget (max_uses),
    // so the default of 2 could fan one lookup out to 3x the searches + wall-clock
    // on a transient 429/5xx. The single attempt already degrades to null on error.
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0 });
    const resp = await ledgerCall('anthropic', MODELS.WORKHORSE, () => client.messages.create({
      model: MODELS.WORKHORSE,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
      messages: [{ role: 'user', content: buildHistoryPrompt(address) }],
    }, { timeout: timeoutMs }), { laneId: 'wdo_history' });

    const textBlock = (resp.content || []).filter((b) => b.type === 'text').pop();
    if (!textBlock?.text) {
      ledgerCallRejected(resp, 'empty_text');
      throw new Error('no text block in lookup response');
    }
    const parsed = parseJson(textBlock.text);
    if (!parsed) {
      ledgerCallRejected(resp, 'invalid_json');
      throw new Error('unparseable lookup response');
    }
    const normalized = normalizeHistory(parsed);
    if (!normalized) {
      ledgerCallRejected(resp, 'schema_invalid');
      throw new Error('lookup response broke its contract (missing verdict, or "yes" without a source)');
    }
    logger.info('[wdo-history] resolved', {
      elapsedMs: Date.now() - t0,
      previousTreatment: normalized.previousTreatment,
      confidence: normalized.confidence,
      permits: normalized.permits?.length || 0,
    });
    return normalized;
  } catch (err) {
    // Failures THROW (callers surface "lookup failed — try again"); they must
    // never collapse into the same null as the skip cases above, or a
    // transient API error reads as "no treatment or permit history found" and
    // the tech writes "no prior treatment" onto a legal filing. A successful
    // "nothing found" is a normal result object (previousTreatment: false).
    logger.warn(`[wdo-history] errored: ${err?.message || err}`, { elapsedMs: Date.now() - t0 });
    const failure = new Error(`WDO history lookup failed: ${err?.message || err}`);
    failure.code = 'lookup_failed';
    throw failure;
  }
}

module.exports = {
  lookupWdoHistory,
  _private: { buildHistoryPrompt, normalizeHistory, parseJson },
};
