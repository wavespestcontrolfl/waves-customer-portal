const db = require('../../models/db');
const logger = require('../logger');

const WP_URL = process.env.WORDPRESS_URL || 'https://wavespestcontrol.com';
const WP_USER = process.env.WORDPRESS_USER;
const WP_APP_PASSWORD = process.env.WORDPRESS_APP_PASSWORD;

const BRANDED_PATTERNS = [/waves/i, /waveguard/i];

class WordPressSync {
  getAuthHeader() {
    if (!WP_USER || !WP_APP_PASSWORD) return {};
    return { Authorization: `Basic ${Buffer.from(`${WP_USER}:${WP_APP_PASSWORD}`).toString('base64')}` };
  }

  async syncAllPosts() {
    logger.info('WordPress sync: starting...');
    let page = 1;
    let allPosts = [];

    while (true) {
      try {
        const url = `${WP_URL}/wp-json/wp/v2/posts?per_page=100&page=${page}&status=publish,draft,pending&_embed`;
        const resp = await fetch(url, { headers: this.getAuthHeader() });

        if (!resp.ok) {
          if (resp.status === 400 && page > 1) break; // past last page
          logger.warn(`WP API ${resp.status}: ${resp.statusText}`);
          break;
        }

        const posts = await resp.json();
        if (!Array.isArray(posts) || posts.length === 0) break;

        allPosts.push(...posts);
        page++;
      } catch (err) {
        logger.error(`WP fetch page ${page}: ${err.message}`);
        break;
      }
    }

    logger.info(`WordPress sync: fetched ${allPosts.length} posts`);

    let imported = 0;
    let updated = 0;

    for (const wp of allPosts) {
      try {
        const existing = await db('blog_posts').where('wordpress_post_id', wp.id.toString()).first();

        const seoKeyword = wp.meta?._yoast_wpseo_focuskw || wp.yoast_head_json?.focuskw || null;
        const seoScore = wp.meta?._yoast_wpseo_linkdex || null;
        const metaDesc = wp.meta?._yoast_wpseo_metadesc || wp.excerpt?.rendered?.replace(/<[^>]*>/g, '').trim() || null;

        const categories = wp._embedded?.['wp:term']?.[0]?.map(c => c.name) || [];
        const tags = wp._embedded?.['wp:term']?.[1]?.map(t => t.name) || [];

        const title = (wp.title?.rendered || '').replace(/&#8211;/g, '–').replace(/&#8217;/g, "'").replace(/&#8216;/g, "'").replace(/&amp;/g, '&').replace(/&#8230;/g, '…');
        const city = this.detectCity(title);

        const plainContent = (wp.content?.rendered || '').replace(/<[^>]*>/g, '');
        const wordCount = plainContent.split(/\s+/).filter(Boolean).length;

        const postData = {
          wordpress_post_id: wp.id.toString(),
          title,
          slug: wp.slug,
          keyword: seoKeyword,
          tag: categories[0] || tags[0] || null,
          meta_description: metaDesc,
          city,
          status: wp.status === 'publish' ? 'published' : 'wp_draft',
          content: plainContent.substring(0, 50000),
          content_html: (wp.content?.rendered || '').substring(0, 100000),
          word_count: wordCount,
          seo_score: seoScore ? parseInt(seoScore) : null,
          publish_date: wp.date ? wp.date.split('T')[0] : null,
          featured_image_url: wp._embedded?.['wp:featuredmedia']?.[0]?.source_url || null,
          source: 'wordpress_import',
          updated_at: new Date(),
        };

        if (existing) {
          await db('blog_posts').where('id', existing.id).update(postData);
          updated++;
        } else {
          await db('blog_posts').insert({ ...postData, created_at: new Date() });
          imported++;
        }
      } catch (err) {
        logger.error(`WP sync post ${wp.id}: ${err.message}`);
      }
    }

    const result = { total: allPosts.length, imported, updated };
    logger.info(`WordPress sync: ${imported} new, ${updated} updated`);
    return result;
  }

  async publishToWordPress(blogPostId) {
    const post = await db('blog_posts').where('id', blogPostId).first();
    if (!post) throw new Error('Post not found');
    if (!WP_USER || !WP_APP_PASSWORD) throw new Error('WordPress credentials not configured');

    const body = {
      title: post.title,
      content: post.content_html || post.content,
      slug: post.slug,
      status: 'draft', // Publish as draft for Adam to review
      excerpt: post.meta_description,
    };

    // Add Yoast SEO fields
    if (post.keyword || post.meta_description) {
      body.meta = {};
      if (post.keyword) body.meta._yoast_wpseo_focuskw = post.keyword;
      if (post.meta_description) body.meta._yoast_wpseo_metadesc = post.meta_description;
    }

    const resp = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { ...this.getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) throw new Error(`WP publish failed: ${resp.status} ${resp.statusText}`);
    const wpPost = await resp.json();

    await db('blog_posts').where('id', blogPostId).update({
      wordpress_post_id: wpPost.id?.toString(),
      status: 'published',
      updated_at: new Date(),
    });

    return wpPost;
  }

  detectCity(title) {
    const t = (title || '').toLowerCase();
    if (t.includes('lakewood ranch') || t.includes('lakewood')) return 'Lakewood Ranch';
    if (t.includes('bradenton')) return 'Bradenton';
    if (t.includes('sarasota')) return 'Sarasota';
    if (t.includes('venice')) return 'Venice';
    if (t.includes('north port')) return 'North Port';
    if (t.includes('parrish')) return 'Parrish';
    if (t.includes('palmetto')) return 'Palmetto';
    if (t.includes('port charlotte')) return 'Port Charlotte';
    return null;
  }
}

module.exports = new WordPressSync();
