// GATE_RECAP_GLASSES_CLIPS (owner 2026-11-01): a camera-glasses clip over 20 s waits as `processing`
// (recap-media.confirmUpload). This turns each one into a 5-second `ready` clip: an AI picks the best
// 5-second window from frames taken every 2 s (Gemini, Claude fallback, the middle window last), ffmpeg
// cuts it with the sound removed, and the clip row then points at the cut. The tech's role and caption
// stay as tapped: the AI picks ONLY the time window and never writes customer text.
//
// Concurrency is recap-media's design: the clip row is locked FOR UPDATE and read again, the recap row is
// marked first (recap-pipeline.markRecapClipsChanged) and the clip changes after, in one transaction.
// Lock order is the clip row, then the recap row. S3 deletes run after the commit.
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const db = require('../../models/db');
const MODELS = require('../../config/models');
const gates = require('../../config/feature-gates');
const config = require('../../config');
const logger = require('../logger');
const { dispatchWithFallback } = require('../llm/call');
const { downloadTo, uploadFrom, runFfmpeg, deleteObject } = require('./recap-transcode');
const { roleInfo } = require('./recap-media');
const recapPipeline = require('./recap-pipeline');

const CLIP_SECONDS = 5;
const CUT_MS = CLIP_SECONDS * 1000;
const FRAME_EVERY_SECONDS = 2;
const MAX_FRAMES = 30;
const FRAME_WIDTH = 512;
const STALE_CUT_MS = 15 * 60 * 1000;

const gateOn = () => typeof gates.recapGlassesClipsLive === 'function' && gates.recapGlassesClipsLive();

// The latest start second a window can have inside a clip of this length.
const lastStart = (durationSeconds) => Math.max(0, Math.floor(durationSeconds) - CLIP_SECONDS);

// Fallback when no provider gives a usable answer: the middle window.
function middleWindowStart(durationSeconds) {
  return Math.max(0, Math.floor((durationSeconds - CLIP_SECONDS) / 2));
}

