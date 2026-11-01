/**
 * Social series intake — the portal half of the weekly numbered "series"
 * posts the owner's other Mac builds (owner decision 2026-11-01).
 *
 * That job used to push Facebook, Instagram and Google Business (GBP) posts
 * through Zernio, a paid third-party posting API. The portal already posts to
 * those three networks for free (social-media.js publishToAll) and already has
 * a scheduler (content-scheduler.js processScheduledPosts), so this intake
 * stores each series post as ONE social_media_posts row (source_type 'series',
 * status 'scheduled') and the existing scheduler posts it at its time, through
 * the same compliance judge as every other scheduled post. TikTok and X stay
 * on Zernio — they are not accepted here.
 *
 * This file holds the pure validation + row mapping and the idempotent insert.
 * The route (routes/social-series-ingest.js) owns auth, parsing and status
 * codes. Every refusal is { error: { reason, detail } } so the route can answer
 * 400 { ok:false, reason, detail } without parsing strings.
 */
const db = require('../models/db');
const { WAVES_LOCATIONS, CITY_TO_LOCATION } = require('../config/locations');

const SOURCE_TYPE = 'series';
const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,119}$/i;
const MAX_TITLE_CHARS = 500;
const MAX_CHANNEL_CAPTION_CHARS = { gbp: 1500 };
const ISO_WITH_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;
const MAX_PAST_MS = 60 * 60 * 1000;
const MAX_AHEAD_MS = 60 * 24 * 60 * 60 * 1000;
// The only paths POST /media mints: uploadImageToS3 stores social-media/series-<uuid>.jpg,
// uploadVideoToS3 social-media/series-<uuid>.mp4. Any other object on the CDN (an
// AI-generated studio image, a blog hero) is refused, so a series row can only post
// media the series job itself uploaded.
const MINTED_PATH_RE = /^\/social-media\/series-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|mp4)$/;
// Request spelling -> the channel name publishToAll and the scheduler use.
const CHANNEL_ALIASES = { facebook: 'facebook', instagram: 'instagram', gmb: 'gbp', gbp: 'gbp' };

const refuse = (reason, detail) => ({ error: { reason, detail } });

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validateId(raw) {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!ID_RE.test(id)) return refuse('invalid_id', 'id: 1-120 chars of letters, digits, . _ : -');
  return { value: id };
}

function validateTitle(raw, id) {
  if (raw === undefined || raw === null) return { value: id };
  const title = typeof raw === 'string' ? raw.trim() : null;
  if (title === null) return refuse('invalid_title', 'title must be a string');
  if (title.length > MAX_TITLE_CHARS) return refuse('invalid_title', `title exceeds ${MAX_TITLE_CHARS} chars`);
  return { value: title || id };
}

function validatePlatforms(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return refuse('invalid_platforms', 'platforms must be a non-empty array');
  const channels = [];
  for (const entry of raw) {
    const channel = CHANNEL_ALIASES[String(entry || '').trim().toLowerCase()];
    if (!channel) return refuse('invalid_platforms', 'platforms may contain only facebook, instagram, gmb or gbp');
    if (channels.includes(channel)) return refuse('invalid_platforms', 'platforms must not repeat a channel (gmb and gbp are the same channel)');
    channels.push(channel);
  }
  return { value: channels };
}

function validateCaptions(body) {
  const caption = typeof body.caption === 'string' ? body.caption.trim() : '';
  if (!caption) return refuse('invalid_caption', 'caption is required');
  const overrides = {};
  const raw = body.captionByPlatform;
  if (raw === undefined || raw === null) return { value: { caption, overrides } };
  if (!isPlainObject(raw)) return refuse('invalid_caption', 'captionByPlatform must be an object');
  for (const [key, text] of Object.entries(raw)) {
    const channel = CHANNEL_ALIASES[key.toLowerCase()];
    if (!channel) return refuse('invalid_caption', 'captionByPlatform keys may be only facebook, instagram, gmb or gbp');
    if (typeof text !== 'string') return refuse('invalid_caption', `captionByPlatform.${key} must be a string`);
    if (overrides[channel] !== undefined) return refuse('invalid_caption', 'captionByPlatform repeats a channel (gmb and gbp are the same channel)');
    if (text.trim()) overrides[channel] = text.trim();
  }
  return { value: { caption, overrides } };
}

