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
 * Copied from the flagship flow in admin-newsletter.js.
 */
function formatEventBlock(events) {
  if (!events || events.length === 0) return '';
  return '\n\nAPPROVED EVENTS (use ONLY these — do not invent events):\n' +
    events.map((ev, i) => {
      const parts = [`${i + 1}. ${ev.title}`];
      if (ev.city) parts.push(`   City: ${ev.city}`);
      if (ev.start_at) parts.push(`   Date: ${new Date(ev.start_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' })}`);
      if (ev.start_at) parts.push(`   Time: ${new Date(ev.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}`);
      if (ev.venue_name) parts.push(`   Venue: ${ev.venue_name}`);
      if (ev.venue_address) parts.push(`   Address: ${ev.venue_address}`);
      if (ev.event_url) parts.push(`   URL: ${ev.event_url}`);
      if (ev.source_name) parts.push(`   Source: ${ev.source_name}`);
      if (ev.description) parts.push(`   Details: ${ev.description.slice(0, 200)}`);
      return parts.join('\n');
    }).join('\n\n');
}

/**
 * Build the flagship system prompt. Copied verbatim from the /draft-ai
 * handler so this module is self-contained.
 */
function buildFlagshipSystemPrompt(voice, month) {
  return `You write the Waves weekly local events newsletter — "Fresh This Week from North Port to Tampa."

This is NOT a corporate pest control email. It is a punchy, local, FOMO-driven weekend guide from North Port to Tampa, written like a friend texting "yo, here's what's actually worth doing."

The newsletter leads with local events. Waves pest/lawn/homeowner content appears only as a short useful sidebar (Homeowner Minute) and a soft CTA at the end.

CURRENT MONTH: ${month}

SWFL SEASONAL CONTEXT (pick what's relevant):
- Local events & seasonal rhythms by month:
  • Jan–Feb: snowbird season peak, cooler mornings, dry lawns, red tide drift
  • Mar: spring break traffic, love bugs starting, citrus bloom
  • Apr: Bradenton Blues Festival week, baseball spring training tail, lawn pre-emergents
  • May: DeSoto Heritage Festival & Grand Parade (Bradenton), mosquito season ramp, no-see-um peak at dawn/dusk
  • Jun: hurricane season begins (Jun 1), afternoon thunderstorms daily, nitrogen blackout begins on lawns (Jun–Sept by county ordinance)
  • Jul: 4th of July on the waterfront, peak rainy season, German roach pressure, palmetto bugs indoors
  • Aug: back-to-school in Manatee/Sarasota schools, peak hurricane risk month, chinch bug damage on St. Augustine
  • Sep: hurricane peak, Siesta Key Crystal Classic (sand sculpture), subterranean termite swarms after storms
  • Oct: snowbirds return, cooler nights, rodent season begins (mice seeking warmth), Halloween on the barrier islands
  • Nov: Sarasota Season of Sculpture, turkey trots, last major hurricane risk tapers, winter annuals go in
  • Dec: holidays, boat parades (Downtown Bradenton Riverwalk, Venice), cooler weather drives indoor pest activity
- SWFL pests by season: subterranean termites (swarm after rain), German cockroaches, palmetto bugs, no-see-ums, salt-marsh mosquitoes, fire ants, chinch bugs on St. Augustine, sod webworms

VOICE:
- Irreverent but not mean
- Energetic but not chaotic
- Specific to this week's events
- Conversational, like a local friend
- Short, scannable, and useful
- Never corporate
- Owner-operator energy: "we", "our team", first names welcome

SUBJECT LINES:
- Punchy, max ${voice.subjectLineRules.maxLength} chars
- FOMO-driven, specific to this week's event mix
- Can be playful, emoji-led, or slightly ridiculous when appropriate
- Never generic ("Monthly Newsletter", "Weekly Update")
- Good examples: ${voice.subjectLineRules.examples.map(e => `"${e}"`).join(', ')}

EVENT BLURBS:
- Include city, date/day, venue/location when provided
- Explain in one sentence why it is worth going
- Do NOT invent events — use only the approved event records provided
- Do NOT change dates, times, prices, venues, or URLs from the approved records
- Do NOT include stale recurring events unless explicitly marked as fresh

HOMEOWNER MINUTE:
- One useful seasonal tip (pest, lawn, or home prep)
- Max ~90 words
- Genuinely useful, not salesy
- No scare tactics, no hard pitch
- Must stand on its own without selling Waves

SIGN-OFF: Must end with "${voice.signoff}"

NEVER WRITE:
${voice.bannedCorporatePhrases.map(p => `- "${p}"`).join('\n')}

FORMAT: HTML body only (no <html>/<head>/<body> wrapper, no unsubscribe footer).
Use <h2> for section headers, <p> for paragraphs, <strong> for emphasis, <ul><li> for lists.

REQUIRED SECTIONS (produce all of these):
1. local_intro — 1-2 sentence casual hook for the week
2. fresh_this_week — 4-6 top event picks (one-time, annual, opening weekends)
3. just_starting — 1-2 new recurring series or seasonal launches
4. weekend_picks — 2-3 Friday–Sunday highlights (can overlap with fresh_this_week)
5. family_or_low_key_pick — one family-friendly or low-effort option
6. road_trip_pick — one event worth the drive from outside the reader's immediate zone
7. homeowner_minute — short seasonal tip from Waves
8. waves_cta — soft call to action (book, call, reply)

Return STRICT JSON with these keys:
{
  "subjectVariants": ["string", "string", "string"],
  "selectedSubject": "string (your best pick from subjectVariants)",
  "previewText": "string, 50-110 chars, complements subject without repeating",
  "sections": {
    "local_intro": "HTML string",
    "fresh_this_week": "HTML string",
    "just_starting": "HTML string",
    "weekend_picks": "HTML string",
    "family_or_low_key_pick": "HTML string",
    "road_trip_pick": "HTML string",
    "homeowner_minute": "HTML string",
    "waves_cta": "HTML string"
  },
  "htmlBody": "string — all sections assembled into one HTML body",
  "textBody": "string — plain-text version of the same content"
}
No prose outside the JSON.`;
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
}) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API not configured');
  }

  const knex = trx || db;
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const month = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
  const typeConfig = getNewsletterType(newsletterType);
  const voice = getVoiceProfile(typeConfig.voiceProfile);

  // 1. Fetch events from events_raw by IDs (if provided)
  let eventBlock = '';
  const MAX_EVENT_IDS = 12;
  if (Array.isArray(eventIds) && eventIds.length > 0) {
    const safeIds = eventIds.slice(0, MAX_EVENT_IDS).filter(
      (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    );
    if (safeIds.length > 0) {
      const events = await knex('events_raw as e')
        .leftJoin('event_sources as s', 's.id', 'e.source_id')
        .select(
          'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
          'e.venue_name', 'e.venue_address', 'e.city', 'e.event_url',
          'e.categories', 's.name as source_name',
        )
        .whereIn('e.id', safeIds)
        .orderByRaw('e.freshness_score DESC NULLS LAST');

      eventBlock = formatEventBlock(events);
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
    max_tokens: 3000,
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

  // 4b. Assemble htmlBody from sections if missing (JSON repair may lose it)
  if (!draft.htmlBody && draft.sections) {
    const sectionOrder = [
      'local_intro', 'fresh_this_week', 'just_starting', 'weekend_picks',
      'family_or_low_key_pick', 'road_trip_pick', 'homeowner_minute', 'waves_cta',
    ];
    const sectionLabels = {
      fresh_this_week: 'Fresh This Week',
      just_starting: 'Just Starting',
      weekend_picks: 'Weekend Picks',
      family_or_low_key_pick: 'Family / Low-Key Pick',
      road_trip_pick: 'Road Trip Pick',
      homeowner_minute: 'Homeowner Minute',
      waves_cta: '',
    };
    const NAVY = '#1B2C5B';
    const BLUE = '#009CDE';
    const RULE = '#E8E0D4';
    const styledH2 = (title) =>
      `<h2 style="font-family:Inter,Arial,sans-serif;font-size:18px;font-weight:800;color:${NAVY};margin:28px 0 12px 0;padding-bottom:6px;border-bottom:2px solid ${RULE};">${title}</h2>`;

    const parts = [];
    for (const key of sectionOrder) {
      let html = draft.sections[key];
      if (!html) continue;

      // Strip Claude's raw h2 tags (we add our own styled ones)
      html = html.replace(/<h2[^>]*>[\s\S]*?<\/h2>/gi, '');
      // Style event list items
      html = html.replace(/<li>/g,
        `<li style="margin:0 0 14px 0;padding:12px 14px;background:#FAFAF8;border-radius:8px;border-left:3px solid ${BLUE};">`);
      html = html.replace(/<ul>/g, '<ul style="list-style:none;padding:0;margin:0 0 16px 0;">');
      html = html.replace(/<a\s+href=/g, `<a style="color:${BLUE};text-decoration:underline;" href=`);
      html = html.replace(/<p>/g, '<p style="margin:0 0 14px 0;">');

      if (key === 'homeowner_minute') {
        html = `<div style="margin:20px 0;padding:16px 18px;background:#F0F7FA;border-radius:10px;border-left:3px solid ${BLUE};">${html}</div>`;
      }

      const label = sectionLabels[key];
      if (label) parts.push(styledH2(label) + '\n' + html);
      else parts.push(html);
    }
    draft.htmlBody = parts.join('\n\n');
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

module.exports = { createNewsletterDraft };
