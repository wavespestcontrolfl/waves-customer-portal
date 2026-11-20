/**
 * Owner 2026-11-19: the app is always "the Waves app" ("all refernces to our
 * newsletter, or our blog, or our website, or app, needs to use waves in
 * them"). Pure text rules with no dependencies, shared by:
 * - the drafter: wavesApp rewrites the common slip before verification, and
 *   the verifier rejects a draft that offAppName flags (app_name), so the
 *   model writes it again;
 * - the publisher: it refuses any reply that offAppName flags, from every
 *   path (the runner, Post now, Use Draft, AI Reply, the Intelligence Bar,
 *   Agent Ops). Audit rounds found one path after another that lost a
 *   draft's origin, so the check sits where every path meets.
 */

// wavesApp rewrites each bare mention whose article is known: "the/our/your
// [Waves [Pest Control]] [mobile] app" becomes "the Waves app" ("The" at the
// start of a sentence or a line). It leaves every other form to offAppName.
const OWN_APP_RE = /\b(?:the|our|your)\s+(?:waves\s+(?:pest\s+control\s+)?)?(?:mobile\s+)?app\b/gi;
// offAppName allows one name and rejects the rest, instead of listing wrong
// phrasings (audit rounds found a new wrong phrasing each time). It blanks
// each exact "the Waves app" ("The Waves app" at the start of a sentence or
// a line; "app's" is the name too), then any word "app" or "apps" left is off
// the name: "a new Waves app", "our apps", "an app", "the Waves app-based
// reminders", "the Waves app store". In a reply to a Waves review an app is
// the Waves app. Other words ("apply", "application") pass. The span is that
// one word, so no other reply text is stored with a rejection.
const WAVES_APP_RE = /\b[Tt]he Waves app\b/g;
const APP_WORD_RE = /\bapps?\b/i;
const SENTENCE_START_RE = /(?:^|[.!?]["')\]’”]*\s+|\n\s*)$/;
// The name ends only at the end of the text, a space or closing punctuation
// ("app's" passes). Any other next character (a hyphen of any kind, a
// letter, a digit, a slash) makes a longer word: "app-based", "app‑based"
// (U+2011), "apps". " store" after it is the App Store, or the verb in "let
// our app store your notes".
const NAME_GOES_ON_RE = /^(?:[^\s.,!?;:)\]"'’”…]|\s+store\b)/i;
const nameAt = (s, at) => (SENTENCE_START_RE.test(s.slice(0, at)) ? 'The Waves app' : 'the Waves app');

function wavesApp(text) {
  return String(text || '').replace(OWN_APP_RE, (m, at, s) => (NAME_GOES_ON_RE.test(s.slice(at + m.length)) ? m : nameAt(s, at)));
}

// Exact, case and spacing included: a reply reaches Google as written.
function offAppName(text) {
  const s = String(text || '');
  const rest = s.replace(WAVES_APP_RE, (m, at) => (m === nameAt(s, at) && !NAME_GOES_ON_RE.test(s.slice(at + m.length)) ? ' '.repeat(m.length) : m));
  const hit = rest.match(APP_WORD_RE);
  return hit ? hit[0] : null;
}

module.exports = { wavesApp, offAppName };
