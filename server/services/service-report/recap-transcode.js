// Transcodes iPhone-native captures into formats Remotion's Chromium can decode:
// HEVC/MOV video -> H.264 mp4, HEIC/HEIF photo -> jpg. Runs at RENDER time on the same
// host as the renderer (where ffmpeg + libheif live). Best-effort: if the host lacks
// ffmpeg/libheif or a file is corrupt it returns null, so the caller drops that clip
// and the recap still renders. Transcoded derivatives are cached in S3 (keyed off the
// original) so re-renders don't repeat the work.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const config = require('../../config');
const logger = require('../logger');

const s3 = new S3Client({
  region: config.s3?.region,
  credentials: config.s3?.accessKeyId
    ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey }
    : undefined,
});
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const RENDERABLE_VIDEO = new Set(['video/mp4', 'video/webm']);
const RENDERABLE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Renderable by stored content-type; fall back to the s3 key extension for older rows
// that predate the content_type column.
function isRenderable(contentType, mediaType, s3Key) {
  const ct = String(contentType || '').toLowerCase();
  if (ct) return mediaType === 'image' ? RENDERABLE_IMAGE.has(ct) : RENDERABLE_VIDEO.has(ct);
  const ext = String(s3Key || '').toLowerCase().split('.').pop();
  return mediaType === 'image'
    ? ['jpg', 'jpeg', 'png', 'webp'].includes(ext)
    : ['mp4', 'webm'].includes(ext);
}

async function s3Exists(key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: config.s3.bucket, Key: key })); return true; }
  catch { return false; }
}

async function downloadTo(key, filePath) {
  const obj = await s3.send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: key }));
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);
    obj.Body.on('error', reject);
    ws.on('error', reject);
    ws.on('finish', resolve);
    obj.Body.pipe(ws);
  });
}

async function uploadFrom(key, filePath, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: config.s3.bucket, Key: key, Body: fs.createReadStream(filePath),
    ContentType: contentType, CacheControl: 'private, max-age=0, no-cache',
  }));
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d.toString(); if (err.length > 4000) err = err.slice(-4000); });
    proc.on('error', reject); // ffmpeg not installed / not on PATH
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.slice(-300)}`))));
  });
}

// Returns a renderable S3 key (transcoding iPhone formats if needed), or null when the
// clip can't be made renderable on this host (so the caller drops it from the recap).
async function ensureRenderable({ s3Key, contentType, mediaType } = {}) {
  if (!s3Key || !config.s3?.bucket) return s3Key || null;
  const type = mediaType === 'image' ? 'image' : 'video';
  if (isRenderable(contentType, type, s3Key)) return s3Key;

  const derivedKey = `${s3Key}.r.${type === 'image' ? 'jpg' : 'mp4'}`;
  if (await s3Exists(derivedKey)) return derivedKey; // cached from a prior render

  const inPath = path.join(os.tmpdir(), `recap-in-${crypto.randomUUID()}`);
  const outPath = path.join(os.tmpdir(), `recap-out-${crypto.randomUUID()}.${type === 'image' ? 'jpg' : 'mp4'}`);
  try {
    await downloadTo(s3Key, inPath);
    if (type === 'image') {
      // .rotate() with no arg applies EXIF orientation so portrait iPhone shots aren't sideways.
      const sharp = require('sharp');
      await sharp(inPath).rotate().jpeg({ quality: 86 }).toFile(outPath);
    } else {
      // H.264 + yuv420p for broad <video> compatibility; strip audio (clips are muted
      // b-roll under the recap's music track); +faststart for progressive playback.
      await runFfmpeg(['-y', '-i', inPath, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', outPath]);
    }
    await uploadFrom(derivedKey, outPath, type === 'image' ? 'image/jpeg' : 'video/mp4');
    return derivedKey;
  } catch (err) {
    logger.warn(`[recap-transcode] could not transcode ${s3Key} (${contentType || 'unknown'}): ${err.message} — excluding from recap`);
    return null;
  } finally {
    fsp.unlink(inPath).catch(() => {});
    fsp.unlink(outPath).catch(() => {});
  }
}

module.exports = { ensureRenderable, isRenderable };
