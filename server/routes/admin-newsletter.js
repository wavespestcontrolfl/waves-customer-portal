/**
 * Admin newsletter routes — subscribers + campaigns.
 *
 * Mounted at /api/admin/newsletter. Feature-gated client-side via the
 * `newsletter-v1` feature flag; the routes themselves don't gate because
 * the flag existence on client is enough and Virginia/Waves are both admin.
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
    res.json({ sends: rows });
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
// Body: { prompt, audience?, tone?, includeCTA? }
router.post('/draft-ai', async (req, res) => {
  try {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'Anthropic API not configured' });
    }
    const { prompt, audience, tone, includeCTA } = req.body;
    if (!prompt || prompt.trim().length < 8) {
      return res.status(400).json({ error: 'prompt required (min 8 chars)' });
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Ground the draft in SWFL season + local community — this is a
    // neighborhood newsletter, not a generic pest-industry blast.
    const month = new Date().toLocaleString('en-US', { month: 'long', timeZone: 'America/New_York' });

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

// POST /api/admin/newsletter/import-beehiiv — pull every Beehiiv post,
// upsert into newsletter_sends so the in-portal History shows the full
// historical campaign archive (subjects, stats, content, web URL).
//
// Automation email bodies are NOT accessible via the Beehiiv API — only
// the automation list (which we already have hard-coded in
// email-automations.js). This endpoint only imports broadcast posts.
router.post('/import-beehiiv', async (req, res) => {
  try {
    if (!process.env.BEEHIIV_API_KEY || !process.env.BEEHIIV_PUB_ID) {
      return res.status(400).json({ error: 'Beehiiv not configured (BEEHIIV_API_KEY / BEEHIIV_PUB_ID missing)' });
    }

    const key = process.env.BEEHIIV_API_KEY;
    const pub = process.env.BEEHIIV_PUB_ID.trim();

    let page = 1;
    let imported = 0;
    let updated = 0;
    let skipped = 0;
    const maxPages = 20;  // safety stop

    while (page <= maxPages) {
      const url = `https://api.beehiiv.com/v2/publications/${pub}/posts?limit=50&page=${page}&expand[]=free_email_content&expand[]=stats`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      if (!r.ok) {
        const text = await r.text();
        logger.error(`[newsletter/import-beehiiv] page ${page} failed: ${r.status} ${text}`);
        return res.status(502).json({ error: `Beehiiv API ${r.status}: ${text.slice(0, 200)}` });
      }
      const body = await r.json();
      const posts = body.data || [];
      if (!posts.length) break;

      for (const p of posts) {
        const externalId = p.id;
        const existing = await db('newsletter_sends').where({ external_post_id: externalId }).first();

        // Beehiiv publish_date can be unix-seconds or ms — normalize.
        let publishMs = null;
        if (p.publish_date) {
          publishMs = typeof p.publish_date === 'number'
            ? (p.publish_date < 1e12 ? p.publish_date * 1000 : p.publish_date)
            : new Date(p.publish_date).getTime();
        }

        const emailStats = p.stats?.email || {};
        const status = p.status === 'confirmed' ? 'sent' : 'draft';

        const row = {
          subject: p.subject_line || p.title || '(no subject)',
          html_body: p.content?.free?.email || null,
          text_body: null,
          preview_text: p.preview_text || null,
          status,
          recipient_count: emailStats.recipients || 0,
          delivered_count: emailStats.delivered || 0,
          bounced_count: emailStats.spam_reports || 0,
          complained_count: emailStats.complaints || 0,
          unsubscribed_count: emailStats.unsubscribes || 0,
          opened_count: emailStats.unique_opens || emailStats.opens || 0,
          clicked_count: emailStats.unique_clicks || emailStats.clicks || 0,
          sent_at: publishMs && status === 'sent' ? new Date(publishMs) : null,
          external_post_id: externalId,
          external_source: 'beehiiv',
          external_web_url: p.web_url || null,
          updated_at: new Date(),
        };

        if (existing) {
          await db('newsletter_sends').where({ id: existing.id }).update(row);
          updated++;
        } else {
          await db('newsletter_sends').insert(row);
          imported++;
        }
      }

      if (posts.length < 50) break;  // last page
      page++;
    }

    logger.info(`[newsletter/import-beehiiv] imported=${imported} updated=${updated} skipped=${skipped}`);
    res.json({ success: true, imported, updated, skipped });
  } catch (err) {
    logger.error(`[newsletter/import-beehiiv] failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
