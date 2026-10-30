/**
 * "How did you hear about us?" — the self-reported discovery channel from the
 * optional quote-form question (owner-approved 2026-09-27), shared by every
 * public lead writer: the web form path (routes/lead-webhook.js) and the
 * online quote wizard (routes/public-quote.js, routes/public-property-lookup.js).
 *
 * Validated against a FIXED allowlist shared with the Astro select options —
 * any other value (including free text) is silently dropped, never stored.
 * Kept SEPARATE from leadSource: leadSource is technically-observed
 * attribution (UTM/referrer/click-id); this is what the visitor chose
 * themselves, and unknown stays unknown (null) rather than being guessed at.
 */

const HEARD_ABOUT_OPTIONS = new Set([
  'google_search', 'google_maps', 'chatgpt', 'other_ai',
  'facebook_instagram', 'nextdoor', 'yelp', 'friend_neighbor',
  'truck_yard_sign', 'other',
]);

function sanitizeHeardAbout(value) {
  const key = String(value || '').trim().toLowerCase();
  return HEARD_ABOUT_OPTIONS.has(key) ? key : null;
}

// Optional follow-up to the AI choices above ("What did you ask it?"). Stored
// as typed — no redaction — but only for chatgpt / other_ai, and normalized to
// one printable line (whitespace collapsed) capped at 500 chars. Anything else
// (non-string, empty, or a non-AI heard_about) resolves to null.
const HEARD_ABOUT_PROMPT_MAX = 500;
const HEARD_ABOUT_PROMPT_KEYS = new Set(['chatgpt', 'other_ai']);

function sanitizeHeardAboutPrompt(value, heardAbout) {
  if (!HEARD_ABOUT_PROMPT_KEYS.has(heardAbout)) return null;
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, HEARD_ABOUT_PROMPT_MAX).trim() : null;
}

// The pair a public wizard request carries, sanitized together: the prompt
// resolves against the SANITIZED answer, so it is kept only for chatgpt /
// other_ai. Both are null when the visitor skipped the question.
function heardAboutFromBody(body) {
  const src = body && typeof body === 'object' ? body : {};
  const heardAbout = sanitizeHeardAbout(src.heard_about);
  return {
    heardAbout,
    heardAboutPrompt: sanitizeHeardAboutPrompt(src.heard_about_prompt, heardAbout),
  };
}

// SQL fragments for the "never overwrite a recorded answer" UPDATE: the
// answer lands only while the row's heard_about is empty/NULL, and the prompt
// rides the same condition so a stored answer never gains a mismatched prompt.
// UPDATE right-hand sides read the row's OLD values, so both columns see the
// same pre-write state in one statement. Returns plain field updates for a knex
// `.update()`; pass the knex instance as `db`. Empty object when nothing to
// record, so the caller can spread it unconditionally.
function heardAboutFillIfEmpty(db, { heardAbout, heardAboutPrompt } = {}) {
  if (!heardAbout) return {};
  return {
    heard_about: db.raw("CASE WHEN COALESCE(heard_about, '') = '' THEN ?::text ELSE heard_about END", [heardAbout]),
    heard_about_prompt: db.raw(
      "CASE WHEN COALESCE(heard_about, '') = '' THEN ?::text ELSE heard_about_prompt END",
      [heardAboutPrompt || null],
    ),
  };
}

// Calls: the call reader's customer_history.referral_source is free text the
// model fills only when a caller says how they found Waves (29 of 343 calls,
// 2026-09-28..10-29 — "google", "ai", "chatgpt", "online reviews", "son is a
// waves customer", sometimes a referrer's name). Mapped onto the SAME
// allowlist; text that names no channel clearly (a bare name, "website",
// "online", "online reviews", "chat") stays null — unknown stays unknown.
// Order matters: AI first; "next-door neighbor" is a person, not the
// Nextdoor app; Google Maps before Google search. "claude" is left out on
// purpose: it is also a first name.
const CALL_REFERRAL_RULES = [
  ['chatgpt', /\bchat\s*gpt\b|\bopen\s*ai\b/],
  ['other_ai', /\bai\b|\ba\.i\.?|\bartificial intelligence\b|\b(gemini|perplexity|copilot|chatbot)\b/],
  ['friend_neighbor', /\bnext[\s-]?door neighbou?rs?\b/],
  ['nextdoor', /\bnext[\s-]?door\b/],
  ['google_maps', /\bgoogle maps?\b/],
  ['google_search', /\bgoogl(e|ed|ing)\b|\b(online|internet|web) search\b|\bsearch(ed|ing)? (online|the internet|the web)\b/],
  ['facebook_instagram', /\bfacebook\b|\binstagram\b|\bfb\b/],
  ['yelp', /\byelp\b/],
  ['truck_yard_sign', /\b(trucks?|vans?|yard signs?)\b/],
  ['friend_neighbor', /\b(friends?|neighbou?rs?|family|word of mouth|referr(ed|al)|recommend(ed|ation)?|son|daughter|mother|mom|father|dad|wife|husband|brother|sister|cousin|aunt|uncle|relatives?|co-?workers?)\b/],
];

function heardAboutFromCallReferral(text) {
  if (typeof text !== 'string') return null;
  const s = text.slice(0, 300).toLowerCase();
  for (const [value, re] of CALL_REFERRAL_RULES) {
    if (re.test(s)) return sanitizeHeardAbout(value);
  }
  return null;
}

module.exports = {
  HEARD_ABOUT_OPTIONS,
  HEARD_ABOUT_PROMPT_MAX,
  HEARD_ABOUT_PROMPT_KEYS,
  sanitizeHeardAbout,
  sanitizeHeardAboutPrompt,
  heardAboutFromBody,
  heardAboutFillIfEmpty,
  heardAboutFromCallReferral,
};
