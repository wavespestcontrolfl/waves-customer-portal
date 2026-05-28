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
- Irreverent but not mean. Energetic but not chaotic.
- Specific to this week's events. Conversational — local friend energy.
- Short, scannable, useful. Never corporate.
- Formatting: use **bold** for key facts/venue names, _italic_ for flavor/asides.
- Em-dashes and parenthetical asides add personality.

SUBJECT LINES: Punchy, max ${voice.subjectLineRules.maxLength} chars, FOMO-driven, specific to this week. Good examples: ${voice.subjectLineRules.examples.map(e => `"${e}"`).join(', ')}

NEVER WRITE: ${voice.bannedCorporatePhrases.map(p => `"${p}"`).join(', ')}

EVENT RULES:
- Use ONLY the approved event records provided. Do NOT invent events.
- For every event you include, copy its [eventId: ...] UUID into the "eventId" field exactly. The renderer uses this to re-pull date, time, venue, address, and ticket URL straight from the database — anything you write for those fields will be IGNORED.
- Do NOT mention specific dollar amounts, "free admission", "no cost", "complimentary", or any ticket-price phrasing in your commentary. We never store admission in the DB, so any pricing claim you make is unverifiable and will hard-block the send.
- Do NOT make pest-control safety or efficacy claims ("pet-safe", "child-safe", "guaranteed", "100% effective", "EPA-approved") — this is an events newsletter, not a service pitch.
- Each event gets a catchy/punny title (not just the raw event name).
- Each event gets a unique thematic emoji (no repeats between events).
- gifSearchTerm: 2-4 word Giphy search to find a mood-matching reaction GIF.
- gifCaption: 1-sentence italic quip below the GIF (humorous, specific to the event).
- description: 1-3 sentences, conversational, says WHY someone would actually go. Do NOT restate the date, venue, or URL — those render automatically.
- highlights: 3-5 bullet points of what to expect (optional — skip if event is simple). Vibe-only; no logistics.
- proTip: insider tip prefixed with "Pro tip:" (optional — only if genuinely useful, e.g. parking, what to wear). NOT pricing or ticket logistics.
- closingLine: punchy one-liner CTA to wrap the event (imperative, mix bold+italic).

HOMEOWNER MINUTE: One useful seasonal tip (pest, lawn, home prep). Max ~90 words. Genuinely useful, not salesy.

SIGN-OFF: "${voice.signoff}"

P.S. JOKE: "If you loved this, forward it to a friend who [humorous qualifier]. If you didn't... [funny punchline]." End with thematic emoji.

Return STRICT JSON (no HTML, no prose outside the JSON):
{
  "subjectVariants": ["string", "string", "string"],
  "selectedSubject": "string",
  "previewText": "string, 50-110 chars",
  "greeting": "string (e.g. 'Hey there!')",
  "introText": "string (2-4 sentences setting the week's vibe, use **bold** and _italic_)",
  "introGifTerm": "string (Giphy search for mood-setting intro GIF)",
  "transitionLine": "string (bold rallying one-liner before events, e.g. 'Let's go exploring. 👇')",
  "events": [
    {
      "eventId": "string (REQUIRED — copy the [eventId: ...] UUID from the approved event verbatim)",
      "emoji": "string (single thematic emoji)",
      "title": "string (catchy/punny, not raw event name)",
      "gifSearchTerm": "string (2-4 word Giphy search)",
      "gifCaption": "string (1-sentence italic quip)",
      "description": "string (1-3 sentences, conversational — vibe only, no logistics)",
      "highlights": ["string"] or null,
      "proTip": "string or null",
      "closingLine": "string (punchy wrap-up)"
    }
  ],
  "homeownerMinute": "string (the tip text, plain — no HTML)",
  "closingEmoji": "string",
  "closingHeading": "string (recap title)",
  "closingText": "string (1-2 paragraphs wrapping the week)",
  "signoff": "string",
  "ps": "string or null"
}`;
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
      title: `Newsletter hero banner: ${subject}. SWFL local events guide — vibrant, fun, Florida coastal energy. No text overlay.`,
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

function safeImageUrl(url) {
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
    const venue = row.venue_name || null;
    const city = row.city || null;
    const location = venue && city ? `${venue}, ${city}` : (venue || city || null);

    locked.push({
      ...ev,
      eventId: row.id,
      date,
      location,
      address: row.venue_address || null,
      eventUrl: row.event_url || null,
      imageUrl: row.image_url || null,
      // admission deliberately omitted — events_raw does not store it,
      // so any value the model produced was unverifiable. Free-vs-paid
      // is signaled by row.is_free if a future render wants to use it.
      admission: null,
    });
  });

  return { locked, dropped };
}

function gifBlock(url, caption) {
  if (!url) return '';
  let html = `<div style="text-align:center;margin:12px 0 8px 0;">
