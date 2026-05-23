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

module.exports = {
  evaluateTitleMetaSpam,
  HYPE_TERMS,
  COMMERCIAL_TERMS,
  _internals: {
    countPhrase,
    repeatedCommercialPhrase,
    titleRepeatTerms,
    slugReason,
  },
};
