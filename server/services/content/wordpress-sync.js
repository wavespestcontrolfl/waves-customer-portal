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

    // Build HTML content with TOC and FAQ schema
    let htmlContent = this.markdownToHtml(post.content || '');
    const tocHtml = this.generateTOC(htmlContent);
    const faqSchema = this.extractFAQSchema(post.content || '', post.title);

    // Prepend TOC if there are headings
    if (tocHtml) {
      htmlContent = `<!-- wp:rank-math/toc-block -->\n<div class="wp-block-rank-math-toc-block">\n<nav>\n<h2>Table of Contents</h2>\n${tocHtml}\n</nav>\n</div>\n<!-- /wp:rank-math/toc-block -->\n\n${htmlContent}`;
    }

    // Append FAQ schema block if FAQs found
    if (faqSchema.length > 0) {
      const faqHtml = faqSchema.map(faq =>
        `<div class="rank-math-faq-item">\n<h3 class="rank-math-question">${faq.question}</h3>\n<div class="rank-math-answer">${faq.answer}</div>\n</div>`
      ).join('\n');
      htmlContent += `\n\n<!-- wp:rank-math/faq-block -->\n<div class="wp-block-rank-math-faq-block">\n<div class="rank-math-faq-wrap">\n${faqHtml}\n</div>\n</div>\n<!-- /wp:rank-math/faq-block -->`;
    }

    const body = {
      title: post.title,
      content: htmlContent,
      slug: post.slug,
      status: 'draft',
      excerpt: post.meta_description,
    };

    // RankMath SEO meta fields
    body.meta = {};
    if (post.keyword) body.meta.rank_math_focus_keyword = post.keyword;
    if (post.meta_description) body.meta.rank_math_description = post.meta_description;
    if (post.title) body.meta.rank_math_title = `${post.title} - Waves Pest Control`;

    // Add FAQ schema to RankMath
    if (faqSchema.length > 0) {
      body.meta.rank_math_schema_faq = JSON.stringify(faqSchema.map(faq => ({
        '@type': 'Question',
        name: faq.question,
        acceptedAnswer: { '@type': 'Answer', text: faq.answer },
      })));
    }

    // Resolve WordPress tag ID
    if (post.tag) {
      try {
        const tagResp = await fetch(`${WP_URL}/wp-json/wp/v2/tags?search=${encodeURIComponent(post.tag)}&per_page=5`, {
          headers: this.getAuthHeader(),
        });
        if (tagResp.ok) {
          const wpTags = await tagResp.json();
          const match = wpTags.find(t => t.name.toLowerCase() === post.tag.toLowerCase());
          if (match) body.tags = [match.id];
        }
      } catch { /* skip tag assignment */ }
    }

    // Upload featured image if available
    let featuredMediaId = null;
    if (post.featured_image_url && post.featured_image_url.startsWith('data:')) {
      try {
        featuredMediaId = await this.uploadFeaturedImage(post.featured_image_url, post.slug);
      } catch (imgErr) {
        logger.error(`WP image upload failed: ${imgErr.message}`);
      }
    }
    if (featuredMediaId) body.featured_media = featuredMediaId;

    // Set Elementor template if configured
    if (process.env.WORDPRESS_ELEMENTOR_TEMPLATE_ID) {
      body.template = 'elementor_header_footer';
      body.meta._elementor_template_type = 'post';
    }

    const resp = await fetch(`${WP_URL}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { ...this.getAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`WP publish failed: ${resp.status} ${errText.substring(0, 200)}`);
    }
    const wpPost = await resp.json();

    await db('blog_posts').where('id', blogPostId).update({
      wordpress_post_id: wpPost.id?.toString(),
      wordpress_url: wpPost.link,
      status: 'published',
      updated_at: new Date(),
    });

    return wpPost;
  }

  // Convert markdown to HTML
  markdownToHtml(md) {
    if (!md) return '';
    return md
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, match => `<ul>${match}</ul>`)
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<[hublop])(.+)$/gm, '<p>$1</p>')
      .replace(/<p><\/p>/g, '')
      .replace(/<p>(<h[23]>)/g, '$1')
      .replace(/(<\/h[23]>)<\/p>/g, '$1');
  }

  // Generate table of contents from HTML headings
  generateTOC(html) {
    const headings = [];
    const regex = /<h([23])[^>]*>(.*?)<\/h[23]>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const level = parseInt(match[1]);
      const text = match[2].replace(/<[^>]+>/g, '');
      const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      headings.push({ level, text, id });
    }
    if (headings.length < 3) return null;
    return '<ul>' + headings.map(h =>
      `<li${h.level === 3 ? ' style="margin-left:20px"' : ''}><a href="#${h.id}">${h.text}</a></li>`
    ).join('\n') + '</ul>';
  }

  // Extract FAQ from markdown Q: / A: or **Q:** patterns
  extractFAQSchema(content, title) {
    const faqs = [];
    // Match **Q: ...** / A: ... patterns or ## FAQ section
    const faqSection = content.match(/## FAQ[\s\S]*$/im);
    if (faqSection) {
      const qRegex = /\*\*Q:\s*(.+?)\*\*\s*\n+(?:A:\s*)?(.+?)(?=\n\n\*\*Q:|\n\n---|$)/gs;
      let m;
      while ((m = qRegex.exec(faqSection[0])) !== null) {
        faqs.push({ question: m[1].trim(), answer: m[2].trim() });
      }
    }
    // Also try matching plain question patterns
    if (faqs.length === 0) {
      const plainRegex = /\*\*(.+?\?)\*\*\s*\n+(?:A:\s*)?(.+?)(?=\n\n\*\*|\n\n---|$)/gs;
      let m;
      while ((m = plainRegex.exec(content)) !== null) {
        faqs.push({ question: m[1].trim(), answer: m[2].trim() });
      }
    }
    return faqs;
  }

  // Upload base64 image as WordPress media
  async uploadFeaturedImage(dataUrl, slug) {
    const [header, base64] = dataUrl.split(',');
    const mimeMatch = header.match(/data:([^;]+)/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
    const buffer = Buffer.from(base64, 'base64');

    const resp = await fetch(`${WP_URL}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        ...this.getAuthHeader(),
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${slug}-featured.${ext}"`,
      },
      body: buffer,
    });

    if (!resp.ok) throw new Error(`Media upload failed: ${resp.status}`);
    const media = await resp.json();
    return media.id;
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
