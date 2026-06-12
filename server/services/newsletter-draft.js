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
const logger = require('./logger');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

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
  return `You write the Waves weekly local events newsletter — "Fresh This Week from North Port to Tampa."

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
- Signature humor devices (use several per issue, vary them):
  * Parenthetical asides as a second comedic voice: "(no judgment)", "(yes, really)", "(you *will*)"
  * Affectionate reader/local roasts: "pretending you know how to swing a golf club"
  * Absurd escalating triads ending on a hyper-specific gag: "without the lines, heatstroke, or second-mortgage lemonade"
  * Bathos/anticlimax: "the grand prize is eternal glory and the world's most charming weapon: a wooden spoon"
  * Internet idioms used sparingly: rent-free, full send, serotonin, "entered the chat"
  * Mock warnings and dares: "Don't say we didn't warn you."
  * Florida in-jokes: foldable chair in the trunk, sunscreen, afternoon thunderstorms

SUBJECT LINES: max ${voice.subjectLineRules.maxLength} chars, specific to this week, two proven shapes — (1) noun-triple + kicker, (2) full declarative sentence with a curiosity gap. Examples: ${voice.subjectLineRules.examples.map(e => `"${e}"`).join(', ')}

PREVIEW TEXT: the second punchline, never a summary. Direct-address roast or three-fragment cadence. Examples: ${(voice.previewTextRules?.examples || []).map(e => `"${e}"`).join(', ')}

NEVER WRITE: ${voice.bannedCorporatePhrases.map(p => `"${p}"`).join(', ')}

GIF CAPTIONS (gifCaption + introGifCaption) are their own genre: ${voice.gifCaptionRules?.maxWords || 12} words MAX, never a description of the image or the event — always a punchline. Proven shapes:
${(voice.gifCaptionRules?.shapes || []).map((s) => `- ${s}`).join('\n')}

EVENT RULES:
- Use ONLY the approved event records provided. Do NOT invent events.
- For every event you include, copy its [eventId: ...] UUID into the "eventId" field exactly. The renderer uses this to re-pull date, time, venue, address, and ticket URL straight from the database — anything you write for those fields will be IGNORED.
- Do NOT mention specific dollar amounts, "free admission", "no cost", "complimentary", or any ticket-price phrasing in your commentary. We never store admission in the DB, so any pricing claim you make is unverifiable and will hard-block the send.
- Do NOT make pest-control safety or efficacy claims ("pet-safe", "child-safe", "guaranteed", "100% effective", "EPA-approved") — this is an events newsletter, not a service pitch.
- title: a CURIOSITY-GAP headline that never uses the raw event name (it renders elsewhere). Proven formulas: question + affirmation ("...? Yes, Please" / "...? Say Less" / "...? Count Us In"), PSA framing ("PSA: You Might Meet Your New Best Friend This Weekend"), direct address ("This One's for You"), equation ("High Hair + Hot Dice = Ultimate Weekend").
- Each event gets a unique thematic emoji (no repeats between events).
- gifSearchTerm: 2-4 word Giphy search for a pop-culture REACTION meme (the joke), not a literal event photo.
- description: 2-4 sentences, conversational, says WHY someone would actually go. Work the event's official name (exactly as given in the record) into the prose once — the renderer turns it into the ticket link. Do NOT restate the date, venue, or URL — those render automatically.
- scoopLabel: the lead-in for the highlights list. Rotate across events, never repeat in one issue: "Here's the scoop:", "Here's the deal:", "Here's what's going down:", "What to expect:", "Here's the rundown:", "Why it's a vibe:", "Why it's a weekend winner:", "Here's what you're walking into:".
- highlights: 3-5 bullets, EACH starting with its own thematic emoji (🐾 🎟️ 🍿 ✨ ...). Vibe-only; no logistics, no prices.
- proTip: insider tip (optional — only if genuinely useful, e.g. parking, arrive-early, what to bring). Do NOT include the words "Pro tip" — the renderer adds the label. NOT pricing or ticket logistics.
- closingLine: punchy one-line kicker to wrap the event — bold the punch ("This is **Bradenton's Fourth of July mic drop.**").
- linkText: short anchor text for the ticket link, rotated across events: "More info here", "Get tickets", "Grab your spot", "Full lineup", "Save your seat", "All the details".

INTRO: greeting "Hey there!" energy; introText 2-4 sentences with a "Whether you're into X, Y, or Z" triad and a FOMO close. introGifCaption: cold-open punchline for the intro GIF (same caption genre).

HOMEOWNER MINUTE: One useful seasonal tip (pest, lawn, plants, home prep). Max ~90 words. Genuinely useful, not salesy — the brand sell in this newsletter is ZERO; this tip is the only Waves-adjacent content and it must stand on its own. Voice it like the themed issues: **bold the facts**, _italicize the jokes_, anthropomorphize the pest/plant when it lands ("that mosquito keeping you up at night? Probably a mom-to-be"), urgency biological/seasonal, never commercial. May end with a "Hot tip:" one-liner.

CLOSING: closingText = 1-2 short paragraphs that CALL BACK to this issue's actual events in an absurd triad ("Whether you end up juggling pineapples, dancing to swamp funk, or sobbing quietly to Schubert — we fully support your weekend choices."). closingChecklist: 3-4 short ✔️-style reminders mixing practical + absurd ("Hydrate like it's your job", "Don't underestimate the power of a funnel cake").

SIGN-OFF: "${voice.signoff}"

P.S. JOKE: "If you loved this, forward it to a friend who [hyper-specific persona — e.g. 'owns both a tutu *and* a folding lawn chair']. If you didn't... [reverse-blame punchline — e.g. 'blame the clown']." End with thematic emoji. Reference this issue's actual events.

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
      "highlights": ["string (each starts with its own emoji)"] or null,
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
  "ps": "string or null"
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

GIF CAPTIONS (introGifCaption, crawlGifCaption, pitchGifCaption): max 12 words, punchline genre, never descriptive.

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
  "ps": "string or null (forwardable nudge)"
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

  // Parallel GIF prefetch — same rationale as the flagship assembler.
  const [introGif, crawlGif, pitchGif] = await Promise.all([
    searchGiphy(draft.introGifTerm),
    searchGiphy(draft.crawlGifTerm),
    searchGiphy(draft.pitchGifTerm),
  ]);

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
<p style="margin:0 0 10px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:${COLORS.muted};font-weight:600;">In this email:</p>
<ul style="list-style:none;padding:0;margin:0;font-size:14px;line-height:2;">${tocItems.join('\n')}</ul>
</div>`);
  }

  // Cold open + intro
  if (introGif) parts.push(gifBlock(introGif, draft.introGifCaption));
  if (draft.greeting) {
    parts.push(`<p style="margin:0 0 4px 0;font-size:16px;line-height:1.6;">👋 <strong><em>${markdownToHtml(draft.greeting)}</em></strong></p>`);
  }
  if (draft.introText) {
    parts.push(`<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.introText).replace(/\n+/g, '<br/><br/>')}</p>`);
  }

  // 1. What's Crawling This Month — the lead story
  if (draft.crawlHeading || draft.crawlText) {
    parts.push(dividerHtml());
    if (draft.crawlHeading) {
      parts.push(`<h2 id="pi-crawl" style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 8px 0;"><strong><em>${markdownToHtml(draft.crawlHeading)}</em></strong></h2>`);
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
    parts.push(`<h2 id="pi-pest" style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 8px 0;">${escapeHtml(card.emoji || '🪲')} <strong><em>Pest of the Month: ${markdownToHtml(card.name)}</em></strong></h2>`);
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
      parts.push(`<h2 id="pi-lawn" style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 8px 0;"><strong><em>${markdownToHtml(draft.lawnHeading)}</em></strong></h2>`);
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
    parts.push(`<h2 id="pi-myth" style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 8px 0;">🔍 <strong><em>Myth-Buster: ${markdownToHtml(draft.mythQuestion)}</em></strong></h2>`);
    parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.mythVerdict)}</p>`);
  }

  // 5. The pitch (sincere middle of the sandwich)
  if (draft.pitchHeading) {
    parts.push(dividerHtml());
    parts.push(`<h2 id="pi-pitch" style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 8px 0;"><strong><em>${markdownToHtml(draft.pitchHeading)}</em></strong></h2>`);
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
      parts.push(`<h2 id="pi-close" style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 12px 0;"><strong><em>${markdownToHtml(draft.closingHeading)}</em></strong></h2>`);
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
    parts.push(`<p style="margin:20px 0 0 0;font-size:14px;color:${COLORS.muted};line-height:1.5;"><strong>P.S.</strong> <em>${markdownToHtml(draft.ps)}</em></p>`);
  }

  return parts.join('\n\n');
}