// Only a URL the /media route minted: https on the social CDN host, on a
// series-<uuid> path, no query or fragment. Returns the URL and its kind.
function validateMediaUrl(raw) {
  if (raw === undefined || raw === null) return { value: null };
  const cdn = String(process.env.SOCIAL_MEDIA_CDN_DOMAIN || '').trim().toLowerCase();
  let url = null;
  try { url = new URL(String(raw)); } catch { url = null; }
  const minted = url && MINTED_PATH_RE.exec(url.pathname);
  if (!cdn || !url || url.protocol !== 'https:' || url.username || url.password
    || url.host.toLowerCase() !== cdn || url.search || url.hash || !minted) {
    return refuse('invalid_media_url', 'mediaUrl must be a URL that POST /media returned');
  }
  return { value: { url: url.toString(), kind: minted[1] === 'mp4' ? 'video' : 'image' } };
}

function validateMedia(body, channels) {
  const media = validateMediaUrl(body.mediaUrl);
  if (media.error) return media;
  if (body.isVideo !== undefined && typeof body.isVideo !== 'boolean') return refuse('invalid_is_video', 'isVideo must be a boolean');
  const isVideo = body.isVideo === true;
  if (isVideo && !media.value) return refuse('media_required', 'isVideo requires mediaUrl');
  if (media.value && (media.value.kind === 'video') !== isVideo) {
    return refuse('media_kind_mismatch', isVideo ? 'isVideo needs an .mp4 mediaUrl' : 'an .mp4 mediaUrl needs isVideo: true');
  }
  if (isVideo && channels.includes('gbp')) return refuse('video_not_supported_on_gbp', 'a video post cannot go to gbp');
  if (channels.includes('instagram') && !media.value) return refuse('media_required', 'instagram requires mediaUrl');
  return { value: { mediaUrl: media.value ? media.value.url : null, isVideo } };
}

// 'all' -> null (every GBP location). Otherwise one WAVES_LOCATIONS id, or a
// location name / mapped city, case-insensitive.
function validateGbpLocation(raw, channels) {
  if (!channels.includes('gbp')) return { value: null };
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!text) return refuse('unknown_gbp_location', 'gbpLocation is required when gbp is requested');
  if (text === 'all') return { value: null };
  const byId = WAVES_LOCATIONS.find((loc) => loc.id.toLowerCase() === text);
  const byName = WAVES_LOCATIONS.find((loc) => String(loc.name || '').toLowerCase() === text);
  const id = (byId || byName)?.id || CITY_TO_LOCATION[text];
  if (!id) return refuse('unknown_gbp_location', 'gbpLocation must be a location id, a service city, or "all"');
  return { value: [id] };
}

function validateSchedule(raw, now) {
  if (raw === undefined || raw === null) return { value: new Date(now) };
  const text = typeof raw === 'string' ? raw.trim() : '';
  const ms = ISO_WITH_OFFSET_RE.test(text) ? Date.parse(text) : NaN;
  if (!Number.isFinite(ms)) return refuse('invalid_schedule_date', 'scheduleDate must be ISO 8601 with a UTC offset');
  if (ms < now - MAX_PAST_MS) return refuse('schedule_date_in_past', 'scheduleDate is more than 1 hour in the past');
  if (ms > now + MAX_AHEAD_MS) return refuse('schedule_date_too_far', 'scheduleDate is more than 60 days ahead');
  return { value: new Date(ms) };
}

// The final copy per requested channel, judged by the same validateContent the
// publisher runs on its last text (pricing claims, compliance words, phone
// numbers, affiliate links, length limits).
function validateCopy(channelCopy) {
  const { validateContent } = require('./social-media');
  for (const [channel, text] of Object.entries(channelCopy)) {
    const limit = MAX_CHANNEL_CAPTION_CHARS[channel];
    if (limit && text.length > limit) return refuse('caption_too_long', `${channel} copy exceeds ${limit} chars`);
    const verdict = validateContent(text, channel);
    if (!verdict.valid) return refuse('content_rejected', `${channel}: ${verdict.issues.join('; ')}`);
  }
  return { value: true };
}

