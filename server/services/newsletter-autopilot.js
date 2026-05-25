/**
 * Newsletter Autopilot — guarded auto-draft for the weekly digest.
 *
 * Called by the Thursday 7 AM ET cron in scheduler.js. Never auto-sends;
 * creates a draft in newsletter_sends for admin review + manual send.
 *
 * Flow:
 *   1. Generate a digest plan from approved events (same query pattern
 *      as POST /events/digest-plan in admin-newsletter.js)
 *   2. If fewer than 3 eligible events → skip with notification
 *   3. Draft the newsletter via Claude (flagship system prompt)
 *   4. Save as newsletter_sends row with status:'draft', created_by:null
 *   5. Notify admin that a draft is ready
 */

const db = require('../models/db');
const MODELS = require('../config/models');
const logger = require('./logger');
const { isEligibleForFreshDigest, scoreFreshEvent } = require('./event-freshness');
const { parseETDateTime, addETDays, etDateString, etParts } = require('../utils/datetime-et');
const { getVoiceProfile } = require('../config/voice-profiles');
const { isFlagshipType, getNewsletterType } = require('../config/newsletter-types');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const NEWSLETTER_TYPE = 'local-weekly-fresh-events';
const MIN_ELIGIBLE_EVENTS = 3;

function generateSlug(subject) {
  const base = (subject || 'newsletter')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  const date = etDateString();
  const suffix = require('crypto').randomUUID().slice(0, 6);
  return `${base}-${date}-${suffix}`;
}

/**
 * Build the digest plan — same query as POST /events/digest-plan
 * in admin-newsletter.js, but without the HTTP layer.
 */
async function buildDigestPlan() {
  const now = new Date();
  const nowET = etParts(now);
  const dayOfWeek = nowET.dayOfWeek;
  const daysUntilThursday = dayOfWeek <= 4
    ? (4 - dayOfWeek + 7) % 7  // This week's Thursday (or today if Thursday)
    : -(dayOfWeek - 4);         // Go back to last Thursday (late rerun)
  const defaultStart = addETDays(now, daysUntilThursday);
  const startDate = parseETDateTime(`${etDateString(defaultStart)}T00:00:00`);
  const endDate = parseETDateTime(`${etDateString(addETDays(startDate, 6))}T23:59:59`);

  const rows = await db('events_raw as e')
    .leftJoin('event_sources as s', 's.id', 'e.source_id')
    .select(
      'e.id', 'e.title', 'e.description', 'e.start_at', 'e.end_at',
      'e.venue_name', 'e.venue_address', 'e.city', 'e.event_url',
      'e.event_type', 'e.freshness_status', 'e.freshness_score',
      'e.admin_status', 'e.times_featured',
      'e.region_zone', 'e.family_friendly', 'e.is_free',
      's.name as source_name', 's.priority_tier as source_priority_tier',
    )
    .whereIn('e.admin_status', ['approved', 'featured'])
    .where('e.start_at', '>=', startDate)
    .where('e.start_at', '<=', endDate)
    .whereNotNull('e.event_url')
    .whereNotIn('e.freshness_status', ['expired', 'stale_recurring'])
    .orderByRaw('e.freshness_score DESC NULLS LAST');

  const eligible = rows.filter((r) => isEligibleForFreshDigest(r));
  const scored = eligible
    .map((r) => ({ ...r, compositeScore: scoreFreshEvent(r) }))
    .sort((a, b) => b.compositeScore - a.compositeScore);

  return { rows, eligible, scored, startDate, endDate };
}

/**
 * Draft the newsletter via Claude using the flagship system prompt.
 * Returns the parsed JSON draft.
 */
