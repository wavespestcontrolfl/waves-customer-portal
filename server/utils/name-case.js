/**
 * Title-case a personal name with handling for Mc/Mac/O'/D' prefixes,
 * hyphenated names, and naming particles (van, de, del, di, la, le, du, von).
 *
 * Replaces the inline `capitalizeName` in twilio-voice-webhook.js (which
 * only handled Mc/O') and the ad-hoc capitalizeName variants scattered
 * across routes. New name writes from the AI call-triage pipeline route
 * through this util so the format is consistent across customers/leads.
 *
 * Examples:
 *   "JOHN MCGOWAN"            → "John McGowan"
 *   "macdonald"               → "MacDonald"
 *   "o'brien-smith"           → "O'Brien-Smith"
 *   "ludwig van beethoven"    → "Ludwig van Beethoven"
 *   "DE LA CRUZ"              → "De la Cruz"        (first word always cap)
 *   "  jane  "                → "Jane"              (trim + collapse)
 *   ""                        → ""
 *   null/undefined            → ""
 *
 * Known false positives (acceptable — false-positive names are rare and
 * human-correctable in the Triage Inbox):
 *   - "Macarena" → "MacArena"   (Mac+capital is the conventional surname
 *                                 pattern; no name dictionary exists to
 *                                 disambiguate)
 *   - "Mackey"   → "MacKey"     (same)
 *
 * Particles only stay lowercase when NOT the first word — purely
 * positional, no last-name detection.
 */

const PARTICLES = new Set([
  'van', 'von', 'de', 'del', 'della', 'di', 'la', 'le', 'du', 'das', 'der',
]);

function properCase(input) {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';

  return trimmed
    .split(' ')
    .map((word, idx) => caseWord(word, idx === 0))
    .join(' ');
}

function caseWord(word, isFirstWord) {
  // Hyphenated parts handled segment-by-segment. The first segment of a
  // hyphenated first word is also "first" for particle/capitalization
  // purposes; subsequent segments are not.
  if (word.includes('-')) {
    return word
      .split('-')
      .map((seg, i) => caseSegment(seg, isFirstWord && i === 0))
      .join('-');
  }
  return caseSegment(word, isFirstWord);
}

function caseSegment(seg, isFirstSegment) {
  if (!seg) return '';
  const lower = seg.toLowerCase();

  // Particle: lowercase unless it's the first segment of the full name.
  if (!isFirstSegment && PARTICLES.has(lower)) return lower;

  // O' / D' apostrophe prefix — capitalize the prefix letter AND the
  // letter after the apostrophe.
  const apostropheMatch = lower.match(/^([od])'(.+)$/);
  if (apostropheMatch) {
    return apostropheMatch[1].toUpperCase() + "'" + capitalize(apostropheMatch[2]);
  }

  // Mc prefix — applies whenever there's at least one letter after "mc".
  if (lower.length >= 3 && lower.startsWith('mc')) {
    return 'Mc' + capitalize(lower.slice(2));
  }

  // Mac prefix — only when followed by 3+ letters (so "Macy"/"Macro"/
  // "Mack" stay as standard title-case; "MacDonald"/"MacKenzie" get the
  // intracaps treatment). Still produces false positives for words like
  // "Macarena" — see header docstring.
  if (lower.length >= 6 && lower.startsWith('mac')) {
    return 'Mac' + capitalize(lower.slice(3));
  }

  return capitalize(lower);
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

module.exports = { properCase };
