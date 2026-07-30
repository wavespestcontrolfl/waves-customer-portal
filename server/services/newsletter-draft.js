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
const config = require('../config');
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
 * Build the flagship system prompt. Produces structured JSON — each event
 * is its own object so we can assemble Beehiiv-quality HTML with GIFs,
 * styled metadata blocks, and per-event sections server-side.
 */
function buildFlagshipSystemPrompt(voice, month) {
  return `You write the Waves Newsletter — Waves Pest Control's weekly local events guide — for readers from North Port to Tampa.

This is NOT a corporate pest control email. It is a punchy, local, FOMO-driven weekend guide written like a friend texting "yo, here's what's actually worth doing."

CURRENT MONTH: ${month}

SWFL SEASONAL CONTEXT (pick what's relevant):
- Jan–Feb: snowbird peak, dry lawns, red tide drift
- Mar: spring break, love bugs, citrus bloom
- Apr: Bradenton Blues Festival, spring training tail, lawn pre-emergents
- May: DeSoto Heritage Festival, mosquito ramp, no-see-um peak
- Jun: hurricane season begins, daily thunderstorms, nitrogen blackout on lawns
- Jul: 4th of July, peak rainy season, German roach pressure, palmetto bugs
- Aug: back-to-school, peak hurricane risk, chinch bug damage on St. Augustine
- Sep: hurricane peak, Siesta Key Crystal Classic, termite swarms after storms
- Oct: snowbirds return, rodent season begins, Halloween on barrier islands
- Nov: Sarasota Season of Sculpture, turkey trots, winter annuals
- Dec: boat parades, cooler weather drives indoor pest activity
- SWFL pests: subterranean termites, German cockroaches, palmetto bugs, no-see-ums, salt-marsh mosquitoes, fire ants, chinch bugs, sod webworms

VOICE:
- Irreverent but not mean. Energetic but not chaotic. A hype-y group-chat friend, single narrator.
- Specific to this week's events. Conversational — local friend energy.
- Short, scannable, useful. Never corporate.
- Formatting: dense phrase-level interleave — **bold** the payoff nouns/facts/imperatives, _italic_ the flavor words and asides. Nearly every sentence should carry at least one emphasis mark.
- HUMOR DENSITY (owner dial 2026-07-29): ONE strong joke in each headline, ONE in each description — useful information everywhere else. Cut the second- and third-best jokes from every module; never stack devices in one sentence. Internet idioms ("entered the chat", "say less", "vibe", "main-character", "chaos", "energy"): at most ONE in the whole issue.
- Signature humor devices (pick 2-3 per issue, vary week to week):
  * Parenthetical asides as a second comedic voice: "(no judgment)", "(yes, really)", "(you *will*)"
  * Affectionate reader/local roasts: "pretending you know how to swing a golf club"
  * Absurd escalating triads ending on a hyper-specific gag: "without the lines, heatstroke, or second-mortgage lemonade"
  * Bathos/anticlimax: "the grand prize is eternal glory and the world's most charming weapon: a wooden spoon"
  * Mock warnings and dares: "Don't say we didn't warn you."
  * Florida in-jokes: foldable chair in the trunk, sunscreen, afternoon thunderstorms

SUBJECT LINES: max ${voice.subjectLineRules.maxLength} chars, LEAD with exactly ONE thematic emoji then a space (reference-edition convention — never two, never zero), then the hook: specific to this week, two proven shapes — (1) noun-triple + kicker, (2) full declarative sentence with a curiosity gap. Examples: ${voice.subjectLineRules.examples.map(e => `"${e}"`).join(', ')}

PREVIEW TEXT: the second punchline, never a summary. Direct-address roast or three-fragment cadence. Examples: ${(voice.previewTextRules?.examples || []).map(e => `"${e}"`).join(', ')}

NEVER WRITE: ${voice.bannedCorporatePhrases.map(p => `"${p}"`).join(', ')}

CAPTIONS (gifCaption + introGifCaption) are their own genre. gifCaption renders under the event's visual — which is the REAL event photo when the record has one, a reaction GIF otherwise — so it must land as a standalone punchline about the EVENT, never a reference to any specific meme image. Rules: ${voice.gifCaptionRules?.maxWords || 12} words MAX, never a description of the image or the event — always a punchline. Proven shapes:
${(voice.gifCaptionRules?.shapes || []).map((s) => `- ${s}`).join('\n')}

EVENT RULES:
- Use ONLY the approved event records provided. Do NOT invent events.
- For every event you include, copy its [eventId: ...] UUID into the "eventId" field exactly. The renderer uses this to re-pull date, time, venue, address, and ticket URL straight from the database — anything you write for those fields will be IGNORED.
- Do NOT mention specific dollar amounts, "free admission", "no cost", "complimentary", or any ticket-price phrasing in your commentary. We never store admission in the DB, so any pricing claim you make is unverifiable and will hard-block the send.
- Do NOT make pest-control safety or efficacy claims ("pet-safe", "child-safe", "guaranteed", "100% effective", "EPA-approved") — this is an events newsletter, not a service pitch.
- title: a CURIOSITY-GAP headline that never uses the raw event name (it renders elsewhere). Proven formulas: question + affirmation ("...? Yes, Please" / "...? Say Less" / "...? Count Us In"), PSA framing ("PSA: You Might Meet Your New Best Friend This Weekend"), direct address ("This One's for You"), equation ("High Hair + Hot Dice = Ultimate Weekend").
- Each event gets a unique thematic emoji (no repeats between events).
- gifSearchTerm: 2-4 word Giphy search for a pop-culture REACTION meme (the joke), not a literal event photo. Every gifSearchTerm in the issue (including introGifTerm) must be clearly DISTINCT from the others — different verbs, moods, and meme genres, never near-synonyms of another section's term — so no two sections pull similar GIFs.
- TIERS (the events arrive in rank order — KEEP that order): the FIRST event is the HEADLINER (description 70-100 words + highlights + optional proTip + closingLine). Events 2-3 are FEATURED (description 40-60 words; highlights, proTip, closingLine all null). Events 4+ are SHORTLIST picks (description = ONE punchy sentence, 15-25 words; highlights, proTip, closingLine all null).
- description: conversational, says WHY someone would actually go (length per tier above). Work the event's official name (exactly as given in the record) into the prose once — the renderer turns it into the ticket link. Do NOT restate the date, venue, or URL — those render automatically.
- scoopLabel: the lead-in for the highlights list. Rotate across events, never repeat in one issue: "Here's the scoop:", "Here's the deal:", "Here's what's going down:", "What to expect:", "Here's the rundown:", "Why it's a vibe:", "Why it's a weekend winner:", "Here's what you're walking into:".
- highlights: 3-5 short bullets, PLAIN TEXT — no emojis, no leading bullet characters (the renderer adds the "•" marker). Vibe-only; no logistics, no prices.
- proTip (HEADLINER only, optional): a genuinely useful planning tip GROUNDED in the event record provided — arrive-early for a stated start time, what to bring for a stated venue type, weather planning for an outdoor venue. NEVER invent logistics the record doesn't support (parking rules, bag policies, sellout predictions, registration requirements). If nothing useful is grounded, return null — a joke is not a tip (jokes live in the description). Do NOT include the words "Pro tip" — the renderer adds the label. NOT pricing.
- closingLine: punchy one-line kicker to wrap the event — bold the punch ("This is **Bradenton's Fourth of July mic drop.**").
- linkText: short anchor text for the ticket link, rotated across events: "More info here", "Get tickets", "Grab your spot", "Full lineup", "Save your seat", "All the details".

INTRO: greeting "Hey there!" energy — NEVER include a name or name placeholder; the renderer appends the subscriber's first name automatically. introText 2-4 sentences with a "Whether you're into X, Y, or Z" triad and a FOMO close. introGifCaption: cold-open punchline for the intro GIF (same caption genre).

HOMEOWNER MINUTE: One useful seasonal tip (pest, lawn, plants, home prep). Max ~90 words. Technical precision is the brand: distinguish OUTDOOR pests pushed toward shelter (rain drives palmetto bugs/outdoor roaches indoors) from INDOOR breeders (German roaches are carried in and thrive wherever there's food, warmth, and moisture — weather doesn't cause them). Never imply weather causes an indoor infestation. Genuinely useful, not salesy — the brand sell in this newsletter is ZERO; this tip is the only Waves-adjacent content and it must stand on its own. Voice it like the themed issues: **bold the facts**, _italicize the jokes_, anthropomorphize the pest/plant when it lands ("that mosquito keeping you up at night? Probably a mom-to-be"), urgency biological/seasonal, never commercial. May end with a "Hot tip:" one-liner.

CLOSING: closingText = 1-2 short paragraphs that CALL BACK to this issue's actual events in an absurd triad ("Whether you end up juggling pineapples, dancing to swamp funk, or sobbing quietly to Schubert — we fully support your weekend choices."). closingChecklist: 3-4 short ✔️-style reminders mixing practical + absurd ("Hydrate like it's your job", "Don't underestimate the power of a funnel cake"). Do NOT include the ✔️ itself in the items — the renderer adds it.

SIGN-OFF: "${voice.signoff}"

P.S. JOKE: "If you loved this, forward it to a friend who [hyper-specific persona — e.g. 'owns both a tutu *and* a folding lawn chair']. If you didn't... [reverse-blame punchline — e.g. 'blame the clown']." End with thematic emoji. Reference this issue's actual events. Do NOT write the "P.S." label itself — the renderer adds it.

Return STRICT JSON (no HTML, no prose outside the JSON):
{
  "subjectVariants": ["string", "string", "string"],
  "selectedSubject": "string",
  "previewText": "string, 40-110 chars (punchline, not summary)",
  "greeting": "string (e.g. 'Hey there!')",
  "introText": "string (2-4 sentences setting the week's vibe, use **bold** and _italic_ densely)",
  "introGifTerm": "string (Giphy search for mood-setting intro GIF)",
  "introGifCaption": "string (cold-open punchline, caption genre)",
  "transitionLine": "string (bold rallying one-liner before events, e.g. 'Let's get into it 👇')",
  "events": [
    {
      "eventId": "string (REQUIRED — copy the [eventId: ...] UUID from the approved event verbatim)",
      "emoji": "string (single thematic emoji)",
      "title": "string (curiosity-gap headline, never the raw event name)",
      "gifSearchTerm": "string (2-4 word Giphy search, pop-culture reaction meme)",
      "gifCaption": "string (caption-genre punchline, max 12 words)",
      "description": "string (2-4 sentences, includes the event's official name once verbatim — vibe only, no logistics)",
      "scoopLabel": "string (rotating lead-in for highlights)",
      "highlights": ["string (plain text, no emoji, no bullet marker)"] or null,
      "proTip": "string or null (no 'Pro tip' prefix)",
      "linkText": "string (rotating ticket-link anchor text)",
      "closingLine": "string (bold punchy kicker)"
    }
  ],
  "homeownerMinute": "string (the tip text, plain — no HTML)",
  "closingEmoji": "string",
  "closingHeading": "string (recap title, e.g. 'That's the scoop, crew')",
  "closingText": "string (callback triad wrapping the week)",
  "closingChecklist": ["string (3-4 short reminders, practical + absurd)"] or null,
  "signoff": "string",
  "ps": "string or null (no 'P.S.' prefix — the renderer adds the label)"
}`;
}

