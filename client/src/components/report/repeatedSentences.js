// A status card prints its own fixed status line, then a narrative. When the
// narrative is the typed template built from the same form (not a written
// report), its sentences restate that line: the termite card said "we
// inspected 22 stations, no activity" three times, the cockroach card twice
// word for word (owner 2026-10-22: say a thing once). This drops a narrative
// sentence whose words the card already prints; a sentence that adds a fact
// (a recommendation, an area, a next step) stays.

import { reportSectionsForText } from './ReportSections';

const FILLER = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'at', 'in', 'on', 'to', 'for', 'we', 'our', 'your', 'you',
  'was', 'were', 'is', 'are', 'be', 'been', 'it', 'its', 'this', 'that', 'all', 'today', 'with',
]);

const wordsOf = (text) => String(text || '').toLowerCase()
  .replace(/[’']/g, '')
  .split(/[^a-z0-9]+/)
  .filter((word) => word && !FILLER.has(word))
  .map((word) => word.replace(/(?:ed|s)$/, ''));

// Share of a sentence's words the card already prints, at or above which the
// sentence is a repeat. Measured on the live termite and cockroach cards
// (2026-10-23): the repeats sit at 0.78 to 1.0, a sentence with a new fact
// ("A follow-up visit in 10–14 days is recommended ...") well under 0.5.
export const REPEAT_SHARE = 0.75;

export function withoutRepeatedSentences(narrative, covered = [], sections = null) {
  const text = String(narrative || '').trim();
  if (!text) return null;
  // A written four-section report keeps every word.
  if (reportSectionsForText(sections, text)) return text;
  const known = new Set(covered.flatMap(wordsOf));
  if (!known.size) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => {
    const words = wordsOf(sentence);
    if (!words.length) return false;
    const seen = words.filter((word) => known.has(word)).length;
    return seen / words.length < REPEAT_SHARE;
  });
  return kept.length ? kept.join(' ') : null;
}

// The words a status card prints before its narrative.
export function statusCardWords({ status, statusSummary, metrics }) {
  return [
    status?.label,
    statusSummary,
    ...(Array.isArray(metrics) ? metrics.flatMap((m) => [m?.label, m?.value]) : []),
  ].filter(Boolean).map(String);
}
