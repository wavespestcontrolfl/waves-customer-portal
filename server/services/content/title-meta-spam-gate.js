/**
 * title-meta-spam-gate.js — lightweight SEO trust checks for generated
 * titles and meta descriptions.
 *
 * This is intentionally rule-based. The goal is to stop obvious title
 * stuffing before any autonomous publish path can promote it.
 */

const HYPE_TERMS = [
  'top-rated',
  'best',
  'affordable',
  'cheap',
  'near me',
  'exterminator',
  'professional',
  'reliable',
  'local',
  'organic',
  'natural',
  'pet-friendly',
  'pet-safe',
];

const COMMERCIAL_TERMS = [
  'pest control',
  'exterminator',
  'exterminators',
  'insect control',
  'pest management',
  'lawn care',
  'lawn pest',
  'mosquito control',
  'termite',
  'rodent',
];

function evaluateTitleMetaSpam(input = {}) {
  const title = clean(input.title || input.frontmatter?.title || '');
  const meta = clean(input.metaDescription || input.meta_description || input.frontmatter?.meta_description || '');
  const city = clean(input.city || '');
  const service = clean(input.service || '');
  const targetKeyword = clean(input.targetKeyword || input.target_keyword || '');

  const hardFailures = [];
  const softFailures = [];

  inspectTitle(title, { city, service, targetKeyword }, hardFailures, softFailures);
  inspectMeta(meta, hardFailures, softFailures);

  return {
    ok: hardFailures.length === 0,
    hard_failures: hardFailures,
    soft_failures: softFailures,
  };
}

function inspectTitle(title, context, hardFailures, softFailures) {
  if (!title) return;

  if (title.length > 90) {
    hardFailures.push(issue('title_too_long', `title_length_${title.length}_over_90`));
  } else if (title.length > 65) {
    softFailures.push(issue('title_long', `title_length_${title.length}_over_65`));
  }

  if (/\bthe\s+best\b/i.test(title)) {
    hardFailures.push(issue('title_the_best_claim', 'title_contains_the_best'));
  }

  const pipeCount = countMatches(title, /\|/g);
  if (pipeCount > 1) {
    hardFailures.push(issue('title_too_many_pipes', `title_pipe_count_${pipeCount}`));
  }

  const lower = title.toLowerCase();
  if (lower.includes('near me')) {
    hardFailures.push(issue('title_forced_near_me', 'title_contains_near_me'));
  }

  const stacked = countHypeTerms(lower);
  if (stacked >= 4) {
    hardFailures.push(issue('title_stacked_hype', `title_hype_term_count_${stacked}`));
  } else if (stacked >= 3) {
    softFailures.push(issue('title_hypey', `title_hype_term_count_${stacked}`));
  }

  const lowerForRepeats = lower.replace(/\bwaves\s+pest\s+control\b/g, 'waves');
  for (const term of titleRepeatTerms(context)) {
    const count = countPhrase(lowerForRepeats, term);
    if (count > 2) {
      hardFailures.push(issue('title_repeats_term', `title_repeats_${slugReason(term)}_${count}x`));
    }
  }

  const repeatedSeoPhrase = repeatedCommercialPhrase(lowerForRepeats);
  if (repeatedSeoPhrase) {
    hardFailures.push(issue('title_repeats_phrase', `title_repeats_${slugReason(repeatedSeoPhrase)}`));
  }
}

function inspectMeta(meta, hardFailures, softFailures) {
  if (!meta) return;
  if (meta.length > 190) {
    hardFailures.push(issue('meta_too_long', `meta_length_${meta.length}_over_190`));
  } else if (meta.length > 160) {
    softFailures.push(issue('meta_long', `meta_length_${meta.length}_over_160`));
  }
  if (countPhrase(meta.toLowerCase(), 'near me') > 1) {
    hardFailures.push(issue('meta_repeats_near_me', 'meta_repeats_near_me'));
  }
  const stacked = countHypeTerms(meta.toLowerCase());
  if (stacked >= 5) {
    hardFailures.push(issue('meta_stacked_hype', `meta_hype_term_count_${stacked}`));
  }
}

function titleRepeatTerms({ city, service, targetKeyword }) {
  const terms = new Set(COMMERCIAL_TERMS);
  if (city) terms.add(city.toLowerCase());
  if (service) terms.add(service.toLowerCase());
  if (targetKeyword) terms.add(targetKeyword.toLowerCase());
  return Array.from(terms).filter((term) => term.length >= 4);
}

function repeatedCommercialPhrase(lowerTitle) {
  for (const term of COMMERCIAL_TERMS) {
    if (countPhrase(lowerTitle, term) > 1) return term;
  }
  return null;
}

