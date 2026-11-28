/**
 * Newsletter Draft Service
 *
 * Shared Claude draft creation logic extracted from the /draft-ai route
 * handler.  Accepts an optional Knex transaction handle so callers like
 * the calendar draft-from-plan endpoint can wrap the entire operation
 * (AI call + DB insert + calendar link) in a single atomic transaction.
 *
 * The flagship system prompt and event-block formatting are copied
 * verbatim from admin-newsletter.js to keep this module self-contained
 * — no cross-file template imports.
 */

const crypto = require('crypto');
const db = require('../models/db');
const MODELS = require('../config/models');
const { getVoiceProfile, validateVoice } = require('../config/voice-profiles');
const { getNewsletterType } = require('../config/newsletter-types');
const { etDateString } = require('../utils/datetime-et');
const { FEEDBACK_HTML_TOKEN, FEEDBACK_TEXT_TOKEN } = require('./newsletter-feedback');
const logger = require('./logger');
const {
  isEligibleForFreshDigest,
  excludeRoutineRecurringFromQuery,
  dedupeDigestEvents,
} = require('./event-freshness');
const {
  filterPreviouslyFeaturedIdentities,
  filterRepeatedDateIdentities,
  loadSharedYearPool,
} = require('./newsletter-event-selection');
const { dispatchWithFallback } = require('./llm/call');

function generateSlug(subject) {
  const base = (subject || 'newsletter')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  const date = etDateString();
  const suffix = crypto.randomUUID().slice(0, 6);
  return `${base}-${date}-${suffix}`;
}

function resolveIssueReference(issueReference, fallback = new Date()) {
  const reference = issueReference ? new Date(issueReference) : new Date(fallback);
  if (Number.isNaN(reference.getTime())) throw new Error('issueReference must be a valid date');
  return reference;
}

/**
 * Build the event block string from an array of events_raw rows.
 * Each event leads with its UUID so Claude can reference it back via
 * the `eventId` field — facts (date/time/venue/address/URL) are then
 * re-locked from the DB at render time, regardless of what the model
 * echoes in its prose.
 */
function formatEventBlock(events) {
  if (!events || events.length === 0) return '';
  return '\n\nAPPROVED EVENTS (use ONLY these — do not invent events):\n' +
    events.map((ev, i) => {
      const parts = [`${i + 1}. [eventId: ${ev.id}] ${ev.title}`];
      if (ev.city) parts.push(`   City: ${ev.city}`);
      if (ev.start_at) parts.push(`   Date: ${new Date(ev.start_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })}`);
      if (ev.start_at) parts.push(`   Time: ${new Date(ev.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}`);
      if (ev.venue_name) parts.push(`   Venue: ${ev.venue_name}`);
      if (ev.venue_address) parts.push(`   Address: ${ev.venue_address}`);
      if (ev.event_url) parts.push(`   URL: ${ev.event_url}`);
      if (ev.image_url) parts.push(`   Image: ${ev.image_url}`);
      if (ev.source_name) parts.push(`   Source: ${ev.source_name}`);
      if (ev.description) parts.push(`   Details: ${ev.description.slice(0, 200)}`);
      return parts.join('\n');
    }).join('\n\n');
}

/**
 * Build the flagship system prompt. Produces structured JSON: the subject,
 * the opening line, three "This weekend" points and ONE sentence per event
 * (keyed by eventId). Everything else — name, town, date, time, venue, price,
 * link, day grouping — is rendered by code from the database (short weekly
 * format, owner 2026-11-26).
 */
// Topics only — no figure, duration, temperature, date range or named-source
// number lives here (codex round 14 P1): a fact restated in a static prompt
// outlives its withdrawal from the register, and the flagship lane has no
// claim scan to catch it. The numbers reach the writer through
// factsPromptBlock alone. pest-insider.test.js pins this.
const FLAGSHIP_SEASONAL_CONTEXT = [
  '- Jan–Feb: snowbird peak, dry lawns, red tide drift; winter termite flights only as the verified facts state them',
  '- Mar: spring break, citrus bloom, native and Asian subterranean termite flight season (from the verified facts)',
  '- Apr: Bradenton Blues Festival, spring training tail, lawn pre-emergents, lovebugs (their flight season, from the verified facts)',
  '- May: DeSoto Heritage Festival, lovebugs, rainy season starts — container mosquitoes after rain (egg-to-adult timeline and the dump-and-scrub rhythm, from the verified facts)',
  '- Jun: hurricane season begins, daily thunderstorms, the summer fertilizer restrictions (dates and places only as the verified facts state them)',
  '- Jul: Fourth of July, peak rainy season, chinch bugs (their season, from the verified facts), palmetto bugs indoors (why they wander in, from the verified facts)',
  '- Aug: back-to-school, peak hurricane risk, chinch bug damage on St. Augustine',
  '- Sep: hurricane peak, Siesta Key Crystal Classic, post-storm yard checklist; drywood termite flights (from the verified facts); native subterranean termites have ONE flight season and no second swarm after storms',
  '- Oct: snowbirds return, rodent exclusion checklist (roof rat access and exclusion, from the verified facts — the source gives no rodent season), Halloween on barrier islands',
  '- Nov: Sarasota Season of Sculpture, turkey trots, winter annuals',
  '- Dec: boat parades, winter termite flights only as the verified facts state them, holiday pantry pests',
  '- SWFL pests: subterranean termites, German cockroaches, palmetto bugs, no-see-ums, salt-marsh mosquitoes, fire ants, chinch bugs, sod webworms',
].join('\n');

async function loadFactsBlock() {
  try {
    return await require('./email-division/fact-register').factsPromptBlock();
  } catch (err) {
    logger.warn(`[newsletter-draft] flagship facts block unavailable, drafting without pest facts: ${err.message}`);
    return '';
  }
}

function buildFlagshipSystemPrompt(voice, month) {
  return `You write the Waves Newsletter — Waves Pest Control's weekly local events email — for readers from North Port to Tampa.

It is a short, scannable list of what is worth doing this week. Write like a friendly neighbor telling you what is going on. Plain, warm, specific. Not corporate, and not a comedy bit.

CURRENT MONTH: ${month}

SWFL SEASONAL CONTEXT (topics only, for framing the season. This is an events email: do not write pest or lawn facts. Any pest fact, date, count or timeline you do state must come from the VERIFIED FACTS block at the end of this prompt, or be left out):
${FLAGSHIP_SEASONAL_CONTEXT}

VOICE:
- A normal, friendly neighbor. Short sentences. One fact or one idea in each.
- HUMOR BUDGET for the WHOLE issue (owner 2026-11-26): at most ONE light joke in the subject line and ONE in the opening line (introText). No joke anywhere else: not in the weekend points, not in an event sentence.
- No emoji except the ONE leading emoji in the subject line. No internet slang, no all-caps hype, no parenthetical asides.
- Do not bold, italicize or add markdown to any field. The renderer does the formatting.

SUBJECT LINES: max ${voice.subjectLineRules.maxLength} chars. LEAD with exactly ONE thematic emoji then a space, then name 2-3 REAL events from the approved list and their towns. One light joke is fine. Example shape: "🎄 Boat parade in Venice, tree lighting in Sarasota, jazz in Bradenton". Never two emoji, never zero.

PREVIEW TEXT: 40-110 chars. Plain: what is inside this week. Not a joke.

NEVER WRITE: ${voice.bannedCorporatePhrases.map(p => `"${p}"`).join(', ')}

EVENT RULES:
- Use ONLY the approved event records provided. Do NOT invent events. Include every approved event.
- For every event you include, copy its [eventId: ...] UUID into the "eventId" field exactly. The renderer re-pulls the name, town, date, time, venue, price and link straight from the database — anything you write for those is IGNORED, so do not write them.
- why: ONE plain sentence, 22 words max, that says why someone would actually go. No joke. Do not repeat the name, town, date, time, venue or price. Do not start the sentence with "Free", "Entry", "Event", "Tickets" or "Admission".
- Do NOT mention specific dollar amounts, "free admission", "no cost", "complimentary", or any ticket-price phrasing anywhere. We never store admission in the DB, so any pricing claim you make is unverifiable and will hard-block the send.
- Do NOT make pest-control safety or efficacy claims ("pet-safe", "child-safe", "guaranteed", "100% effective", "EPA-approved") — this is an events email, not a service pitch.

INTRO: greeting "Hey there!" — NEVER include a name or name placeholder; the renderer appends the subscriber's first name automatically. introText: one or two short sentences that open the week. This is the ONE place besides the subject where a light joke may go.
weekendPoints: exactly 3 short "This weekend" points, 12 words max each, plain text, no emoji. Each names something real from the approved events (an event, a town, a day). No prices, no "free", no jokes.

SIGN-OFF: "${voice.signoff}"

Return STRICT JSON (no HTML, no prose outside the JSON):
{
  "subjectVariants": ["string", "string", "string"],
  "selectedSubject": "string",
  "previewText": "string, 40-110 chars",
  "greeting": "string (e.g. 'Hey there!')",
  "introText": "string (1-2 short sentences)",
  "weekendPoints": ["string", "string", "string"],
  "events": [
    {
      "eventId": "string (REQUIRED — copy the [eventId: ...] UUID from the approved event verbatim)",
      "why": "string (ONE plain sentence, 22 words max, why to go)"
    }
  ],
  "signoff": "string"
}`;
}

// ── Newsletter assembly ──────────────────────────────────────────────
//
// Renders structured event JSON into email HTML and plain text (the short
// weekly format below). The GIF helpers further down are no longer used by
// the weekly pipeline (the 2026-07-28 comedic format is retired, 2026-11-26)
// and stay only until their own tests are retired.

