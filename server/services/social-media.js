/**
 * Social Media Engine.
 *
 * Flow: RSS/Blog trigger → AI content generation → post to all platforms
 *   - Facebook Page
 *   - Instagram Business
 *   - LinkedIn Company Page
 *   - Google Business Profile (4 locations, each with location-specific copy)
 *
 * Env vars:
 *   ANTHROPIC_API_KEY          — AI content generation (already set)
 *   FACEBOOK_PAGE_ID           — Facebook page ID
 *   FACEBOOK_ACCESS_TOKEN      — Long-lived page access token
 *   INSTAGRAM_ACCOUNT_ID       — Instagram business account ID
 *   LINKEDIN_COMPANY_ID        — LinkedIn company page ID
 *   LINKEDIN_ACCESS_TOKEN      — LinkedIn OAuth token
 *   GOOGLE_MAPS_API_KEY        — Already set for GBP
 *   GEMINI_API_KEY             — For AI image generation (optional)
 */

const db = require('../models/db');
const logger = require('./logger');
const gbpService = require('./google-business');
const { WAVES_LOCATIONS } = require('../config/locations');
const config = require('../config');
const MODELS = require('../config/models');

let Anthropic;
try {
  const sdk = require('@anthropic-ai/sdk');
  Anthropic = sdk.default || sdk.Anthropic || sdk;
} catch (err) {
  logger.warn(`[social] Anthropic SDK unavailable: ${err.message}`);
  Anthropic = null;
}

const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID || '110336442031847';
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID || '17841465266249854';
const LINKEDIN_COMPANY_ID = process.env.LINKEDIN_COMPANY_ID || '89173265';

// ── AI Content Generation ──
async function generateContent(platform, { title, description, link, locationName }) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const safeTitle = String(title || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  const safeDesc = String(description || '').replace(/[\r\n]+/g, ' ').slice(0, 1000);
  const safeLocation = String(locationName || '').replace(/[\r\n]+/g, ' ').slice(0, 100);

  const prompts = {
    facebook: `Write an engaging Facebook post for Waves Pest Control based on this blog article.
Keep it conversational, use 1-2 relevant emojis, include a call to action.
150-250 characters. Do NOT include the URL — it will be added separately.

Title: ${safeTitle}
Description: ${safeDesc}`,

    instagram: `Write an Instagram caption for Waves Pest Control based on this blog article.
Keep it engaging, use 3-5 relevant hashtags at the end (#wavespestcontrol #pestcontrol #swfl etc).
150-300 characters before hashtags. Do NOT include any URL.

Title: ${safeTitle}
Description: ${safeDesc}`,

    linkedin: `Write a professional LinkedIn post for Waves Pest Control company page based on this blog article.
Professional but approachable tone. 100-200 characters. Do NOT include the URL.

Title: ${safeTitle}
Description: ${safeDesc}`,

    gbp: `Write a Google Business Profile post for Waves Pest Control ${safeLocation} based on this blog article.
Local, helpful tone for SWFL homeowners. 100-200 characters. Do NOT include any URL.

Title: ${safeTitle}
Description: ${safeDesc}`,
  };

  const prompt = prompts[platform] || prompts.facebook;

  const response = await client.messages.create({
    model: MODELS.FLAGSHIP,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0]?.text?.trim() || '';
}

// ── AI Image Generation (Gemini) ──
async function generateImage(title) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const prompt = `Create a high-quality, bright, modern image for a professional pest control business named "Waves Pest Control."
Style: Clean, trustworthy, professional. Use teal/ocean blue (#0ea5e9) accent colors.
Topic: ${title}
Do NOT include any text or words in the image. Photorealistic style, well-lit, 1080x1080.`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }),
      }
    );

    if (!res.ok) {
      logger.warn(`[social] Gemini image generation failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    // Extract image from response
    const imagePart = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (imagePart?.inlineData) {
      return {
        base64: imagePart.inlineData.data,
        mimeType: imagePart.inlineData.mimeType || 'image/png',
      };
    }
    return null;
  } catch (err) {
    logger.error(`[social] Image generation failed: ${err.message}`);
    return null;
  }
}

// ── S3 Image Upload (for Instagram public URL requirement) ──
async function uploadImageToS3(base64Data, filename) {
  if (!config.s3.accessKeyId || !config.s3.bucket) return null;
  try {
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      region: config.s3.region,
      credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
    });
    const buffer = Buffer.from(base64Data, 'base64');
    const key = `social-media/${filename}`;
    await client.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: buffer,
      ContentType: 'image/png',
      ACL: 'public-read',
    }));
    const url = `https://${config.s3.bucket}.s3.${config.s3.region}.amazonaws.com/${key}`;
    logger.info(`[social] Image uploaded to S3: ${url}`);
    return url;
  } catch (err) {
    logger.error(`[social] S3 upload failed: ${err.message}`);
    return null;
  }
}

// ── Platform Posting ──