// ── Pest Insider (monthly) ───────────────────────────────────────────
//
// The humor-sandwich format from the shipped Beehiiv "Pest Watch" issues
// (docs/design/newsletter-fresh-this-week-style-guide.md): ~60% genuinely
// fun pest edutainment → ONE sincere featured-service section → voice-y
// close with a phone CTA. Sell stays ≤ ~3.5/10; urgency is biological
// ("by March they're out in full force"), never commercial.

// Month → editorial slate (owner decision 2026-06-11: auto-rotate by
// season, override any month via the Compose prompt). Built from the
// SWFL pest calendar: each month carries the featured service (the ONE
// pitch), the Lawn Corner beat, and the content angles that month owns.
const PEST_INSIDER_ROTATION = {
  January: {
    service: 'rodent control & pest inspections (cool weather drives rats/mice indoors; snowbirds reopening closed-up homes — the "welcome-back inspection")',
    lawn: 'dry-season lawn watering discipline + winter annuals',
    beats: 'rodents seeking warmth; surprises in snowbird homes',
  },
  February: {
    service: 'termite protection & WDO inspections (pre-swarm prep — the single most important content window of the year starts NOW)',
    lawn: 'pre-emergent timing before spring weeds wake up',
    beats: 'flying ants vs termites — the 10-second test; drywood vs subterranean',
  },
  March: {
    service: 'subterranean termite treatment (swarm season is ON)',
    lawn: 'spring lawn wake-up: first mow height, aeration timing',
    beats: 'termite swarmers after warm rain; love bug season opener (pure engagement — everyone in SWFL has opinions)',
  },
  April: {
    service: 'termite & WDO inspections (spring home-buying season) + fire ant control (mounds wake with spring rain)',
    lawn: 'weed pre-emergents last call + aeration',
    beats: 'love bugs peak; spring buyers need WDO',
  },
  May: {
    service: 'mosquito treatment (rainy-season kickoff = mosquito explosion — the biggest add-on push of the year)',
    lawn: 'rainy-season mowing rhythm; watch for early chinch activity',
    beats: 'standing-water audit checklist ("walk your yard with this list"); Memorial Day backyard prep',
  },
  June: {
    service: 'mosquito treatment (daily thunderstorms = standing water everywhere)',
    lawn: 'chinch bugs starting on St. Augustine; nitrogen blackout begins',
    beats: 'hurricane season opens — what storms do to pests (displaced rodents, mosquito boom in debris, fire ant rafts)',
  },
  July: {
    service: 'quarterly pest defense (German cockroach & palmetto bug peak indoor pressure; ghost ants in kitchens)',
    lawn: 'chinch bug damage spreading — brown patches that aren\'t drought',
    beats: 'ghost ants, palmetto bugs, post-storm pest surges',
  },
  August: {
    service: 'lawn pest control (chinch bugs shredding St. Augustine — before/after season)',
    lawn: 'sod webworms move in; recovery plan for chinch damage',
    beats: 'peak hurricane risk — post-storm yard checklist; back-to-school',
  },
  September: {
    service: 'termite inspection (post-storm swarms) + lawn recovery',
    lawn: 'fall fertilization window opens as blackout ends',
    beats: 'hurricane peak; termite swarms after storms',
  },
  October: {
    service: 'rodent exclusion (season begins as nights cool)',
    lawn: 'fall fertilization + winterizing the irrigation schedule',
    beats: 'spooky season fun: spider myths debunked, which Florida bugs are ACTUALLY dangerous',
  },
  November: {
    service: 'rodent control (attics fill as snowbirds return)',
    lawn: 'winter annuals in; last fertilization call',
    beats: 'pantry pests before holiday baking; firewood hitchhikers',
  },
  December: {
    service: 'pest inspections (pest-proof the house before holiday guests; gift-a-service for elderly parents)',
    lawn: 'cool-season lawn care + holiday lighting vs irrigation',
    beats: 'Christmas tree hitchhikers; pantry pests; cooler weather drives indoor activity',
  },
};