// Palette lives in email-template.js (one theme layer for every email
// surface, resolved per property access so generated bodies follow the
// active GATE_EMAIL_GLASS chrome). Getter shape keeps the 30+
// `COLORS.x` call sites unchanged; classic values are verbatim the
// original set, so gate-off output is byte-identical.
const { newsletterPalette, newsletterSectionTheme } = require('./email-template');
const COLORS = {
  get font() { return newsletterPalette().font; },
  get navy() { return newsletterPalette().navy; },
  get blue() { return newsletterPalette().blue; },
  get gold() { return newsletterPalette().gold; },
  get muted() { return newsletterPalette().muted; },
  get cardBg() { return newsletterPalette().cardBg; },
  get homeownerBg() { return newsletterPalette().homeownerBg; },
  get rule() { return newsletterPalette().rule; },
};

// Inline-only section bands are deliberate: many inboxes strip embedded CSS,
// so each heading carries its own accessible text/background/accent pairing.
function sectionHeadingStyle(index, marginBottom = 12) {
  const theme = newsletterSectionTheme(index);
  return `font-family:${COLORS.font};font-size:20px;line-height:1.35;font-weight:800;color:${theme.text};background:${theme.background};border-left:4px solid ${theme.accent};border-radius:8px;padding:10px 12px;margin:0 0 ${marginBottom}px 0;`;
}

// The exact words the hero poster letters into the artwork: the issue's
// subject line, emoji stripped (image models render emoji glyphs as mush;
// the words are the content signal). Owner rule 2026-07-09: the hero must
// carry text and it must match what the issue is actually delivering.
function heroTitleText(subject) {
  return String(subject || '')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}️‍]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fetch up to 25 candidate GIFs for a search term as [{ id, url }].
