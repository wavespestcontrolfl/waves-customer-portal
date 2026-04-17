const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const BlogWriter = require('../services/content/blog-writer');
const BlogAuditor = require('../services/content/blog-auditor');
// WordPressSync removed — content now publishes to wavespestcontrol.com Astro site
const logger = require('../services/logger');
const MODELS = require('../config/models');

router.use(adminAuthenticate, requireTechOrAdmin);

// =========================================================================
// BLOG POSTS — CRUD + FILTERING
// =========================================================================

// GET /api/admin/content/blog?status=queued&tag=Pest+Control&city=Bradenton&sort=publish_date
router.get('/blog', async (req, res, next) => {
  try {
    const { status, tag, city, sort = 'publish_date', order = 'asc', search, limit = 200 } = req.query;

    let query = db('blog_posts');
    if (status) query = query.where('status', status);
    if (tag) query = query.where('tag', tag);
    if (city) query = query.where('city', city);
    if (search) query = query.where(function () {
      this.where('title', 'ilike', `%${search}%`).orWhere('keyword', 'ilike', `%${search}%`);
    });

    const posts = await query.orderBy(sort, order).limit(parseInt(limit));

    // Counts by status
    const statusCounts = await db('blog_posts').select('status').count('* as count').groupBy('status');
    const counts = {};
    statusCounts.forEach(s => { counts[s.status] = parseInt(s.count); });

    res.json({ posts, counts, total: posts.length });
  } catch (err) { next(err); }
});

// ── Named blog routes (must be before /:id to avoid being shadowed) ──

// GET /api/admin/content/blog/audit
router.get('/blog/audit', async (req, res, next) => {
  try {
    const recent = await db('ai_audits')
      .where('audit_type', 'blog_content')
      .orderBy('audit_date', 'desc')
      .first();

    if (recent && (Date.now() - new Date(recent.audit_date).getTime()) < 3600000) {
      return res.json({
        audit: typeof recent.report_data === 'string' ? JSON.parse(recent.report_data) : recent.report_data,
        cached: true,
        auditDate: recent.audit_date,
      });
    }

    const audit = await BlogAuditor.runFullAudit();
    await db('ai_audits').insert({
      audit_type: 'blog_content',
      audit_date: new Date(),
      report_data: JSON.stringify(audit),
      recommendation_count: audit.recommendations?.length || 0,
      critical_issues: audit.duplicates?.length || 0,
      status: 'completed',
    });

    res.json({ audit, cached: false, auditDate: new Date() });
  } catch (err) { next(err); }
});

