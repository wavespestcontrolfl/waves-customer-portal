/**
 * video-generator.js — Veo video generation for social Reels.
 *
 * Gemini API long-running flow: POST models/{model}:predictLongRunning →
 * poll operations/{name} until done → download the generated MP4 from the
 * files API. Chain: Veo Fast first (generates in under a minute, ~$0.15/s),
 * stepping through VIDEO_CHAIN on 404/model-retirement so an ID going away
 * degrades cost/quality, never availability.
 *
 * Returns { buffer, mimeType, model } or throws — callers (the social
 * creative engine) catch and treat a throw as "no video variant today".
 */

const logger = require('../logger');
const { GEMINI_VIDEO_FAST, GEMINI_VIDEO_QUALITY } = require('../../config/models');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Fast first (cost + latency); QUALITY only reached if the fast ID is gone.
const VIDEO_CHAIN = [GEMINI_VIDEO_FAST, GEMINI_VIDEO_QUALITY];

// Google documents Veo request latency up to 6 MINUTES at peak
// (ai.google.dev/gemini-api/docs/veo#limitations) — abandoning a started
// operation still pays for it, so the budget must cover the documented peak.
// Generation runs on the 6:30 AM cron; a manual admin "Run Draft" may outlive
// its proxy timeout, but the run completes server-side and lands in the queue.
const DEFAULT_TIMEOUT_MS = Number(process.env.SOCIAL_VIDEO_TIMEOUT_MS) > 0
  ? Number(process.env.SOCIAL_VIDEO_TIMEOUT_MS)
  : 6.5 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Model-unavailable (retired preview ID, not-enabled model) → try next in
// chain. Anything else (quota, safety block, bad request) applies to every
// Veo model equally, so failing fast beats burning the timeout budget twice.
function isModelUnavailable(status, body = '') {
  if (status === 404) return true;
  return status === 400 && /model|not found|not supported/i.test(String(body));
}

async function startOperation({ model, prompt, aspectRatio, fetchFn }) {
  const res = await fetchFn(`${API_BASE}/models/${model}:predictLongRunning`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { aspectRatio },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Veo start ${res.status}: ${body.slice(0, 240)}`);
    err.status = res.status;
    err.body = body;
    return { error: err };
  }
  const data = await res.json();
  if (!data?.name) return { error: new Error('Veo start returned no operation name') };
  return { operationName: data.name };
}

async function pollOperation({ operationName, deadline, fetchFn, pollIntervalMs = POLL_INTERVAL_MS }) {
  let last = null;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const res = await fetchFn(`${API_BASE}/${operationName}`, {
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Veo poll ${res.status}: ${body.slice(0, 240)}`);
    }
    last = await res.json();
    if (last?.done) {
      if (last.error) {
        throw new Error(`Veo operation failed: ${JSON.stringify(last.error).slice(0, 240)}`);
      }
      return last;
    }
  }
  throw new Error(`Veo operation timed out (last state: ${JSON.stringify(last?.metadata || {}).slice(0, 120)})`);
}

// The response shape has shifted across Veo releases — accept both the
// generatedSamples and generatedVideos spellings, and inline bytes if present.
function extractVideo(operation) {
  const resp = operation?.response?.generateVideoResponse || operation?.response || {};
  const sample = resp.generatedSamples?.[0] || resp.generatedVideos?.[0] || null;
  if (!sample) return null;
  const video = sample.video || sample;
  if (video?.uri) return { uri: video.uri };
  const inline = video?.videoBytes || video?.bytesBase64Encoded;
  if (inline) return { base64: inline };
  return null;
}

async function downloadVideo({ uri, fetchFn }) {
  // Files-API URIs require the API key; some already carry query params.
  const res = await fetchFn(uri, {
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`Veo download ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * generate({ prompt, aspectRatio = '9:16', timeoutMs, fetchFn })
 * → { buffer, mimeType: 'video/mp4', model }
 * Throws if every model in the chain failed.
 */
async function generate({ prompt, aspectRatio = '9:16', timeoutMs = DEFAULT_TIMEOUT_MS, pollIntervalMs, fetchFn = fetch } = {}) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
  if (!prompt) throw new Error('video prompt required');

  const attempts = [];
  for (const model of VIDEO_CHAIN) {
    const deadline = Date.now() + timeoutMs;
    const started = await startOperation({ model, prompt, aspectRatio, fetchFn });
    if (started.error) {
      attempts.push({ model, error: started.error.message });
      if (isModelUnavailable(started.error.status, started.error.body)) {
        logger.warn(`[video-generator] ${model} unavailable — trying next in chain`);
        continue;
      }
      break; // non-model error (quota/safety/bad request) — same for the whole chain
    }
    try {
      const operation = await pollOperation({ operationName: started.operationName, deadline, fetchFn, pollIntervalMs });
      const video = extractVideo(operation);
      if (!video) throw new Error('Veo operation completed without a video payload');
      const buffer = video.base64
        ? Buffer.from(video.base64, 'base64')
        : await downloadVideo({ uri: video.uri, fetchFn });
      logger.info(`[video-generator] generated via ${model} (${Math.round(buffer.length / 1024)}KB)`);
      return { buffer, mimeType: 'video/mp4', model };
    } catch (err) {
      attempts.push({ model, error: err.message });
      break; // generation started but failed — retrying a second model doubles cost/latency
    }
  }

  const summary = attempts.map((a) => `${a.model}: ${a.error}`).join(' | ');
  throw new Error(`video-generator: all attempts failed (${summary})`);
}

module.exports = {
  generate,
  _internals: {
    VIDEO_CHAIN,
    DEFAULT_TIMEOUT_MS,
    extractVideo,
    isModelUnavailable,
  },
};