// Candidates (not a single winner) so the assembler can dedupe across the
// whole issue: similar search terms ("excited dance", "happy dancing")
// share Giphy's top result, and limit=1 shipped the same GIF 6× in one
// issue (2026-07-09 draft). Wide pool per owner ("slightly broader search
// or scope"). Never rejects — [] on any failure.
async function searchGiphyCandidates(term) {
  if (!term) return [];
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) return [];
  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(term)}&limit=25&rating=pg`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data.data) ? data.data : [])
      .map((gif) => ({
        id: gif?.id,
        url: gif?.images?.downsized_medium?.url || gif?.images?.original?.url || null,
      }))
      .filter((c) => c.id && c.url);
  } catch { return []; }
}

// Issue-level GIF dedupe: first candidate whose Giphy id hasn't been used
// in this issue wins and is marked used. A term whose candidates are ALL
// taken yields null — the renderer falls back to the event photo, because
// repeating a GIF is never acceptable (owner rule 2026-07-09).
function pickUniqueGif(candidates, usedIds) {
  for (const c of candidates || []) {
    if (!usedIds.has(c.id)) {
      usedIds.add(c.id);
      return c.url;
    }
  }
  return null;
}

// Expanded-keyword retry (owner 2026-07-09: "expand the keywords"): when a
// term's whole candidate pool is already used, re-search with broadened
// variants of the term before giving up. Only then does the renderer fall
// back to the event photo — a repeat is still never an option.
//
// Two bounds keep a degraded Giphy from stalling assembly (each search
// carries a 5s timeout): an EMPTY primary pool means Giphy is unreachable
// or the term is dead — broadened variants would just burn more timeouts,
// so we skip them; and the caller passes a shared per-issue retryBudget so
// the extra sequential searches across all sections stay capped.
async function pickUniqueGifWithRetry(term, candidates, usedIds, retryBudget = null) {
  const first = pickUniqueGif(candidates, usedIds);
  if (first) return first;
  if (!term) return null;
  if (!candidates || candidates.length === 0) return null;
  for (const broadened of [`${term} reaction`, `${term} meme`, `funny ${term}`]) {
    if (retryBudget) {
      if (retryBudget.remaining <= 0) return null;
      retryBudget.remaining -= 1;
    }
    const pick = pickUniqueGif(await searchGiphyCandidates(broadened), usedIds);
    if (pick) return pick;
  }
  return null;
}

// HTML-escape a string before it is interpolated into the email body.
// Critical defense: event titles/descriptions come from ingested external
// feeds and the rest is free-form model output, so any raw <a>/<img>/<script>
// must be neutralized or it renders live in subscribers' inboxes.
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Validate a URL for safe use in an href/src: http(s) only, quotes escaped.
// Shared by image src and the DB-locked event ticket link so a malformed or
// javascript:/data: URL (even one that slipped through ingestion) can't render.
function safeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString().replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  } catch { return null; }
}

// ── Greeting personalization ─────────────────────────────────────────
// The assembler injects this token into the greeting ("Hey
// there{{greeting-name}}!"); sendBatch substitutes it per recipient with
// ", FirstName" (or "" when the subscriber has no first name, so the
// greeting reads naturally either way). Hyphenated on purpose: an
// underscore token could pair with a model-written _italic_ marker in
// markdownToHtml and split the token mid-render.
const GREETING_NAME_TOKEN = '{{greeting-name}}';

// "Hey there!" → "Hey there{{greeting-name}}!" — the token slots in
// before any trailing punctuation so the substituted name lands inside
// the sentence, not after the exclamation point.
function greetingWithNameToken(greeting) {
  const m = String(greeting).match(/^([\s\S]*?)([!.?…]*)\s*$/);
  return `${m[1]}${GREETING_NAME_TOKEN}${m[2]}`;
}

// Substitution value for one subscriber. SendGrid substitutions are raw
// string replacement into BOTH the HTML and plain-text parts, so instead
// of HTML-escaping (which would render "&#39;" in the text part for
// names like D'Angelo) we whitelist name characters — letters, marks,
// apostrophes, spaces, periods, hyphens. No HTML metacharacter survives.
function greetingNameValueFor(firstName) {
  const cleaned = String(firstName || '')
    .replace(/[^\p{L}\p{M}'’ .-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return cleaned ? `, ${cleaned}` : '';
}

// For surfaces with no per-recipient identity (public archive pages,
// any path that skips substitution): drop the token so readers never
// see a literal "{{greeting-name}}".
function stripGreetingNameToken(content) {
  return String(content || '').split(GREETING_NAME_TOKEN).join('');
}

// Per-recipient merge tags resolved only inside the SendGrid payload at send
// time. Hyphenated to avoid markdown _italic_ collisions (see GREETING token).
const CITY_TOKEN = '{{city}}';
const GRASS_TYPE_TOKEN = '{{grass-type}}';
// Neutral fallbacks for BOTH the live-send default (no lawn/city on file) and
// every no-recipient surface. 'St. Augustine' is the owner-directed default
// grass; 'your area' reads naturally in a city slot.
const DEFAULT_CITY_LABEL = 'your area';
const DEFAULT_GRASS_LABEL = 'St. Augustine';

// Neutralize EVERY per-recipient merge tag for surfaces that render the
// persisted body without substitution (public archive, RSS feed, preview/test
// send, touchpoint log). Greeting → '' (it carries its own leading ", "); city
// and grass → their neutral defaults — so a campaign using these tokens never
// shows a literal "{{city}}" / "{{grass-type}}" in public.
function stripPersonalizationTokens(content) {
  // require here (not at top) so newsletter-quiz — which requires db — stays a
  // leaf of newsletter-draft's dependency graph regardless of load order.
  const { neutralizeQuizTokens } = require('./newsletter-quiz');
  const { neutralizeFeedbackTokens } = require('./newsletter-feedback');
  // Leftover evclick tokens (render paths that couldn't resolve the DB
  // url map) fall back to the homepage — defense-in-depth; the archive
  // and proof paths resolve them to the real event URLs first.
  const { resolveEvclickDirect } = require('./newsletter-event-clicks');
  // A Waves Pest Insider issue's tokens (pest-insider/referral-line.js, a leaf
  // module): the "Your home" tokens go, since that block is per reader and
  // never shows here, and the referral line stands in its form with no amount.
  const { neutralizeIssueTokens } = require('./pest-insider/referral-line');
  return resolveEvclickDirect(neutralizeFeedbackTokens(neutralizeQuizTokens(
    neutralizeIssueTokens(stripGreetingNameToken(content))
      .split(CITY_TOKEN).join(DEFAULT_CITY_LABEL)
      .split(GRASS_TYPE_TOKEN).join(DEFAULT_GRASS_LABEL),
  )));
}

// Highlights bullets are plain text with a renderer-added "•" marker
// (owner decision 2026-06-12: no emoji bullets). The prompt forbids
// emojis, but strip any leading emoji/marker the model emits anyway —
// and older persisted drafts still carry the emoji-bullet format.
function plainBulletText(text) {
  return String(text || '')
    // leading emoji clusters incl. ZWJ sequences + variation selectors
    .replace(/^\s*(?:(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u200D\uFE0F\u20E3])+\s*)*/u, '')
    // leading literal bullet/dash markers the model might add
    .replace(/^[•·▪◦*–—-]+\s*/, '')
    .trim();
}

// The renderer prepends the bold "P.S." label, so strip any leading
// P.S./PS marker the model writes into the ps field anyway — the label
// never doubles ("P.S. P.S. ..." shipped once). The prompt forbids it,
// but older persisted drafts still carry the prefix. Bare "PS" with no
// dot/colon is left alone: it could open a real word ("PSA...").
function psBodyText(text) {
  return String(text || '').replace(/^\s*(?:p\.\s?s\.?|ps[.:])[\s:,.—–-]*/i, '').trim();
}

// The renderer prepends the "✔️ " marker to checklist items, so strip any
// leading checkmark the model writes anyway — items never double
// ("✔️ ✔️ ..." shipped once). The prompt's "✔️-style reminders" wording
// invites the prefix, and older persisted drafts still carry it. Only
// checkmark-genre emoji are stripped (unlike plainBulletText): a checklist
// item legitimately opening with any other emoji is content, not a marker.
function checklistItemText(text) {
  // ✅ U+2705, ✓ U+2713, ✔ U+2714, ☑ U+2611 — each optionally followed by
  // the emoji variation selector (U+FE0F), repeated ("✔️ ✔️ item" strips fully).
  return String(text || '').replace(/^\s*(?:[\u2705\u2713\u2714\u2611]\uFE0F?\s*)+/, '').trim();
}

// Exact inverse of escapeHtml, for deriving the plain-text part from the
// assembled HTML. Text content in the body only ever passes through
// escapeHtml/markdownToHtml, so after tags are stripped these five
// entities are the only ones a clean render contains — left undecoded,
// the text part ships a literal "&#39;" wherever an apostrophe appears.
// No generic entity table on purpose: a model-written literal entity
// ("&hellip;") was double-escaped to "&amp;hellip;" and must round-trip
// back to its literal text form — which is also why &amp; decodes last.
function decodeEscapedEntities(text) {
  return String(text ?? '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Re-lock factual fields (date, time, location, address, ticket URL, image)
 * onto AI-generated event objects using the corresponding events_raw rows.
 *
 * The model is instructed to never write these fields, but we override them
 * anyway — defense in depth. Events without a matching DB row are dropped
 * and surfaced to the caller as warnings (or, if every event drops, a hard
 * error before assembly).
 *
 * @param {Array} aiEvents - The `events` array from Claude's JSON output
 * @param {Array} dbEvents - The events_raw rows fetched by eventIds
 * @returns {{ locked: Array, dropped: Array<{ index:number, reason:string, title?:string }> }}
 */
// Strip URLs (and bare www. / markdown links) from AI commentary prose.
// The ONLY link that should reach the body is the DB-locked eventUrl,
// rendered in the metadata block — a URL the model slipped into prose is
// unverified and could be wrong or malicious. Leaves trailing connector
// words like "at"/"here" dangling-free by tidying whitespace + stray
// punctuation around the removed token.
function stripCommentaryUrls(value) {
  if (typeof value !== 'string' || !value) return value;
  return value
    .replace(/\[([^\]]*)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, '$1')                       // markdown link → keep label
    .replace(/\b(?:at|via|from|on|here)\b[\s:]*(?:https?:\/\/|www\.)[^\s)<>"']+/gi, '')   // connector + URL together
    .replace(/\b(?:https?:\/\/|www\.)[^\s)<>"']+/gi, '')                                  // remaining bare URLs
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

function sanitizeCommentaryFields(ev) {
  const out = { ...ev };
  for (const k of ['title', 'why', 'description', 'proTip', 'closingLine', 'gifCaption', 'scoopLabel', 'linkText', 'hook', 'heroWhy']) {
    if (typeof out[k] === 'string') out[k] = stripCommentaryUrls(out[k]);
  }
  if (Array.isArray(out.highlights)) {
    // Strip URLs, then drop any bullet that's now empty (a URL-only item
    // strips to '' and would render as a blank bullet).
    out.highlights = out.highlights
      .map((h) => (typeof h === 'string' ? stripCommentaryUrls(h) : h))
      .filter((h) => !(typeof h === 'string' && h.trim() === ''));
  } else if (typeof out.highlights === 'string') {
    // assembleWeeklyNewsletter wraps a string highlights into an array and
    // renders it. A URL-only string strips to '' — null it out so the
    // "What to expect" block isn't rendered with a single blank bullet.
    const stripped = stripCommentaryUrls(out.highlights);
    out.highlights = stripped.trim() === '' ? null : stripped;
  }
  return out;
}

// Free-prose fields the model authors outside the per-event objects. They get
// the same URL strip the event commentary already gets — only the DB-locked
// event ticket link may render. (Raw HTML in these fields is separately
// neutralized by markdownToHtml's escaping at render time; this removes
// invented/off-brand link TEXT a reader could still click as plain markdown.)
const WEEKEND_POINT_LIMIT = 3;
const PROSE_FIELDS = ['greeting', 'introText', 'introGifCaption', 'transitionLine', 'homeownerMinute', 'closingHeading', 'closingText', 'signoff', 'ps'];
function sanitizeProseFields(draft) {
  for (const k of PROSE_FIELDS) {
    if (typeof draft[k] === 'string') draft[k] = stripCommentaryUrls(draft[k]);
  }
  if (Array.isArray(draft.closingChecklist)) {
    draft.closingChecklist = draft.closingChecklist
      .map((item) => (typeof item === 'string' ? stripCommentaryUrls(item) : null))
      .filter((item) => typeof item === 'string' && item.trim() !== '');
  } else {
    draft.closingChecklist = null;
  }
  // The three "This weekend" points: URL strip like the rest of the prose,
  // blank items dropped, never more than three (the short format's cap).
  draft.weekendPoints = (Array.isArray(draft.weekendPoints) ? draft.weekendPoints : [])
    .map((item) => (typeof item === 'string' ? stripCommentaryUrls(item) : ''))
    .filter((item) => item.trim() !== '')
    .slice(0, WEEKEND_POINT_LIMIT);
  return draft;
}

function lockEventFactsFromDb(aiEvents, dbEvents) {
  const dbById = new Map((dbEvents || []).map((r) => [String(r.id).toLowerCase(), r]));
  const locked = [];
  const dropped = [];
  const seenIds = new Set();

  (aiEvents || []).forEach((ev, index) => {
    const rawId = ev && ev.eventId ? String(ev.eventId).toLowerCase() : '';
    if (!rawId) {
      dropped.push({ index, reason: 'missing eventId', title: ev?.title });
      return;
    }
    const row = dbById.get(rawId);
    if (!row) {
      dropped.push({ index, reason: 'eventId not in approved list', title: ev?.title });
      return;
    }
    if (seenIds.has(rawId)) {
      dropped.push({ index, reason: 'duplicate eventId in draft', title: ev?.title });
      return;
    }
    seenIds.add(rawId);

    const startAt = row.start_at ? new Date(row.start_at) : null;
    const dateStr = startAt
      ? startAt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })
      : null;
    const timeStr = startAt
      ? startAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
      : null;
    const date = dateStr && timeStr ? `${dateStr} @ ${timeStr}` : (dateStr || null);
    const location = formatLockedLocation(row);

    locked.push({
      // Strip any URLs the model slipped into commentary prose before
      // spreading — only the DB-locked eventUrl below may render as a link.
      ...sanitizeCommentaryFields(ev),
      eventId: row.id,
      // The locked occurrence, persisted on the send (event_occurrences) so
      // the sender stamps the date the email shows.
      startAt: row.start_at,
      date,
      dateStr,
      timeStr,
      // Beehiiv house device: the clock emoji matches the actual start hour.
      clockEmoji: startAt ? clockEmojiFor(startAt) : null,
      location,
      ...lockedTownAndVenue(row),
      address: locationCoversAddress(location, row.venue_address) ? null : (row.venue_address || null),
      eventUrl: row.event_url || null,
      imageUrl: row.image_url || null,
      // DB-locked official name — the assembler links its first occurrence
      // in the description prose (the Beehiiv inline-link convention).
      sourceTitle: row.title || null,
      // DB-verifiable free flag: events_raw.is_free. Rendered as a bare
      // "FREE" badge — never as model prose, so the hallucinated-claim
      // scan's unverifiable-pricing rules stay meaningful.
      isFree: row.is_free === true,
      // DB-locked price line (events_raw.price_text, populated by the
      // rubric-era assessment) — renders verbatim-escaped in the meta box.
      // Model-written dollar amounts remain hard-blocked; this is the only
      // legitimate price source.
      priceText: (typeof row.price_text === 'string' && row.price_text.trim())
        ? row.price_text.trim().slice(0, 80)
        : null,
      // admission deliberately omitted — events_raw does not store it,
      // so any value the model produced was unverifiable.
      admission: null,
      // Deterministic audience labels for the compact format — derived
      // from DB assessment fields, never model prose.
      labels: deriveEventLabels(row),
    });
  });

  return { locked, dropped };
}

/**
 * Audience label chips for the compact card format (owner spec
 * 2026-07-28): Family / Parents' night / Free / Worth the drive.
 * Derived ONLY from DB fields so a hallucinated label can't render.
 */
function deriveEventLabels(row) {
  let eventTags = row.audience_tags;
  if (typeof eventTags === 'string') { try { eventTags = JSON.parse(eventTags); } catch { eventTags = []; } }
  const tagSet = new Set((Array.isArray(eventTags) ? eventTags : []).map((t) => String(t).toLowerCase()));
  let breakdown = row.score_breakdown;
  if (typeof breakdown === 'string') { try { breakdown = JSON.parse(breakdown); } catch { breakdown = {}; } }

  const labels = [];
  if (row.family_friendly === true || tagSet.has('family') || breakdown?.family_status === 'confirmed') {
    labels.push('Family');
  }
  if (tagSet.has('parents_night') || breakdown?.family_status === 'adults_lean') {
    labels.push("Parents' night");
  }
  // The customer-facing Free chip is STRICTER than the portfolio's
  // free-ish coverage classifier: an unqualified "Free" claim renders
  // only when the row is unambiguously all-free — the is_free flag, the
  // curated tag, or price text that says free / $0 WITHOUT any nonzero
  // dollar tier ("Kids $0, adults $25" gets no chip).
  const priceText = String(row.price_text || '');
  // Any nonzero dollar amount — integer OR fractional ("$0.50") — is a
  // paid tier that disqualifies the unqualified Free chip.
  const hasPaidTier = /\$\s*(?:\d*[1-9]\d*(?:\.\d+)?|\d+\.\d*[1-9]\d*)/.test(priceText);
  const unambiguouslyFree = /\bfree\b/i.test(priceText) || /^\s*\$?\s*0+(?:\.0+)?\s*$/.test(priceText);
  // Explicit paid pricing SUPPRESSES the chip even when a stale is_free
  // flag or curated tag survives a later price correction — the corrected
  // price text is the freshest signal.
  if (!hasPaidTier && (row.is_free === true || tagSet.has('free') || unambiguouslyFree)) {
    labels.push('Free');
  }
  if (tagSet.has('worth_the_drive')) labels.push('Worth the drive');
  return labels;
}

// 🕐..🕧 — pick the clock face matching the event's ET start time, snapping
// minutes to the nearest half-hour face (the shipped issues used 🕢 for
// 7:30PM, 🕗 for 8PM, 🕚 for 11AM).
const CLOCK_FACES = ['🕛', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚'];
const CLOCK_FACES_HALF = ['🕧', '🕜', '🕝', '🕞', '🕟', '🕠', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦'];
function clockEmojiFor(dateObj) {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: 'numeric', hour12: false, timeZone: 'America/New_York',
  }).formatToParts(dateObj);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 12;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return minute >= 15 && minute < 45 ? CLOCK_FACES_HALF[hour] : CLOCK_FACES[(minute >= 45 ? hour + 1 : hour) % 12];
}

// Title-case a stored city slug ("anna-maria" / "north port" → "Anna Maria",
// "North Port") for rendering.
function displayCity(raw) {
  if (!raw || typeof raw !== 'string') return null;
  return raw
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Venue strings from feeds often already embed the city and/or street
// address ("Izzy's Place, 12012 Cortez Rd W, Cortez, FL, 34215") — appending
// the city slug and the address again rendered triplicated locations. Only
// add what the venue string doesn't already contain.
function formatLockedLocation(row) {
  const venue = (row.venue_name || '').trim() || null;
  const city = displayCity(row.city);
  if (!venue) return city;
  if (!city || venue.toLowerCase().includes(city.toLowerCase())) return venue;
  return `${venue}, ${city}`;
}

// The short weekly format's heading and fact line carry the town and the
// venue separately (the combined `location` repeats the town).
function lockedTownAndVenue(row) {
  const venue = typeof row.venue_name === 'string' ? row.venue_name.trim() : '';
  return { town: displayCity(row.city), venue: venue || null };
}

function locationCoversAddress(location, address) {
  if (!location || !address) return false;
  const addr = String(address).trim();
  const streetNumber = addr.match(/^\d+/);
  if (!streetNumber) return false;
  // The street number alone is too weak a signal — "Studio 131" would
  // swallow the address "131 N Orange Ave". Require a street-NAME token
  // too (first alphabetic word of 3+ chars after the number, skipping
  // directionals like "N"/"SW").
  const streetWord = addr.slice(streetNumber[0].length).match(/[A-Za-z]{3,}/);
  if (!streetWord) return false;
  const haystack = location.toLowerCase();
  return haystack.includes(streetNumber[0]) && haystack.includes(streetWord[0].toLowerCase());
}

// Wrap the first occurrence of `text` inside already-escaped/markdown-rendered
// HTML with a link to `url`. Case-insensitive, plain-text match only — if the
// model split the name across emphasis tags, we simply don't link (the
// metadata block still carries a labeled link). `url` must already be
// safeUrl-validated by the caller.
// GIF-shaped urls: path suffix, format-style query params, or a known
// GIF-CDN host. Heuristic by design — image urls are rendered by the
// recipient's mail client, never fetched server-side, and a content-type
// probe of feed-controlled urls would reopen the SSRF surface the
// live-reverify hardening closed (event-reverify.js). Fail toward
// rendering: an unparseable url falls back to the plain suffix test.
function isLikelyGifUrl(url) {
  try {
    const u = new URL(url);
    if (/\.gif$/i.test(u.pathname)) return true;
    if (/(^|\.)(giphy\.com|tenor\.com|gfycat\.com)$/i.test(u.hostname)) return true;
    for (const v of u.searchParams.values()) {
      if (/\.gif$/i.test(v) || /^gif$/i.test(v)) return true;
    }
    return false;
  } catch {
    return /\.gif($|[?#])/i.test(String(url));
  }
}

function linkifyFirst(html, text, url) {
  const needle = escapeHtml(String(text).trim());
  if (!needle) return html;
  const idx = html.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return html;
  const matched = html.slice(idx, idx + needle.length);
  return `${html.slice(0, idx)}<a href="${url}" style="color:${COLORS.blue};text-decoration:underline;font-weight:600;">${matched}</a>${html.slice(idx + needle.length)}`;
}

function gifBlock(url, caption, { capHeight = false } = {}) {
  const safeGifUrl = safeUrl(url);
  if (!safeGifUrl) return '';
  // capHeight: EVENT visuals only (owner 2026-07-30 — GIFs and photos
  // share one 280px aspect-fit box). Intro and Pest Insider GIFs keep
  // their natural sizing. Capped visuals are mso-hidden like the still
  // photos (#3033 contract): Outlook's Word engine ignores max-height
  // and would render a tall GIF at natural size — Outlook readers keep
  // the caption and full card content.
  const sizing = capHeight
    ? 'max-width:100%;max-height:280px;width:auto;height:auto;'
    : 'max-width:100%;height:auto;';
  const imgHtml = `<div style="text-align:center;margin:12px 0 8px 0;">