function buildPestInsiderSystemPrompt(voice, month) {
  const slate = PEST_INSIDER_ROTATION[month]
    || { service: 'general home pest defense', lawn: 'seasonal lawn upkeep', beats: 'seasonal pest pressure' };
  return `You write "Pest Insider" — Waves Pest Control's monthly pest + lawn deep-dive for Southwest Florida homeowners. It should read like a knowledgeable neighbor texting you what's about to crawl out of the ground this month — NEVER corporate marketing.

The four jobs, in priority order: (1) retention — readers who feel informed keep their quarterly service; (2) tier upgrades — seasonal content naturally introduces the matching add-on; (3) referrals; (4) eventual conversion of non-customers who subscribed for the tips. Jobs 2-4 get exactly ONE pitch and ONE CTA; job 1 is every section.

CURRENT MONTH: ${month}
FEATURED SERVICE (the one pitch): ${slate.service}
LAWN CORNER BEAT: ${slate.lawn}
CONTENT ANGLES THIS MONTH OWNS: ${slate.beats}

VOICE (same narrator as the weekly events guide, signed by a real person):
- Funny, blunt, zero fearmongering-for-sales. "So, your place has bed bugs. Fantastic." energy.
- Dense phrase-level interleave — **bold** the payoff facts, _italic_ the jokes and asides.
- Anthropomorphize the pest ("that mosquito keeping you up at night? Probably a mom-to-be").
- Jokes at the PEST's expense, never pressure on the reader.
- Parenthetical asides as a second comedic voice: "(which, we assume you are)", "(no judgment)".

SUBJECT LINES: max ${voice.subjectLineRules.maxLength} chars, one leading thematic emoji. SPECIFIC AND LOCAL BEATS CLEVER: "🐜 Termites are swarming in Sarasota this week" crushes "Your March Pest Insider". Use honest alert framing whenever the season supports it. PREVIEW TEXT: short punchline, never a summary ("Bite Me? Nope. Not Anymore.").

HARD RULES:
- NO dollar amounts, prices, discounts, or "free" offers anywhere.
- NO invented technology names, product brands, percentages, statistics, or study citations — honest capability terms only.
- NO safety/efficacy claims: never "pet-safe", "child-safe", "guaranteed", "100% effective", "EPA-approved".
- Facts must be true, mainstream pest/lawn knowledge for SWFL — nothing obscure enough to be wrong.
- NO invented customer stories, tech anecdotes, or "we saw this in [city]" claims — you have no field data. Stay in general seasonal-biology territory.
- Urgency is seasonal/biological only — never "limited time", never commercial pressure.
- The pitch section is SINCERE: plain feature-benefit, no jokes inside the bullets. The humor lives in everything around it.

ISSUE SKELETON (every issue, same order — train the reader):
1. "What's Crawling This Month" — the lead story: 150-250 words on the pest about to peak, why now, what the reader will actually notice.
2. "Pest of the Month" ID card — where you'll see it, how worried to be (honest), one genuinely useful DIY tip, and when it's time to call someone.
3. "The Lawn Corner" — one timely lawn task or threat (${slate.lawn}). Most pest newsletters ignore lawns; we have a whole lawn division.
4. "Myth-Buster" — one forwardable myth verdict ("Do dryer sheets repel mosquitoes?" / "Does mulch attract termites?").
5. Featured service — the ONE earnest pitch section tied to the month.
6. Close — voice returns; one-line call CTA; quarterly tie-in ("this is what your quarterly visit is handling right now"); referral nudge.

GIF CAPTIONS (introGifCaption, crawlGifCaption, pitchGifCaption): max 12 words, punchline genre, never descriptive. The three Giphy search terms (introGifTerm, crawlGifTerm, pitchGifTerm) must be clearly DISTINCT from each other — different moods and meme genres, never near-synonyms.

SIGN-OFF: "${voice.pestInsiderSignoff || '— Adam, Waves Pest Control'}" (a real person, not "The Team" — the renderer appends the 🌊).

Return STRICT JSON (no HTML, no prose outside the JSON):
{
  "subjectVariants": ["string", "string", "string"],
  "selectedSubject": "string",
  "previewText": "string, 30-90 chars (punchline)",
  "introGifTerm": "string (Giphy search, pest/seasonal reaction meme)",
  "introGifCaption": "string",
  "greeting": "string (e.g. 'Hey there!')",
  "introText": "string (1-2 short paragraphs, seasonal hook, **bold**/_italic_ interleave)",
  "crawlHeading": "string (emoji + hook, e.g. '🦟 What's Crawling This Month')",
  "crawlGifTerm": "string (Giphy search)",
  "crawlGifCaption": "string",
  "crawlText": "string (the 150-250 word lead story)",
  "pestOfMonth": {
    "name": "string (common name)",
    "emoji": "string",
    "whereYoullSeeIt": "string (1-2 sentences)",
    "threatLevel": "string (honest, e.g. 'Annoying, not dangerous' or 'Call sooner than later')",
    "diyTip": "string (one genuinely useful tip)",
    "whenToCall": "string (the honest escalation line)"
  },
  "lawnHeading": "string (e.g. '🌱 The Lawn Corner')",
  "lawnText": "string (one timely task/threat, 60-120 words)",
  "mythQuestion": "string (e.g. 'Do dryer sheets repel mosquitoes?')",
  "mythVerdict": "string (the answer with a punchline, 40-90 words)",
  "pitchHeading": "string (emoji + benefit-framed, e.g. '✈️ Turn Your Yard Into a No-Fly Zone')",
  "pitchGifTerm": "string (Giphy search)",
  "pitchGifCaption": "string",
  "pitchIntro": "string (1 paragraph framing what Waves does about this — sincere)",
  "pitchBullets": [{ "title": "string (e.g. 'Stops the Cycle')", "text": "string (plain feature-benefit, no jokes)" }],
  "closingHeading": "string (e.g. '😎 Want Your Backyard Back?')",
  "closingText": "string (voice returns; include the quarterly tie-in sentence)",
  "ctaLine": "string (one line ending in the call prompt — the renderer attaches the phone number)",
  "signoff": "string",
  "ps": "string or null (forwardable nudge, no 'P.S.' prefix — the renderer adds the label)"
}`;
}

const PEST_INSIDER_PROSE_FIELDS = [
  'greeting', 'introText', 'introGifCaption',
  'crawlHeading', 'crawlGifCaption', 'crawlText',
  'lawnHeading', 'lawnText', 'mythQuestion', 'mythVerdict',
  'pitchHeading', 'pitchGifCaption', 'pitchIntro',
  'closingHeading', 'closingText', 'ctaLine', 'signoff', 'ps',
];
const PEST_OF_MONTH_FIELDS = ['name', 'emoji', 'whereYoullSeeIt', 'threatLevel', 'diyTip', 'whenToCall'];

function sanitizePestInsiderDraft(draft) {
  for (const k of PEST_INSIDER_PROSE_FIELDS) {
    if (typeof draft[k] === 'string') draft[k] = stripCommentaryUrls(draft[k]);
  }
  if (draft.pestOfMonth && typeof draft.pestOfMonth === 'object') {
    const card = {};
    for (const k of PEST_OF_MONTH_FIELDS) {
      card[k] = typeof draft.pestOfMonth[k] === 'string' ? stripCommentaryUrls(draft.pestOfMonth[k]) : null;
    }
    draft.pestOfMonth = card.name ? card : null;
  } else {
    draft.pestOfMonth = null;
  }
  draft.pitchBullets = (Array.isArray(draft.pitchBullets) ? draft.pitchBullets : [])
    .map((item) => (item && typeof item === 'object' ? {
      title: typeof item.title === 'string' ? stripCommentaryUrls(item.title) : null,
      text: typeof item.text === 'string' ? stripCommentaryUrls(item.text) : null,
    } : null))
    .filter((item) => item && (item.title || item.text));
  return draft;
}

// Customer-facing referral page (verified live 2026-06-11).
const WAVES_REFERRAL_URL = 'https://www.wavespestcontrol.com/referral/';

