'use strict';

// Owner ruling 2026-09-26: customer texts are never signed ("— Adam, Waves
// Pest Control" or any sign-off). Prompts forbid it; this strips a trailing
// sign-off a model adds anyway, or copies from earlier signed history:
//   - a closer plus signer: "Thanks, Adam", "Best,\nAdam", "- Thanks, Adam"
//   - a signer set off by a dash or its own line: "— Adam", "\nWaves Pest Control"
//   - a bare signer that is its own final sentence: "Talk soon. Adam, Waves Pest Control"
// Not sign-offs, so they stay: "Waves Pest Control here" mid-message,
// "...choosing Waves Pest Control", "Hi Adam, ...", "Your technician is Adam."
// and a closer that ends its own sentence ("Talk soon.").
const DASH = '[-\\u2013\\u2014]{1,2}';
const CLOSER = '(?:thanks|thank\\s+you|best(?:\\s+regards)?|regards|cheers|sincerely|talk\\s+soon|see\\s+you\\s+soon|take\\s+care)';
const COMPANY = '(?:the\\s+)?waves(?:\\s+pest\\s+control)?(?:\\s+team)?';
const SIGNER = `(?:adam(?:\\s+(?:benetti|b\\b\\.?))?(?:\\s*,?\\s*(?:(?:from|at|with)\\s+)?${COMPANY})?|${COMPANY})`;
const TAIL = '\\s*[.!]?\\s*$';

// Closer + signer first, so "Best,\nAdam" goes as one unit instead of
// leaving a dangling "Best,".
const SIGNATURE_TAIL_RES = [
  new RegExp(`(?:^|(?<=[.!?])\\s+|\\s*\\n\\s*|\\s*${DASH}\\s*)${CLOSER},?\\s+${SIGNER}${TAIL}`, 'i'),
  new RegExp(`(?:\\s*${DASH}\\s*|\\s*\\n\\s*)${SIGNER}${TAIL}`, 'i'),
  new RegExp(`(?<=[.!?])\\s+${SIGNER}${TAIL}`, 'i'),
];

function stripTrailingSignature(message) {
  let text = String(message || '').trim();
  for (let i = 0; i < 3; i += 1) {
    const next = SIGNATURE_TAIL_RES.reduce((current, re) => current.replace(re, ''), text).trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

module.exports = { stripTrailingSignature };