<img src="${safeGifUrl}" alt="" style="${sizing}border-radius:10px;display:block;margin:0 auto;" />
</div>`;
  let html = capHeight ? `<!--[if !mso]><!-->${imgHtml}<!--<![endif]-->` : imgHtml;
  if (caption) {
    html += `\n<p style="text-align:center;margin:0 0 16px 0;font-size:14px;font-style:italic;color:${COLORS.muted};line-height:1.4;">${escapeHtml(caption)}</p>`;
  }
  return html;
}

function markdownToHtml(text) {
  if (!text) return '';
  // Escape HTML FIRST, then apply the bold/italic markdown. The ** and _
  // markers survive escaping, so formatting still renders, but any injected
  // <a href>/<img onerror> in model output or ingested event copy becomes
  // inert text instead of a live tag.
  return escapeHtml(text)
    .replace(/\*\*_([^_]+)_\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/_\*\*([^*]+)\*\*_/g, '<em><strong>$1</strong></em>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}

/**
 * Compact flagship assembler (owner spec 2026-07-28): one hero + compact
 * standard cards, Community Notes, Homeowner Minute, short close. No TOC,
 * no GIFs, no scoop labels, no P.S. Official event names lead every card
 * and every fact line is DB-locked (lockEventFactsFromDb). Target: whole
 * body under ~900 words.
 */
async function assembleWavesNewsletter(draft) {
  const parts = [];
  const events = draft.events || [];
  const hero = events.find((ev) => ev.isHero) || events[0] || null;
  const standard = events.filter((ev) => ev !== hero);

  const metaLine = (ev) => {
    const bits = [];
    if (ev.dateStr) {
      bits.push(`📅 <strong>${escapeHtml(ev.dateStr)}${ev.timeStr ? `, ${escapeHtml(ev.timeStr)}` : ''}</strong>`);
    }
    if (ev.location) {
      // Include the separately-locked street address when the venue line
      // doesn't already carry it — readers get directions without the link.
      const loc = ev.address ? `${ev.location} (${ev.address})` : ev.location;
      bits.push(`📍 ${escapeHtml(loc)}`);
    }
    const labels = Array.isArray(ev.labels) ? ev.labels : [];
    if (labels.length) bits.push(`<strong>${labels.map(escapeHtml).join(' · ')}</strong>`);
    // Ordinary spaces around the separator — the derived plain-text body
    // strips tags but does not decode &nbsp;, so nonbreaking entities
    // would reach text-only clients literally.
    return bits.join(' · ');
  };

  const detailsLink = (ev, text = 'Details') => {
    const url = safeUrl(ev.eventUrl);
    if (!url) return '';
    // Details links render as {{evclick:<eventId>}} tokens: the live
    // sender substitutes a per-recipient tracking redirect; proof,
    // preview, and archive resolve them back to the DIRECT event URL
    // (newsletter-event-clicks.js) — tracking applies to real sends only.
    const href = ev.eventId ? `{{evclick:${String(ev.eventId).toLowerCase()}}}` : url;
    return `<a href="${href}" style="color:${COLORS.blue};text-decoration:underline;font-weight:600;">${escapeHtml(text)} →</a>`;
  };

  // ── Greeting + intro ──
  if (draft.greeting) {
    parts.push(`<p style="margin:0 0 8px 0;font-size:22px;line-height:1.4;">👋 <strong><em>${markdownToHtml(greetingWithNameToken(draft.greeting))}</em></strong></p>`);
  }
  if (draft.introText) {
    parts.push(`<p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.introText)}</p>`);
  }

  // ── Hero ──
  if (hero) {
    const heroParts = [];
    heroParts.push(`<p style="margin:0 0 4px 0;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:${COLORS.muted};font-weight:600;">This week's top pick</p>`);
    const heroImg = safeUrl(hero.imageUrl);
    if (heroImg) {
      const heroAlt = escapeHtml(hero.sourceTitle || '');
      heroParts.push(`<div style="margin:0 0 10px 0;">
<!--[if !mso]><!--><img src="${heroImg}" alt="${heroAlt}" style="max-width:100%;height:auto;border-radius:10px;display:block;" /><!--<![endif]-->
<!--[if mso]><img src="${heroImg}" alt="${heroAlt}" width="544" /><![endif]-->
</div>`);
    }
    heroParts.push(`<h2 style="margin:0 0 6px 0;font-size:20px;line-height:1.35;">${escapeHtml(hero.sourceTitle || '')}</h2>`);
    const heroMeta = metaLine(hero);
    if (heroMeta) heroParts.push(`<p style="margin:0 0 8px 0;font-size:14px;color:${COLORS.muted};">${heroMeta}</p>`);
    if (hero.hook) heroParts.push(`<p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;">${markdownToHtml(hero.hook)}</p>`);
    if (hero.heroWhy) heroParts.push(`<p style="margin:0 0 8px 0;font-size:14px;line-height:1.5;"><strong>Why it made the cut:</strong> ${markdownToHtml(hero.heroWhy)}</p>`);
    const heroCta = detailsLink(hero, 'Details & tickets');
    if (heroCta) heroParts.push(`<p style="margin:0;font-size:14px;">${heroCta}</p>`);
    parts.push(`<div class="dm-box" style="margin:0 0 24px 0;padding:18px 20px;background:${COLORS.cardBg};border-radius:10px;">\n${heroParts.join('\n')}\n</div>`);
  }

  // ── Standard picks ──
  for (const ev of standard) {
    const card = [];
    // Per-event thumbnail (owner ask 2026-07-28 evening review): the
    // DB-locked event image renders above each card when the feed
    // supplied one — real event art, never generated, never a GIF.
    // Reject GIF urls — the thumbnail contract is real still event art,
    // and safeUrl validates scheme only. Two-axis cap without upscaling
    // for standards clients; Outlook's Word engine ignores max-* so the
    // MSO branch gets a fixed width (height scales proportionally).
    const thumbUrl = safeUrl(ev.imageUrl);
    if (thumbUrl && !isLikelyGifUrl(thumbUrl)) {
      const thumbAlt = escapeHtml(ev.sourceTitle || '');
      card.push(`<div style="margin:0 0 8px 0;">
<!--[if !mso]><!--><img src="${thumbUrl}" alt="${thumbAlt}" style="max-width:100%;max-height:220px;width:auto;height:auto;border-radius:8px;display:block;" /><!--<![endif]-->
<!--[if mso]><img src="${thumbUrl}" alt="${thumbAlt}" width="280" /><![endif]-->
</div>`);
    }
    card.push(`<h2 style="margin:0 0 6px 0;font-size:17px;line-height:1.35;">${escapeHtml(ev.sourceTitle || '')}</h2>`);
    const meta = metaLine(ev);
    if (meta) card.push(`<p style="margin:0 0 6px 0;font-size:14px;color:${COLORS.muted};">${meta}</p>`);
    // The DB-locked details link renders regardless of model prose — a
    // partially valid response must never ship a card with no way in.
    const link = detailsLink(ev);
    if (ev.hook) {
      card.push(`<p style="margin:0 0 6px 0;font-size:15px;line-height:1.6;">${markdownToHtml(ev.hook)}${link ? ` ${link}` : ''}</p>`);
    } else if (link) {
      card.push(`<p style="margin:0 0 6px 0;font-size:14px;">${link}</p>`);
    }
    parts.push(`<div style="margin:0 0 20px 0;">\n${card.join('\n')}\n</div>`);
  }

  // ── Community Notes ──
  const notes = (Array.isArray(draft.communityNotes) ? draft.communityNotes : [])
    .filter((n) => typeof n === 'string' && n.trim())
    .slice(0, 2);
  if (notes.length) {
    const noteLines = notes.map((n) => `<p style="margin:0 0 4px 0;font-size:14px;line-height:1.5;">• ${markdownToHtml(n)}</p>`);
    parts.push(`<div class="dm-box" style="margin:0 0 24px 0;padding:14px 18px;background:#FFF8EC;border-radius:10px;">
<p style="margin:0 0 6px 0;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:${COLORS.muted};font-weight:600;">Community notes</p>
${noteLines.join('\n')}
</div>`);
  }

  // ── Homeowner Minute ──
  if (draft.homeownerMinute) {
    parts.push(`<div id="homeowner-minute" style="margin:0 0 24px 0;">
<h2 style="margin:0 0 6px 0;font-size:17px;">🏠 Homeowner Minute</h2>
<p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.homeownerMinute)} <a href="https://www.wavespestcontrol.com/" style="color:${COLORS.blue};font-weight:600;">Schedule a visit at wavespestcontrol.com</a>.</p>
</div>`);
  }

  // ── Close + sign-off + reaction footer ──
  if (draft.closingText) {
    parts.push(`<p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.closingText)}</p>`);
  }
  parts.push(`<p style="margin:0 0 16px 0;font-size:15px;">${escapeHtml(draft.signoff || '— The Waves Team')}</p>`);
  parts.push(FEEDBACK_HTML_TOKEN);

  return parts.join('\n\n');
}