<img src="${url}" alt="" style="max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto;" />
</div>`;
  if (caption) {
    html += `\n<p style="text-align:center;margin:0 0 16px 0;font-size:14px;font-style:italic;color:${COLORS.muted};line-height:1.4;">${caption}</p>`;
  }
  return html;
}

function markdownToHtml(text) {
  if (!text) return '';
  return text
    .replace(/\*\*_([^_]+)_\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/_\*\*([^*]+)\*\*_/g, '<em><strong>$1</strong></em>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}

async function assembleBeehiivNewsletter(draft) {
  const parts = [];
  const events = draft.events || [];

  // ── Hero Image ──
  const heroUrl = safeImageUrl(draft.heroImageUrl);
  if (heroUrl) {
    parts.push(`<div style="margin:0 0 20px 0;text-align:center;">
<img src="${heroUrl}" alt="${(draft.selectedSubject || 'Fresh This Week').replace(/"/g, '&quot;')}" style="max-width:100%;height:auto;border-radius:12px;display:block;margin:0 auto;" />
</div>`);
  }

  // ── Table of Contents ──
  const tocItems = events.map(ev =>
    `<li style="margin:0 0 6px 0;"><a href="#evt-${slugify(ev.title)}" style="color:${COLORS.blue};text-decoration:none;font-weight:500;">${ev.emoji || '🎯'} ${markdownToHtml(ev.title)}</a></li>`
  );
  if (draft.homeownerMinute) {
    tocItems.push(`<li style="margin:0 0 6px 0;"><a href="#homeowner-minute" style="color:${COLORS.blue};text-decoration:none;font-weight:500;">🏠 Homeowner Minute</a></li>`);
  }
  parts.push(`<div style="margin:0 0 24px 0;padding:16px 20px;background:${COLORS.cardBg};border-radius:10px;">