// GET /api/admin/content/blog/analytics
router.get('/blog/analytics', async (req, res, next) => {
  try {
    const all = await db('blog_posts');

    const byStatus = {};
    const byTag = {};
    const byCity = {};
    const bySource = {};

    for (const p of all) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      if (p.tag) byTag[p.tag] = (byTag[p.tag] || 0) + 1;
      if (p.city) byCity[p.city] = (byCity[p.city] || 0) + 1;
      bySource[p.source || 'unknown'] = (bySource[p.source || 'unknown'] || 0) + 1;
    }

    const published = all.filter(p => p.status === 'published');
    const avgSEO = published.filter(p => p.seo_score).reduce((s, p) => s + p.seo_score, 0) / (published.filter(p => p.seo_score).length || 1);
    const avgWordCount = published.filter(p => p.word_count).reduce((s, p) => s + p.word_count, 0) / (published.filter(p => p.word_count).length || 1);

    const today = new Date().toISOString().split('T')[0];
    const weekOut = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];
    const upcoming = await db('blog_posts')
      .where('publish_date', '>=', today)
      .where('publish_date', '<=', weekOut)
      .orderBy('publish_date', 'asc');

    res.json({
      total: all.length,
      byStatus,
      byTag: Object.entries(byTag).sort((a, b) => b[1] - a[1]),
      byCity: Object.entries(byCity).sort((a, b) => b[1] - a[1]),
      bySource,
      avgSEOScore: Math.round(avgSEO),
      avgWordCount: Math.round(avgWordCount),
      upcoming,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/content/blog/overlap-check
router.get('/blog/overlap-check', async (req, res, next) => {
  try {
    const queued = await db('blog_posts').where('status', 'queued');
    const published = await db('blog_posts').where('status', 'published');
    const overlaps = [];

    for (const q of queued) {
      const qkw = (q.keyword || '').toLowerCase();
      if (!qkw || qkw.length < 5) continue;
      for (const p of published) {
        const pkw = (p.keyword || '').toLowerCase();
        if (pkw && (qkw.includes(pkw) || pkw.includes(qkw))) {
          overlaps.push({
            queued: { id: q.id, title: q.title, keyword: q.keyword, city: q.city },
            existing: { id: p.id, title: p.title, keyword: p.keyword, city: p.city },
          });
        }
      }
    }

    res.json({ overlaps, count: overlaps.length });
  } catch (err) { next(err); }
});

// GET /api/admin/content/blog/:id
router.get('/blog/:id', async (req, res, next) => {
  try {
    const post = await db('blog_posts').where('id', req.params.id).first();
    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Parse optimization_suggestions if string
    if (post.optimization_suggestions && typeof post.optimization_suggestions === 'string') {
      post.optimization_suggestions = JSON.parse(post.optimization_suggestions);
    }

    res.json({ post });
  } catch (err) { next(err); }
});

// PUT /api/admin/content/blog/:id
router.put('/blog/:id', async (req, res, next) => {
  try {
    const updates = { ...req.body, updated_at: new Date() };
    if (updates.content) {
      updates.word_count = updates.content.split(/\s+/).filter(Boolean).length;
    }
    const [post] = await db('blog_posts').where('id', req.params.id).update(updates).returning('*');
    res.json({ post });
  } catch (err) { next(err); }
});

// DELETE /api/admin/content/blog/:id
router.delete('/blog/:id', async (req, res, next) => {
  try {
    await db('blog_posts').where('id', req.params.id).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// CONTENT GENERATION
// =========================================================================

// POST /api/admin/content/blog/:id/generate — generate AI content for a post
router.post('/blog/:id/generate', async (req, res, next) => {
  try {
    const result = await BlogWriter.generatePost(req.params.id);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/content/blog/:id/optimize — generate optimization suggestions
router.post('/blog/:id/optimize', async (req, res, next) => {
  try {
    const result = await BlogWriter.optimizeExistingPost(req.params.id);
    res.json({ optimization: result });
  } catch (err) { next(err); }
});

// POST /api/admin/content/blog/bulk-generate — generate content for next N posts
router.post('/blog/bulk-generate', async (req, res, next) => {
  try {
    const count = parseInt(req.body.count || 5);
    const posts = await db('blog_posts')
      .where('status', 'queued')
      .whereNull('content')
      .orderBy('publish_date', 'asc')
      .limit(count);

    const results = [];
    for (const post of posts) {
      try {
        const result = await BlogWriter.generatePost(post.id);
        results.push({ id: post.id, title: post.title, wordCount: result.wordCount, success: true });
      } catch (err) {
        results.push({ id: post.id, title: post.title, error: err.message, success: false });
      }
    }

    res.json({ results, generated: results.filter(r => r.success).length });
  } catch (err) { next(err); }
});

// POST /api/admin/content/blog/ideas — generate new ideas
router.post('/blog/ideas', async (req, res, next) => {
  try {
    const ideas = await BlogWriter.generateNewIdeas(parseInt(req.body.count || 20));
    res.json({ ideas, count: ideas.length });
  } catch (err) { next(err); }
});

// =========================================================================
// PUBLISH TO SITE
// =========================================================================

// POST /api/admin/content/blog/:id/publish — publish to wavespestcontrol.com
router.post('/blog/:id/publish', async (req, res, next) => {
  try {
    const post = await db('blog_posts').where('id', req.params.id).first();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    await db('blog_posts').where('id', req.params.id).update({ status: 'published', publish_date: new Date() });
    res.json({ success: true, link: `https://www.wavespestcontrol.com/${post.slug}` });
  } catch (err) { next(err); }
});

// POST /api/admin/content/blog/:id/share-social — share published post to all social platforms
router.post('/blog/:id/share-social', async (req, res, next) => {
  try {
    const post = await db('blog_posts').where({ id: req.params.id }).first();
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const link = post.url || `https://www.wavespestcontrol.com/${post.slug}`;
    const title = post.title;
    const description = post.meta_description || (post.content || '').replace(/[#*_\[\]]/g, '').substring(0, 300);

    const SocialMediaService = require('../services/social-media');
    const result = await SocialMediaService.publishToAll({
      title, description, link,
      guid: `blog_${post.id}`,
      source: 'blog',
    });

    // Mark post as shared
    try {
      await db('blog_posts').where({ id: post.id }).update({ shared_to_social: true, shared_at: new Date() });
    } catch { /* column may not exist */ }

    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// HYPER-LOCAL CONTENT GENERATION
// =========================================================================

// GET /api/admin/content/weather — FAWN weather snapshot + active signals
router.get('/weather', async (req, res, next) => {
  try {
    // Attempt to pull live FAWN data (Florida Automated Weather Network)
    let weather = {};
    try {
      const fawnRes = await fetch('https://fawn.ifas.ufl.edu/controller.php/lastObservation/summary/');
      if (fawnRes.ok) {
        const fawnData = await fawnRes.json();
        // Find Manatee or Sarasota County station
        const station = (fawnData || []).find(s =>
          (s.StationName || '').toLowerCase().includes('manatee') ||
          (s.StationName || '').toLowerCase().includes('sarasota') ||
          (s.StationName || '').toLowerCase().includes('myakka')
        ) || fawnData?.[0];
        if (station) {
          weather = {
            temp: station.AirTemp_Avg || station.t2m_avg,
            humidity: station.RelHum_Avg || station.rh_avg,
            rainfall: station.Rain_Tot || station.rain_sum,
            soilTemp: station.SoilTemp4_Avg || station.ts4_avg,
            station: station.StationName || 'FAWN SWFL',
            timestamp: new Date().toISOString(),
          };
        }
      }
    } catch { /* FAWN unavailable — return defaults */ }

    // Active content signals based on date/season
    const month = new Date().getMonth();
    const signals = [];
    if (month >= 3 && month <= 9) signals.push('Mosquito season active — high search volume');
    if (month >= 4 && month <= 8) signals.push('Chinch bug pressure peak in SWFL');
    if (month >= 5 && month <= 8) signals.push('Nitrogen blackout in effect (Sarasota + Manatee counties)');
    if (month >= 2 && month <= 4) signals.push('Termite swarm season — swarmer reports trending');
    if (month >= 5 && month <= 9) signals.push('Afternoon thunderstorms — reschedule content relevant');
    if (month >= 0 && month <= 2) signals.push('Pre-emergent window — lawn content peak');
    if (month >= 9 && month <= 11) signals.push('Rodent season ramping — attic entry point content');

    res.json({ weather, signals });
  } catch (err) { next(err); }
});

// POST /api/admin/content/generate — hyper-local content generation
router.post('/generate', async (req, res, next) => {
  try {
    const { topic, contentType = 'blog_post', targetCity = 'Lakewood Ranch' } = req.body;
    if (!topic) return res.status(400).json({ error: 'Topic is required' });

    // Get voice config
    const voice = await db('blog_voice_config').where('active', true).first();
    const voiceDesc = voice?.voice_description || '';
    const sampleTitles = (typeof voice?.sample_titles === 'string' ? JSON.parse(voice.sample_titles) : voice?.sample_titles) || [];

    // Pull weather data for the prompt
    let weatherContext = '';
    try {
      const fawnRes = await fetch('https://fawn.ifas.ufl.edu/controller.php/lastObservation/summary/');
      if (fawnRes.ok) {
        const fawnData = await fawnRes.json();
        const station = (fawnData || []).find(s =>
          (s.StationName || '').toLowerCase().includes('manatee') ||
          (s.StationName || '').toLowerCase().includes('myakka')
        );
        if (station) {
          weatherContext = `Current FAWN data (${station.StationName}): Air temp ${station.AirTemp_Avg || '?'}F, Humidity ${station.RelHum_Avg || '?'}%, Soil temp ${station.SoilTemp4_Avg || '?'}F, Rain ${station.Rain_Tot || '?'}". Timestamp: ${new Date().toISOString()}`;
        }
      }
    } catch { weatherContext = 'FAWN data unavailable — use seasonal SWFL defaults.'; }

    // Content type parameters
    const typeConfig = {
      blog_post: { wordRange: '800–1200', format: 'H2 subheadings every 200–300 words, short paragraphs, 1–2 pro tip callouts, FAQ section with 3 questions at the end using schema-ready format' },
      pest_pressure: { wordRange: '400–600', format: 'This week format: conditions → active pests → what homeowners should do → when to call. Include FAWN data timestamp.' },
      gbp_post: { wordRange: '150–300', format: 'Google Business Profile post format: hook line, 2–3 short paragraphs, soft CTA. No headers.' },
      service_page: { wordRange: '1500–2000', format: 'Comprehensive landing page: hero section, problem/solution, process steps, FAQ (5+ questions), service area mention, trust signals, CTA sections.' },
    };
    const config = typeConfig[contentType] || typeConfig.blog_post;

    // Check for existing content overlap
    const existing = await db('blog_posts')
      .where('status', 'published')
      .where(function () {
        const words = topic.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 3);
        for (const w of words) {
          this.orWhere('title', 'ilike', `%${w}%`);
        }
      })
      .select('title', 'city')
      .limit(5);

    const overlapNote = existing.length > 0
      ? `\n\nEXISTING CONTENT (differentiate from these):\n${existing.map(e => `- "${e.title}" (${e.city})`).join('\n')}`
      : '';

    // Generate via Claude if available, otherwise return a structured outline
    let content, title, metaDesc, keyword;

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const response = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 4000,
        system: `You write hyper-local pest control and lawn care content for Waves Pest Control in Southwest Florida.

VOICE: ${voiceDesc}

SAMPLE TITLES FOR TONE:
${sampleTitles.slice(0, 5).map(t => `• "${t}"`).join('\n')}

REQUIREMENTS FOR EVERY ARTICLE:
1. Include timestamped FAWN weather data from the station provided
2. Cite at least one UF/IFAS source with EDIS publication ID (e.g., ENY-2006, SS-AGR-417)
3. Reference a specific neighborhood or landmark in ${targetCity}
4. Include a real field observation (phrase it as "Our techs are seeing..." or "On recent inspections in ${targetCity}...")
5. If lawn/fertilizer related, mention county fertilizer ordinance compliance
6. End with a WaveGuard CTA tied to the specific problem discussed

FORMAT: ${config.wordRange} words. ${config.format}
CITY: ${targetCity} — mention it by name multiple times, reference local conditions.`,
        messages: [{
          role: 'user',
          content: `Write a ${contentType.replace(/_/g, ' ')} about: ${topic}

Target city: ${targetCity}

FAWN WEATHER: ${weatherContext || 'Use seasonal SWFL defaults for current month.'}
${overlapNote}

Return the content in markdown. Before the content, on the first 3 lines provide:
TITLE: [the article title]
META: [meta description, max 160 chars]
KEYWORD: [primary SEO keyword]

Then a blank line, then the full content.`
        }]
      });

      const raw = response.content[0].text;

      // Parse title/meta/keyword from the header
      const titleMatch = raw.match(/^TITLE:\s*(.+)/m);
      const metaMatch = raw.match(/^META:\s*(.+)/m);
      const kwMatch = raw.match(/^KEYWORD:\s*(.+)/m);

      title = titleMatch?.[1]?.trim() || topic;
      metaDesc = metaMatch?.[1]?.trim() || '';
      keyword = kwMatch?.[1]?.trim() || '';
      content = raw.replace(/^TITLE:.*\n?/m, '').replace(/^META:.*\n?/m, '').replace(/^KEYWORD:.*\n?/m, '').trim();
    } catch (aiErr) {
      // Fallback — create the post record without generated content
      title = topic;
      metaDesc = '';
      keyword = '';
      content = null;
      logger.warn(`Content generation AI unavailable: ${aiErr.message}`);
    }

    // Auto-detect tag from content
    const TAG_RULES = [
      { tag: 'Lawn Pests', patterns: ['chinch bug', 'grub', 'sod webworm', 'mole cricket', 'armyworm', 'lawn pest'] },
      { tag: 'Lawn Care', patterns: ['lawn care', 'fertiliz', 'mowing', 'irrigation', 'turf', 'grass', 'aeration', 'weed control', 'herbicide', 'st. augustine', 'sod'] },
      { tag: 'Termites', patterns: ['termite', 'wdo', 'wood-destroying', 'subterranean', 'drywood'] },
      { tag: 'Mosquitoes', patterns: ['mosquito'] },
      { tag: 'Rodents', patterns: ['rodent', 'rat', 'mouse', 'mice'] },
      { tag: 'Ants', patterns: ['ant ', 'ants', 'fire ant', 'carpenter ant', 'ghost ant'] },
      { tag: 'Cockroaches', patterns: ['cockroach', 'roach'] },
      { tag: 'Bed Bugs', patterns: ['bed bug', 'bedbug'] },
      { tag: 'Spiders', patterns: ['spider', 'arachnid', 'brown recluse', 'black widow'] },
      { tag: 'Fleas', patterns: ['flea', 'tick'] },
      { tag: 'Flying Insects', patterns: ['fly ', 'flies', 'wasp', 'bee ', 'hornet', 'yellow jacket', 'flying insect'] },
      { tag: 'Insects', patterns: ['insect', 'bug'] },
      { tag: 'Pest Control', patterns: ['pest control', 'exterminator', 'pest management', 'ipm'] },
    ];

    const combined = `${title} ${keyword} ${topic} ${(content || '').substring(0, 500)}`.toLowerCase();
    let autoTag = null;
    for (const rule of TAG_RULES) {
      if (rule.patterns.some(p => combined.includes(p))) {
        autoTag = rule.tag;
        break;
      }
    }
    if (!autoTag && contentType === 'pest_pressure') autoTag = 'Pest Control';

    // Generate featured image via Gemini
    let featuredImageUrl = null;
    if (process.env.GEMINI_API_KEY && content) {
      try {
        const imgPrompt = `Create a high-quality, photorealistic hero image for a pest control blog article.
Title: "${title}"
Topic: ${keyword || topic}
Style: Bright, professional, clean. Southwest Florida setting (palm trees, tropical landscaping, sunny).
DO NOT include any text, words, or watermarks in the image.
The image should feel like a professional stock photo suitable for a blog featured image.
Landscape orientation, 1200x630px aspect ratio.`;

        const imgRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: imgPrompt }] }],
              generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
            }),
          }
        );
        if (imgRes.ok) {
          const imgData = await imgRes.json();
          const imagePart = imgData.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
          if (imagePart?.inlineData) {
            featuredImageUrl = `data:${imagePart.inlineData.mimeType || 'image/png'};base64,${imagePart.inlineData.data}`;
            logger.info(`[content] Generated featured image for "${title}"`);
          }
        }
      } catch (imgErr) {
        logger.warn(`[content] Featured image generation failed: ${imgErr.message}`);
      }
    }

    // Create the blog post record
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 80);
    const wordCount = content ? content.split(/\s+/).filter(Boolean).length : 0;

    const insertData = {
      title,
      keyword,
      meta_description: metaDesc,
      slug,
      city: targetCity,
      tag: autoTag,
      status: content ? 'draft' : 'queued',
      content,
      word_count: wordCount,
      source: 'ai_generated',
    };
    if (featuredImageUrl) insertData.featured_image_url = featuredImageUrl;

    let post;
    try {
      [post] = await db('blog_posts').insert(insertData).returning('*');
    } catch (insErr) {
      // featured_image_url column may not exist
      delete insertData.featured_image_url;
      [post] = await db('blog_posts').insert(insertData).returning('*');
    }

    res.json({ post, wordCount, contentType, hasContent: !!content, tag: autoTag, hasImage: !!featuredImageUrl });
  } catch (err) { next(err); }
});

// =========================================================================
// CONTENT CALENDAR + SCHEDULING
// =========================================================================

const ContentScheduler = require('../services/content-scheduler');

// GET /api/admin/content/calendar?start=2026-04-01&end=2026-04-30
router.get('/calendar', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end query params required' });
    const calendar = await ContentScheduler.getCalendar(start, end);
    res.json({ calendar, count: calendar.length });
  } catch (err) { next(err); }
});