// ── Beehiiv-Quality Newsletter Assembly ──────────────────────────────
//
// Renders structured event JSON into styled email HTML matching the
// visual quality of the Beehiiv "Fresh This Week" newsletters: per-event
// GIFs, branded dividers, emoji metadata blocks, TOC with jump links.

const COLORS = {
  navy: '#1B2C5B',
  blue: '#009CDE',
  gold: '#FFD700',
  muted: '#8B8680',
  cardBg: '#FAFAF8',
  homeownerBg: '#F0F7FA',
  rule: '#E7E2D7',
};

const WAVES_DIVIDER_GIF = 'https://media.beehiiv.com/cdn-cgi/image/fit=scale-down,format=auto,onerror=redirect,quality=80/uploads/asset/file/952b11dc-99a2-4de3-8def-481a1c34f8d7/giphy.gif';

async function generateHeroImage(subject) {
  const s3Ready = config.s3.accessKeyId && config.s3.secretAccessKey && config.s3.bucket && process.env.SOCIAL_MEDIA_CDN_DOMAIN;
  if (!s3Ready) return null;

  try {
    const imageGenerator = require('./content/image-generator');
    const result = await imageGenerator.generate({
      // The shipped issues' visual identity: a custom flat retro-cartoon
      // collage restating the subject (tornado + dog + pirate, Mozart +
      // llama + pie). AI lettering garbles, so no text overlay — the
      // subject line itself stays in the email chrome.
      title: `Retro flat-cartoon poster collage for a Southwest Florida weekend events newsletter titled "${subject}". 2-4 playful cartoon vignettes representing the lineup's themes, vintage palette (teal, orange, cream, brick red), sunburst background, bold and fun, Florida coastal energy. Strictly NO text, NO lettering, NO words in the image.`,
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
async function searchGiphy(term) {
  if (!term) return null;
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) return null;
  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${apiKey}&q=${encodeURIComponent(term)}&limit=1&rating=pg`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const gif = data.data?.[0];
    return gif?.images?.downsized_medium?.url || gif?.images?.original?.url || null;
  } catch { return null; }
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
  return `<div style="text-align:center;margin:28px 0;">
<a href="https://www.wavespestcontrol.com/" style="text-decoration:none;">
<img src="${WAVES_DIVIDER_GIF}" alt="" width="100" style="width:100px;height:auto;display:inline-block;" />
</a></div>`;
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
  for (const k of ['title', 'description', 'proTip', 'closingLine', 'gifCaption', 'scoopLabel', 'linkText']) {
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
      // admission deliberately omitted — events_raw does not store it,
      // so any value the model produced was unverifiable.
      admission: null,
    });
  });

  return { locked, dropped };
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
function linkifyFirst(html, text, url) {
  const needle = escapeHtml(String(text).trim());
  if (!needle) return html;
  const idx = html.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return html;
  const matched = html.slice(idx, idx + needle.length);
  return `${html.slice(0, idx)}<a href="${url}" style="color:${COLORS.blue};text-decoration:underline;font-weight:600;">${matched}</a>${html.slice(idx + needle.length)}`;
}

function gifBlock(url, caption) {
  if (!url) return '';
  let html = `<div style="text-align:center;margin:12px 0 8px 0;">
<img src="${url}" alt="" style="max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto;" />
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

async function assembleBeehiivNewsletter(draft) {
  const parts = [];
  const events = draft.events || [];

  // Prefetch ALL Giphy lookups concurrently. GIF-first rendering would
  // otherwise await searchGiphy serially inside the event loop — with
  // Giphy slow/unreachable that's 5s × 12 events of dead time; in
  // parallel the worst case is one 5s timeout. searchGiphy never
  // rejects (catch → null), so Promise.all is safe.
  const [introGif, ...eventGifs] = await Promise.all([
    searchGiphy(draft.introGifTerm),
    ...events.map((ev) => searchGiphy(ev.gifSearchTerm)),
  ]);

  // ── Hero Image ──
  const heroUrl = safeUrl(draft.heroImageUrl);
  if (heroUrl) {
    parts.push(`<div style="margin:0 0 20px 0;text-align:center;">
<img src="${heroUrl}" alt="${escapeHtml(draft.selectedSubject || 'Fresh This Week')}" style="max-width:100%;height:auto;border-radius:12px;display:block;margin:0 auto;" />
</div>`);
  }

  // ── Table of Contents ──
  const tocItems = events.map(ev =>
    `<li style="margin:0 0 6px 0;"><a href="#evt-${slugify(ev.title)}" style="color:${COLORS.blue};text-decoration:none;font-weight:500;">${escapeHtml(ev.emoji || '🎯')} ${markdownToHtml(ev.title)}</a></li>`
  );
  if (draft.homeownerMinute) {
    tocItems.push(`<li style="margin:0 0 6px 0;"><a href="#homeowner-minute" style="color:${COLORS.blue};text-decoration:none;font-weight:500;">🏠 Homeowner Minute</a></li>`);
  }
  parts.push(`<div style="margin:0 0 24px 0;padding:16px 20px;background:${COLORS.cardBg};border-radius:10px;">
<p style="margin:0 0 10px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:${COLORS.muted};font-weight:600;">In this email:</p>
<ul style="list-style:none;padding:0;margin:0;font-size:14px;line-height:2;">${tocItems.join('\n')}</ul>
</div>`);

  // ── Intro GIF (cold open — caption is part of the joke) ──
  if (introGif) parts.push(gifBlock(introGif, draft.introGifCaption));

  // ── Greeting + Intro ──
  if (draft.greeting) {
    parts.push(`<p style="margin:0 0 4px 0;font-size:16px;line-height:1.6;">👋 <strong><em>${markdownToHtml(draft.greeting)}</em></strong></p>`);
  }
  if (draft.introText) {
    parts.push(`<p style="margin:0 0 16px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.introText)}</p>`);
  }
  if (draft.transitionLine) {
    parts.push(`<p style="margin:0 0 8px 0;font-size:15px;line-height:1.6;"><strong>${markdownToHtml(draft.transitionLine)}</strong></p>`);
  }

  // ── Event Sections ──
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    parts.push(dividerHtml());

    // Heading
    const anchorId = `evt-${slugify(ev.title)}`;
    parts.push(`<h2 id="${anchorId}" style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 8px 0;">${escapeHtml(ev.emoji || '🎯')} <strong><em>${markdownToHtml(ev.title)}</em></strong></h2>`);

    // Reaction GIF first — in the shipped Beehiiv formula the GIF + caption
    // IS the joke; the event photo is only a fallback when Giphy yields
    // nothing (or no API key, e.g. in tests). Prefetched above.
    const eventGif = eventGifs[i];
    if (eventGif) {
      parts.push(gifBlock(eventGif, ev.gifCaption));
    } else {
      const thumbUrl = safeUrl(ev.imageUrl);
      if (thumbUrl) {
        parts.push(`<div style="text-align:center;margin:8px 0 12px 0;">
<img src="${thumbUrl}" alt="${escapeHtml(ev.title || '')}" style="max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto;" />
</div>`);
      }
    }

    // Description — the event's official (DB-locked) name becomes the
    // inline ticket link, per the Beehiiv convention; the metadata block
    // keeps a labeled link as well for skimmers.
    const ticketUrl = safeUrl(ev.eventUrl);
    if (ev.description) {
      let descHtml = markdownToHtml(ev.description);
      if (ticketUrl && ev.sourceTitle) {
        descHtml = linkifyFirst(descHtml, ev.sourceTitle, ticketUrl);
      }
      parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${descHtml}</p>`);
    }

    // Metadata block. date/location/address are DB-locked but originate from
    // ingested feeds, so escape them; the ticket link is validated via safeUrl.
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
    // DB-verifiable free flag only — never model prose (events_raw stores
    // no admission, so model pricing claims stay hard-blocked).
    if (ev.isFree) meta.push(`🎟️ <strong>FREE</strong>`);
    if (ev.admission) meta.push(`🎟️ ${markdownToHtml(ev.admission)}`);
    if (ticketUrl) {
      const anchorText = (typeof ev.linkText === 'string' && ev.linkText.trim())
        ? ev.linkText.trim().slice(0, 40)
        : 'Tickets & Info';
      meta.push(`🔗 <a href="${ticketUrl}" style="color:${COLORS.blue};text-decoration:underline;font-weight:500;">${escapeHtml(anchorText)}</a>`);
    }
    if (meta.length) {
      parts.push(`<div style="margin:0 0 14px 0;padding:12px 16px;background:${COLORS.cardBg};border-radius:8px;font-size:14px;line-height:2;">\n${meta.join('<br/>\n')}\n</div>`);
    }

    // Highlights — rotating lead-in label from the model; each bullet
    // carries its own thematic emoji, so no injected "•".
    const hl = Array.isArray(ev.highlights) ? ev.highlights : (typeof ev.highlights === 'string' ? [ev.highlights] : []);
    if (hl.length) {
      const label = (typeof ev.scoopLabel === 'string' && ev.scoopLabel.trim())
        ? ev.scoopLabel.trim().slice(0, 60)
        : 'What to expect:';
      parts.push(`<p style="margin:0 0 6px 0;font-size:14px;font-weight:600;">${markdownToHtml(label)}</p>`);
      const bullets = hl.map(h =>
        `<li style="margin:0 0 6px 0;padding-left:4px;font-size:14px;line-height:1.6;">${markdownToHtml(h)}</li>`
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

    // Closing line
    if (ev.closingLine) {
      parts.push(`<p style="margin:0 0 0 0;font-size:15px;line-height:1.6;">${markdownToHtml(ev.closingLine)}</p>`);
    }
  }

  // ── Homeowner Minute ──
  if (draft.homeownerMinute) {
    parts.push(dividerHtml());
    parts.push(`<h2 id="homeowner-minute" style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 12px 0;">🏠 <strong><em>Homeowner Minute</em></strong></h2>`);
    parts.push(`<div style="margin:0 0 20px 0;padding:18px 20px;background:${COLORS.homeownerBg};border-radius:12px;border-left:4px solid ${COLORS.blue};">
<p style="margin:0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.homeownerMinute)}</p>
</div>`);
  }

  // ── Closing ──
  if (draft.closingHeading || draft.closingText) {
    parts.push(dividerHtml());
    if (draft.closingHeading) {
      parts.push(`<h2 style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 12px 0;">${escapeHtml(draft.closingEmoji || '📝')} <strong><em>${markdownToHtml(draft.closingHeading)}</em></strong></h2>`);
    }
    if (draft.closingText) {
      parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.closingText)}</p>`);
    }
    // ✔️ checklist — practical + absurd reminders (Beehiiv outro device).
    if (Array.isArray(draft.closingChecklist) && draft.closingChecklist.length) {
      const items = draft.closingChecklist.slice(0, 5).map((item) =>
        `<li style="margin:0 0 6px 0;font-size:14px;line-height:1.6;">✔️ ${markdownToHtml(item)}</li>`
      ).join('\n');
      parts.push(`<ul style="list-style:none;padding:0;margin:0 0 14px 0;">${items}</ul>`);
    }
  }

  // ── Sign-off ──
  parts.push(`<p style="margin:20px 0 4px 0;font-size:15px;line-height:1.6;"><strong>Catch you out there this week.</strong></p>`);
  const signoffText = draft.signoff || '— The Waves Pest Control Team';
  parts.push(`<p style="margin:0 0 0 0;font-size:15px;line-height:1.6;">${markdownToHtml(signoffText)} 🌊</p>`);

  // ── P.S. ──
  if (draft.ps) {
    parts.push(`<p style="margin:20px 0 0 0;font-size:14px;color:${COLORS.muted};line-height:1.5;"><strong>P.S.</strong> <em>${markdownToHtml(draft.ps)}</em></p>`);
  }

  // ── Share Banner ──
  parts.push(`<div style="margin:28px 0 0 0;padding:16px 20px;background:${COLORS.cardBg};border-radius:10px;text-align:center;">
<p style="margin:0 0 8px 0;font-size:13px;color:${COLORS.muted};">Know someone who'd dig this? Forward it or share the link 👇</p>
<p style="margin:0;">
<a href="https://www.facebook.com/wavespestcontrol" style="text-decoration:none;margin:0 8px;font-size:20px;">📘</a>
<a href="https://www.instagram.com/wavespestcontrol" style="text-decoration:none;margin:0 8px;font-size:20px;">📸</a>
<a href="https://www.youtube.com/@wavespestcontrol" style="text-decoration:none;margin:0 8px;font-size:20px;">▶️</a>
</p>
</div>`);

  return parts.join('\n\n');
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
  trx,
  persist = true,
}) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API not configured');
  }

  const knex = trx || db;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const month = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
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
      approvedEvents = await knex('events_raw as e')
        .leftJoin('event_sources as s', 's.id', 'e.source_id')
        .select(
          'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
          'e.venue_name', 'e.venue_address', 'e.city', 'e.event_url',
          'e.image_url', 'e.categories', 'e.is_free', 's.name as source_name',
        )
        .whereIn('e.id', safeIds)
        .whereIn('e.admin_status', ['approved', 'featured'])
        .whereNull('e.merged_into')
        .whereNotIn('e.freshness_status', ['expired', 'stale_recurring'])
        .orderByRaw('e.freshness_score DESC NULLS LAST');

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

  // 3. Call Claude API. 8192 tokens — the Beehiiv-parity schema is richer
  // (captions, scoop labels, checklists) and a 10-event lineup at 4096
  // risked mid-JSON truncation.
  const response = await anthropic.messages.create({
    model: MODELS.WORKHORSE,
    max_tokens: 8192,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  // 4. Parse JSON response
  const text = response.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return JSON');

  let rawJson = jsonMatch[0];
  // Repair common Claude JSON issues
  rawJson = rawJson.replace(/,\s*([\]}])/g, '$1');  // trailing commas
  rawJson = rawJson.replace(/[\x00-\x1F\x7F]/g, (ch) => {  // unescaped control chars
    if (ch === '\n' || ch === '\r' || ch === '\t') return ch;
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });

  let draft;
  try {
    draft = JSON.parse(rawJson);
  } catch (firstErr) {
    const logger = require('./logger');
    logger.warn(`[newsletter-draft] JSON repair: first parse failed (${firstErr.message}), retrying with Claude`);
    // Ask Claude to fix its own JSON
    const repairResponse = await anthropic.messages.create({
      model: MODELS.WORKHORSE,
      max_tokens: 4000,
      messages: [
        { role: 'user', content: `The following JSON has syntax errors. Fix ONLY the JSON syntax (trailing commas, unescaped quotes, etc) and return ONLY the valid JSON. Do not change any content.\n\n${rawJson}` },
      ],
    });
    const repairText = repairResponse.content?.[0]?.text || '';
    const repairMatch = repairText.match(/\{[\s\S]*\}/);
    if (!repairMatch) throw firstErr;
    let repairedJson = repairMatch[0].replace(/,\s*([\]}])/g, '$1');
    draft = JSON.parse(repairedJson);
  }

  // 4a. Factual lock — overwrite AI-supplied date/venue/address/URL/image
  //     with the values from events_raw, keyed by the eventId the model
  //     copied from each [eventId: ...] tag in the prompt. Events the
  //     model failed to anchor to a real eventId are dropped here so they
  //     never reach the rendered HTML.
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
    draft.events = locked;
  }

  // 4a.5 Strip stray URLs from the free-prose fields (intro / homeowner minute /
  //      closing / etc). Per-event commentary is already sanitized inside
  //      lockEventFactsFromDb; this extends the same defense to the prose the
  //      model authors outside the events array.
  sanitizeProseFields(draft);

  // 4b. Generate hero image (runs in parallel with nothing — fire and await)
  if ((draft.events?.length || isPestInsider) && !draft.heroImageUrl) {
    draft.heroImageUrl = await generateHeroImage(draft.selectedSubject || draft.subjectVariants?.[0] || 'Fresh This Week');
  }

  // 4c. Assemble Beehiiv-quality HTML from structured data + Giphy GIFs
  if (isPestInsider) {
    sanitizePestInsiderDraft(draft);
    draft.htmlBody = await assemblePestInsiderNewsletter(draft);
  } else if (draft.events?.length) {
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

  if (!draft.textBody && draft.htmlBody) {
    draft.textBody = draft.htmlBody.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
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
    const claimErrors = findHallucinatedClaims(
      [draft.htmlBody, draft.textBody].filter(Boolean).join('\n'),
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

  // 6. Generate slug
  const slug = generateSlug(draft.subject);

  // 7. Insert newsletter_sends row
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

  // 8. Return { send, draft }
  return { send, draft };
}

module.exports = {
  createNewsletterDraft,
  lockEventFactsFromDb,
  // Exported for unit testing the injection/prose defenses
  escapeHtml,
  safeUrl,
  markdownToHtml,
  sanitizeProseFields,
  assembleBeehiivNewsletter,
  // Exported for unit testing the Beehiiv-parity render devices
  clockEmojiFor,
  displayCity,
  formatLockedLocation,
  linkifyFirst,
  // Pest Insider (monthly humor-sandwich) pieces
  buildPestInsiderSystemPrompt,
  sanitizePestInsiderDraft,
  assemblePestInsiderNewsletter,
  PEST_INSIDER_ROTATION,
};