// Returns { error: { reason, detail } } or { value: { dryRun, row } }. `row` is
// the exact set of fields that gets stored (jsonb fields as plain values).
function validateSeriesPost(body, { now = Date.now() } = {}) {
  if (!isPlainObject(body)) return refuse('invalid_body', 'body must be a JSON object');
  const id = validateId(body.id);
  if (id.error) return id;
  const title = validateTitle(body.title, id.value);
  if (title.error) return title;
  const platforms = validatePlatforms(body.platforms);
  if (platforms.error) return platforms;
  const channels = platforms.value;
  const captions = validateCaptions(body);
  if (captions.error) return captions;
  const media = validateMedia(body, channels);
  if (media.error) return media;
  const gbp = validateGbpLocation(body.gbpLocation, channels);
  if (gbp.error) return gbp;
  const schedule = validateSchedule(body.scheduleDate, now);
  if (schedule.error) return schedule;
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return refuse('invalid_dry_run', 'dryRun must be a boolean');

  const { caption, overrides } = captions.value;
  const customContent = {};
  for (const channel of channels) customContent[channel] = overrides[channel] || caption;
  const copy = validateCopy(customContent);
  if (copy.error) return copy;

  const { mediaUrl, isVideo } = media.value;
  return {
    value: {
      dryRun: body.dryRun === true,
      row: {
        title: title.value,
        description: caption,
        source_type: SOURCE_TYPE,
        source_guid: `${SOURCE_TYPE}:${id.value}`,
        platforms_posted: channels,
        status: 'scheduled',
        publish_status: 'pending',
        scheduled_for: schedule.value.toISOString(),
        custom_content: customContent,
        image_url: isVideo ? null : mediaUrl,
        video_url: isVideo ? mediaUrl : null,
        gbp_location_ids: gbp.value,
      },
    },
  };
}

// The jsonb columns go in as JSON text: the pg driver turns a JS array into a
// Postgres array literal, which a jsonb column refuses.
function dbRow(row) {
  return {
    ...row,
    platforms_posted: JSON.stringify(row.platforms_posted),
    custom_content: JSON.stringify(row.custom_content),
    gbp_location_ids: row.gbp_location_ids ? JSON.stringify(row.gbp_location_ids) : null,
    created_at: new Date(),
  };
}

// The guid a body's id maps to, or null when the id is not valid (the full
// validation then refuses it).
function seriesGuidOf(body) {
  const id = isPlainObject(body) ? validateId(body.id) : refuse('invalid_body');
  return id.error ? null : `${SOURCE_TYPE}:${id.value}`;
}

// The stored row for a guid, as the route answers it, or null.
async function findSeriesPost(guid) {
  const stored = await db('social_media_posts').where({ source_guid: guid, source_type: SOURCE_TYPE }).first('id', 'scheduled_for');
  return stored ? { id: stored.id, scheduledFor: new Date(stored.scheduled_for).toISOString() } : null;
}

// Idempotent on source_guid (partial unique index idx_social_posts_series_guid_unique).
// Returns { id, deduped, scheduledFor }.
async function insertSeriesPost(row) {
  const [inserted] = await db('social_media_posts')
    .insert(dbRow(row))
    .onConflict(db.raw(`(source_guid) where source_type = '${SOURCE_TYPE}'`))
    .ignore()
    .returning(['id', 'scheduled_for']);
  const stored = inserted
    || await db('social_media_posts').where({ source_guid: row.source_guid, source_type: SOURCE_TYPE }).first('id', 'scheduled_for');
  if (!stored) throw new Error('series row neither inserted nor found');
  return {
    id: stored.id,
    deduped: !inserted,
    scheduledFor: new Date(stored.scheduled_for).toISOString(),
  };
}

module.exports = {
  SOURCE_TYPE, ID_RE, validateSeriesPost, insertSeriesPost, seriesGuidOf, findSeriesPost,
};
module.exports._private = { dbRow, validateGbpLocation, validateMediaUrl, validateSchedule };