// POST /api/admin/content/schedule-blog/:id — schedule a blog post for auto-publish
router.post('/schedule-blog/:id', async (req, res, next) => {
  try {
    const { publishAt, autoShareSocial } = req.body;
    if (!publishAt) return res.status(400).json({ error: 'publishAt is required' });
    const post = await ContentScheduler.scheduleBlogPost(req.params.id, publishAt, autoShareSocial !== false);
    res.json({ success: true, post });
  } catch (err) { next(err); }
});

// POST /api/admin/content/schedule-social — schedule a new social media post
router.post('/schedule-social', async (req, res, next) => {
  try {
    const { title, description, link, platforms, scheduledFor, customContent } = req.body;
    if (!title || !scheduledFor) return res.status(400).json({ error: 'title and scheduledFor are required' });
    const post = await ContentScheduler.scheduleSocialPost({ title, description, link, platforms, scheduledFor, customContent });
    res.json({ success: true, post });
  } catch (err) { next(err); }
});

// DELETE /api/admin/content/schedule/:id — unschedule a post (blog or social)
router.delete('/schedule/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Try blog first
    const blog = await db('blog_posts').where('id', id).first();
    if (blog) {
      await db('blog_posts').where('id', id).update({
        scheduled_publish_at: null,
        publish_status: null,
        updated_at: new Date(),
      });
      return res.json({ success: true, type: 'blog', id });
    }

    // Try social
    const social = await db('social_media_posts').where('id', id).first();
    if (social) {
      await db('social_media_posts').where('id', id).update({
        scheduled_for: null,
        publish_status: null,
        status: 'draft',
      });
      return res.json({ success: true, type: 'social', id });
    }

    return res.status(404).json({ error: 'Post not found' });
  } catch (err) { next(err); }
});

