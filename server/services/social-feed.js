/**
 * Public social feed aggregator.
 *
 * Pulls recent posts from the channels we own tokens for and normalizes them
 * into a single shape the marketing site's /social page renders as branded
 * cards:
 *
 *   { platform, caption, postedAt, postUrl, image, video, location }
 *
 *   platform : 'instagram' | 'facebook' | 'google' | 'youtube'
 *   postedAt : ISO 8601 string
 *   postUrl  : public permalink ("View Post")
 *   image    : thumbnail URL or null
 *   video    : boolean (renders a play overlay)
 *   location : GBP city name for Google posts, else null
 *
 * Sources:
 *   - Instagram : Graph API /{ig-user-id}/media     (FACEBOOK_ACCESS_TOKEN)
 *   - Facebook  : Graph API /{page-id}/posts          (FACEBOOK_ACCESS_TOKEN)
 *   - Google    : GBP localPosts for each configured location
 *   - YouTube   : channel RSS (no key) — optional, YOUTUBE_CHANNEL_ID
 *
 * Every source is wrapped so one failing/unconfigured channel never breaks
 * the others; the response always resolves to an object (never throws). The
 * whole payload is cached in-memory (TTL) and served stale on upstream
 * errors. TikTok is intentionally absent — no read API; the site links to
 * the profile instead.
 */

const logger = require('./logger');
const gbpService = require('./google-business');
const { WAVES_LOCATIONS } = require('../config/locations');

const GRAPH = 'https://graph.facebook.com/v25.0';
const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;

const TTL_MS = 15 * 60 * 1000; // 15 minutes
const CAPTION_MAX = 300;
const IG_LIMIT = 8;
const FB_LIMIT = 8;
const GBP_PER_LOCATION = 5;
const YT_LIMIT = 5;

let CACHE = { payload: null, expires: 0 };
let INFLIGHT = null;
let YT_CHANNEL_ID = null; // resolved lazily from handle if not set via env

function token() {
  return process.env.FACEBOOK_ACCESS_TOKEN || null;
}

function clip(text) {
  if (!text || typeof text !== 'string') return '';
  const t = text.trim();
  return t.length > CAPTION_MAX ? `${t.slice(0, CAPTION_MAX - 1).trimEnd()}…` : t;
}