<p style="margin:0 0 10px 0;font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:${COLORS.muted};font-weight:600;">In this email:</p>
<ul style="list-style:none;padding:0;margin:0;font-size:14px;line-height:2;">${tocItems.join('\n')}</ul>
</div>`);

  // ── Intro GIF ──
  const introGif = await searchGiphy(draft.introGifTerm);
  if (introGif) parts.push(gifBlock(introGif));

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
    parts.push(`<h2 id="${anchorId}" style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 8px 0;">${ev.emoji || '🎯'} <strong><em>${markdownToHtml(ev.title)}</em></strong></h2>`);

    // Event thumbnail (from events_raw.image_url) or GIF
    const thumbUrl = safeImageUrl(ev.imageUrl);
    if (thumbUrl) {
      parts.push(`<div style="text-align:center;margin:8px 0 12px 0;">
<img src="${thumbUrl}" alt="${(ev.title || '').replace(/"/g, '&quot;')}" style="max-width:100%;height:auto;border-radius:10px;display:block;margin:0 auto;" />
</div>`);
    }
    if (!thumbUrl) {
      const eventGif = await searchGiphy(ev.gifSearchTerm);
      if (eventGif) parts.push(gifBlock(eventGif, ev.gifCaption));
    }

    // Description
    if (ev.description) {
      parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${markdownToHtml(ev.description)}</p>`);
    }

    // Metadata block
    const meta = [];
    if (ev.date) meta.push(`📅 <strong>${ev.date}</strong>`);
    if (ev.location) {
      const loc = ev.address ? `${ev.location} (${ev.address})` : ev.location;
      meta.push(`📍 <em>${loc}</em>`);
    }
    if (ev.admission) meta.push(`🎟️ ${markdownToHtml(ev.admission)}`);
    if (ev.eventUrl) {
      meta.push(`🔗 <a href="${ev.eventUrl}" style="color:${COLORS.blue};text-decoration:underline;font-weight:500;">Tickets &amp; Info</a>`);
    }
    if (meta.length) {
      parts.push(`<div style="margin:0 0 14px 0;padding:12px 16px;background:${COLORS.cardBg};border-radius:8px;font-size:14px;line-height:2;">\n${meta.join('<br/>\n')}\n</div>`);
    }

    // Highlights / What to Expect
    const hl = Array.isArray(ev.highlights) ? ev.highlights : (typeof ev.highlights === 'string' ? [ev.highlights] : []);
    if (hl.length) {
      parts.push(`<p style="margin:0 0 6px 0;font-size:14px;font-weight:600;">What to expect:</p>`);
      const bullets = hl.map(h =>
        `<li style="margin:0 0 6px 0;padding-left:4px;font-size:14px;line-height:1.6;">• <em>${markdownToHtml(h)}</em></li>`
      ).join('\n');
      parts.push(`<ul style="list-style:none;padding:0;margin:0 0 14px 0;">${bullets}</ul>`);
    }

    // Pro tip
    if (ev.proTip) {
      parts.push(`<p style="margin:0 0 14px 0;font-size:14px;line-height:1.5;">🚨 <strong>Pro tip:</strong> <em>${markdownToHtml(ev.proTip)}</em></p>`);
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
      parts.push(`<h2 style="font-family:Inter,Arial,sans-serif;font-size:20px;font-weight:800;color:${COLORS.navy};margin:0 0 12px 0;">${draft.closingEmoji || '📝'} <strong><em>${markdownToHtml(draft.closingHeading)}</em></strong></h2>`);
    }
    if (draft.closingText) {
      parts.push(`<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;">${markdownToHtml(draft.closingText)}</p>`);
    }
  }

  // ── Sign-off ──
  parts.push(`<p style="margin:20px 0 4px 0;font-size:15px;line-height:1.6;"><strong>Catch you out there this week.</strong></p>`);
  const signoffText = draft.signoff || '— The Waves crew';
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
      approvedEvents = await knex('events_raw as e')
        .leftJoin('event_sources as s', 's.id', 'e.source_id')
        .select(
          'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
          'e.venue_name', 'e.venue_address', 'e.city', 'e.event_url',
          'e.image_url', 'e.categories', 's.name as source_name',
        )
        .whereIn('e.id', safeIds)
        .orderByRaw('e.freshness_score DESC NULLS LAST');

      eventBlock = formatEventBlock(approvedEvents);
    }
  }

  // 2. Build the flagship system prompt
  const systemPrompt = buildFlagshipSystemPrompt(voice, month);

  // Enrich the user prompt with homeowner minute topic if provided
  let enrichedPrompt = prompt;
  if (homeownerMinuteTopic) {
    enrichedPrompt += `\nHomeowner Minute topic: ${homeownerMinuteTopic}`;
  }

  const userPrompt = `Topic / prompt: ${enrichedPrompt}
${audience ? `Audience: ${audience}` : ''}
${tone ? `Tone: ${tone}` : ''}${eventBlock}`;

  // 3. Call Claude API
  const response = await anthropic.messages.create({
    model: MODELS.WORKHORSE,
    max_tokens: 4096,
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
    draft.events = locked;
  }

  // 4b. Generate hero image (runs in parallel with nothing — fire and await)
  if (draft.events?.length && !draft.heroImageUrl) {
    draft.heroImageUrl = await generateHeroImage(draft.selectedSubject || draft.subjectVariants?.[0] || 'Fresh This Week');
  }

  // 4c. Assemble Beehiiv-quality HTML from structured event data + Giphy GIFs
  if (draft.events?.length) {
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
  }).returning('*');

  // 8. Return { send, draft }
  return { send, draft };
}

module.exports = { createNewsletterDraft, lockEventFactsFromDb };