// The model's answer -> an integer start second inside the clip, or null (invalid).
function parseWindowStart(text, durationSeconds) {
  const match = String(text || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  const start = parsed?.start_second;
  if (!Number.isInteger(start) || start < 0 || start > lastStart(durationSeconds)) return null;
  return start;
}

function buildPickPrompt({ caption, durationSeconds, frameCount }) {
  return [
    'These frames come from a pest-control technician\'s camera-glasses video, one frame every 2 seconds (the label before each frame gives its second).',
    `The technician tagged the clip: "${caption}".`,
    `The clip is ${Math.floor(durationSeconds)} seconds long. Choose the start second of the ${CLIP_SECONDS}-second window that best shows the work to the customer: a clear view of the treated area or of the action.`,
    'Avoid windows that show people\'s faces, the inside of a home seen through a window, blur or shake, or only sky or ground.',
    `Answer with JSON only, for example {"start_second": 12}. The number is an integer from 0 to ${lastStart(durationSeconds)}. There are ${frameCount} frames.`,
  ].join('\n');
}

// Ask the two-provider dispatcher for the window. A failed or invalid answer is not an error: the
// deterministic middle window answers instead.
async function pickWindowStart({ clip, frames, durationSeconds }) {
  const fallback = middleWindowStart(durationSeconds);
  if (durationSeconds <= CLIP_SECONDS || !frames.length) return { start: 0, source: 'short_clip' };
  try {
    const generated = await dispatchWithFallback(
      MODELS.TEXT_POLICIES.recapClipPick,
      {
        laneId: 'recap_clip_pick',
        text: buildPickPrompt({ caption: roleInfo(clip.role).caption, durationSeconds, frameCount: frames.length }),
        images: frames,
        jsonMode: false,
        maxTokens: 2048,
        temperature: 0.2,
      },
      { validate: (candidate) => (parseWindowStart(candidate.text, durationSeconds) == null ? 'invalid_window' : null) },
    );
    const start = generated?.ok ? parseWindowStart(generated.text, durationSeconds) : null;
    if (start != null) return { start, source: 'ai' };
  } catch (err) {
    logger.warn(`[recap-clip-cut] window pick failed for clip ${clip.id}: ${err.message}`);
  }
  return { start: fallback, source: 'middle' };
}

// One frame every 2 s, 512 px wide, JPEG, at most 30; returned as labelled dispatcher images.
async function extractFrames(inPath, dir) {
  await runFfmpeg([
    '-y', '-i', inPath, '-an',
    '-vf', `fps=1/${FRAME_EVERY_SECONDS},scale=${FRAME_WIDTH}:-2`,
    '-frames:v', String(MAX_FRAMES), '-q:v', '5',
    path.join(dir, 'frame-%03d.jpg'),
  ]);
  const names = (await fsp.readdir(dir)).filter((n) => /^frame-\d+\.jpg$/.test(n)).sort();
  const frames = [];
  for (const [i, name] of names.entries()) {
    frames.push({
      data: (await fsp.readFile(path.join(dir, name))).toString('base64'),
      mimeType: 'image/jpeg',
      label: `Frame at ${i * FRAME_EVERY_SECONDS}s`,
    });
  }
  return frames;
}

// Download, pick, cut, upload. Returns the cut's key and size; the caller changes the row.
async function cutClip(clip, dir) {
  const inPath = path.join(dir, 'original');
  const outPath = path.join(dir, 'cut.mp4');
  await downloadTo(clip.s3_key, inPath);
  const frames = await extractFrames(inPath, dir);
  const durationSeconds = Number(clip.duration_ms) > 0 ? clip.duration_ms / 1000 : frames.length * FRAME_EVERY_SECONDS;
  const { start, source } = await pickWindowStart({ clip, frames, durationSeconds });
  await runFfmpeg([
    '-y', '-ss', String(start), '-i', inPath, '-t', String(CLIP_SECONDS),
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart',
    outPath,
  ]);
  // A key of its own per attempt: two attempts on one clip (a stale-cutting recovery) never share a
  // cut, so neither can delete the cut the other's row points to.
  const key = `${clip.s3_key}.cut-${crypto.randomUUID().slice(0, 8)}.mp4`;
  await uploadFrom(key, outPath, 'video/mp4');
  return { key, bytes: (await fsp.stat(outPath)).size, start, source };
}

// Finish in one transaction, like recap-media: lock the clip row and read it again; a clip the tech
// removed meanwhile (gone, or no longer `cutting` on its original) changes nothing. Otherwise mark the
// recap first, then point the clip at the cut.
async function finishCut(knex, clip, cut, now) {
  return knex.transaction(async (trx) => {
    const current = await trx('service_media').where({ id: clip.id }).forUpdate().first();
    if (!current || current.status !== 'cutting' || current.s3_key !== clip.s3_key) return { abandoned: true };
    await recapPipeline.markRecapClipsChanged(current.scheduled_service_id, { ...current, status: 'ready' }, { knex: trx, now });
    await trx('service_media').where({ id: clip.id }).update({
      s3_key: cut.key, content_type: 'video/mp4', status: 'ready', duration_ms: CUT_MS, bytes: cut.bytes, updated_at: now,
    });
    return { abandoned: false };
  });
}

async function deleteQuietly(key, why) {
  try { await deleteObject(key); } catch (err) { logger.warn(`[recap-clip-cut] S3 delete failed for ${key} (${why}): ${err.message}`); }
}

// Returns 'ready' | 'abandoned' | 'failed'. Never throws.
async function processClip(knex, clip, now) {
  let dir = null;
  let cut = null;
  try {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'recap-cut-'));
    cut = await cutClip(clip, dir);
    const outcome = await finishCut(knex, clip, cut, now);
    if (outcome.abandoned) {
      await deleteQuietly(cut.key, 'clip changed or removed while cutting');
      return 'abandoned';
    }
    await deleteQuietly(clip.s3_key, 'original after the cut');
    logger.info(`[recap-clip-cut] clip ${clip.id} cut at ${cut.start}s (${cut.source})`);
    return 'ready';
  } catch (err) {
    logger.warn(`[recap-clip-cut] clip ${clip.id} failed: ${err.message}`);
    if (cut) await deleteQuietly(cut.key, 'cut not used');
    try {
      await knex('service_media').where({ id: clip.id, status: 'cutting' }).update({ status: 'failed', updated_at: new Date() });
    } catch (markErr) {
      logger.warn(`[recap-clip-cut] could not mark clip ${clip.id} failed: ${markErr.message}`);
    }
    return 'failed';
  } finally {
    if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Cut up to `limit` waiting clips. Gate off: returns before any query.
async function processPendingClipCuts({ limit = 2, now = new Date() } = {}, knex = db) {
  const summary = { claimed: 0, ready: 0, failed: 0, abandoned: 0 };
  if (!gateOn() || !config.s3?.bucket) return summary;

  await knex.raw(
    "UPDATE service_media SET status = 'processing', updated_at = ? WHERE status = 'cutting' AND updated_at < ?",
    [now, new Date(now.getTime() - STALE_CUT_MS)],
  );
  const claimed = await knex.raw(`
    UPDATE service_media SET status = 'cutting', updated_at = ?
    WHERE id IN (
      SELECT id FROM service_media WHERE status = 'processing' ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT ?
    )
    RETURNING *
  `, [now, limit]);

  // UPDATE ... RETURNING has no order: cut the oldest clip first.
  for (const clip of [...(claimed.rows || [])].sort((a, b) => a.created_at - b.created_at)) {
    summary.claimed += 1;
    summary[await processClip(knex, clip, now)] += 1;
  }
  return summary;
}

module.exports = { processPendingClipCuts, middleWindowStart, parseWindowStart };
