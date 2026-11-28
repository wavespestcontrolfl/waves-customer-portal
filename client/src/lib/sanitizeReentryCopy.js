// Defense-in-depth sanitizer for legacy re-entry text paths.
// Primary compliance enforcement runs server-side in reports-public.js via
// stripFixedReentryTiming; this client helper remains exported for any legacy
// text that bypassed that boundary.

const REENTRY_NUMBER_WORDS = 'a|an|one|two|three|four|five|six|seven|eight|nine|ten'
  + '|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen'
  + '|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety|hundred|half|several';

// A clock time (7 PM / 7:03 PM) or a quantity attached to a time unit.
const REENTRY_TIME_RX = new RegExp(
  '\\b\\d{1,2}(:\\d{2})?\\s*(a\\.?m\\.?|p\\.?m\\.?)\\b'
  + `|\\b(\\d+(\\.\\d+)?|(${REENTRY_NUMBER_WORDS})([\\s-](${REENTRY_NUMBER_WORDS}))?)`
  + '[\\s-]*(second|sec|minute|min|hour|hr|day|week)s?\\b',
  'i',
);

// Must actually make a re-entry or drying claim so label-required agronomic
// directions like "water in within 24 hours" remain intact.
const REENTRY_CLAIM_RX = new RegExp(
  '\\b(re-?enter|re-?entry|reentry|entry|ready|dry|dries|dried|drying|safe'
  + '|keep\\s+(\\w+\\s+){0,3}(off|out|away|clear)'
  + '|stay\\s+(off|out|away)'
  + '|avoid\\w*\\s+(the\\s+)?(treated|lawn|grass|yard|area)'
  + '|(you|your\\s+family|residents?|occupants?|everyone)\\s+(\\w+\\s+){0,3}return\\w*'
  + '|^\\s*return(ing)?\\b'
  + '|off\\s+(the\\s+)?treated)\\b',
  'i',
);

const REENTRY_SAFE_COPY = 'Ready once dry — your technician confirms timing.';

export function sanitizeReentryCopy(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let replaced = false;
  const kept = sentences.filter((sentence) => {
    if (REENTRY_TIME_RX.test(sentence) && REENTRY_CLAIM_RX.test(sentence)) {
      replaced = true;
      return false;
    }
    return true;
  });
  if (!replaced) return text;
  return [REENTRY_SAFE_COPY, ...kept].join(' ').trim();
}