// ── Short weekly format (owner approved 2026-11-26) ───────────────────
//
// The weekly events email is a short, scannable list: three "This weekend"
// points, a subscribe line for forwarded copies, then the events under day
// headers in start-time order. Every event is the same four pieces — a bold
// "Name · Town" heading, ONE fixed fact line ("Fri, Nov 27 • 5:00 PM • Free ·
// Venue"), ONE plain sentence on why to go, and the tracked details link.
// Code renders the structure (day grouping, the fact line); the model only
// supplies the subject, the opening line, the three points and one sentence
// per event. Name, town, date, time, venue, price and link are all DB-locked.
// This replaces the long comedic per-event format (GIFs, headline + sub-line,
// 3 bullets, pro tip, closing line, checklist, P.S.).

// The site's newsletter sign-up page. It reads no source parameter (the
// sign-up form posts its own fixed source), so the link carries none.
const NEWSLETTER_SUBSCRIBE_URL = 'https://www.wavespestcontrol.com/newsletter/';
const DATES_CAN_CHANGE_LINE = 'Dates can change. Check before you go.';

// ET calendar facts for one event start, or null when it has none.
function etWhen(startAt) {
  const d = startAt ? new Date(startAt) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  // Newer ICU puts a narrow no-break space before AM/PM; plain text and the
  // claim scans want an ordinary space.
  const fmt = (opts) => d.toLocaleString('en-US', { timeZone: 'America/New_York', ...opts }).replace(/[  ]/g, ' ');
  return {
    ms: d.getTime(),
    dayKey: etDateString(d),
    weekday: fmt({ weekday: 'long' }),
    monthDay: fmt({ month: 'short', day: 'numeric' }),
    dateLabel: fmt({ weekday: 'short', month: 'short', day: 'numeric' }),
    timeLabel: fmt({ hour: 'numeric', minute: '2-digit' }),
  };
}

const PLAIN_FREE_PRICE = /^\s*(?:free(?:\s+(?:admission|entry))?|\$?\s*0+(?:\.0+)?)\s*[.!]?\s*$/i;

// One event's display pieces, shared by the HTML and text renderers.
function shortEventView(ev) {
  const when = etWhen(ev.startAt);
  const name = (ev.sourceTitle || ev.title || '').trim();
  const labels = Array.isArray(ev.labels) ? ev.labels : [];
  const url = safeUrl(ev.eventUrl);
  const priceText = (typeof ev.priceText === 'string' && ev.priceText.trim()) ? ev.priceText.trim() : null;
  return {
    when,
    heading: ev.town ? `${name} · ${ev.town}` : name,
    // An unqualified "Free" only when the record shows free admission for
    // everyone: the strict Free label AND no price text, or a price text that
    // says nothing more than free / $0. A qualified one ("Free for members")
    // keeps its locked price text, so the qualification is never dropped.
    free: labels.includes('Free') && (!priceText || PLAIN_FREE_PRICE.test(priceText)),
    priceText,
    venue: ev.venue || null,
    why: typeof ev.why === 'string' ? ev.why.trim() : '',
    eventId: ev.eventId ? String(ev.eventId).toLowerCase() : null,
    // The details link is the {{evclick:<eventId>}} tracking token; proof,
    // preview and archive resolve it to the direct URL (newsletter-event-clicks.js).
    href: url ? (ev.eventId ? `{{evclick:${String(ev.eventId).toLowerCase()}}}` : url) : null,
  };
}

// Events under day headers: chronological, same-start events keep the
// caller's rank order, events with no start time last. Header is the weekday;
// when two different dates share a weekday (a lineup spanning two weeks) each
// header adds its date.
function groupEventsByDay(events) {
  const views = (events || []).map((ev, i) => ({ ev, view: shortEventView(ev), i }));
  views.sort((a, b) => (
    (a.view.when ? a.view.when.ms : Number.MAX_SAFE_INTEGER) - (b.view.when ? b.view.when.ms : Number.MAX_SAFE_INTEGER)
    || a.i - b.i
  ));
  const groups = [];
  for (const { view } of views) {
    const key = view.when ? view.when.dayKey : 'undated';
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, when: view.when, events: [] };
      groups.push(group);
    }
    group.events.push(view);
  }
  const weekdayDates = new Map();
  for (const g of groups) {
    if (!g.when) continue;
    if (!weekdayDates.has(g.when.weekday)) weekdayDates.set(g.when.weekday, new Set());
    weekdayDates.get(g.when.weekday).add(g.key);
  }
  for (const g of groups) {
    if (!g.when) g.header = 'Date to be confirmed';
    else g.header = weekdayDates.get(g.when.weekday).size > 1 ? `${g.when.weekday}, ${g.when.monthDay}` : g.when.weekday;
  }
  return groups;
}

