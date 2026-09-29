/**
 * AI-assistant referral detection — SHARED between every lead-entry path so
 * a visitor who asked ChatGPT/Perplexity/Gemini/Copilot/Claude/etc. and
 * followed its citation link resolves to the SAME `ai_assistant` bucket no
 * matter which door the lead walked in:
 *   - lead-source-classify.js (the /api/leads webhook + self-booking
 *     attribution, via lead-estimate-link.js)
 *   - lead-source-resolver.js (the quote-wizard: /api/public/estimator/
 *     property-lookup and /api/public/quote/calculate)
 *
 * Extracted here (codex pre-push P1, AGENTS.md "extend the existing
 * mechanism") so the two resolution paths can't drift into judging the same
 * ChatGPT visit differently. Owner-approved 2026-09-27.
 *
 * `AI_ASSISTANT_SOURCE_TYPE` / `AI_ASSISTANT_LEAD_SOURCE_NAME` mirror the
 * `lead_sources` row seeded by migration
 * 20260928030000_ai_assistant_lead_source.js EXACTLY (that migration is
 * already deployed/frozen — never edit it; these constants must match its
 * literal `source_type`/`name` values, not the other way around).
 */
const AI_ASSISTANT_SOURCE_TYPE = 'ai_assistant';
const AI_ASSISTANT_LEAD_SOURCE_NAME = 'AI Assistant Referrals';

// utm_source values AND referrer hosts that name a known AI answer engine.
// Real citation links from ChatGPT carry utm_source=chatgpt.com (or
// utm_source=openai, seen in real citations); a plain link with no UTMs
// still arrives with document.referrer set to the assistant's own domain.
// Data-driven so a new assistant is one row, not a new branch — `detail` is
// the exact label callers surface.
const AI_ASSISTANT_SOURCES = [
  { detail: 'ChatGPT', utmSources: ['chatgpt.com', 'chatgpt', 'openai'], hosts: ['chatgpt.com', 'chat.openai.com'] },
  { detail: 'Perplexity', utmSources: ['perplexity', 'perplexity.ai'], hosts: ['perplexity.ai', 'www.perplexity.ai'] },
  { detail: 'Gemini', utmSources: ['gemini'], hosts: ['gemini.google.com', 'bard.google.com'] },
  { detail: 'Copilot', utmSources: ['copilot'], hosts: ['copilot.microsoft.com'] },
  { detail: 'Claude', utmSources: ['claude', 'claude.ai'], hosts: ['claude.ai'] },
  { detail: 'Other AI', utmSources: ['you.com'], hosts: ['you.com'] },
];

// source: a trimmed/lowercased utm_source. referrerHost: a normalized
// hostname (lowercased, "www." stripped) or null. Either alone is enough to
// match — a caller with only a referrer (no UTMs) or only a utm_source (no
// referrer, e.g. first-touch persisted across pages) still resolves.
function findAiAssistant(source, referrerHost) {
  return AI_ASSISTANT_SOURCES.find((row) =>
    (source && row.utmSources.includes(source)) || (referrerHost && row.hosts.includes(referrerHost))
  ) || null;
}

// Hostname for a referrer/landing URL (lowercased, "www." stripped); null on
// garbage so a bad URL can never satisfy a host check. Shared normalization
// so callers that don't already compute their own host (lead-source-classify
// does; lead-source-resolver's extractHost is identical and kept local to
// avoid churning its existing call sites) can reuse it directly.
function hostnameOf(url) {
  if (!url) return null;
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

module.exports = {
  AI_ASSISTANT_SOURCE_TYPE,
  AI_ASSISTANT_LEAD_SOURCE_NAME,
  AI_ASSISTANT_SOURCES,
  findAiAssistant,
  hostnameOf,
};
