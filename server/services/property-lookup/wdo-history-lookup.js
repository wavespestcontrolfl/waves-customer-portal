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

function normalizeHistory(parsed) {
  if (!parsed) return null;
  const pt = String(parsed.previousTreatment || '').toLowerCase();
  const conf = String(parsed.confidence || '').toLowerCase();
  const fum = parsed.fumigation && typeof parsed.fumigation === 'object' ? parsed.fumigation : null;
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
    roofPermitYear: Number.isFinite(Number(parsed.roofPermitYear)) && Number(parsed.roofPermitYear) > 1800
      ? Number(parsed.roofPermitYear)
      : null,
    permits: Array.isArray(parsed.permits)
      ? parsed.permits.slice(0, 10).map((p) => ({
        type: str(p?.type, 60),
        date: str(p?.date, 40),
        description: str(p?.description, 200),
      })).filter((p) => p.type || p.description)
      : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 8).map((s) => str(s, 300)).filter(Boolean) : [],
    confidence: ['high', 'medium', 'low'].includes(conf) ? conf : 'low',
  };
}

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
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const resp = await client.messages.create({
      model: MODELS.WORKHORSE,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
      messages: [{ role: 'user', content: buildHistoryPrompt(address) }],
    }, { timeout: timeoutMs });

    const textBlock = (resp.content || []).filter((b) => b.type === 'text').pop();
    if (!textBlock?.text) {
      logger.warn('[wdo-history] no text block in response', { elapsedMs: Date.now() - t0 });
      return null;
    }
    const normalized = normalizeHistory(parseJson(textBlock.text));
    logger.info('[wdo-history] resolved', {
      elapsedMs: Date.now() - t0,
      previousTreatment: normalized?.previousTreatment,
      confidence: normalized?.confidence,
      permits: normalized?.permits?.length || 0,
    });
    return normalized;
  } catch (err) {
    logger.warn(`[wdo-history] errored: ${err?.message || err}`);
    return null;
  }
}

module.exports = {
  lookupWdoHistory,
  _private: { buildHistoryPrompt, normalizeHistory, parseJson },
};
