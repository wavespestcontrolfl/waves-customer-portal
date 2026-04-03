const db = require('../../models/db');
const logger = require('../logger');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

class BlogWriter {
  async getVoiceConfig() {
    const config = await db('blog_voice_config').where('active', true).first();
    if (!config) return null;
    return {
      ...config,
      sample_titles: typeof config.sample_titles === 'string' ? JSON.parse(config.sample_titles) : config.sample_titles,
      sample_metas: typeof config.sample_metas === 'string' ? JSON.parse(config.sample_metas) : config.sample_metas,
      tone_rules: typeof config.tone_rules === 'string' ? JSON.parse(config.tone_rules) : config.tone_rules,
      swfl_knowledge: typeof config.swfl_knowledge === 'string' ? JSON.parse(config.swfl_knowledge) : config.swfl_knowledge,
    };
  }

  async generatePost(blogPostId) {
    const post = await db('blog_posts').where('id', blogPostId).first();
    if (!post) throw new Error('Post not found');

    const voice = await this.getVoiceConfig();

    // Get similar published posts for tone reference
    const similarPosts = await db('blog_posts')
      .where('tag', post.tag)
      .where('status', 'published')
      .whereNotNull('content')
      .where('word_count', '>', 200)
      .orderBy('seo_score', 'desc')
      .limit(3)
      .select('title', 'meta_description', 'content');

    // Get all titles for tone calibration
    const allTitles = await db('blog_posts')
      .whereNotNull('meta_description')
      .orderBy('seo_score', 'desc')
      .limit(30)
      .select('title', 'meta_description');

    // Check for existing published content on this topic (overlap check)
    const existingOnTopic = await db('blog_posts')
      .where('status', 'published')
      .where(function () {
        const kw = (post.keyword || '').toLowerCase();
        if (kw.length > 3) {
          this.whereRaw('LOWER(keyword) LIKE ?', [`%${kw}%`]);
        }
      })
      .select('title', 'keyword', 'city', 'slug');

    let differentiationNote = '';
    if (existingOnTopic.length > 0) {
      differentiationNote = `\n\nIMPORTANT: We already have published content on similar topics:\n${existingOnTopic.map(e => `- "${e.title}" (${e.city}) targeting "${e.keyword}"`).join('\n')}\n\nYour post MUST differentiate by:\n- Focusing specifically on ${post.city} (not the cities above)\n- Taking a different angle or subtopic\n- Covering aspects the existing posts don't\n- DO NOT repeat the same core advice — add new value`;
    }

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return { content: null, error: 'Anthropic API not configured' };
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const systemPrompt = `You write blog posts for Waves Pest Control, a pest control and lawn care company in Southwest Florida.

YOUR VOICE — study these real Waves blog titles and match the tone EXACTLY:
${(voice?.sample_titles || allTitles.map(t => t.title)).map(t => `• "${t}"`).join('\n')}

TONE RULES:
${(voice?.tone_rules || []).map(r => `- ${r}`).join('\n')}

SWFL-SPECIFIC KNOWLEDGE:
${voice?.swfl_knowledge ? Object.entries(voice.swfl_knowledge).map(([k, v]) => `- ${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n') : '- Sandy soil, afternoon thunderstorms, St. Augustine grass, nitrogen blackout June-Sept'}

FORMAT:
- 800-1200 words
- H2 subheadings every 200-300 words (casual, not keyword-stuffed)
- Short paragraphs (2-4 sentences max)
- Include 1-2 "pro tip" callouts
- Include the target keyword naturally 3-5 times
- End with a practical takeaway + soft Waves mention`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: `Write the full blog post for:

Title: ${post.title}
Target keyword: ${post.keyword}
Topic tag: ${post.tag}
City: ${post.city}
Meta description: ${post.meta_description}
Slug: ${post.slug}
${differentiationNote}
${similarPosts.length > 0 ? `\nHere are similar published posts for tone reference:\n${similarPosts.map(p => `---\nTitle: ${p.title}\n${(p.content || '').substring(0, 400)}...`).join('\n')}` : ''}

Write the full post in the Waves voice. Return ONLY the blog post content (no JSON wrapper). Use markdown formatting for headers.`
      }]
    });

    const content = response.content[0].text;
    const wordCount = content.split(/\s+/).filter(Boolean).length;

    await db('blog_posts').where('id', blogPostId).update({
      content,
      word_count: wordCount,
      status: 'draft',
      updated_at: new Date(),
    });

    logger.info(`Blog post generated: "${post.title}" (${wordCount} words)`);
    return { content, wordCount };
  }

  async optimizeExistingPost(blogPostId) {
    const post = await db('blog_posts').where('id', blogPostId).first();
    if (!post) throw new Error('Post not found');

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return { error: 'Anthropic API not configured' };
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      system: 'You optimize existing blog posts for Waves Pest Control. Improve SEO without changing core content. Match the Waves voice: snarky, casual, Florida-specific, technically knowledgeable.',
      messages: [{
        role: 'user',
        content: `Optimize this published blog post. Current SEO score: ${post.seo_score || 'unknown'}/100.

TITLE: ${post.title}
KEYWORD: ${post.keyword || 'NOT SET — suggest one'}
META: ${post.meta_description || 'MISSING — write one'}
CITY: ${post.city || 'NOT SET — detect from content'}
WORD COUNT: ${post.word_count}

CONTENT (first 5000 chars):
${(post.content || '').substring(0, 5000)}

EXISTING INTERNAL LINKS: ${(post.content_html || '').match(/href="https?:\/\/wavespestcontrol\.com/g)?.length || 0}

Available internal link targets:
- wavespestcontrol.com/pest-control-bradenton-fl/
- wavespestcontrol.com/pest-control-sarasota-fl/
- wavespestcontrol.com/lawn-care/
- wavespestcontrol.com/mosquito-control/
- wavespestcontrol.com/termite-control/
- wavespestcontrol.com/rodent-control/
- wavespestcontrol.com/tree-and-shrub/

Return JSON: {
  "suggested_title": "better title in Waves voice (or null if good)",
  "suggested_keyword": "focus keyword if missing",
  "suggested_meta": "meta description under 160 chars with personality",
  "missing_internal_links": [{"anchor_text": "", "url": "", "insert_near": "context"}],
  "faq_to_add": [{"question": "", "answer": ""}],
  "seo_improvements": ["specific fix"],
  "estimated_new_score": 0
}`
      }]
    });

    let optimization;
    try {
      optimization = JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim());
    } catch {
      optimization = { raw: response.content[0].text, parse_error: true };
    }

    await db('blog_posts').where('id', blogPostId).update({
      optimization_suggestions: JSON.stringify(optimization),
      updated_at: new Date(),
    });

    return optimization;
  }

  async generateNewIdeas(count = 20) {
    const existing = await db('blog_posts').select('title', 'keyword', 'tag', 'city');

    // Find gaps
    const tagCounts = {};
    const cityCounts = {};
    for (const p of existing) {
      if (p.tag) tagCounts[p.tag] = (tagCounts[p.tag] || 0) + 1;
      if (p.city) cityCounts[p.city] = (cityCounts[p.city] || 0) + 1;
    }

    const underrepTags = Object.entries(tagCounts).filter(([, c]) => c < 8).map(([t]) => t);
    const underrepCities = Object.entries(cityCounts).filter(([, c]) => c < 19).map(([c]) => c);

    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      return [];
    }

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system: `Generate ${count} new blog post ideas for Waves Pest Control. Match the tone of these existing titles:

${existing.slice(0, 20).map(p => `• "${p.title}" [${p.tag}] [${p.city}]`).join('\n')}

RULES:
- Each idea targets a specific SWFL city (rotate across: Bradenton, Lakewood Ranch, Sarasota, Venice, North Port, Parrish, Palmetto, Port Charlotte)
- Each idea has a specific keyword with local search intent
- Prioritize underrepresented topics: ${underrepTags.join(', ')}
- Prioritize underrepresented cities: ${underrepCities.join(', ')}
- Avoid duplicating any existing title or keyword
- Titles: provocative, curiosity-driven, not generic SEO

Return JSON array: [{ "title": "", "keyword": "", "tag": "", "slug": "", "meta_description": "", "city": "" }]`,
      messages: [{
        role: 'user',
        content: `Generate ${count} new blog post ideas focusing on gaps in our content library.`
      }]
    });

    try {
      const ideas = JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim());

      for (const idea of ideas) {
        await db('blog_posts').insert({
          title: idea.title,
          keyword: idea.keyword,
          tag: idea.tag,
          slug: idea.slug,
          meta_description: idea.meta_description,
          city: idea.city,
          status: 'idea',
          source: 'ai_generated',
        });
      }

      return ideas;
    } catch {
      return [];
    }
  }
}

module.exports = new BlogWriter();
