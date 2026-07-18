/**
 * Embedding client for the knowledge index (lane A2).
 *
 * Same fail-closed contract as llm/call.js — every function NEVER throws and
 * returns a uniform shape:
 *
 *   { ok: true,  vectors, model }        // vectors[i] aligns with texts[i]
 *   { ok: false, reason: 'no_key' | 'openai_<status>' | 'bad_response' | 'error' }
 *
 * SINGLE provider by design (see the OPENAI_EMBEDDING note in config/models.js):
 * an embedding space is only comparable to itself, so there is no cross-provider
 * fallback — callers degrade to full-text search on { ok: false }.
 */

const logger = require('../logger');
const { OPENAI_EMBEDDING, EMBEDDING_DIMS } = require('../../config/models');

const OPENAI_EMBEDDINGS_API = 'https://api.openai.com/v1/embeddings';
const DEFAULT_TIMEOUT_MS = 60 * 1000;

// OpenAI accepts up to 2048 inputs per request; callers batch well below that
// (ingest batches at 64). Guarded here so a caller bug can't 400 the lane.
const MAX_INPUTS_PER_REQUEST = 256;

async function embedTexts(texts, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!process.env.OPENAI_API_KEY) return { ok: false, reason: 'no_key' };
  const input = (texts || []).map((t) => String(t || '').slice(0, 24000));
  if (!input.length) return { ok: true, vectors: [], model: OPENAI_EMBEDDING };
  if (input.length > MAX_INPUTS_PER_REQUEST) return { ok: false, reason: 'too_many_inputs' };
  try {
    const resp = await fetch(OPENAI_EMBEDDINGS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_EMBEDDING, input, dimensions: EMBEDDING_DIMS }),
      ...(timeoutMs && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (!resp.ok) { logger.warn(`[embed] OpenAI ${resp.status}`); return { ok: false, reason: `openai_${resp.status}` }; }
    const data = await resp.json();
    const rows = Array.isArray(data?.data) ? data.data : null;
    if (!rows || rows.length !== input.length) return { ok: false, reason: 'bad_response' };
    // index-sort defensively — the API documents order-preserving output, but
    // a misaligned vector written to the wrong row would poison retrieval.
    const vectors = rows
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((r) => r.embedding);
    if (vectors.some((v) => !Array.isArray(v) || v.length !== EMBEDDING_DIMS)) {
      return { ok: false, reason: 'bad_response' };
    }
    return { ok: true, vectors, model: OPENAI_EMBEDDING };
  } catch (err) {
    logger.error(`[embed] embedTexts failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

async function embedQuery(text, options = {}) {
  const result = await embedTexts([text], options);
  if (!result.ok) return result;
  return { ok: true, vector: result.vectors[0], model: result.model };
}

module.exports = { embedTexts, embedQuery, OPENAI_EMBEDDINGS_API };
