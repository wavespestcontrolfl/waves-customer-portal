/**
 * Admin newsletter routes — subscribers + campaigns.
 *
 * Mounted at /api/admin/newsletter. Newsletter is rolled out and
 * always-on for admins; the only gate is the standard admin auth
 * applied at router.use() below.
 *
 * See docs/design/DECISIONS.md (PR 5) for the scope.
 */

const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const sendgrid = require('../services/sendgrid-mail');
const NewsletterSender = require('../services/newsletter-sender');
const MODELS = require('../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

router.use(adminAuthenticate, requireTechOrAdmin);

// ── Subscribers ──────────────────────────────────────────────────

// GET /api/admin/newsletter/subscribers?status=active&q=search
router.get('/subscribers', async (req, res, next) => {
  try {
    const { status, q, limit = 200, offset = 0 } = req.query;
    const query = db('newsletter_subscribers').orderBy('subscribed_at', 'desc').limit(Math.min(+limit, 1000)).offset(+offset);
    if (status) query.where({ status });
    if (q) query.where('email', 'ilike', `%${q}%`);
    const rows = await query;

    const counts = await db('newsletter_subscribers')
      .select('status')
      .count('* as count')
      .groupBy('status');
    const byStatus = Object.fromEntries(counts.map((r) => [r.status, Number(r.count)]));

    res.json({ subscribers: rows, counts: byStatus, total: rows.length });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/subscribers
// Body: { email, firstName?, lastName?, source? }
router.post('/subscribers', async (req, res, next) => {
  try {
    const { email, firstName, lastName, source } = req.body;
    if (!email) return res.status(400).json({ error: 'email required' });

    const existing = await db('newsletter_subscribers').where({ email: email.toLowerCase() }).first();
    if (existing) {
      // Resubscribe path — flip status back to active.
      if (existing.status !== 'active') {
        await db('newsletter_subscribers').where({ id: existing.id }).update({
          status: 'active',
          resubscribed_at: new Date(),
          unsubscribed_at: null,
          updated_at: new Date(),
        });
      }
      return res.json({ success: true, subscriber: existing, resubscribed: existing.status !== 'active' });
    }

    const [row] = await db('newsletter_subscribers').insert({
      email: email.toLowerCase(),
      first_name: firstName || null,
      last_name: lastName || null,
      source: source || 'admin_manual',
      status: 'active',
    }).returning('*');

    res.json({ success: true, subscriber: row });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/subscribers/import
// Body: { subscribers: [{ email, firstName?, lastName? }], source? }
// Designed for a Beehiiv CSV export → POST flow.
router.post('/subscribers/import', async (req, res, next) => {
  try {
    const { subscribers, source = 'beehiiv_import' } = req.body;
    if (!Array.isArray(subscribers) || subscribers.length === 0) {
      return res.status(400).json({ error: 'subscribers[] required' });
    }

    let inserted = 0, skipped = 0;
    for (const s of subscribers) {
      const email = (s.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) { skipped++; continue; }
      const existing = await db('newsletter_subscribers').where({ email }).first();
      if (existing) { skipped++; continue; }
      await db('newsletter_subscribers').insert({
        email,
        first_name: s.firstName || s.first_name || null,
        last_name: s.lastName || s.last_name || null,
        source,
        status: 'active',
      });
      inserted++;
    }

    res.json({ success: true, inserted, skipped, total: subscribers.length });
  } catch (err) { next(err); }
});

// DELETE /api/admin/newsletter/subscribers/:id — admin unsubscribe
router.delete('/subscribers/:id', async (req, res, next) => {
  try {
    await db('newsletter_subscribers').where({ id: req.params.id }).update({
      status: 'unsubscribed',
      unsubscribed_at: new Date(),
      updated_at: new Date(),
    });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── Sends (campaigns) ────────────────────────────────────────────

// GET /api/admin/newsletter/sends
router.get('/sends', async (req, res, next) => {
  try {
    // Order by effective send date (sent_at for sent rows, otherwise created_at)
    // so Beehiiv-imported historical posts slot into chronological order
    // instead of bunching at "now" by import time.
    const rows = await db('newsletter_sends')
      .leftJoin('technicians', 'newsletter_sends.created_by', 'technicians.id')
      .select('newsletter_sends.*', 'technicians.name as created_by_name')
      .orderByRaw('COALESCE(newsletter_sends.sent_at, newsletter_sends.created_at) DESC')
      .limit(500);

    // Uncapped status breakdown so callers (e.g. the Dashboard's Scheduled
    // tile) don't have to derive counts from the 500-row payload.
    const countRows = await db('newsletter_sends')
      .select('status')
      .count('* as count')
      .groupBy('status');
    const counts = Object.fromEntries(countRows.map((r) => [r.status, Number(r.count)]));

    res.json({ sends: rows, counts });
  } catch (err) { next(err); }
});

// GET /api/admin/newsletter/sends/:id
router.get('/sends/:id', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });

    const deliveries = await db('newsletter_send_deliveries')
      .where({ send_id: req.params.id })
      .orderBy('created_at', 'desc')
      .limit(1000);

    res.json({ send, deliveries });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/sends — create a draft
router.post('/sends', async (req, res, next) => {
  try {
    const { subject, subjectB, htmlBody, textBody, previewText, fromName, fromEmail, replyTo, segmentFilter, aiPrompt } = req.body;
    if (!subject) return res.status(400).json({ error: 'subject required' });

    const [row] = await db('newsletter_sends').insert({
      subject,
      subject_b: subjectB || null,
      html_body: htmlBody || null,
      text_body: textBody || null,
      preview_text: previewText || null,
      from_name: fromName || 'Waves Pest Control',
      from_email: fromEmail || 'newsletter@wavespestcontrol.com',
      reply_to: replyTo || 'contact@wavespestcontrol.com',
      status: 'draft',
      segment_filter: segmentFilter || null,
      ai_prompt: aiPrompt || null,
      created_by: req.technicianId || null,
    }).returning('*');

    res.json({ success: true, send: row });
  } catch (err) { next(err); }
});

// PATCH /api/admin/newsletter/sends/:id — edit a draft (or a scheduled row)
router.patch('/sends/:id', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (!['draft', 'scheduled'].includes(send.status)) return res.status(400).json({ error: 'can only edit drafts or scheduled' });

    const { subject, subjectB, htmlBody, textBody, previewText, fromName, fromEmail, replyTo, segmentFilter, aiPrompt } = req.body;
    await db('newsletter_sends').where({ id: req.params.id }).update({
      subject: subject ?? send.subject,
      subject_b: subjectB !== undefined ? subjectB : send.subject_b,
      html_body: htmlBody ?? send.html_body,
      text_body: textBody ?? send.text_body,
      preview_text: previewText ?? send.preview_text,
      from_name: fromName ?? send.from_name,
      from_email: fromEmail ?? send.from_email,
      reply_to: replyTo ?? send.reply_to,
      segment_filter: segmentFilter !== undefined ? segmentFilter : send.segment_filter,
      ai_prompt: aiPrompt !== undefined ? aiPrompt : send.ai_prompt,
      updated_at: new Date(),
    });

    const updated = await db('newsletter_sends').where({ id: req.params.id }).first();
    res.json({ success: true, send: updated });
  } catch (err) { next(err); }
});

// DELETE /api/admin/newsletter/sends/:id — delete a draft
router.delete('/sends/:id', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'draft') return res.status(400).json({ error: 'can only delete drafts' });
    await db('newsletter_sends').where({ id: req.params.id }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/sends/:id/test — send preview to one email
router.post('/sends/:id/test', async (req, res) => {
  try {
    if (!sendgrid.isConfigured()) return res.status(400).json({ error: 'SendGrid not configured (SENDGRID_API_KEY missing)' });

    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });

    const testEmail = req.body.email || 'contact@wavespestcontrol.com';
    // Demo unsubscribe URL — won't resolve to a real subscriber but the link
    // renders correctly and Gmail/Apple Mail will show the native unsub UI.
    const demoUrl = sendgrid.unsubscribeUrl('test-' + send.id);
    const html = sendgrid.injectUnsubscribeFooter(send.html_body || '', { realUrl: demoUrl });

    const result = await sendgrid.sendOne({
      to: testEmail,
      fromEmail: send.from_email,
      fromName: send.from_name,
      subject: `[TEST] ${send.subject}`,
      html,
      text: send.text_body || undefined,
      replyTo: send.reply_to,
      headers: {
        'List-Unsubscribe': `<${demoUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      categories: ['newsletter_test', `send_${send.id}`],
    });

    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    logger.error(`[newsletter] test send failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/newsletter/sends/:id/send — send to all matching active subscribers
router.post('/sends/:id/send', async (req, res) => {
  try {
    const result = await NewsletterSender.sendCampaign(req.params.id);
    res.json({ success: true, sendId: req.params.id, ...result });
  } catch (err) {
    logger.error(`[newsletter] send failed: ${err.message}`, { stack: err.stack });
    try { await db('newsletter_sends').where({ id: req.params.id }).update({ status: 'failed' }); } catch { /* swallow */ }
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/newsletter/sends/:id/schedule — mark a draft as scheduled
router.post('/sends/:id/schedule', async (req, res, next) => {
  try {
    const { scheduledFor } = req.body;
    if (!scheduledFor) return res.status(400).json({ error: 'scheduledFor required (ISO timestamp)' });
    const when = new Date(scheduledFor);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'invalid scheduledFor' });
    if (when.getTime() <= Date.now()) return res.status(400).json({ error: 'scheduledFor must be in the future' });

    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'draft') return res.status(400).json({ error: 'can only schedule drafts' });
    if (!send.html_body && !send.text_body) return res.status(400).json({ error: 'body required before scheduling' });

    await db('newsletter_sends').where({ id: send.id }).update({
      status: 'scheduled',
      scheduled_for: when,
      updated_at: new Date(),
    });
    const updated = await db('newsletter_sends').where({ id: send.id }).first();
    res.json({ success: true, send: updated });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/sends/:id/cancel-schedule — return a scheduled row to draft
router.post('/sends/:id/cancel-schedule', async (req, res, next) => {
  try {
    const send = await db('newsletter_sends').where({ id: req.params.id }).first();
    if (!send) return res.status(404).json({ error: 'not found' });
    if (send.status !== 'scheduled') return res.status(400).json({ error: 'not scheduled' });
    await db('newsletter_sends').where({ id: send.id }).update({
      status: 'draft',
      scheduled_for: null,
      updated_at: new Date(),
    });
    const updated = await db('newsletter_sends').where({ id: send.id }).first();
    res.json({ success: true, send: updated });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/segment-preview — count subscribers matching a segment
router.post('/segment-preview', async (req, res, next) => {
  try {
    const count = await NewsletterSender.buildSubscriberQuery(req.body.segmentFilter || null).count('* as c').first();
    res.json({ count: Number(count?.c || 0) });
  } catch (err) { next(err); }
});

// POST /api/admin/newsletter/draft-ai — Claude drafts a newsletter
// Body: { prompt, template?, audience?, tone?, includeCTA? }
//   template: one of 'weekend' | 'pest_concern' | 'local_spotlight'
//             | 'service_promo' (or omitted for free-form). Maps to a
//             structure + voice block that's appended to the system
//             prompt — the templates themselves live in
//             client/src/pages/admin/NewsletterTabs.jsx.
router.post('/draft-ai', async (req, res) => {
  try {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'Anthropic API not configured' });
    }
    const { prompt, template, audience, tone, includeCTA } = req.body;
    if (!prompt || prompt.trim().length < 8) {
      return res.status(400).json({ error: 'prompt required (min 8 chars)' });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Ground the draft in SWFL season + local community — this is a
    // neighborhood newsletter, not a generic pest-industry blast.
    const month = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });

    // Per-template structure + voice guidance — kept in sync with the
    // TEMPLATES array in client/src/pages/admin/NewsletterTabs.jsx.
    // The client's templates seed the Compose textarea; this guidance
    // tells Claude to draft into the same structure when the operator
    // picks a template + clicks AI Draft.
    const TEMPLATE_GUIDANCE = {
      weekend: `
TEMPLATE: Weekend Lineup
- Lead with an emoji + a punchy, FOMO-friendly weekend headline (think "Your No-Lame-Plans Weekend Starts Here", not "Weekly Update").
- Open with a casual, irreverent hook (1-2 sentences).
- Body: 3-5 SWFL events. Each event uses <h2>[Event name]</h2> followed by <p><strong>[City] · [Day, time]</strong> — [one or two sentences on why it's worth going]</p>.
- Optional final section <h2>One more thing</h2> with a soft pest/lawn tie-in if it fits naturally.
- Sign off "— The Waves crew" (not "Waves Pest Control").
- Tone is neighborly + slightly irreverent; this format is the highest-engagement one historically.`,

      pest_concern: `
TEMPLATE: Pest / Lawn Concern
- Lead with an emoji + concern headline (e.g., "🦟 Mosquitoes are back across SWFL").
- <h2>Why now</h2> — 1-2 sentences on weather/season/lifecycle trigger.
- <h2>Signs to watch for</h2> — <ul><li> with 3-5 specific, visible signs.
- <h2>What to do this week</h2> — 2-3 sentences of practical homeowner advice + soft Waves mention. Don't oversell.
- Sign off "Stay ahead of it, — The Waves crew".`,

      local_spotlight: `
TEMPLATE: Local Spotlight
- Lead with an emoji + food/shop/lifestyle hook.
- Open: 1-2 sentences framing the rundown ("built from what our techs and neighbors are talking about").
- Body: 3-4 spots. Each uses <h2>[Spot name]</h2> followed by <p><strong>[Neighborhood / city]</strong> — [1-2 sentences on why to visit. Drop a vibe or a specific dish]</p>.
- Sign off with a casual closer like "Tell 'em Waves sent you. — The Waves crew".`,

      service_promo: `
TEMPLATE: Service Promo
- Lead with an emoji + a clear, direct offer headline (no clickbait — say the dollar value or % off).
- Open: 1-2 sentences naming the offer, audience, and expiration date.
- <h2>The deal</h2> — exact offer, eligibility, dollar value.
- <h2>What's included</h2> — <ul><li> 3-4 inclusions.
- <h2>How to claim</h2> — clear next step (reply, call) and expiration.
- This is a promotional template — DO end with a clear CTA regardless of the includeCTA setting.
- Sign off "— The Waves crew".`,
    };
    const templateGuidance = TEMPLATE_GUIDANCE[template] || '';

    const systemPrompt = `You draft email newsletters for Waves Pest Control, a family-owned pest control + lawn care company in Southwest Florida (SWFL). Core service area: Bradenton, Parrish, Palmetto, Sarasota, Venice, North Port, Lakewood Ranch.

EVERY NEWSLETTER IS CENTERED ON LOCAL SWFL EVENTS, SEASON, AND COMMUNITY. Do not write generic pest-industry content. Write like a neighbor who happens to run a pest control truck — someone who drives Manatee and Sarasota county roads every day and knows what's happening in town this month.

CURRENT MONTH: ${month}

ALWAYS CONSIDER (pick what's relevant to the topic):
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
- SWFL-specific conditions: sandy soil, afternoon thunderstorms, high humidity, salt air near the coast, canal-fed yards
- SWFL pests by relevance: subterranean termites (swarm after rain), German cockroaches, American/palmetto bugs, no-see-ums, salt-marsh mosquitoes, fire ants, silverfish, fleas/ticks, carpenter ants, drywood termites near the coast
- SWFL lawn: St. Augustine (Floratam, Palmetto cultivars), Bahia, chinch bugs, sod webworms, dollar weed, nitrogen blackout rules
- Community tone: Manatee/Sarasota neighbors, retirees + young families, fishing + boating + beach culture

VOICE:
- Warm, neighborly, no corporate jargon
- Owner-operator voice: "we", "our team", "our trucks", first names welcome
- Short sentences. Short paragraphs (2-4 sentences).
- Mention a specific city or landmark by name when natural (not every section)
- Anchor the newsletter in THIS month's reality — weather, events, what people are actually dealing with in their yards and homes right now

AVOID:
- Generic "pest control tips" framing
- National weather or non-FL references
- ALL CAPS, clickbait, corporate tone

FORMAT (HTML body):
- Lead with a SWFL-grounded opening line that references the current season, a local event, or a condition residents are experiencing
- 2-4 short sections, each with an <h2>
- Short paragraphs in <p> tags
- Use <ul><li> for any list
- ${includeCTA ? 'End with ONE clear call to action (book, call, reply)' : 'End with a friendly sign-off — no hard CTA'}
- Sign off from "Waves Pest Control" (or a team member if the prompt names one)
- NO unsubscribe footer (appended automatically)
- NO <html>/<head>/<body> wrapper — just the content markup
${templateGuidance ? `

WHEN A TEMPLATE IS SELECTED, FOLLOW ITS STRUCTURE + VOICE OVER THE GENERIC FORMAT ABOVE:
${templateGuidance}` : ''}

Return STRICT JSON with these keys:
{
  "subject": "string, 30-65 chars, no clickbait, no ALL CAPS — SWFL-grounded when natural",
  "previewText": "string, 50-110 chars, complements subject without repeating",
  "htmlBody": "string, the HTML body as described",
  "textBody": "string, plain-text version of the same content"
}
No prose outside the JSON.`;

    const userPrompt = `Topic / prompt: ${prompt}
${audience ? `Audience: ${audience}` : ''}
${tone ? `Tone: ${tone}` : ''}`;

    const response = await anthropic.messages.create({
      model: MODELS.WORKHORSE,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Claude did not return JSON');

    const draft = JSON.parse(jsonMatch[0]);
    res.json({ success: true, draft });
  } catch (err) {
    logger.error(`[newsletter] draft-ai failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/newsletter/events — upcoming events from events_raw,
// for the NewsletterPage Dashboard tiles. Query params:
//   days     — forward window in days (default 14, max 90)
//   limit    — max rows (default 12, max 50)
//   city     — optional city filter (matches events_raw.city case-insensitive)
//
// Sorted: dated events ascending by start_at first, then dateless
// (NULL start_at) at the bottom by pulled_at desc. Joins event_sources
// to surface the source name + the source's coverage_geo[0] as a
// fallback "region" when events_raw.city is null.
router.get('/events', async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 12));
    const city = req.query.city ? String(req.query.city).toLowerCase() : null;

    const cutoffMs = Date.now() + days * 24 * 60 * 60 * 1000;
    const cutoff = new Date(cutoffMs);

    let q = db('events_raw as e')
      .leftJoin('event_sources as s', 's.id', 'e.source_id')
      .select(
        'e.id',
        'e.title',
        'e.description',
        'e.start_at',
        'e.end_at',
        'e.venue_name',
        'e.venue_address',
        'e.city',
        'e.geo_lat',
        'e.geo_lng',
        'e.event_url',
        'e.image_url',
        'e.categories',
        'e.pulled_at',
        's.name as source_name',
        's.coverage_geo as source_coverage_geo',
      )
      // Drop events that already happened more than 2h ago (in case the
      // cron hasn't pruned them yet — same logic as ingestion's recap drop).
      .where(function () {
        this.whereNull('e.start_at').orWhere('e.start_at', '>=', new Date(Date.now() - 2 * 60 * 60 * 1000));
      })
      // Forward window cap so the dashboard never shows events 3 months out.
      .where(function () {
        this.whereNull('e.start_at').orWhere('e.start_at', '<=', cutoff);
      });

    if (city) {
      q = q.whereRaw('LOWER(e.city) = ?', [city]);
    }

    const rows = await q
      .orderByRaw('e.start_at IS NULL') // false (dated) before true (dateless)
      .orderBy('e.start_at', 'asc')
      .orderBy('e.pulled_at', 'desc')
      .limit(limit);

    const events = rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      startAt: r.start_at,
      endAt: r.end_at,
      venueName: r.venue_name,
      venueAddress: r.venue_address,
      city: r.city || (Array.isArray(r.source_coverage_geo) ? r.source_coverage_geo[0] : null),
      geoLat: r.geo_lat != null ? Number(r.geo_lat) : null,
      geoLng: r.geo_lng != null ? Number(r.geo_lng) : null,
      eventUrl: r.event_url,
      imageUrl: r.image_url,
      categories: r.categories || [],
      sourceName: r.source_name,
    }));

    res.json({ events, count: events.length, days, limit });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