function countHypeTerms(lowerText) {
  return HYPE_TERMS.reduce((count, term) => count + (lowerText.includes(term) ? 1 : 0), 0);
}

function countPhrase(lowerText, phrase) {
  if (!phrase) return 0;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return countMatches(lowerText, new RegExp(`\\b${escaped}\\b`, 'gi'));
}

function countMatches(text, regex) {
  return (String(text || '').match(regex) || []).length;
}

function issue(code, reason) {
  return { code, reason };
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugReason(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Rendered-length approximation for meta text carrying per-domain tokens —
// Google measures what RENDERS, not the template. Hub token widths; spoke
// brand/phone values land within a few characters. Single source of truth
// for the meta length contract (owner rule 2026-07-29: every meta carries
// the {{cityPhone}} token and never exceeds 160 rendered characters) —
// consumed by content-quality-gate and content-guardrails so the two
// enforcement points can never drift.
// Token grammar mirrors the Astro publisher's remark substitution
// (whitespace-tolerant, and phone/tel are aliases that also render a phone
// number) — exact-string checks let "{{ cityPhone }}" or "{{tel}}" through.
// PHONE_TOKEN_RE is the BAN matcher (any token that renders a phone);
// CITY_PHONE_TOKEN_RE is the REQUIREMENT matcher — only {{cityPhone}}
// resolves the tracking number that belongs to the page (owner: "the phone
// has to align with the page"); {{phone}}/{{tel}} render the generic line.
const PHONE_TOKEN_RE = /\{\{\s*(cityPhone|phone|tel)\s*\}\}/i;
const CITY_PHONE_TOKEN_RE = /\{\{\s*cityPhone\s*\}\}/i;
const META_TOKEN_RENDERINGS = [
  [/\{\{\s*(cityPhone|phone|tel)\s*\}\}/gi, '(941) 297-2606'],
  [/\{\{\s*brandShort\s*\}\}/gi, 'Waves'],
  [/\{\{\s*brandName\s*\}\}/gi, 'Waves Pest Control'],
];
function renderMetaTokens(text) {
  let s = String(text || '');
  for (const [re, v] of META_TOKEN_RENDERINGS) s = s.replace(re, v);
  return s;
}

// Blog metas are the informational lane (owner rule 2026-07-29): no phone,
// no sales copy, and they END with a soft CTA like "Learn more on the Waves
// blog." Shared here (like renderMetaTokens) so the quality gate and the
// guardrails enforce the SAME sales-copy/CTA definitions and can't drift.
const SALESY_META_RE = /free\s+(estimate|quote|inspection)|call\s+(now|today|us)\b|book\s+(now|today|online)\b|schedule\s+(service|now|today|your)\b|(request|get)\s+a\s+(free\s+)?quote\b|contact\s+us\b|save\s+(on|up\s+to|with|big|money|\$|\d+\s*%)|you\s+can\s+save\b|\d+\s*%\s*off|discount|special\s+offer|act\s+now|limited\s+time|\b(choose|hire|trust|pick)\s+(waves|us\b|our\s)|\bwaves\s+(can|will)\s+(help|handle|protect|treat)\b|\bget\s+started\b|\bsign\s+up\b|\blet\s+us\s+(handle|help|take)\b|\bwe(?:'|’)ll\s+(handle|take\s+care)\b/i;
const SOFT_CTA_RE = /\b(learn\s+(more|how|why|what)|read\s+(more|on|the\s+full)|find\s+out\s+(more|how|why|what)|see\s+(how|what|why))\b/i;

// The meta's LAST sentence must BE a sanctioned soft CTA — not merely
// contain a CTA-ish verb ("See how much you can save with Waves" contains
// "see how" but is a sales pitch). Sanctioned shapes: "Learn more" /
// "Read more" / "Read on" / "Find out more|how|why|what", optionally with
// an "about <topic>" clause, optionally closed by a neutral pointer
// ("on the Waves blog", "on our blog", "in our/the guide", "here").
const SOFT_CTA_SENTENCE_RE = /^(learn\s+more|read\s+more|read\s+on|find\s+out\s+(?:more|how|why|what))(?:\s+about\s+[\w\s,.'’-]{1,50})?(?:\s+(?:on\s+the\s+waves\s+blog|on\s+our\s+blog|in\s+(?:our|the)\s+(?:full\s+)?guide|here))?$/i;
// Money/deal terms can't ride in via the about-clause either
// ("Learn more about saving big with Waves").
const CTA_SALES_TERMS_RE = /\b(sav(?:e|ing|ings)|deal|offer|price|pricing|discount|percent|quote|estimate)\b|[%$]/i;
// Abbreviation periods are NOT sentence boundaries — "Learn more about
// St. Augustine grass." must keep its CTA sentence intact (St. Augustine is
// the dominant SWFL turf, so this is the common case, not the edge).
const ABBREV_DOT_RE = /\b(St|Dr|Mt|Ft|Mr|Mrs|Ms|vs|No)\./gi;
// Decimal points in amounts ("$49.99") are NOT sentence boundaries either —
// splitting there hands downstream checks a bare "99" and hides the money
// term (Codex r3).
const DECIMAL_DOT_RE = /(\d)\.(\d)/g;
function metaSentences(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  const masked = t
    .replace(ABBREV_DOT_RE, (m) => m.replace('.', '\u0001'))
    .replace(DECIMAL_DOT_RE, '$1\u0001$2');
  return masked.split(/[.!?]+/).map((s) => s.replace(/\u0001/g, '.').trim()).filter(Boolean);
}
function lastSentence(text) {
  const sentences = metaSentences(text);
  return sentences[sentences.length - 1] || '';
}

// TRANSACTIONAL sales copy in the meta's FINAL sentence stays a HARD
// contract term even though CTA presence became a soft nudge (owner ruling
// 2026-07-30). Two shapes qualify (Codex r3: informational grammar like
// "what quarterly plans offer homeowners" or "an estimate of the damage"
// must NOT hard-fail — that would recreate the parks the ruling removed):
//   1. money in the closer — a currency/percent symbol ("…starts at $49.99.")
//   2. sales terms riding a CTA-shaped sentence ("Learn more about saving
//      big with Waves.")
const CURRENCY_OR_PERCENT_RE = /[%$]/;
// Transactional sentences that are neither CTA-shaped nor carry a symbol —
// "Ask Waves for a quote on treatment." / "A treatment estimate is available
// today." (Codex r4). Two shapes, bounded to the sentence: a solicitation
// verb reaching a sales noun, or a sales noun with immediate now/today
// urgency. Plain availability is NOT enough ("a damage estimate is available
// in the county public record" is informational — Codex r5).
const TRANSACTIONAL_SENTENCE_RE = /\b(ask|call|text|contact|request|get|book|schedule)\b[^.!?]{0,40}?\b(quote|estimate|pricing|price|deal|offer|discount)s?\b|\b(quote|estimate|pricing|price|deal|offer|discount)s?\b[^.!?]{0,30}?\b(today|now)\b/i;
// EVERY sentence is scanned for the sales shapes — a pitch followed by an
// informational closer ("Learn more about saving big with Waves. This guide
// explains…") is still sales copy (Codex r5). Currency/percent stays
// CLOSER-ONLY by design: mid-meta figures are usually legitimate stats
// ("$5 billion in yearly damage", "40% of lawns") while the closer is the
// pitch slot.
function metaHasSalesCopy(text) {
  const sentences = metaSentences(text);
  if (!sentences.length) return false;
  if (CURRENCY_OR_PERCENT_RE.test(sentences[sentences.length - 1])) return true;
  return sentences.some((s) => TRANSACTIONAL_SENTENCE_RE.test(s) || (SOFT_CTA_RE.test(s) && CTA_SALES_TERMS_RE.test(s)));
}

// Waves' own number typed WITHOUT separators ("Call 9412972606") slips both
// the separator-shaped literal-phone regex and the PII scan (known business
// number). NANP-shaped: optional leading 1, area code and exchange can't
// start with 0/1 — keeps years, ZIPs, and small counts out (Codex r4).
const BARE_PHONE_DIGITS_RE = /\b1?[2-9]\d{2}[2-9]\d{6}\b/;

function endsWithSoftCta(text) {
  const last = lastSentence(text);
  if (!last) return false;
  if (CTA_SALES_TERMS_RE.test(last)) return false;
  return SOFT_CTA_SENTENCE_RE.test(last);
}

module.exports = {
  evaluateTitleMetaSpam,
  renderMetaTokens,
  PHONE_TOKEN_RE,
  CITY_PHONE_TOKEN_RE,
  SALESY_META_RE,
  SOFT_CTA_RE,
  endsWithSoftCta,
  metaHasSalesCopy,
  BARE_PHONE_DIGITS_RE,
  HYPE_TERMS,
  COMMERCIAL_TERMS,
  _internals: {
    countPhrase,
    repeatedCommercialPhrase,
    titleRepeatTerms,
    slugReason,
  },
};
