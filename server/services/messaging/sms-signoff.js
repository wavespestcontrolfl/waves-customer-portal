'use strict';

// Owner ruling 2026-09-26: customer texts are never signed ("— Adam, Waves
// Pest Control" or any sign-off). Prompts forbid it; this strips a trailing
// sign-off a model adds anyway (or copies from earlier signed history). Only
// a TRAILING segment set off by a dash or its own line counts, so "Waves Pest
// Control here" mid-message and a sentence ending "...choosing Waves Pest
// Control" stay intact.
const SIGNATURE_TAIL_RE = /(?:\s*[-–—]{1,2}\s*|\s*\n\s*)(?:adam(?:\s+benetti)?(?:\s*,?\s*waves(?:\s+pest\s+control)?)?|(?:the\s+)?waves(?:\s+pest\s+control)?(?:\s+team)?)\s*[.!]?\s*$/i;

function stripTrailingSignature(message) {
  let text = String(message || '').trim();
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(SIGNATURE_TAIL_RE, '').trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

module.exports = { stripTrailingSignature };