async function postToFacebook(message, link, imageUrl) {
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!token) throw new Error('FACEBOOK_ACCESS_TOKEN not configured');

  const body = { message, access_token: token };
  if (link) body.link = link;

  const res = await fetch(`https://graph.facebook.com/v21.0/${FACEBOOK_PAGE_ID}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook API ${res.status}: ${err}`);
  }
  const data = await res.json();
  logger.info(`[social] Facebook post created: ${data.id}`);
  return { platform: 'facebook', postId: data.id, success: true };
}

async function postToInstagram(caption, imageUrl) {
  const token = process.env.FACEBOOK_ACCESS_TOKEN; // Instagram uses same token
  if (!token) throw new Error('FACEBOOK_ACCESS_TOKEN not configured');
  if (!imageUrl) throw new Error('Instagram requires an image URL');

  // Step 1: Create media container
  const containerRes = await fetch(
    `https://graph.facebook.com/v21.0/${INSTAGRAM_ACCOUNT_ID}/media`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_url: imageUrl, caption, access_token: token }),
    }
  );
  if (!containerRes.ok) {
    const err = await containerRes.text();
    throw new Error(`Instagram container ${containerRes.status}: ${err}`);
  }
  const container = await containerRes.json();

  // Step 2: Publish
  const publishRes = await fetch(
    `https://graph.facebook.com/v21.0/${INSTAGRAM_ACCOUNT_ID}/media_publish`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ creation_id: container.id, access_token: token }),
    }
  );
  if (!publishRes.ok) {
    const err = await publishRes.text();
    throw new Error(`Instagram publish ${publishRes.status}: ${err}`);
  }
  const data = await publishRes.json();
  logger.info(`[social] Instagram post published: ${data.id}`);
  return { platform: 'instagram', postId: data.id, success: true };
}

