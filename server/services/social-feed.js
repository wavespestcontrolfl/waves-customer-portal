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
 *   - TikTok    : Display API /v2/video/list/         (TIKTOK_CLIENT_KEY /
 *                 TIKTOK_CLIENT_SECRET / TIKTOK_REFRESH_TOKEN) — optional
 *
 * Every source is wrapped so one failing/unconfigured channel never breaks
 * the others; the response always resolves to an object (never throws). The
 * whole payload is cached in-memory (TTL) and served stale on upstream
 * errors.
 */

const logger = require('./logger');
const db = require('../models/db');
const gbpService = require('./google-business');
const { WAVES_LOCATIONS } = require('../config/locations');
const { runExclusive } = require('../utils/cron-lock');

const GRAPH = 'https://graph.facebook.com/v25.0';
const FACEBOOK_PAGE_ID = process.env.FACEBOOK_PAGE_ID;
const INSTAGRAM_ACCOUNT_ID = process.env.INSTAGRAM_ACCOUNT_ID;

const TTL_MS = 15 * 60 * 1000; // 15 minutes
const CAPTION_MAX = 300;
const IG_LIMIT = 8;
const FB_LIMIT = 8;
const GBP_PER_LOCATION = 5;
const YT_LIMIT = 5;
const TIKTOK_LIMIT = 6;

const TIKTOK_TOKENS_KEY = 'tiktok_oauth_tokens';
const TIKTOK_CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const TIKTOK_CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const TIKTOK_VIDEO_FIELDS = 'id,title,video_description,cover_image_url,share_url,embed_link,create_time,duration';

const SOURCE_TIMEOUT_MS = 8000; // per-source hard cap so a hung upstream can't wedge the feed

let CACHE = { payload: null, expires: 0 };
let INFLIGHT = null;
let YT_CHANNEL_ID = null; // resolved lazily from handle if not set via env

function token() {
  return process.env.FACEBOOK_ACCESS_TOKEN || null;
}

// Abort a fetch after SOURCE_TIMEOUT_MS so a slow socket releases.
function timeoutSignal(ms = SOURCE_TIMEOUT_MS) {
  return AbortSignal.timeout(ms);
}

// Backstop for sources whose internal fetches we don't control (GBP goes
// through gbpService): reject the whole source if it overruns, so build()
// and INFLIGHT never stay pending.
function withTimeout(promise, label, ms = SOURCE_TIMEOUT_MS) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
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
  const res = await fetch(url.toString(), { signal: timeoutSignal() });
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
        // Only surface posts that are actually live on the profile — never
        // REJECTED / PROCESSING / unspecified lifecycle states (this is a
        // public endpoint; see the AGENTS.md allowlist guardrails).
        if (post.state !== 'LIVE') continue;
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
      signal: timeoutSignal(),
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
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { signal: timeoutSignal() });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  return { status: 'ok', posts: parseYouTubeRss(xml) };
}

// ------------------------------------------------------------------- TikTok
// TikTok refresh tokens rotate on every refresh and access tokens last ~24h,
// so the latest token pair is persisted in system_settings (same KV store
// the GBP integration uses). TIKTOK_REFRESH_TOKEN env seeds the very first
// run after OAuth; thereafter the rotated token in the DB wins.
async function tiktokStoredTokens() {
  try {
    const row = await db('system_settings').where({ key: TIKTOK_TOKENS_KEY }).first();
    if (!row?.value) return {};
    return typeof row.value === 'object' ? row.value : JSON.parse(row.value);
  } catch {
    return {};
  }
}

async function tiktokStoreTokens(record) {
  const now = new Date();
  await db('system_settings')
    .insert({
      key: TIKTOK_TOKENS_KEY,
      value: JSON.stringify(record),
      category: 'integrations',
      description: 'TikTok OAuth tokens (access + rotating refresh)',
      created_at: now,
      updated_at: now,
    })
    .onConflict('key')
    .merge({ value: JSON.stringify(record), category: 'integrations', updated_at: now });
}