async function assemblePestInsiderNewsletter(draft) {
  const { WAVES_SUPPORT_PHONE_DISPLAY, WAVES_SUPPORT_PHONE_E164 } = require('../constants/business');
  const parts = [];

  // Parallel candidate prefetch — same rationale as the flagship assembler.
  // Selection runs sequentially afterward so the same GIF can never appear
  // twice in one issue.
  const usedGifIds = new Set();
  const gifRetryBudget = { remaining: 3 };
  const [introCandidates, crawlCandidates, pitchCandidates] = await Promise.all([
    searchGiphyCandidates(draft.introGifTerm),
    searchGiphyCandidates(draft.crawlGifTerm),
    searchGiphyCandidates(draft.pitchGifTerm),
  ]);
  const introGif = await pickUniqueGifWithRetry(draft.introGifTerm, introCandidates, usedGifIds, gifRetryBudget);
  const crawlGif = await pickUniqueGifWithRetry(draft.crawlGifTerm, crawlCandidates, usedGifIds, gifRetryBudget);
  const pitchGif = await pickUniqueGifWithRetry(draft.pitchGifTerm, pitchCandidates, usedGifIds, gifRetryBudget);

  // The generator already paid for and uploaded this issue-specific artwork.
  // Render it as the lead image just like the flagship assembler does; keeping
  // it out of the body silently burned an image-generation call every month.
  const heroUrl = safeUrl(draft.heroImageUrl);
  if (heroUrl) {
    parts.push(`<div style="text-align:center;margin:0 0 24px 0;">
<img src="${heroUrl}" alt="${escapeHtml(draft.selectedSubject || draft.subject || 'Pest Insider')}" style="max-width:100%;height:auto;border-radius:12px;display:block;margin:0 auto;" />
</div>`);
  }

  // TOC — the repeatable skeleton trains the reader.
  const tocItems = [
    draft.crawlHeading && `<li style="margin:0 0 6px 0;"><a href="#pi-crawl" style="color:${COLORS.blue};text-decoration:none;font-weight:500;">${markdownToHtml(draft.crawlHeading)}</a></li>`,
    draft.pestOfMonth?.name && `<li style="margin:0 0 6px 0;"><a href="#pi-pest" style="color:${COLORS.blue};text-decoration:none;font-weight:500;">${escapeHtml(draft.pestOfMonth.emoji || '🪲')} Pest of the Month</a></li>`,
    draft.lawnHeading && `<li style="margin:0 0 6px 0;"><a href="#pi-lawn" style="color:${COLORS.blue};text-decoration:none;font-weight:500;">${markdownToHtml(draft.lawnHeading)}</a></li>`,
    draft.mythQuestion && `<li style="margin:0 0 6px 0;"><a href="#pi-myth" style="color:${COLORS.blue};text-decoration:none;font-weight:500;">🔍 Myth-Buster</a></li>`,
    draft.pitchHeading && `<li style="margin:0 0 6px 0;"><a href="#pi-pitch" style="color:${COLORS.blue};text-decoration:none;font-weight:500;">${markdownToHtml(draft.pitchHeading)}</a></li>`,
  ].filter(Boolean);
  if (tocItems.length) {
    parts.push(`<div style="margin:0 0 24px 0;padding:16px 20px;background:${COLORS.cardBg};border-radius:10px;">
<p style="margin:0 0 10px 0;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:${COLORS.muted};font-weight:600;">In this email:</p>
<ul style="list-style:none;padding:0;margin:0;font-size:14px;line-height:2;">${tocItems.join('\n')}</ul>
</div>`);
  }

  // Cold open + intro — 22px greeting with the per-recipient first-name
  // token (same device as the flagship assembler).
  if (introGif) parts.push(gifBlock(introGif, draft.introGifCaption));
  if (draft.greeting) {
    parts.push(`<p style="margin:0 0 8px 0;font-size:22px;line-height:1.4;">👋 <strong><em>${markdownToHtml(greetingWithNameToken(draft.greeting))}</em></strong></p>`);
  }
  if (draft.introText) {
    parts.push(`<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.introText).replace(/\n+/g, '<br/><br/>')}</p>`);
  }

  // 1. What's Crawling This Month — the lead story
  if (draft.crawlHeading || draft.crawlText) {
    parts.push(dividerHtml());
    if (draft.crawlHeading) {
      parts.push(`<h2 id="pi-crawl" style="${sectionHeadingStyle(0, 8)}"><strong><em>${markdownToHtml(draft.crawlHeading)}</em></strong></h2>`);
    }
    if (crawlGif) parts.push(gifBlock(crawlGif, draft.crawlGifCaption));
    if (draft.crawlText) {
      parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.crawlText).replace(/\n+/g, '<br/><br/>')}</p>`);
    }
  }

  // 2. Pest of the Month — ID card
  if (draft.pestOfMonth?.name) {
    const card = draft.pestOfMonth;
    parts.push(dividerHtml());
    parts.push(`<h2 id="pi-pest" style="${sectionHeadingStyle(1, 8)}">${escapeHtml(card.emoji || '🪲')} <strong><em>Pest of the Month: ${markdownToHtml(card.name)}</em></strong></h2>`);
    const rows = [
      card.whereYoullSeeIt && `📍 <strong>Where you'll see it:</strong> ${markdownToHtml(card.whereYoullSeeIt)}`,
      card.threatLevel && `⚠️ <strong>How worried to be:</strong> ${markdownToHtml(card.threatLevel)}`,
      card.diyTip && `🛠️ <strong>DIY tip:</strong> ${markdownToHtml(card.diyTip)}`,
      card.whenToCall && `📞 <strong>When to call:</strong> ${markdownToHtml(card.whenToCall)}`,
    ].filter(Boolean);
    parts.push(`<div style="margin:0 0 14px 0;padding:14px 18px;background:${COLORS.cardBg};border-radius:10px;font-size:14px;line-height:1.8;">\n${rows.join('<br/>\n')}\n</div>`);
  }

  // 3. The Lawn Corner
  if (draft.lawnHeading || draft.lawnText) {
    parts.push(dividerHtml());
    if (draft.lawnHeading) {
      parts.push(`<h2 id="pi-lawn" style="${sectionHeadingStyle(2, 8)}"><strong><em>${markdownToHtml(draft.lawnHeading)}</em></strong></h2>`);
    }
    if (draft.lawnText) {
      parts.push(`<div style="margin:0 0 14px 0;padding:14px 18px;background:#F2F8F0;border-radius:10px;border-left:4px solid #5BA862;">
<p style="margin:0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.lawnText)}</p>
</div>`);
    }
  }

  // 4. Myth-Buster
  if (draft.mythQuestion && draft.mythVerdict) {
    parts.push(dividerHtml());
    parts.push(`<h2 id="pi-myth" style="${sectionHeadingStyle(3, 8)}">🔍 <strong><em>Myth-Buster: ${markdownToHtml(draft.mythQuestion)}</em></strong></h2>`);
    parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.mythVerdict)}</p>`);
  }

  // 5. The pitch (sincere middle of the sandwich)
  if (draft.pitchHeading) {
    parts.push(dividerHtml());
    parts.push(`<h2 id="pi-pitch" style="${sectionHeadingStyle(4, 8)}"><strong><em>${markdownToHtml(draft.pitchHeading)}</em></strong></h2>`);
    if (pitchGif) parts.push(gifBlock(pitchGif, draft.pitchGifCaption));
    if (draft.pitchIntro) {
      parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.pitchIntro)}</p>`);
    }
    const bullets = (draft.pitchBullets || []).slice(0, 5).map((b) =>
      `<li style="margin:0 0 10px 0;font-size:15px;line-height:1.6;">🔹 <strong>${markdownToHtml(b.title || '')}</strong>${b.title && b.text ? ' – ' : ''}${markdownToHtml(b.text || '')}</li>`
    ).join('\n');
    if (bullets) parts.push(`<ul style="list-style:none;padding:0;margin:0 0 14px 0;">${bullets}</ul>`);
  }

  // Close + phone CTA
  if (draft.closingHeading || draft.closingText || draft.ctaLine) {
    parts.push(dividerHtml());
    if (draft.closingHeading) {
      parts.push(`<h2 id="pi-close" style="${sectionHeadingStyle(5)}"><strong><em>${markdownToHtml(draft.closingHeading)}</em></strong></h2>`);
    }
    if (draft.closingText) {
      parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.closingText).replace(/\n+/g, '<br/><br/>')}</p>`);
    }
    const cta = draft.ctaLine ? markdownToHtml(draft.ctaLine) : 'Tired of sharing your yard? Give us a call';
    parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">👉 ${cta} <a href="tel:${WAVES_SUPPORT_PHONE_E164}" style="color:${COLORS.blue};text-decoration:underline;font-weight:600;">${escapeHtml(WAVES_SUPPORT_PHONE_DISPLAY)}</a></p>`);
    // Referral nudge — every issue carries it; readers are the warmest
    // referral audience (job #3). One line, never a second pitch.
    parts.push(`<p style="margin:0 0 14px 0;font-size:14px;line-height:1.6;color:${COLORS.muted};">Know a neighbor fighting the same bugs? <a href="${WAVES_REFERRAL_URL}" style="color:${COLORS.blue};text-decoration:underline;font-weight:500;">Send them our way</a> — referrals are the nicest compliment we get.</p>`);
  }

  // Sign-off — a real person, not "The Team" (reviews mention Adam by
  // name constantly; that's an asset).
  const signoffText = draft.signoff || '— Adam, Waves Pest Control';
  parts.push(`<p style="margin:20px 0 0 0;font-size:15px;line-height:1.6;">${markdownToHtml(signoffText)} 🌊</p>`);
  if (draft.ps) {
    const psText = psBodyText(draft.ps);
    if (psText) {
      parts.push(`<p style="margin:20px 0 0 0;font-size:14px;color:${COLORS.muted};line-height:1.5;"><strong>P.S.</strong> <em>${markdownToHtml(psText)}</em></p>`);
    }
  }

  // ── Reaction footer ── every edition ends with the feedback ask (owner
  // directive 2026-07-17). Per-recipient links substitute at send time;
  // archive/preview surfaces neutralize to inert chips.
  parts.push(FEEDBACK_HTML_TOKEN);

  return parts.join('\n\n');
}

// ── Beehiiv-Quality Newsletter Assembly ──────────────────────────────
//
// Renders structured event JSON into styled email HTML matching the
// visual quality of the former Beehiiv-hosted newsletters: per-event
// GIFs, branded dividers, emoji metadata blocks, TOC with jump links.

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

// Animated circular mascot badge built from the CURRENT brand mascot
// (client/public/waves-logo-2026.png art, wordmark cropped out — illegible
// at divider size anyway), self-hosted on our CDN. Replaces the Beehiiv-era
// mascot GIF that (a) was the old logo art and (b) lived on media.beehiiv.com,
// a platform we left — that asset can vanish without notice.
const WAVES_DIVIDER_GIF = 'https://d2riygw2ap9mi.cloudfront.net/social-media/waves-divider-2026-v2.gif';

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