async function postToLinkedIn(text, link, title, description, imageUrl) {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  if (!token) throw new Error('LINKEDIN_ACCESS_TOKEN not configured');

  const body = {
    author: `urn:li:organization:${LINKEDIN_COMPANY_ID}`,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory: link ? 'ARTICLE' : 'NONE',
        media: link ? [{
          status: 'READY',
          originalUrl: link,
          title: { text: title || '' },
          description: { text: (description || '').substring(0, 200) },
        }] : [],
      },
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' },
  };

  const res = await fetch('https://api.linkedin.com/v2/ugcPosts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': '2.0.0',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LinkedIn API ${res.status}: ${err}`);
  }
  const headerId = res.headers.get('x-restli-id');
  let bodyId = null;
  try {
    const data = await res.json();
    bodyId = data?.id || null;
  } catch { /* empty body */ }
  const postId = headerId || bodyId;
  logger.info(`[social] LinkedIn post created: ${postId}`);
  return { platform: 'linkedin', postId, success: true };
}

async function postToGBP(locationId, summary, link, imageUrl) {
  const loc = WAVES_LOCATIONS.find(l => l.id === locationId);
  if (!loc?.googleLocationResourceName) throw new Error(`No GBP resource for ${locationId}`);

  try {
    const result = await gbpService.createPost(
      loc.googleLocationResourceName,
      {
        summary,
        callToAction: link ? { actionType: 'LEARN_MORE', url: link } : undefined,
        mediaUrl: imageUrl || undefined,
      },
      locationId
    );
    logger.info(`[social] GBP post created for ${loc.name}`);
    return { platform: 'gbp', location: locationId, success: true, postId: result.name };
  } catch (err) {
    logger.error(`[social] GBP post failed for ${loc.name}: ${err.message}`);
    return { platform: 'gbp', location: locationId, success: false, error: err.message };
  }
}

// ── RSS Feed Polling ──
async function fetchRSSFeed(feedUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let res;
  try {
    res = await fetch(feedUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();

  // Simple XML parsing for RSS items
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const get = (tag) => {
      const m = itemXml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 's'));
      return m ? m[1].trim() : '';
    };
    items.push({
      title: get('title'),
      link: get('link'),
      description: get('description').replace(/<[^>]+>/g, '').substring(0, 500),
      pubDate: get('pubDate'),
      guid: get('guid') || get('link'),
    });
  }
  return items;
}

// ══════════════════════════════════════════════════════════════
// MAIN SERVICE
// ══════════════════════════════════════════════════════════════
const SocialMediaService = {
  /**
   * Check RSS feed for new posts and publish to all platforms.
   * Called by cron job or manually from admin.
   */
  async checkAndPublish(feedUrl = 'https://www.wavespestcontrol.com/feed/') {
    const items = await fetchRSSFeed(feedUrl);
    if (!items.length) return { processed: 0, results: [] };

    const results = [];

    for (const item of items.slice(0, 5)) { // Process max 5 at a time
      // Check if already posted
      const existing = await db('social_media_posts')
        .where({ source_url: item.link })
        .orWhere({ source_guid: item.guid })
        .first();

      if (existing) continue; // Already processed

      try {
        const result = await this.publishToAll({
          title: item.title,
          description: item.description,
          link: item.link,
          guid: item.guid,
          source: 'rss',
        });
        results.push({ item: item.title, ...result });
      } catch (err) {
        logger.error(`[social] Failed to process RSS item "${item.title}": ${err.message}`);
        results.push({ item: item.title, error: err.message });
      }
    }

    return { processed: results.length, results };
  },

  /**
   * Publish content to all configured platforms.
   */
  async publishToAll({ title, description, link, guid, source, imageUrl, customContent }) {
    const platformResults = [];

    // Generate AI image if no image provided
    let generatedImageUrl = imageUrl || null;
    if (!generatedImageUrl && process.env.GEMINI_API_KEY) {
      try {
        const img = await generateImage(title);
        if (img && img.base64) {
          // Upload to S3 to get a public URL (required by Instagram)
          const filename = `post-${Date.now()}.png`;
          const s3Url = await uploadImageToS3(img.base64, filename);
          if (s3Url) {
            generatedImageUrl = s3Url;
          }
        }
      } catch { /* non-critical */ }
    }

    // Generate content for each platform and post
    const platforms = [
      { key: 'facebook', enabled: !!process.env.FACEBOOK_ACCESS_TOKEN },
      { key: 'instagram', enabled: !!process.env.FACEBOOK_ACCESS_TOKEN && !!generatedImageUrl },
      { key: 'linkedin', enabled: !!process.env.LINKEDIN_ACCESS_TOKEN },
    ];

    for (const p of platforms) {
      if (!p.enabled) {
        platformResults.push({ platform: p.key, skipped: 'Not configured' });
        continue;
      }

      try {
        const content = customContent?.[p.key] || await generateContent(p.key, { title, description, link });

        if (p.key === 'facebook') {
          const r = await postToFacebook(content, link);
          platformResults.push(r);
        } else if (p.key === 'instagram') {
          // Instagram needs a publicly accessible image URL
          const imgUrl = typeof generatedImageUrl === 'string' ? generatedImageUrl : null;
          if (imgUrl) {
            const r = await postToInstagram(content, imgUrl);
            platformResults.push(r);
          } else {
            platformResults.push({ platform: 'instagram', skipped: 'No public image URL' });
          }
        } else if (p.key === 'linkedin') {
          const r = await postToLinkedIn(content, link, title, description);
          platformResults.push(r);
        }
      } catch (err) {
        logger.error(`[social] ${p.key} post failed: ${err.message}`);
        platformResults.push({ platform: p.key, success: false, error: err.message });
      }
    }

    // Post to all 4 GBP locations
    // customContent.gbp may be a string (same copy for all locations) or an object keyed by location id
    for (const loc of WAVES_LOCATIONS) {
      try {
        const gbpCustom = customContent?.gbp;
        const gbpContent =
          (typeof gbpCustom === 'string' ? gbpCustom : gbpCustom?.[loc.id]) ||
          await generateContent('gbp', { title, description, link, locationName: loc.name });
        const r = await postToGBP(loc.id, gbpContent, link);
        platformResults.push(r);
      } catch (err) {
        platformResults.push({ platform: 'gbp', location: loc.id, success: false, error: err.message });
      }
    }

    // Log to database
    try {
      await db('social_media_posts').insert({
        title,
        description: (description || '').substring(0, 1000),
        source_url: link,
        source_guid: guid,
        source_type: source || 'manual',
        platforms_posted: JSON.stringify(platformResults),
        image_url: typeof generatedImageUrl === 'string' ? generatedImageUrl : null,
        status: platformResults.some(r => r.success) ? 'published' : 'failed',
      });
    } catch (err) {
      logger.error(`[social] Failed to log post: ${err.message}`);
    }

    return {
      success: platformResults.some(r => r.success),
      platforms: platformResults,
    };
  },

  /**
   * Post to a single platform (from admin UI).
   */
  async postToSingle(platform, { title, description, link, content, imageUrl, locationId }) {
    const text = content || await generateContent(platform, { title, description, link, locationName: locationId });

    if (platform === 'facebook') return postToFacebook(text, link);
    if (platform === 'instagram') return postToInstagram(text, imageUrl);
    if (platform === 'linkedin') return postToLinkedIn(text, link, title, description);
    if (platform === 'gbp') return postToGBP(locationId || 'lakewood-ranch', text, link, imageUrl);
    throw new Error(`Unknown platform: ${platform}`);
  },

  /**
   * Get post history.
   */
  async getHistory({ limit = 50, offset = 0, status } = {}) {
    let query = db('social_media_posts').orderBy('created_at', 'desc');
    if (status) query = query.where({ status });
    return query.limit(limit).offset(offset);
  },

  /**
   * Generate AI content preview (for admin UI).
   */
  async previewContent({ title, description, link }) {
    const [facebook, instagram, linkedin, gbp] = await Promise.all([
      generateContent('facebook', { title, description, link }),
      generateContent('instagram', { title, description, link }),
      generateContent('linkedin', { title, description, link }),
      generateContent('gbp', { title, description, link, locationName: 'Lakewood Ranch' }),
    ]);
    return { facebook, instagram, linkedin, gbp };
  },

  /**
   * Fetch recent RSS items (for admin preview).
   */
  async getRSSItems(feedUrl = 'https://www.wavespestcontrol.com/feed/') {
    return fetchRSSFeed(feedUrl);
  },

  // Expose for direct use
  generateContent,
  generateImage,
};

module.exports = SocialMediaService;