// =========================================================================
// CONTENT AGENT — Managed Agent autonomous content production
// =========================================================================

// POST /api/admin/content/agent/run — run the content agent for a single topic
router.post('/agent/run', async (req, res, next) => {
  try {
    const ContentAgent = require('../services/content/content-agent');
    const { topic, city, angle, publishDraft, distributeSocial } = req.body;

    if (!topic) return res.status(400).json({ error: 'topic is required' });

    // Run async — return immediately with session tracking
    const runPromise = ContentAgent.run({
      topic,
      city: city || null,
      angle: angle || null,
      publishDraft: publishDraft !== false,
      distributeSocial: distributeSocial !== false,
    });

    // If the client wants to wait for completion (long-running)
    if (req.query.wait === 'true') {
      const result = await runPromise;
      return res.json(result);
    }

    // Otherwise fire-and-forget, return immediately
    runPromise
      .then(result => logger.info(`[content-agent] Completed: "${result.title}" (${result.durationSeconds}s)`))
      .catch(err => logger.error(`[content-agent] Failed: ${err.message}`));

    res.json({
      status: 'started',
      topic,
      city,
      message: 'Content agent is running. Check /api/admin/content/agent/runs for results.',
    });
  } catch (err) { next(err); }
});

// POST /api/admin/content/agent/batch — run the content agent for multiple topics
router.post('/agent/batch', async (req, res, next) => {
  try {
    const ContentAgent = require('../services/content/content-agent');
    const { topics, publishDraft, distributeSocial } = req.body;

    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      return res.status(400).json({ error: 'topics array is required' });
    }

    if (topics.length > 10) {
      return res.status(400).json({ error: 'Max 10 topics per batch' });
    }

    // Fire-and-forget
    const batchPromise = ContentAgent.runBatch(topics, {
      publishDraft: publishDraft !== false,
      distributeSocial: distributeSocial !== false,
    });

    batchPromise
      .then(results => {
        const success = results.filter(r => r.success).length;
        logger.info(`[content-agent] Batch complete: ${success}/${results.length} succeeded`);
      })
      .catch(err => logger.error(`[content-agent] Batch failed: ${err.message}`));

    res.json({
      status: 'started',
      count: topics.length,
      message: 'Content agent batch running. Check /api/admin/content/agent/runs for results.',
    });
  } catch (err) { next(err); }
});

// GET /api/admin/content/agent/runs — get content agent run history
router.get('/agent/runs', async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const runs = await db('content_agent_runs')
      .leftJoin('blog_posts', 'content_agent_runs.blog_post_id', 'blog_posts.id')
      .select(
        'content_agent_runs.*',
        'blog_posts.title as post_title',
        'blog_posts.url',
        'blog_posts.status as post_status'
      )
      .orderBy('content_agent_runs.created_at', 'desc')
      .limit(parseInt(limit));

    res.json({
      runs: runs.map(r => ({
        id: r.id,
        sessionId: r.session_id,
        topic: r.topic,
        city: r.city,
        status: r.status,
        title: r.post_title,
        wordCount: r.word_count,
        qaScore: r.qa_score,
        siteUrl: r.url,
        postStatus: r.post_status,
        toolsExecuted: typeof r.tools_executed === 'string' ? JSON.parse(r.tools_executed) : r.tools_executed,
        durationSeconds: r.duration_seconds,
        createdAt: r.created_at,
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