async function assembleWeeklyNewsletter(draft, { pollQuizId = null } = {}) {
  const parts = [];
  const groups = groupEventsByDay(draft.events || []);

  // ── Greeting + opening line ── the first-name token resolves per
  // recipient ("Hey there, Adam!" / "Hey there!").
  if (draft.greeting) {
    parts.push(`<p style="margin:0 0 8px 0;font-size:22px;line-height:1.4;"><strong>${markdownToHtml(greetingWithNameToken(draft.greeting))}</strong></p>`);
  }
  if (draft.introText) {
    parts.push(`<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.introText)}</p>`);
  }

  // ── This weekend: three short points ──
  const points = (Array.isArray(draft.weekendPoints) ? draft.weekendPoints : [])
    .filter((p) => typeof p === 'string' && p.trim())
    .slice(0, WEEKEND_POINT_LIMIT);
  if (points.length) {
    const items = points.map((p) => `<li style="margin:0 0 4px 0;font-size:15px;line-height:1.5;">${markdownToHtml(p)}</li>`).join('\n');
    parts.push(`<p style="margin:0 0 6px 0;font-size:15px;line-height:1.5;"><strong>This weekend</strong></p>
<ul style="margin:0 0 14px 0;padding-left:22px;">${items}</ul>`);
  }

  // ── Forwarded copies: subscribe line ──
  parts.push(`<p class="dm-muted" style="margin:0 0 8px 0;font-size:14px;line-height:1.5;color:${COLORS.muted};">Forwarded this? <a href="${NEWSLETTER_SUBSCRIBE_URL}" class="dm-link" style="color:${COLORS.blue};text-decoration:underline;font-weight:600;">Subscribe free</a></p>`);

  // ── Events under day headers ──
  groups.forEach((group, gi) => {
    parts.push(`<h2 class="dm-chip" style="${sectionHeadingStyle(gi, 12)}">${escapeHtml(group.header)}</h2>`);
    for (const e of group.events) {
      const facts = [];
      if (e.when) facts.push(escapeHtml(e.when.dateLabel), escapeHtml(e.when.timeLabel));
      // Price policy: the strict Free label, else the DB-locked price text in
      // its PAIR-verified data-db-price sentinel (the only structurally
      // exempt price shape in the claim scan). Never model prose.
      if (e.free) facts.push('Free');
      else if (e.priceText) facts.push(`<span data-db-price="${escapeHtml(e.eventId || '')}">${escapeHtml(e.priceText)}</span>`);
      let line = facts.join(' • ');
      if (e.venue) line = line ? `${line} · ${escapeHtml(e.venue)}` : escapeHtml(e.venue);
      const card = [`<p style="margin:0 0 2px 0;font-size:16px;line-height:1.4;"><strong>${escapeHtml(e.heading)}</strong></p>`];
      if (line) card.push(`<p class="dm-muted" style="margin:0 0 4px 0;font-size:14px;line-height:1.5;color:${COLORS.muted};">${line}</p>`);
      if (e.why) card.push(`<p style="margin:0 0 4px 0;font-size:15px;line-height:1.5;">${markdownToHtml(e.why)}</p>`);
      // The DB-locked details link renders regardless of the model's
      // sentence — a partly valid response never ships an event with no way in.
      if (e.href) card.push(`<p style="margin:0;font-size:14px;line-height:1.5;"><a href="${e.href}" class="dm-link" style="color:${COLORS.blue};text-decoration:underline;font-weight:600;">Details →</a></p>`);
      parts.push(`<div style="margin:0 0 18px 0;">\n${card.join('\n')}\n</div>`);
    }
  });

  // ── Quick poll ── at most every 3rd issue (newsletter-quiz.js
  // chooseNewsletterPoll, owner-approved list 2026-11-20). The token becomes
  // each reader's own answer buttons at send time and an inert copy on the
  // archive and the owner's Monday copy. An unknown id adds nothing.
  const poll = issuePoll(pollQuizId);
  if (poll) {
    parts.push(`<h2 class="dm-chip" style="${sectionHeadingStyle(groups.length, 12)}">Quick poll</h2>`);
    parts.push(`{{quiz:${poll}}}`);
  }

  // ── Close ──
  parts.push(`<p style="margin:20px 0 4px 0;font-size:15px;line-height:1.6;"><strong>${DATES_CAN_CHANGE_LINE}</strong></p>`);
  parts.push(`<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.signoff || '— The Waves Team')}</p>`);

  // ── Reaction footer ── every edition ends with the feedback ask (owner
  // directive 2026-07-17). Per-recipient links substitute at send time;
  // archive/preview surfaces neutralize to inert chips.
  parts.push(FEEDBACK_HTML_TOKEN);

  return parts.join('\n\n');
}