async function draftViaClaudeAI(events) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Anthropic API not configured');
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const month = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });
  const typeConfig = getNewsletterType(NEWSLETTER_TYPE);
  const voice = getVoiceProfile(typeConfig.voiceProfile);

  // Build event block — same numbered-list format as the /draft-ai handler
  const eventBlock = events.length > 0
    ? '\n\nAPPROVED EVENTS (use ONLY these — do not invent events):\n' +
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
      }).join('\n\n')
    : '';

  const flagshipSystemPrompt = `You write the Waves weekly local events newsletter — "Fresh This Week from North Port to Tampa."

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

  const eventTitles = events.map((ev) => ev.title).join(', ');
  const userPrompt = `Fresh events this week from North Port to Tampa: ${eventTitles}. Generate the full weekly newsletter.${eventBlock}`;

  const response = await anthropic.messages.create({
    model: MODELS.WORKHORSE,
    max_tokens: 3000,
    system: flagshipSystemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude did not return JSON');

  const draft = JSON.parse(jsonMatch[0]);
  draft.subject = draft.selectedSubject || draft.subjectVariants?.[0] || '';

  return { draft, userPrompt, systemPrompt: flagshipSystemPrompt };
}

/**
 * Auto-draft the weekly flagship newsletter.
 *
 * @returns {{ skipped: boolean, reason?: string, sendId?: number, eventCount?: number }}
 */
async function autoDraftFlagship() {
  logger.info('[newsletter-autopilot] Starting weekly auto-draft');

  // 1. Build digest plan
  const plan = await buildDigestPlan();
  const { eligible, scored } = plan;

  // 2. Gate: minimum event count
  if (eligible.length < MIN_ELIGIBLE_EVENTS) {
    const reason = `Not enough approved events (${eligible.length} eligible)`;
    logger.info(`[newsletter-autopilot] Skipped: ${reason}`);

    // Notify admin about the skip
    try {
      const { triggerNotification } = require('./notification-triggers');
      await triggerNotification('newsletter_autopilot_skipped', {
        eligible: eligible.length,
        reason,
      });
    } catch (e) {
      logger.warn(`[newsletter-autopilot] skip notification failed: ${e.message}`);
    }

    return { skipped: true, reason };
  }

  // 3. Idempotency: transaction-scoped advisory lock so the dedupe check +
  //    insert are atomic. pg_advisory_xact_lock auto-releases when the
  //    transaction ends — no leak if the process crashes mid-flight.
  //    The Claude API call (~5-10s) runs inside the transaction; acceptable
  //    for a weekly cron that isn't a hot path.
  const lockKey = Math.abs(Buffer.from(plan.startDate.toISOString()).readInt32BE(0) % 2147483647);

  let row;
  let topEvents;
  let draft;
  let earlyReturn = null;

  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [lockKey]);

    const existing = await trx('newsletter_sends')
      .where({ newsletter_type: NEWSLETTER_TYPE, status: 'draft' })
      .whereNull('created_by')
      .where('created_at', '>=', plan.startDate)
      .first();

    if (existing) {
      logger.info(`[newsletter-autopilot] draft already exists for this week: ${existing.id}`);
      earlyReturn = { skipped: true, reason: `Draft already exists: ${existing.id}`, sendId: existing.id };
      return; // transaction commits → lock auto-releases
    }

    // 4. Draft via Claude (top 12 events)
    topEvents = scored.slice(0, 12);
    const { draft: aiDraft, userPrompt } = await draftViaClaudeAI(topEvents);
    draft = aiDraft;

    // 5. Save as newsletter_sends draft
    [row] = await trx('newsletter_sends').insert({
      subject: draft.subject,
      html_body: draft.htmlBody || null,
      text_body: draft.textBody || null,
      preview_text: draft.previewText || null,
      from_name: 'Waves Pest Control',
      from_email: 'newsletter@wavespestcontrol.com',
      reply_to: 'contact@wavespestcontrol.com',
      status: 'draft',
      newsletter_type: NEWSLETTER_TYPE,
      ai_prompt: userPrompt,
      slug: generateSlug(draft.subject),
      created_by: null,
    }).returning('*');
    // transaction commits → lock auto-releases
  });

  if (earlyReturn) return earlyReturn;

  logger.info(`[newsletter-autopilot] Draft created: sendId=${row.id}, events=${topEvents.length}`);

  // 6. Notify admin that a draft is ready
  try {
    const { triggerNotification } = require('./notification-triggers');
    await triggerNotification('newsletter_autopilot_draft', {
      sendId: row.id,
      subject: draft.subject,
      eventCount: topEvents.length,
    });
  } catch (e) {
    logger.warn(`[newsletter-autopilot] draft notification failed: ${e.message}`);
  }

  return { skipped: false, sendId: row.id, eventCount: topEvents.length };
}

module.exports = { autoDraftFlagship };
