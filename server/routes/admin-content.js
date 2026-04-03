const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const BlogWriter = require('../services/content/blog-writer');
const BlogAuditor = require('../services/content/blog-auditor');
const WordPressSync = require('../services/content/wordpress-sync');
const logger = require('../services/logger');

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
// WORDPRESS
// =========================================================================

// POST /api/admin/content/blog/sync-wordpress
router.post('/blog/sync-wordpress', async (req, res, next) => {
  try {
    const result = await WordPressSync.syncAllPosts();
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/content/blog/:id/publish — publish to WordPress
router.post('/blog/:id/publish', async (req, res, next) => {
  try {
    const wpPost = await WordPressSync.publishToWordPress(req.params.id);
    res.json({ success: true, wordpressId: wpPost.id, link: wpPost.link });
  } catch (err) { next(err); }
});

// =========================================================================
// AUDIT
// =========================================================================

// GET /api/admin/content/blog/audit
router.get('/blog/audit', async (req, res, next) => {
  try {
    // Check for recent audit
    const recent = await db('ai_audits')
      .where('audit_type', 'blog_content')
      .orderBy('audit_date', 'desc')
      .first();

    if (recent && (Date.now() - new Date(recent.audit_date).getTime()) < 3600000) {
      // Return cached audit if less than 1 hour old
      return res.json({
        audit: typeof recent.report_data === 'string' ? JSON.parse(recent.report_data) : recent.report_data,
        cached: true,
        auditDate: recent.audit_date,
      });
    }

    // Run fresh audit
    const audit = await BlogAuditor.runFullAudit();

    // Store
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

// =========================================================================
// ANALYTICS
// =========================================================================

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

    // Upcoming (next 7 days)
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
        model: 'claude-sonnet-4-20250514',
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

    // Create the blog post record
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 80);
    const wordCount = content ? content.split(/\s+/).filter(Boolean).length : 0;

    const [post] = await db('blog_posts').insert({
      title,
      keyword,
      meta_description: metaDesc,
      slug,
      city: targetCity,
      tag: contentType === 'pest_pressure' ? 'Pest Control' : null,
      status: content ? 'draft' : 'queued',
      content,
      word_count: wordCount,
      source: 'ai_generated',
    }).returning('*');

    res.json({ post, wordCount, contentType, hasContent: !!content });
  } catch (err) { next(err); }
});

module.exports = router;