async function graphGet(path, params = {}) {
  const url = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('access_token', token());
  const res = await fetch(url.toString());
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

// ---------------------------------------------------------------- Instagram
async function fetchInstagram() {
  if (!token() || !INSTAGRAM_ACCOUNT_ID) return { status: 'skipped', posts: [] };
  const data = await graphGet(`${INSTAGRAM_ACCOUNT_ID}/media`, {
    fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp',
    limit: String(IG_LIMIT),
  });
  const posts = (data.data || [])
    .filter((m) => m.permalink)
    .map((m) => ({
      platform: 'instagram',
      caption: clip(m.caption),
      postedAt: m.timestamp || null,
      postUrl: m.permalink,
      image: m.thumbnail_url || m.media_url || null,
      video: m.media_type === 'VIDEO',
      location: null,
    }));
  return { status: 'ok', posts };
}

// ----------------------------------------------------------------- Facebook
async function fetchFacebook() {
  if (!token() || !FACEBOOK_PAGE_ID) return { status: 'skipped', posts: [] };
  const data = await graphGet(`${FACEBOOK_PAGE_ID}/posts`, {
    fields: 'id,message,full_picture,permalink_url,created_time',
    limit: String(FB_LIMIT),
  });
  const posts = (data.data || [])
    .filter((p) => (p.message || p.full_picture) && p.permalink_url)
    .map((p) => ({
      platform: 'facebook',
      caption: clip(p.message),
      postedAt: p.created_time || null,
      postUrl: p.permalink_url,
      image: p.full_picture || null,
      video: false,
      location: null,
    }));
  return { status: 'ok', posts };
}

// ------------------------------------------------------------------- Google
function gbpPostUrl(post, loc) {
  if (post.searchUrl) return post.searchUrl;
  if (loc.googlePlaceId) return `https://www.google.com/maps/place/?q=place_id:${loc.googlePlaceId}`;
  return `https://www.google.com/maps/search/${encodeURIComponent('Waves Pest Control ' + loc.name)}`;
}

async function fetchGoogle() {
  let any = false;
  const posts = [];
  for (const loc of WAVES_LOCATIONS) {
    if (!loc.googleLocationResourceName) continue;
    try {
      const raw = await gbpService.listLocalPosts(loc.googleLocationResourceName, loc.id, GBP_PER_LOCATION);
      any = true;
      for (const post of raw) {
        const summary = post.summary || post.event?.title || '';
        if (!summary && !(post.media && post.media.length)) continue;
        posts.push({
          platform: 'google',
          caption: clip(summary),
          postedAt: post.createTime || post.updateTime || null,
          postUrl: gbpPostUrl(post, loc),
          image: post.media?.[0]?.googleUrl || null,
          video: false,
          location: loc.name,
        });
      }
    } catch (err) {
      logger.warn(`[social-feed] GBP posts failed for ${loc.name}: ${err.message}`);
    }
  }
  return { status: any ? 'ok' : 'skipped', posts };
}

// ------------------------------------------------------------------ YouTube
async function resolveYouTubeChannelId() {
  if (process.env.YOUTUBE_CHANNEL_ID) return process.env.YOUTUBE_CHANNEL_ID;
  if (YT_CHANNEL_ID) return YT_CHANNEL_ID;
  const handle = process.env.YOUTUBE_HANDLE || '@wavespestcontrol';
  try {
    const res = await fetch(`https://www.youtube.com/${handle}`, {
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/"channelId":"(UC[0-9A-Za-z_-]{22})"/) || html.match(/channel\/(UC[0-9A-Za-z_-]{22})/);
    YT_CHANNEL_ID = m ? m[1] : null;
    return YT_CHANNEL_ID;
  } catch {
    return null;
  }
}

function parseYouTubeRss(xml) {
  const entries = [];
  const blocks = xml.split('<entry>').slice(1);
  for (const block of blocks.slice(0, YT_LIMIT)) {
    const id = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
    const title = (block.match(/<title>([^<]*)<\/title>/) || [])[1];
    const published = (block.match(/<published>([^<]+)<\/published>/) || [])[1];
    if (!id) continue;
    entries.push({
      platform: 'youtube',
      caption: clip(title ? title.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') : ''),
      postedAt: published || null,
      postUrl: `https://www.youtube.com/watch?v=${id}`,
      image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      video: true,
      location: null,
    });
  }
  return entries;
}

async function fetchYouTube() {
  const channelId = await resolveYouTubeChannelId();
  if (!channelId) return { status: 'skipped', posts: [] };
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  return { status: 'ok', posts: parseYouTubeRss(xml) };
}

// --------------------------------------------------------------- aggregate
async function build() {
  const sources = {};
  const all = [];
  const runners = [
    ['instagram', fetchInstagram],
    ['facebook', fetchFacebook],
    ['google', fetchGoogle],
    ['youtube', fetchYouTube],
  ];

  const results = await Promise.allSettled(runners.map(([, fn]) => fn()));
  results.forEach((r, i) => {
    const key = runners[i][0];
    if (r.status === 'fulfilled') {
      sources[key] = r.value.status;
      all.push(...r.value.posts);
    } else {
      sources[key] = 'error';
      logger.warn(`[social-feed] ${key} failed: ${r.reason?.message || r.reason}`);
    }
  });

  all.sort((a, b) => {
    const ta = a.postedAt ? Date.parse(a.postedAt) : 0;
    const tb = b.postedAt ? Date.parse(b.postedAt) : 0;
    return tb - ta;
  });

  return { posts: all, sources, generatedAt: new Date().toISOString() };
}

/**
 * Returns the cached feed, rebuilding when stale. Never throws — on a full
 * rebuild failure with no cached payload it resolves to an empty feed.
 */
async function getFeed({ force = false } = {}) {
  const now = Date.now();
  if (!force && CACHE.payload && now < CACHE.expires) return CACHE.payload;
  if (INFLIGHT) return INFLIGHT;

  INFLIGHT = build()
    .then((payload) => {
      CACHE = { payload, expires: Date.now() + TTL_MS };
      INFLIGHT = null;
      return payload;
    })
    .catch((err) => {
      INFLIGHT = null;
      logger.error(`[social-feed] build failed: ${err.message}`);
      if (CACHE.payload) return CACHE.payload; // serve stale
      return { posts: [], sources: {}, generatedAt: new Date().toISOString() };
    });
  return INFLIGHT;
}

module.exports = { getFeed };