async function generateHeroImage(subject) {
  const s3Ready = config.s3.accessKeyId && config.s3.secretAccessKey && config.s3.bucket && process.env.SOCIAL_MEDIA_CDN_DOMAIN;
  if (!s3Ready) return null;

  try {
    const imageGenerator = require('./content/image-generator');
    const titleText = heroTitleText(subject);
    const result = await imageGenerator.generate({
      // The shipped issues' visual identity: a custom flat retro-cartoon
      // collage restating the subject (tornado + dog + pirate, Mozart +
      // llama + pie), now WITH the subject lettered into the poster —
      // owner rule 2026-07-09. The primary generators (gpt-image line)
      // render typography reliably; the old "no text" rule predated them.
      // Passed as the raw `prompt` (NOT `title`) so image-generator's
      // generic buildPrompt scaffolding — "photorealistic … No text, words,
      // watermarks" — can't wrap and contradict it. The composition line
      // must ride along because Gemini fallbacks take size from the prompt.
      prompt: `Retro flat-cartoon poster collage for a Southwest Florida weekend events newsletter. 2-4 playful cartoon vignettes representing the lineup's themes ("${titleText}"), vintage palette (teal, orange, cream, brick red), sunburst background, bold and fun, Florida coastal energy. The poster prominently features the headline text "${titleText}" in bold retro hand-lettered poster typography — spelled EXACTLY as written, fully legible, integrated into the design as an arched or banner headline. No other words, letters, or writing anywhere else in the image. Composition: landscape 3:2 aspect ratio, 1536x1024.`,
      mode: 'blog-hero',
    });
    const match = /^data:([^;]+);base64,(.+)$/.exec(result.dataUrl || '');
    if (!match) return null;

    const { uploadImageToS3 } = require('./social-media');
    const filename = `newsletter-hero-${Date.now()}.jpg`;
    const cdnUrl = await uploadImageToS3(match[2], filename);
    if (cdnUrl) logger.info(`[newsletter-draft] hero image uploaded: ${cdnUrl}`);
    return cdnUrl;
  } catch (err) {
    logger.warn(`[newsletter-draft] hero image generation failed: ${err.message}`);
    return null;
  }
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

function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

function dividerHtml() {
  // Deliberately NOT a link (owner-accepted critique 2026-07-29): a linked
  // decorative divider is an accidental tap target on mobile and pollutes
  // click analytics with non-editorial homepage clicks.
  return `<div style="text-align:center;margin:28px 0;">
<img src="${WAVES_DIVIDER_GIF}" alt="" width="48" style="width:48px;height:auto;display:inline-block;" />
</div>`;
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
  return resolveEvclickDirect(neutralizeFeedbackTokens(neutralizeQuizTokens(
    stripGreetingNameToken(content)
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
  for (const k of ['title', 'description', 'proTip', 'closingLine', 'gifCaption', 'scoopLabel', 'linkText', 'hook', 'heroWhy']) {
    if (typeof out[k] === 'string') out[k] = stripCommentaryUrls(out[k]);
  }
  if (Array.isArray(out.highlights)) {
    // Strip URLs, then drop any bullet that's now empty (a URL-only item
    // strips to '' and would render as a blank bullet).
    out.highlights = out.highlights
      .map((h) => (typeof h === 'string' ? stripCommentaryUrls(h) : h))
      .filter((h) => !(typeof h === 'string' && h.trim() === ''));
  } else if (typeof out.highlights === 'string') {
    // assembleBeehiivNewsletter wraps a string highlights into an array and
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
      date,
      dateStr,
      timeStr,
      // Beehiiv house device: the clock emoji matches the actual start hour.
      clockEmoji: startAt ? clockEmojiFor(startAt) : null,
      location,
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

function gifBlock(url, caption) {
  const safeGifUrl = safeUrl(url);
  if (!safeGifUrl) return '';
  let html = `<div style="text-align:center;margin:12px 0 8px 0;">
<img src="${safeGifUrl}" alt="" style="max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto;" />
</div>`;
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
    heroParts.push(`<p style="margin:0 0 4px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:${COLORS.muted};font-weight:600;">This week's top pick</p>`);
    const heroImg = safeUrl(hero.imageUrl);
    if (heroImg) {
      heroParts.push(`<div style="margin:0 0 10px 0;"><img src="${heroImg}" alt="${escapeHtml(hero.sourceTitle || '')}" style="max-width:100%;height:auto;border-radius:10px;display:block;" /></div>`);
    }
    heroParts.push(`<h2 style="margin:0 0 6px 0;font-size:20px;line-height:1.35;">${escapeHtml(hero.sourceTitle || '')}</h2>`);
    const heroMeta = metaLine(hero);
    if (heroMeta) heroParts.push(`<p style="margin:0 0 8px 0;font-size:13px;color:${COLORS.muted};">${heroMeta}</p>`);
    if (hero.hook) heroParts.push(`<p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;">${markdownToHtml(hero.hook)}</p>`);
    if (hero.heroWhy) heroParts.push(`<p style="margin:0 0 8px 0;font-size:14px;line-height:1.5;"><strong>Why it made the cut:</strong> ${markdownToHtml(hero.heroWhy)}</p>`);
    const heroCta = detailsLink(hero, 'Details & tickets');
    if (heroCta) heroParts.push(`<p style="margin:0;font-size:14px;">${heroCta}</p>`);
    parts.push(`<div style="margin:0 0 24px 0;padding:18px 20px;background:${COLORS.cardBg};border-radius:10px;">\n${heroParts.join('\n')}\n</div>`);
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
    if (meta) card.push(`<p style="margin:0 0 6px 0;font-size:13px;color:${COLORS.muted};">${meta}</p>`);
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
    parts.push(`<div style="margin:0 0 24px 0;padding:14px 18px;background:#FFF8EC;border-radius:10px;">
<p style="margin:0 0 6px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:${COLORS.muted};font-weight:600;">Community notes</p>
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

async function assembleBeehiivNewsletter(draft) {
  const parts = [];
  const events = draft.events || [];

  // Prefetch ALL Giphy candidate lists concurrently. GIF-first rendering
  // would otherwise await Giphy serially inside the event loop — with
  // Giphy slow/unreachable that's 5s × 12 events of dead time; in
  // parallel the worst case is one 5s timeout. searchGiphyCandidates never
  // rejects (catch → []), so Promise.all is safe. Selection then runs
  // sequentially (intro first, events in order) against a shared used-set
  // so one issue can never repeat a GIF.
  const usedGifIds = new Set();
  const gifRetryBudget = { remaining: 6 };
  // Image-first visual rule (owner direction 2026-07-29): an event with
  // real still art shows THAT (the useful information), and the reaction
  // GIF is the fallback comedy device for events without art. Giphy is
  // only queried for events that will actually render a GIF — which also
  // excludes SHORTLIST entries (index > FEATURED_MAX): their compact
  // format renders no visual at all, so a lookup would burn requests and
  // the shared retry budget on a discarded pick.
  const FEATURED_MAX = 2; // [0] hero, [1..2] featured, [3..] shortlist
  const eventShowsImage = events.map((ev) => {
    const u = safeUrl(ev.imageUrl);
    return Boolean(u && !isLikelyGifUrl(u));
  });
  const eventRendersGif = (i) => i <= FEATURED_MAX && !eventShowsImage[i];
  const [introCandidates, ...eventCandidates] = await Promise.all([
    searchGiphyCandidates(draft.introGifTerm),
    ...events.map((ev, i) => (eventRendersGif(i) ? searchGiphyCandidates(ev.gifSearchTerm) : Promise.resolve([]))),
  ]);
  const introGif = await pickUniqueGifWithRetry(draft.introGifTerm, introCandidates, usedGifIds, gifRetryBudget);
  const eventGifs = [];
  for (let i = 0; i < eventCandidates.length; i++) {
    eventGifs.push(eventRendersGif(i)
      ? await pickUniqueGifWithRetry(events[i]?.gifSearchTerm, eventCandidates[i], usedGifIds, gifRetryBudget)
      : null);
  }

  // ── Hero Image ──
  const heroUrl = safeUrl(draft.heroImageUrl);
  if (heroUrl) {
    parts.push(`<div style="margin:0 0 20px 0;text-align:center;">
<img src="${heroUrl}" alt="${escapeHtml(draft.selectedSubject || 'Waves Newsletter')}" style="max-width:100%;height:auto;border-radius:12px;display:block;margin:0 auto;" />
</div>`);
  }

  // ── Table of Contents ── collapsible where the client supports
  // <details> (Apple Mail, most webmail); Gmail/Outlook render it
  // expanded — graceful degradation, never hidden content. The summary
  // line is the compact at-a-glance version (owner-accepted critique
  // 2026-07-29), and entries lead with the REAL event name so the list
  // is scannable — the curiosity headline rides second.
  const tocItems = events.map(ev => {
    const real = ev.sourceTitle ? `<strong>${escapeHtml(ev.sourceTitle)}</strong>` : markdownToHtml(ev.title);
    const witty = ev.sourceTitle ? ` <em style="color:${COLORS.muted};">— ${markdownToHtml(ev.title)}</em>` : '';
    return `<li style="margin:0 0 6px 0;"><a href="#evt-${slugify(ev.title)}" style="color:${COLORS.blue};text-decoration:none;">${escapeHtml(ev.emoji || '🎯')} ${real}</a>${witty}</li>`;
  });
  if (draft.homeownerMinute) {
    tocItems.push(`<li style="margin:0 0 6px 0;"><a href="#homeowner-minute" style="color:${COLORS.blue};text-decoration:none;font-weight:500;">🏠 Homeowner Minute</a></li>`);
  }
  const tocSummary = `${events.length} weekend pick${events.length === 1 ? '' : 's'} · North Port to Tampa · ~5-minute read`;
  parts.push(`<div style="margin:0 0 24px 0;padding:14px 20px;background:${COLORS.cardBg};border-radius:10px;">
<details>
<summary style="cursor:pointer;font-size:14px;color:${COLORS.muted};font-weight:600;">${escapeHtml(tocSummary)} <span style="font-weight:400;">(tap for the list)</span></summary>
<ul style="list-style:none;padding:0;margin:10px 0 0 0;font-size:14px;line-height:1.9;">${tocItems.join('\n')}</ul>
</details>
</div>`);

  // ── Intro GIF (cold open — caption is part of the joke) ──
  if (introGif) parts.push(gifBlock(introGif, draft.introGifCaption));

  // ── Greeting + Intro ──
  // 22px display-weight greeting with the per-recipient first-name token
  // ("Hey there, Adam!" / "Hey there!" when no name is on file).
  if (draft.greeting) {
    parts.push(`<p style="margin:0 0 8px 0;font-size:22px;line-height:1.4;">👋 <strong><em>${markdownToHtml(greetingWithNameToken(draft.greeting))}</em></strong></p>`);
  }
  if (draft.introText) {
    parts.push(`<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.introText)}</p>`);
  }
  if (draft.transitionLine) {
    parts.push(`<p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;"><strong>${markdownToHtml(draft.transitionLine)}</strong></p>`);
  }

  // ── Event Sections ── tiered treatment (owner direction 2026-07-29,
  // from the external editorial critique): the events arrive in the
  // portfolio's rank order (caller-order sort upstream), so position
  // assigns the tier —
  //   [0]        HEADLINER: full Beehiiv anatomy
  //   [1..2]     FEATURED:  visual + trimmed description + meta
  //   [3..]      SHORTLIST: compact entries under a single heading
  // "When everything is highlighted, nothing feels important."
  const tierOf = (i) => (i === 0 ? 'hero' : (i <= FEATURED_MAX ? 'featured' : 'quick'));

  // Shared per-event pieces, computed once per iteration. Ticket links
  // render as {{evclick:<eventId>}} tokens: the live sender substitutes a
  // per-recipient tracking redirect; proof, preview, and archive resolve
  // them back to the DIRECT event URL (newsletter-event-clicks.js).
  const eventPieces = (ev) => {
    const ticketUrl = safeUrl(ev.eventUrl);
    const ticketHref = (ticketUrl && ev.eventId)
      ? `{{evclick:${String(ev.eventId).toLowerCase()}}}`
      : ticketUrl;
    const anchorText = (typeof ev.linkText === 'string' && ev.linkText.trim())
      ? ev.linkText.trim().slice(0, 40)
      : 'Tickets & Info';
    const labels = (Array.isArray(ev.labels) ? ev.labels : []).slice(0, 3);
    return { ticketUrl, ticketHref, anchorText, labels };
  };

  // Meta lines shared by hero + featured cards. Price policy: the FREE
  // badge (DB flag) wins; otherwise the DB-locked priceText renders
  // verbatim-escaped. Model-written pricing stays hard-blocked upstream.
  const metaBoxHtml = (ev, pieces) => {
    const meta = [];
    if (ev.dateStr) {
      const timePart = ev.timeStr ? ` | ${ev.clockEmoji || '⏰'} <strong>${escapeHtml(ev.timeStr)}</strong>` : '';
      meta.push(`📅 <strong>${escapeHtml(ev.dateStr)}</strong>${timePart}`);
    } else if (ev.date) {
      meta.push(`📅 <strong>${escapeHtml(ev.date)}</strong>`);
    }
    if (ev.location) {
      const loc = ev.address ? `${escapeHtml(ev.location)} (${escapeHtml(ev.address)})` : escapeHtml(ev.location);
      meta.push(`📍 <em>${loc}</em>`);
    }
    if (ev.isFree) meta.push(`🎟️ <strong>FREE</strong>`);
    else if (ev.priceText) meta.push(`🎟️ ${escapeHtml(ev.priceText)}`);
    if (ev.admission) meta.push(`🎟️ ${markdownToHtml(ev.admission)}`);
    if (pieces.labels.length) {
      meta.push(`🏷️ <em>${pieces.labels.map((l) => escapeHtml(l)).join(' · ')}</em>`);
    }
    if (pieces.ticketUrl) {
      meta.push(`🔗 <a href="${pieces.ticketHref}" style="color:${COLORS.blue};text-decoration:underline;font-weight:500;">${escapeHtml(pieces.anchorText)}</a>`);
    }
    if (!meta.length) return null;
    return `<div style="margin:0 0 14px 0;padding:12px 16px;background:${COLORS.cardBg};border-radius:8px;font-size:14px;line-height:2;">\n${meta.join('<br/>\n')}\n</div>`;
  };

  // One visual per event: real still art when the event has it (the
  // useful information — owner direction 2026-07-29), reaction GIF as
  // the comedy fallback. The caption genre rides under either. mso-hidden
  // for images: Outlook's Word engine cannot aspect-fit a bounded box
  // (#3033 contract); Outlook readers keep the caption + card content.
  const visualHtml = (ev, i) => {
    if (eventShowsImage[i]) {
      const thumbUrl = safeUrl(ev.imageUrl);
      const thumbAlt = escapeHtml(ev.sourceTitle || ev.title || '');
      let html = `<!--[if !mso]><!--><div style="text-align:center;margin:0 0 8px 0;">
<img src="${thumbUrl}" alt="${thumbAlt}" style="max-width:100%;max-height:280px;width:auto;height:auto;border-radius:10px;display:block;margin:0 auto;" />
</div><!--<![endif]-->`;
      if (ev.gifCaption) {
        html += `\n<p style="text-align:center;margin:0 0 14px 0;font-size:14px;color:${COLORS.muted};"><em>${markdownToHtml(ev.gifCaption)}</em></p>`;
      }
      return html;
    }
    const eventGif = eventGifs[i];
    return eventGif ? gifBlock(eventGif, ev.gifCaption) : '';
  };

  let quickHeadingRendered = false;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const tier = tierOf(i);
    const pieces = eventPieces(ev);
    const anchorId = `evt-${slugify(ev.title)}`;

    if (tier === 'quick') {
      // Shortlist: one heading for the group, then compact entries —
      // real name, one sentence, one inline meta line.
      if (!quickHeadingRendered) {
        parts.push(dividerHtml());
        parts.push(`<h2 style="${sectionHeadingStyle(i, 8)}">⚡ <strong><em>The Weekend Shortlist</em></strong></h2>`);
        quickHeadingRendered = true;
      }
      const lines = [];
      const nameHtml = ev.sourceTitle ? escapeHtml(ev.sourceTitle) : markdownToHtml(ev.title);
      lines.push(`<p id="${anchorId}" style="margin:0 0 4px 0;font-size:15px;line-height:1.5;">${escapeHtml(ev.emoji || '🎯')} <strong>${nameHtml}</strong>${pieces.labels.length ? ` <em style="color:${COLORS.muted};font-size:13px;">· ${pieces.labels.map((l) => escapeHtml(l)).join(' · ')}</em>` : ''}</p>`);
      if (ev.description) {
        let descHtml = markdownToHtml(ev.description);
        if (pieces.ticketHref && ev.sourceTitle) {
          descHtml = linkifyFirst(descHtml, ev.sourceTitle, pieces.ticketHref);
        }
        lines.push(`<p style="margin:0 0 4px 0;font-size:14px;line-height:1.6;">${descHtml}</p>`);
      }
      const metaBits = [];
      if (ev.dateStr) metaBits.push(`📅 <strong>${escapeHtml(ev.dateStr)}</strong>${ev.timeStr ? ` · ${escapeHtml(ev.timeStr)}` : ''}`);
      if (ev.location) metaBits.push(`📍 ${escapeHtml(ev.location)}`);
      if (ev.isFree) metaBits.push(`🎟️ <strong>FREE</strong>`);
      else if (ev.priceText) metaBits.push(`🎟️ ${escapeHtml(ev.priceText)}`);
      if (pieces.ticketUrl) metaBits.push(`🔗 <a href="${pieces.ticketHref}" style="color:${COLORS.blue};text-decoration:underline;font-weight:500;">${escapeHtml(pieces.anchorText)}</a>`);
      if (metaBits.length) {
        lines.push(`<p style="margin:0;font-size:13px;line-height:1.7;color:${COLORS.muted};">${metaBits.join(' &nbsp;·&nbsp; ')}</p>`);
      }
      parts.push(`<div style="margin:0 0 18px 0;padding:12px 16px;background:${COLORS.cardBg};border-radius:8px;">\n${lines.join('\n')}\n</div>`);
      continue;
    }

    // Hero + featured cards.
    parts.push(dividerHtml());
    parts.push(`<h2 id="${anchorId}" style="${sectionHeadingStyle(i, 8)}">${escapeHtml(ev.emoji || '🎯')} <strong><em>${markdownToHtml(ev.title)}</em></strong></h2>`);

    const visual = visualHtml(ev, i);
    if (visual) parts.push(visual);

    if (ev.description) {
      let descHtml = markdownToHtml(ev.description);
      if (pieces.ticketHref && ev.sourceTitle) {
        descHtml = linkifyFirst(descHtml, ev.sourceTitle, pieces.ticketHref);
      }
      parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${descHtml}</p>`);
    }

    const metaBox = metaBoxHtml(ev, pieces);
    if (metaBox) parts.push(metaBox);

    // Scoop bullets, pro tip, and kicker are HEADLINER furniture only —
    // featured cards stay trimmed (40-60 word description + meta).
    if (tier === 'hero') {
      const hl = Array.isArray(ev.highlights) ? ev.highlights : (typeof ev.highlights === 'string' ? [ev.highlights] : []);
      if (hl.length) {
        const label = (typeof ev.scoopLabel === 'string' && ev.scoopLabel.trim())
          ? ev.scoopLabel.trim().slice(0, 60)
          : 'What to expect:';
        parts.push(`<p style="margin:0 0 6px 0;font-size:14px;font-weight:600;">${markdownToHtml(label)}</p>`);
        const bullets = hl
          .map((h) => plainBulletText(h))
          .filter(Boolean)
          .map((h) =>
            `<li style="margin:0 0 6px 0;padding-left:4px;font-size:14px;line-height:1.6;">• ${markdownToHtml(h)}</li>`
          ).join('\n');
        parts.push(`<ul style="list-style:none;padding:0;margin:0 0 14px 0;">${bullets}</ul>`);
      }

      // Pro tip — strip any model-provided "Pro tip:" prefix so the rendered
      // label never doubles ("Pro tip: Pro tip: ..." shipped once).
      if (ev.proTip) {
        const tipText = String(ev.proTip).replace(/^\s*(?:🚨\s*)?pro[\s-]*tip[:\s-]*/i, '');
        if (tipText.trim()) {
          parts.push(`<p style="margin:0 0 14px 0;font-size:14px;line-height:1.5;">🚨 <strong>Pro tip:</strong> <em>${markdownToHtml(tipText)}</em></p>`);
        }
      }

      if (ev.closingLine) {
        parts.push(`<p style="margin:0 0 0 0;font-size:15px;line-height:1.6;">${markdownToHtml(ev.closingLine)}</p>`);
      }
    }
  }

  // ── Homeowner Minute ──
  if (draft.homeownerMinute) {
    parts.push(dividerHtml());
    parts.push(`<h2 id="homeowner-minute" style="${sectionHeadingStyle(events.length)}">🏠 <strong><em>Homeowner Minute</em></strong></h2>`);
    parts.push(`<div style="margin:0 0 20px 0;padding:18px 20px;background:${COLORS.homeownerBg};border-radius:12px;border-left:4px solid ${COLORS.blue};">
<p style="margin:0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.homeownerMinute)}</p>
</div>`);
  }

  // ── Closing ──
  if (draft.closingHeading || draft.closingText) {
    parts.push(dividerHtml());
    if (draft.closingHeading) {
      parts.push(`<h2 style="${sectionHeadingStyle(events.length + 1)}">${escapeHtml(draft.closingEmoji || '📝')} <strong><em>${markdownToHtml(draft.closingHeading)}</em></strong></h2>`);
    }
    if (draft.closingText) {
      parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.closingText)}</p>`);
    }
    // ✔️ checklist — practical + absurd reminders (Beehiiv outro device).
    if (Array.isArray(draft.closingChecklist) && draft.closingChecklist.length) {
      const items = draft.closingChecklist.slice(0, 5).map((item) =>
        `<li style="margin:0 0 6px 0;font-size:14px;line-height:1.6;">✔️ ${markdownToHtml(checklistItemText(item))}</li>`
      ).join('\n');
      parts.push(`<ul style="list-style:none;padding:0;margin:0 0 14px 0;">${items}</ul>`);
    }
  }

  // ── Sign-off ──
  parts.push(`<p style="margin:20px 0 4px 0;font-size:15px;line-height:1.6;"><strong>Catch you out there this week.</strong></p>`);
  const signoffText = draft.signoff || '— The Waves Team';
  parts.push(`<p style="margin:0 0 0 0;font-size:15px;line-height:1.6;">${markdownToHtml(signoffText)} 🌊</p>`);

  // ── P.S. ──
  if (draft.ps) {
    const psText = psBodyText(draft.ps);
    if (psText) {
      parts.push(`<p style="margin:20px 0 0 0;font-size:14px;color:${COLORS.muted};line-height:1.5;"><strong>P.S.</strong> <em>${markdownToHtml(psText)}</em></p>`);
    }
  }

  // ── Share Banner ── forward prompt only. The old icon row linked the
  // Waves social PROFILES while claiming to share the issue (owner-
  // accepted critique 2026-07-29); profiles stay in the footer, and the
  // wrapper adds a real web-version permalink when the send has a slug.
  parts.push(`<div style="margin:28px 0 0 0;padding:16px 20px;background:${COLORS.cardBg};border-radius:10px;text-align:center;">
<p style="margin:0;font-size:14px;color:${COLORS.muted};">Know someone who always asks what's happening this weekend? <strong>Forward them this email.</strong></p>
</div>`);

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

function buildFlagshipTextBody(draft) {
  const out = [];
  if (draft.greeting) out.push(stripMd(greetingWithNameToken(draft.greeting)));
  if (draft.introText) out.push(stripMd(draft.introText));
  const evs = draft.events || [];
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    const lines = [];
    lines.push(`== ${ev.sourceTitle || stripMd(ev.title)} ==`);
    if (ev.description) lines.push(stripMd(ev.description));
    // Headliner furniture serializes too — the MIME alternatives must
    // stay content-equivalent (same fields, nothing extra, nothing less).
    if (i === 0) {
      const hl = Array.isArray(ev.highlights) ? ev.highlights : [];
      for (const h of hl) {
        const t = plainBulletText(h);
        if (t) lines.push(`- ${stripMd(t)}`);
      }
      if (ev.proTip) {
        const tip = String(ev.proTip).replace(/^\s*(?:🚨\s*)?pro[\s-]*tip[:\s-]*/i, '').trim();
        if (tip) lines.push(`Pro tip: ${stripMd(tip)}`);
      }
      if (ev.closingLine) lines.push(stripMd(ev.closingLine));
    }
    const facts = [];
    if (ev.dateStr) facts.push(ev.timeStr ? `${ev.dateStr} at ${ev.timeStr}` : ev.dateStr);
    if (ev.location) facts.push(ev.location);
    if (ev.isFree) facts.push('FREE');
    // "Tickets:" marker on purpose — the claim scan only excises locked
    // prices in the renderer's own marker-bound shapes.
    else if (ev.priceText) facts.push(`Tickets: ${ev.priceText}`);
    if (facts.length) lines.push(facts.join(' | '));
    const url = safeUrl(ev.eventUrl);
    if (url) lines.push(`Tickets & info: ${url}`);
    out.push(lines.join('\n'));
  }
  if (draft.homeownerMinute) {
    // No appended CTA: the HTML's schedule link is wrapper furniture the
    // operator reviewed; injecting unreviewed sales copy into the text
    // alternative would break the zero-sell rule AND MIME equivalence.
    out.push(`== Homeowner Minute ==\n${stripMd(draft.homeownerMinute)}`);
  }
  if (draft.closingText) out.push(stripMd(draft.closingText));
  const checklist = Array.isArray(draft.closingChecklist) ? draft.closingChecklist : [];
  if (checklist.length) {
    out.push(checklist.map((c) => `[ ] ${stripMd(c)}`).join('\n'));
  }
  out.push(stripMd(draft.signoff || '— The Waves Team'));
  if (draft.ps) {
    const psText = psBodyText(draft.ps);
    if (psText) out.push(`P.S. ${stripMd(psText)}`);
  }
  out.push(FEEDBACK_TEXT_TOKEN);
  return out.filter(Boolean).join('\n\n');
}

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
 * @returns {Promise<{send: Object, draft: Object}>}
 */
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
}) {
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
          'e.times_featured', 'e.last_featured_at', 'e.pulled_at',
          'e.price_text', 'e.family_friendly', 'e.audience_tags',
          'e.novelty_type', 'e.region_zone', 'e.score_breakdown',
          's.name as source_name',
        )
        .whereIn('e.id', safeIds)
        .whereIn('e.admin_status', ['approved', 'featured'])
        .whereNull('e.merged_into')
        .whereNotIn('e.freshness_status', ['expired', 'stale_recurring'])
        .orderByRaw('e.freshness_score DESC NULLS LAST');

      const approvedRows = await excludeRoutineRecurringFromQuery(approvedQuery);
      const nonRepeatedRows = await filterRepeatedDateIdentities(approvedRows, {
        knex,
        reference: editorialReference,
      });
      const historicallyNewRows = await filterPreviouslyFeaturedIdentities(nonRepeatedRows, {
        knex,
        reference: editorialReference,
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

  // 2. Build the system prompt — Pest Insider gets the humor-sandwich
  //    prompt (no events, no anchoring); everything else gets the
  //    flagship events prompt.
  const isPestInsider = typeConfig?.key === 'pest-insider-monthly';
  const systemPrompt = isPestInsider
    ? buildPestInsiderSystemPrompt(voice, month)
    : buildFlagshipSystemPrompt(voice, month);

  // Enrich the user prompt with homeowner minute topic if provided
  let enrichedPrompt = prompt;
  if (homeownerMinuteTopic) {
    enrichedPrompt += `\nHomeowner Minute topic: ${homeownerMinuteTopic}`;
  }

  const userPrompt = `Topic / prompt: ${enrichedPrompt}
${audience ? `Audience: ${audience}` : ''}
${tone ? `Tone: ${tone}` : ''}${eventBlock}`;

  // 3. Call the Sonnet → OpenAI Terra content policy. 8192 tokens — the Beehiiv-parity schema is richer
  // (captions, scoop labels, checklists) and a 10-event lineup at 4096
  // risked mid-JSON truncation.
  const response = await dispatchWithFallback(MODELS.TEXT_POLICIES.contentDraft, {
    maxTokens: 8192,
    jsonMode: true,
    system: systemPrompt,
    text: userPrompt,
  });
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
  if (!isPestInsider && draft.hero && draft.hero.eventId) {
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
  if (!isPestInsider) draft.communityNotes = null;

  if (!isPestInsider && Array.isArray(draft.events) && draft.events.length > 0) {
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
    // Tier assignment is positional, so re-assert the CALLER's rank
    // (portfolio order) over whatever sequence the model echoed back —
    // a reordered-but-valid JSON must not promote an arbitrary event to
    // headliner. Unknown ids sort last (lock already dropped them).
    draft.events = sortByCallerRank(locked, eventIds);
  }

  // 4a.5 Strip stray URLs from the free-prose fields (intro / homeowner minute /
  //      closing / etc). Per-event commentary is already sanitized inside
  //      lockEventFactsFromDb; this extends the same defense to the prose the
  //      model authors outside the events array.
  sanitizeProseFields(draft);

  // 4b. Generate hero image (non-flagship lanes only — the compact
  //     flagship format uses the hero EVENT's own image, not a generated
  //     collage, per the 2026-07-28 spec; this also ends that image spend).
  if ((draft.events?.length || isPestInsider) && !draft.heroImageUrl) {
    draft.heroImageUrl = await generateHeroImage(draft.selectedSubject || draft.subjectVariants?.[0] || 'Waves Newsletter');
  }

  // 4c. Assemble HTML from structured data. Flagship uses the compact
  //     2026-07-28 format; other event-carrying types keep the legacy
  //     Beehiiv-style assembler.
  if (isPestInsider) {
    sanitizePestInsiderDraft(draft);
    draft.htmlBody = await assemblePestInsiderNewsletter(draft);
  } else if (draft.events?.length) {
    // Owner reversal 2026-07-28 (late evening): the flagship keeps the
    // Beehiiv-formula renderer + comedic devices. assembleWavesNewsletter
    // (the compact format) is retained, unused by the pipeline.
    draft.htmlBody = await assembleBeehiivNewsletter(draft);
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

  if (!draft.textBody && draft.events?.length && typeConfig?.flagship) {
    // Structured plain-text alternative (owner-accepted critique
    // 2026-07-29): real sections, event names, dates, prices, and full
    // destination urls — not tag-stripped HTML collapsed into one
    // paragraph. Direct event urls on purpose: text-only clients get no
    // per-recipient substitution pass for evclick tokens.
    draft.textBody = buildFlagshipTextBody(draft);
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
    // Same lock list the send-time gate uses — without it every
    // DB-rendered price would log a false hallucination warning here.
    const draftLockedPrices = (draft.events || [])
      .map((ev) => (typeof ev.priceText === 'string' ? ev.priceText : ''))
      .filter(Boolean);
    const claimErrors = findHallucinatedClaims(
      [draft.htmlBody, draft.textBody].filter(Boolean).join('\n'),
      draftLockedPrices,
    );
    if (claimErrors.length > 0) {
      draft.hallucinationErrors = claimErrors;
      logger.warn(`[newsletter-draft] ${claimErrors.length} hallucinated-claim error(s) at draft time: ${claimErrors.join(' | ')}`);
    }
  }

  // Map flagship output to legacy shape
  draft.subject = draft.selectedSubject || draft.subjectVariants?.[0] || '';

  // persist=false: the interactive Compose flow (/draft-ai) reuses this
  // locked generator for a preview, then saves via the normal /sends
  // route after the operator reviews. Skip the DB insert and return the
  // draft only — facts are still locked at this point.
  if (!persist) {
    return { send: null, draft };
  }

  const send = await persistNewsletterDraft({ draft, prompt, newsletterType, knex });

  // 8. Return { send, draft }
  return { send, draft };
}

async function persistNewsletterDraft({ draft, prompt, newsletterType, knex = db }) {
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
    from_email: 'events@wavespestcontrol.com',
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
  }).returning('*');
  return send;
}

module.exports = {
  resolveIssueReference,
  createNewsletterDraft,
  persistNewsletterDraft,
  lockEventFactsFromDb,
  // Exported for unit testing the injection/prose defenses
  escapeHtml,
  safeUrl,
  markdownToHtml,
  sanitizeProseFields,
  assembleBeehiivNewsletter,
  assembleWavesNewsletter,
  isLikelyGifUrl,
  buildFlagshipTextBody,
  sortByCallerRank,
  deriveEventLabels,
  // Exported for unit testing the Beehiiv-parity render devices
  clockEmojiFor,
  // GIF dedupe (one issue never repeats a GIF)
  searchGiphyCandidates,
  pickUniqueGif,
  pickUniqueGifWithRetry,
  // Hero poster headline text (subject, emoji-stripped)
  heroTitleText,
  displayCity,
  formatLockedLocation,
  linkifyFirst,
  // Pest Insider (monthly humor-sandwich) pieces
  buildPestInsiderSystemPrompt,
  sanitizePestInsiderDraft,
  assemblePestInsiderNewsletter,
  PEST_INSIDER_ROTATION,
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