// The actual refresh+persist. Only ever invoked inside the advisory lock
// (see tiktokAccessToken). Re-reads the stored token first so a worker that
// lost the race uses the freshly-stored token instead of spending — and
// rotating — the refresh token a second time.
async function refreshTikTokTokenLocked() {
  const stored = await tiktokStoredTokens();
  const now = Date.now();
  if (stored.access_token && stored.access_expires_at && Date.parse(stored.access_expires_at) - 60_000 > now) {
    return stored.access_token;
  }
  const refreshToken = stored.refresh_token || process.env.TIKTOK_REFRESH_TOKEN;
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    client_key: TIKTOK_CLIENT_KEY,
    client_secret: TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: body.toString(),
    signal: timeoutSignal(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(data.error_description || data.error || `token HTTP ${res.status}`);
  }

  const nowMs = Date.now();
  await tiktokStoreTokens({
    access_token: data.access_token,
    access_expires_at: new Date(nowMs + (Number(data.expires_in) || 86400) * 1000).toISOString(),
    refresh_token: data.refresh_token || refreshToken,
    refresh_expires_at: new Date(nowMs + (Number(data.refresh_expires_in) || 31536000) * 1000).toISOString(),
    open_id: data.open_id || stored.open_id || null,
    scope: data.scope || stored.scope || null,
    updated_at: new Date(nowMs).toISOString(),
  });
  return data.access_token;
}

// Returns a usable TikTok access token, or null. This runs on the public,
// unauthenticated feed path, so the rotating refresh token must never be
// spent by racing requests: the refresh+persist runs ONLY under a Postgres
// advisory lock and fails closed. At most one worker refreshes across the
// fleet; a worker that can't take the lock uses the currently-stored token
// or skips TikTok for this cycle rather than rotate the token itself.
async function tiktokAccessToken() {
  const stored = await tiktokStoredTokens();
  const now = Date.now();
  if (stored.access_token && stored.access_expires_at && Date.parse(stored.access_expires_at) - 60_000 > now) {
    return stored.access_token; // read-only fast path — no write
  }
  const result = await runExclusive('tiktok-token-refresh', refreshTikTokTokenLocked);
  if (result && typeof result === 'object' && result.skipped) {
    const s = await tiktokStoredTokens();
    return s.access_token && s.access_expires_at && Date.parse(s.access_expires_at) > Date.now() ? s.access_token : null;
  }
  return result; // access token string, or null
}

async function fetchTikTok() {
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) return { status: 'skipped', posts: [] };
  const accessToken = await tiktokAccessToken();
  if (!accessToken) return { status: 'skipped', posts: [] };

  const res = await fetch(`https://open.tiktokapis.com/v2/video/list/?fields=${encodeURIComponent(TIKTOK_VIDEO_FIELDS)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_count: TIKTOK_LIMIT }),
    signal: timeoutSignal(),
  });
  const data = await res.json().catch(() => ({}));
  // TikTok wraps the status in data.error; code 'ok' means success.
  const errCode = data?.error?.code;
  if (!res.ok || (errCode && errCode !== 'ok')) {
    throw new Error(data?.error?.message || errCode || `video list HTTP ${res.status}`);
  }

  const videos = data?.data?.videos || [];
  const posts = videos
    .map((v) => ({
      platform: 'tiktok',
      caption: clip(v.title || v.video_description || ''),
      postedAt: v.create_time ? new Date(v.create_time * 1000).toISOString() : null,
      postUrl: v.share_url || (v.id ? `https://www.tiktok.com/video/${v.id}` : ''),
      image: v.cover_image_url || null,
      video: true,
      location: null,
    }))
    .filter((p) => p.postUrl);
  return { status: 'ok', posts };
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
    ['tiktok', fetchTikTok],
  ];

  const results = await Promise.allSettled(runners.map(([key, fn]) => withTimeout(fn(), key)));
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