// Re-sort locked events into the caller's eventIds order (portfolio
// rank). Stable for members not in the list (sorted after ranked ones,
// original order preserved) — defensive; the lock already drops them.
function sortByCallerRank(lockedEvents, eventIds) {
  const ids = Array.isArray(eventIds) ? eventIds : [];
  const rank = new Map(ids.map((id, i) => [String(id).toLowerCase(), i]));
  return [...lockedEvents].sort((a, b) => (
    (rank.get(String(a.eventId).toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
    - (rank.get(String(b.eventId).toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
  ));
}

// Structured plain-text body for the flagship: blank-line-separated
// sections, official event names, date/city/price lines, and full
// destination urls. Markdown emphasis is stripped (plain text carries no
// renderer). The greeting keeps its per-recipient name token; the
// reaction footer keeps its text token for the sender's substitution.
function stripMd(text) {
  return decodeEscapedEntities(String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1'))
    .trim();
}

// The issue's poll id when it is one of the Waves Newsletter polls, else null.
function issuePoll(pollQuizId) {
  // require here, as in stripPersonalizationTokens: newsletter-quiz requires db.
  const { isNewsletterPoll } = require('./newsletter-quiz');
  return pollQuizId && isNewsletterPoll(pollQuizId) ? pollQuizId : null;
}

// The claim scan excises a locked price in the text part only as
// "Tickets: <price>" with the SAME event's {{evclick:<id>}} token within 200
// characters after it (newsletter-validator.js, text mode). So a priced
// event's text rides the price on the details line, right next to its token:
// no venue or sentence length can push the two apart. An event with no
// details link has no token to verify the price against; the text part
// leaves the price out and the HTML part still shows it.
function textEventBlock(e) {
  const facts = [];
  if (e.when) facts.push(e.when.dateLabel, e.when.timeLabel);
  if (e.free) facts.push('Free');
  let line = facts.join(' • ');
  if (e.venue) line = line ? `${line} · ${e.venue}` : e.venue;
  const lines = [e.heading];
  if (line) lines.push(line);
  if (e.why) lines.push(stripMd(e.why));
  // "Details:", NOT "Tickets & info": a Free fact line right above would
  // read "Free Tickets ..." and trip the claim scan's free-tickets pattern.
  if (e.href) {
    const priced = !e.free && e.priceText && e.href.startsWith('{{evclick:');
    lines.push(`${priced ? `Tickets: ${e.priceText} · ` : ''}Details: ${e.href}`);
  }
  return lines.join('\n');
}

// Plain-text alternative: the same pieces in the same order as the HTML. The
// greeting keeps its per-recipient name token; the reaction footer keeps its
// text token for the sender's substitution. Markdown emphasis is stripped.
function buildFlagshipTextBody(draft, { pollQuizId = null } = {}) {
  const out = [];
  if (draft.greeting) out.push(stripMd(greetingWithNameToken(draft.greeting)));
  if (draft.introText) out.push(stripMd(draft.introText));
  const points = (Array.isArray(draft.weekendPoints) ? draft.weekendPoints : [])
    .filter((p) => typeof p === 'string' && p.trim())
    .slice(0, WEEKEND_POINT_LIMIT);
  if (points.length) out.push(`This weekend\n${points.map((p) => `- ${stripMd(p)}`).join('\n')}`);
  out.push(`Forwarded this? Subscribe free: ${NEWSLETTER_SUBSCRIBE_URL}`);
  for (const group of groupEventsByDay(draft.events || [])) {
    out.push(`== ${group.header} ==`);
    for (const e of group.events) out.push(textEventBlock(e));
  }
  const poll = issuePoll(pollQuizId);
  if (poll) out.push(`== Quick poll ==\n{{quiz-text:${poll}}}`);
  out.push(DATES_CAN_CHANGE_LINE);
  out.push(stripMd(draft.signoff || '— The Waves Team'));
  out.push(FEEDBACK_TEXT_TOKEN);
  return out.filter(Boolean).join('\n\n');
}

// Owner ruling 2026-09-27: newsletterWriter (Opus 5.5) thinks on every
// request and spends that from max_tokens ahead of the JSON reply
// (anthropic-wire.js THINKING_FLOOR_TOKENS=8192 is only a floor — 'max'
// effort's actual thinking depth runs well past it), so the prior 8192-token
// cap — sized for a non-thinking Sonnet reply — would starve the ~8k-token
// Beehiiv-parity JSON reply. 32000 gives headroom for max-effort thinking
// plus the full reply.
const NEWSLETTER_WRITE_MAX_TOKENS = 32000;
// Generous enough for max effort end to end; explicit so callAnthropic
// passes { timeout } to the SDK (avoids the "streaming is strongly
// recommended" error a large max_tokens with no explicit timeout can throw
// on a non-streaming request) and so the fallback chain's own deadline math
// runs off a real number instead of DEFAULT_FALLBACK_BUDGET_MS (4 min, too
// short for 'max' effort). reserveFallbackBudget (passed at the call site)
// splits this across legs instead of handing a stalled Opus leg the whole
// budget, so the OpenAI fallback still gets real time.
const NEWSLETTER_WRITE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Create a newsletter draft via Claude and persist it.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - The user/editorial prompt
 * @param {string[]} [opts.eventIds] - UUIDs of events_raw rows to include
 * @param {string} [opts.homeownerMinuteTopic] - Topic for the homeowner minute
 * @param {string} [opts.topic] - Calendar topic / theme
 * @param {string} opts.newsletterType - e.g. 'local-weekly-fresh-events'
 * @param {string} [opts.audience] - Audience description
 * @param {string} [opts.tone] - Tone description
 * @param {boolean} [opts.includeCTA] - Whether to include CTA
 * @param {string|Date} [opts.issueReference] - Issue Tuesday/target used for event policy windows
 * @param {import('knex').Knex.Transaction} [opts.trx] - Optional Knex transaction
 * @param {string|null} [opts.pollQuizId] - the issue's poll (flagship only)
 * @param {string} [opts.effort] - Anthropic effort override for the
 *   newsletterWriter policy's primary leg (default: the policy's own 'max').
 *   No caller passes it since the admin composer was removed.
 * @returns {Promise<{send: Object, draft: Object}>}
 */
// persistNewsletterDraft refuses a Waves Pest Insider issue: it saves no audience plan.
const PEST_INSIDER_UNSAVED = 'a Waves Pest Insider issue needs its planned audience, which this draft writer does not save';
// createNewsletterDraft refuses one too. The Waves Pest Insider is built from
// its reviewed facts by services/pest-insider (planner: schedule.js); the old
// model-written monthly format this writer once produced is gone.
const PEST_INSIDER_NOT_WRITTEN_HERE = 'a Waves Pest Insider issue is built by its planner (services/pest-insider), not by this draft writer';

// The short weekly format needs exactly 3 "This weekend" points and a
// sentence for every event. A writer reply without them is a shape error like
// the other refusals below: it throws before anything is saved, so the caller
// retries or skips the week (nothing half-written ships).
function assertShortFormatShape(draft) {
  const points = (draft.weekendPoints || []).filter((p) => typeof p === 'string' && p.trim());
  if (points.length !== WEEKEND_POINT_LIMIT) {
    throw new Error(`Newsletter writer returned ${points.length} weekend point(s); the short format needs exactly ${WEEKEND_POINT_LIMIT}.`);
  }
  const missing = (draft.events || []).filter((ev) => typeof ev.why !== 'string' || !ev.why.trim());
  if (missing.length > 0) {
    throw new Error(`Newsletter writer gave no sentence for ${missing.length} event(s): ${missing.map((ev) => ev.sourceTitle || ev.eventId).join('; ')}.`);
  }
}

async function createNewsletterDraft({
  prompt,
  eventIds,
  homeownerMinuteTopic,
  topic,
  newsletterType,
  audience,
  tone,
  includeCTA,
  issueReference,
  trx,
  persist = true,
  // Owner ruling 2026-09-27: the newsletter is WRITTEN by Opus 5.5. Autopilot
  // (the weekly cron) never passes this — it gets
  // the policy's own 'max' effort. The interactive admin composer routes
  // that passed 'high' were removed (owner 2026-10-30).
  effort,
  timeoutMs = NEWSLETTER_WRITE_TIMEOUT_MS,
  // The issue's Waves Newsletter poll (newsletter-quiz.js chooseNewsletterPoll),
  // or null. Only the weekly autopilot passes one; only the flagship shows it.
  pollQuizId = null,
}) {
  // Refused before any facts load or paid generation, saved or not: this
  // writer has no Waves Pest Insider format.
  if (newsletterType === 'pest-insider-monthly') throw new Error(PEST_INSIDER_NOT_WRITTEN_HERE);
  const knex = trx || db;
  // The issue's Tuesday (not "now") anchors both the seasonal-month framing
  // and every event-policy window — cross-provider dispatch happens below.
  const editorialReference = resolveIssueReference(issueReference);
  const month = editorialReference.toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
  const typeConfig = getNewsletterType(newsletterType);
  const voice = getVoiceProfile(typeConfig.voiceProfile);

  // 1. Fetch events from events_raw by IDs (if provided). The fetched rows
  //    are held for both the Claude prompt AND the post-draft factual lock —
  //    the lock re-applies date/venue/URL from the DB regardless of what the
  //    model echoes back.
  let eventBlock = '';
  let approvedEvents = [];
  const MAX_EVENT_IDS = 12;
  if (Array.isArray(eventIds) && eventIds.length > 0) {
    const safeIds = eventIds.slice(0, MAX_EVENT_IDS).filter(
      (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    );
    if (safeIds.length > 0) {
      // Editorial gate: only approved/featured, non-merged, non-expired events
      // may be locked into a draft. The autopilot auto-source path is already
      // filtered, but explicit eventIds (admin /draft-ai) and calendar
      // event_ids flow straight here — without these filters a rejected,
      // merged-away, or expired event could be re-pulled with DB-accurate
      // facts and shipped as "fresh". Ineligible ids simply don't resolve and
      // get dropped by lockEventFactsFromDb.
      const approvedQuery = knex('events_raw as e')
        .leftJoin('event_sources as s', 's.id', 'e.source_id')
        .select(
          'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
          'e.venue_name', 'e.venue_address', 'e.city', 'e.event_url',
          'e.image_url', 'e.categories', 'e.is_free', 'e.admin_status',
          'e.event_type', 'e.recurrence_type', 'e.freshness_status',
          'e.times_featured', 'e.last_featured_at', 'e.last_featured_occurrence_at', 'e.pulled_at',
          'e.price_text', 'e.family_friendly', 'e.audience_tags',
          'e.novelty_type', 'e.region_zone', 'e.score_breakdown',
          's.name as source_name',
        )
        .whereIn('e.id', safeIds)
        .whereIn('e.admin_status', ['approved', 'featured'])
        .whereNull('e.merged_into')
        // 'stale_recurring' is deliberately NOT excluded here (Codex P1,
        // 2026-09-27, second pass) — see newsletter-autopilot.js's
        // buildDigestPlan for why: it used to be, which unconditionally
        // defeated excludeRoutineRecurringFromQuery's own first-of-year
        // admission for every routine row before that shared gate even ran.
        .whereNotIn('e.freshness_status', ['expired'])
        .orderByRaw('e.freshness_score DESC NULLS LAST');

      const approvedRows = await excludeRoutineRecurringFromQuery(approvedQuery);
      // One calendar-year identity pool for this batch, shared by both
      // filters below (Codex P2, 2026-09-27: "Reuse the calendar-year pool
      // across eligibility filters") instead of each loading its own copy.
      const yearPool = await loadSharedYearPool(knex, approvedRows, editorialReference);
      const nonRepeatedRows = await filterRepeatedDateIdentities(approvedRows, {
        knex,
        reference: editorialReference,
        yearPool,
      });
      const historicallyNewRows = await filterPreviouslyFeaturedIdentities(nonRepeatedRows, {
        knex,
        reference: editorialReference,
        yearPool,
      });
      approvedEvents = dedupeDigestEvents(
        historicallyNewRows.filter((event) => isEligibleForFreshDigest(event, editorialReference)),
      );

      // Present events in the CALLER's order — the portfolio selector /
      // operator ranked them (hero first), and the compact prompt makes
      // the first event the default hero. The freshness-score DB order
      // would silently promote an arbitrary fresh event instead.
      const callerRank = new Map(safeIds.map((id, i) => [String(id).toLowerCase(), i]));
      approvedEvents = [...approvedEvents].sort((a, b) => (
        (callerRank.get(String(a.id).toLowerCase()) ?? 999)
        - (callerRank.get(String(b.id).toLowerCase()) ?? 999)
      ));

      eventBlock = formatEventBlock(approvedEvents);
    }
  }

  // 2. Build the system prompt: the flagship events prompt.
  // Its seasonal context names topics only, so its pest facts come from the
  // live register block appended here and stop reaching the writer the moment
  // a fact is withdrawn (codex round 14 P1). The weekly events guide does not
  // depend on them: an empty or unreachable register logs, the block is
  // omitted, and the prompt's own rule ("from the verified facts block, or
  // left out") keeps pest facts out of that issue (pre-push audit P1 on
  // e0dd938596).
  const factsBlock = await loadFactsBlock();
  const systemPrompt = buildFlagshipSystemPrompt(voice, month) + factsBlock;

  // Homeowner Minute RETIRED from the flagship (owner 2026-07-30) —
  // homeownerMinuteTopic is accepted for caller compatibility but no
  // longer reaches the prompt.
  const enrichedPrompt = prompt;

  const userPrompt = `Topic / prompt: ${enrichedPrompt}
${audience ? `Audience: ${audience}` : ''}
${tone ? `Tone: ${tone}` : ''}${eventBlock}`;

  // 3. Call the newsletterWriter policy (Opus 5.5 effort 'max' → OpenAI
  // Terra fallback; owner ruling 2026-09-27). `effort` overrides the
  // policy's own 'max' only when the caller asked for a lighter interactive
  // path (see the JSDoc above) — the fallback leg has no effort concept, so
  // only the primary route needs the override.
  const basePolicy = MODELS.TEXT_POLICIES.newsletterWriter;
  const draftPolicy = effort && effort !== basePolicy.primary.effort
    ? { ...basePolicy, primary: { ...basePolicy.primary, effort } }
    : basePolicy;
  const response = await dispatchWithFallback(draftPolicy, {
    laneId: 'newsletter',
    maxTokens: NEWSLETTER_WRITE_MAX_TOKENS,
    timeoutMs,
    jsonMode: true,
    system: systemPrompt,
    text: userPrompt,
  }, { reserveFallbackBudget: true });
  if (!response.ok || !response.json) throw new Error('Newsletter AI providers did not return valid JSON');

  // 4. The shared dispatcher parses JSON and crosses providers on malformed output.
  const draft = response.json;

  // 4a. Factual lock — overwrite AI-supplied date/venue/address/URL/image
  //     with the values from events_raw, keyed by the eventId the model
  //     copied from each [eventId: ...] tag in the prompt. Events the
  //     model failed to anchor to a real eventId are dropped here so they
  //     never reach the rendered HTML.
  // Compact-format normalization: fold the hero into the events array
  // (hero first, deduped) so the shared factual lock anchors it too.
  if (draft.hero && draft.hero.eventId) {
    const heroId = String(draft.hero.eventId).toLowerCase();
    const rest = (Array.isArray(draft.events) ? draft.events : [])
      .filter((e) => String(e?.eventId || '').toLowerCase() !== heroId);
    draft.events = [
      { eventId: draft.hero.eventId, hook: draft.hero.heroHook, heroWhy: draft.hero.heroWhy, isHero: true },
      ...rest,
    ];
    delete draft.hero;
  }
  // Community Notes have NO factual-lock pipeline yet — no notice records
  // are fetched or supplied to the model, so anything it wrote here is
  // invented. Force the section empty until a real sourcing pipeline
  // exists (operator-curated notice records, locked by id like events).
  draft.communityNotes = null;

  if (Array.isArray(draft.events) && draft.events.length > 0) {
    if (approvedEvents.length === 0) {
      // No DB pool to anchor against — every event is unverifiable.
      throw new Error(
        `Model returned ${draft.events.length} event(s) but no approved DB events were supplied. ` +
        `Refusing to render unanchored event content.`
      );
    }
    const { locked, dropped } = lockEventFactsFromDb(draft.events, approvedEvents);
    if (dropped.length > 0) {
      const summary = dropped.map((d) => `[${d.index}] ${d.title || '(no title)'} — ${d.reason}`).join('; ');
      logger.warn(`[newsletter-draft] dropped ${dropped.length} event(s) without DB anchor: ${summary}`);
      draft.factualLockingWarnings = dropped.map(
        (d) => `Event dropped (${d.reason}): ${d.title || 'no title'}`
      );
    }
    if (locked.length === 0) {
      throw new Error(
        `Factual locking dropped every event — model returned ${draft.events.length} event(s) ` +
        `but none matched the approved eventIds. Refusing to render an empty newsletter.`
      );
    }
    // Re-assert the APPROVED PROMPT LINEUP's order (approvedEvents,
    // already caller-sorted — the events the model actually saw) over
    // whatever sequence the model echoed back. Uniform treatment
    // (owner 2026-07-29) means no tier assignment: every surviving
    // event renders the same full anatomy.
    draft.events = sortByCallerRank(locked, approvedEvents.map((r) => r.id));
  }

  // 4a.5 Strip stray URLs from the free-prose fields (intro / homeowner minute /
  //      closing / etc). Per-event commentary is already sanitized inside
  //      lockEventFactsFromDb; this extends the same defense to the prose the
  //      model authors outside the events array.
  sanitizeProseFields(draft);
  assertShortFormatShape(draft);

  // 4b. No generated hero image: the short weekly format (owner 2026-11-26)
  //     has no hero or event visuals, so that image spend ends here.

  // 4c. Assemble HTML from structured data: the short weekly format
  //     (owner 2026-11-26). assembleWavesNewsletter (the 2026-07-28 compact
  //     format) is retained, unused by the pipeline.
  if (draft.events?.length) {
    draft.htmlBody = await assembleWeeklyNewsletter(draft, { pollQuizId: typeConfig?.flagship ? pollQuizId : null });
  } else if (typeConfig?.flagship) {
    // Flagship drafts must come through the locked structured-events path.
    // If the model returned no events (e.g. the legacy `sections` shape, or
    // `events: []` + `sections`), refuse to fall back — rendering section
    // HTML directly would let AI-generated dates/venues/URLs ship without a
    // DB anchor, defeating the factual lock.
    throw new Error(
      'Flagship draft produced no structured events — refusing to render ' +
      'unlocked sections output. The model must return events[] anchored by eventId.'
    );
  } else if (draft.sections) {
    // Fallback: old-style sections format (non-flagship types only)
    const keys = ['local_intro', 'fresh_this_week', 'just_starting', 'weekend_picks',
      'family_or_low_key_pick', 'road_trip_pick', 'homeowner_minute', 'waves_cta'];
    draft.htmlBody = keys.map(k => {
      const v = draft.sections[k];
      return (v && typeof v === 'string') ? v : null;
    }).filter(Boolean).join('\n\n');
  }

  if (draft.events?.length && typeConfig?.flagship) {
    // Structured plain-text alternative (owner-accepted critique
    // 2026-07-29): real sections, event names, dates, prices, and full
    // destination urls — not tag-stripped HTML collapsed into one
    // paragraph. Direct event urls on purpose: text-only clients get no
    // per-recipient substitution pass for evclick tokens. Always built from
    // the locked draft: a textBody the writer added on its own (the prompt
    // asks for none) would skip the factual lock and the issue's poll.
    draft.textBody = buildFlagshipTextBody(draft, { pollQuizId });
  }
  if (!draft.textBody && draft.htmlBody) {
    draft.textBody = decodeEscapedEntities(draft.htmlBody.replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim()
      // The HTML reaction token survives tag-stripping as a literal string;
      // the text part carries its own token so the sender substitutes the
      // plain-text render (links list) instead of an HTML block.
      .split(FEEDBACK_HTML_TOKEN).join(FEEDBACK_TEXT_TOKEN);
  }

  // 5. Run voice validation
  const voiceCheck = validateVoice(
    { subject: draft.selectedSubject || draft.subjectVariants?.[0], htmlBody: draft.htmlBody },
    typeConfig.voiceProfile,
  );
  draft.voiceWarnings = voiceCheck.warnings;
  draft.newsletterType = newsletterType;

  // 5b. Defense-in-depth: run the same hallucinated-claim scan the send gate
  //     uses, here at creation, so a fabricated price/efficacy claim is
  //     surfaced on the draft (in logs + on the returned object) instead of
  //     only being discovered at /validate or /send. Flagship-gated to match
  //     the send-time policy (events guide can't quote admission); does not
  //     block draft creation — the send gate remains the hard stop.
  if (typeConfig?.flagship) {
    const { findHallucinatedClaims } = require('./newsletter-validator');
    // Segment-scoped like the send-time gate: html's exemption is the
    // structural data-db-price span; only the text segment excises its
    // renderer shape via the lineup's locked prices.
    const draftLockedPrices = (draft.events || [])
      .filter((ev) => typeof ev.priceText === 'string' && ev.priceText)
      .map((ev) => ({ eventId: String(ev.eventId || '').toLowerCase(), price: ev.priceText }));
    const claimErrors = [...new Set([
      ...findHallucinatedClaims(draft.htmlBody || '', draftLockedPrices, 'html'),
      ...findHallucinatedClaims(draft.textBody || '', draftLockedPrices, 'text'),
    ])];
    if (claimErrors.length > 0) {
      draft.hallucinationErrors = claimErrors;
      logger.warn(`[newsletter-draft] ${claimErrors.length} hallucinated-claim error(s) at draft time: ${claimErrors.join(' | ')}`);
    }
  }

  // Map flagship output to legacy shape
  draft.subject = draft.selectedSubject || draft.subjectVariants?.[0] || '';

  // persist=false: the autopilot generates first, then saves the draft
  // itself inside a short advisory-locked transaction. Skip the DB insert
  // and return the draft only — facts are still locked at this point.
  if (!persist) {
    return { send: null, draft };
  }

  const send = await persistNewsletterDraft({ draft, prompt, newsletterType, knex });

  // 8. Return { send, draft }
  return { send, draft };
}

/**
 * { [eventId]: start_at ISO } for drafted events, from their fact-locked
 * startAt (lockEventFactsFromDb): the dates the rendered email shows.
 */
function lockedEventOccurrences(events) {
  return Object.fromEntries((Array.isArray(events) ? events : [])
    .filter((e) => e && e.eventId && e.startAt && !Number.isNaN(new Date(e.startAt).getTime()))
    .map((e) => [String(e.eventId), new Date(e.startAt).toISOString()]));
}

async function persistNewsletterDraft({ draft, prompt, newsletterType, knex = db }) {
  // This writer saves no audience plan, and a Waves Pest Insider send goes
  // out only with one (audienceRefusal in newsletter-sender.js): it refuses
  // the type rather than save an issue that could never be sent.
  if (newsletterType === 'pest-insider-monthly') throw new Error(PEST_INSIDER_UNSAVED);
  // Generate slug only at persistence time. This lets callers do paid/network
  // generation before opening a short advisory-locked DB transaction.
  const slug = generateSlug(draft.subject);

  // Insert newsletter_sends row
  const [send] = await knex('newsletter_sends').insert({
    subject: draft.subject,
    subject_b: null,
    html_body: draft.htmlBody || null,
    text_body: draft.textBody || null,
    preview_text: draft.previewText || null,
    from_name: 'Waves Pest Control',
    // The newsletter signs as its own subdomain (SendGrid domain auth on
    // news.wavespestcontrol.com, owner 2026-10-31), so list complaints stay off
    // the domain that carries invoices and reminders. Replies still go to contact@.
    from_email: 'events@news.wavespestcontrol.com',
    reply_to: 'contact@wavespestcontrol.com',
    status: 'draft',
    segment_filter: null,
    ai_prompt: prompt,
    newsletter_type: newsletterType,
    slug,
    created_by: null,
    auto_share_social: true,
    // Record the locked event ids so the sender can advance events_raw
    // .times_featured (+ recompute freshness) for exactly the events that
    // actually shipped, on the first 'sent' transition.
    event_ids: JSON.stringify((draft.events || []).map((e) => e.eventId).filter(Boolean)),
    // Locked occurrence per event, stamped as last_featured_occurrence_at at
    // send (the row itself may be advanced in place before delivery).
    event_occurrences: JSON.stringify(lockedEventOccurrences(draft.events)),
  }).returning('*');
  return send;
}

module.exports = {
  lockedEventOccurrences,
  resolveIssueReference,
  createNewsletterDraft,
  persistNewsletterDraft,
  lockEventFactsFromDb,
  // Exported for unit testing the injection/prose defenses
  escapeHtml,
  safeUrl,
  markdownToHtml,
  sanitizeProseFields,
  assembleWeeklyNewsletter,
  assembleWavesNewsletter,
  isLikelyGifUrl,
  buildFlagshipTextBody,
  sortByCallerRank,
  deriveEventLabels,
  // Exported for unit testing the Beehiiv-parity render devices
  clockEmojiFor,
  // GIF dedupe (one issue never repeats a GIF)
  gifBlock,
  searchGiphyCandidates,
  pickUniqueGif,
  pickUniqueGifWithRetry,
  // Hero poster headline text (subject, emoji-stripped)
  heroTitleText,
  displayCity,
  formatLockedLocation,
  linkifyFirst,
  FLAGSHIP_SEASONAL_CONTEXT,
  // Greeting personalization — token + per-recipient value + archive strip
  GREETING_NAME_TOKEN,
  greetingWithNameToken,
  greetingNameValueFor,
  stripGreetingNameToken,
  // City / grass merge tags + neutral defaults + combined no-recipient stripper
  CITY_TOKEN,
  GRASS_TYPE_TOKEN,
  DEFAULT_CITY_LABEL,
  DEFAULT_GRASS_LABEL,
  stripPersonalizationTokens,
  plainBulletText,
  // P.S. label-doubling guard + plain-text entity decode (escapeHtml inverse)
  psBodyText,
  decodeEscapedEntities,
  // ✔️ checklist marker-doubling guard (same genre as psBodyText)
  checklistItemText,
};
