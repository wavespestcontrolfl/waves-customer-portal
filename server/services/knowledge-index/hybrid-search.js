/**
 * Hybrid knowledge search — vector + full-text lists fused with reciprocal
 * rank fusion (RRF, k=60), the Cerebras pattern sized for this corpus.
 *
 * Ranked lists (each independently best-effort):
 *   1. vector      — cosine over knowledge_embeddings (paraphrase recall)
 *   2. chunk FTS   — websearch_to_tsquery over knowledge_embeddings chunks
 *                    (covers EVERY corpus, incl. services/protocols/labels)
 *   3. kb FTS      — KnowledgeBridge.unifiedSearch claudeopedia list (lane A1)
 *   4. wiki FTS    — KnowledgeBridge.unifiedSearch wiki list (lane A1)
 *
 * Chunks collapse to their parent document (best rank per list) BEFORE
 * fusion, results are capped per source type so one corpus cannot flood the
 * top, and each returned doc carries its best-matching chunk as the snippet.
 *
 * No recency decay here BY DESIGN: every v1 corpus is curated/canonical
 * (protocols, labels, KB). Decay arrives with lane B's observational
 * resolution artifacts, where staleness is real.
 *
 * Trust gates: the wiki corpus is trusted-only at INGEST (connectors) and the
 * A1 lists enforce trustedOnly at query time, so unreviewed pages can't
 * surface through any list.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { embedQuery } = require('../llm/embed');
const KnowledgeBridge = require('../knowledge-bridge');
const { toVectorLiteral } = require('./ingest');

const RRF_K = 60;
const LIST_LIMIT = 20;
// Chunk-level lists overfetch so rrfFuse's per-document collapse still sees
// LIST_LIMIT distinct documents even when one long document matches with
// many chunks (fuse counts ranks per document, not per chunk).
const CHUNK_FETCH_LIMIT = 100;
// Cosine-similarity floor for the vector list: without it, an off-topic
// query still "matches" its nearest 20 chunks and vector-only rows surface
// as unrelated citations. 0.30 is a conservative floor for
// text-embedding-3-small — on-topic pairs typically score well above it.
const MIN_VECTOR_SIMILARITY = 0.30;
const MAX_PER_SOURCE = 6;

const docKey = (source, sourceId) => `${source}:${sourceId}`;

/**
 * rrfFuse(lists) — lists: Array<Array<{ key, ...payload }>> (each ranked,
 * best first). Returns [{ key, score, hits, ...firstPayloadSeen }] sorted by
 * fused score. Pure — unit-tested directly.
 */
function rrfFuse(lists, { k = RRF_K } = {}) {
  const docs = new Map();
  for (const list of lists) {
    const seenInList = new Set();
    let rank = 0;
    for (const item of list || []) {
      if (!item || !item.key || seenInList.has(item.key)) continue; // chunk collapse: best rank only
      seenInList.add(item.key);
      rank += 1;
      const entry = docs.get(item.key) || { key: item.key, score: 0, hits: 0, payload: item };
      entry.score += 1 / (k + rank);
      entry.hits += 1;
      docs.set(item.key, entry);
    }
  }
  return [...docs.values()]
    .sort((a, b) => b.score - a.score)
    .map((e) => ({ key: e.key, score: e.score, hits: e.hits, ...e.payload }));
}

async function vectorList(query) {
  const embedded = await embedQuery(query);
  if (!embedded.ok) return { list: [], usedVector: false, reason: embedded.reason };
  const literal = toVectorLiteral(embedded.vector);
  const rows = await db('knowledge_embeddings')
    .whereNotNull('embedding')
    .whereRaw('1 - (embedding <=> ?::vector) >= ?', [literal, MIN_VECTOR_SIMILARITY])
    .select('source', 'source_id', 'title', 'content', 'metadata',
      db.raw('1 - (embedding <=> ?::vector) as similarity', [literal]))
    .orderByRaw('embedding <=> ?::vector', [literal])
    .limit(CHUNK_FETCH_LIMIT);
  return {
    usedVector: true,
    list: rows.map((r) => ({ key: docKey(r.source, r.source_id), source: r.source, sourceId: r.source_id, title: r.title, snippet: r.content, metadata: r.metadata })),
  };
}

async function chunkFtsList(query) {
  const rows = await db('knowledge_embeddings')
    .whereRaw("search_vector @@ websearch_to_tsquery('english', ?)", [query])
    .select('source', 'source_id', 'title', 'content', 'metadata',
      db.raw("ts_rank(search_vector, websearch_to_tsquery('english', ?)) as rank", [query]))
    .orderBy('rank', 'desc')
    .limit(CHUNK_FETCH_LIMIT);
  return rows.map((r) => ({ key: docKey(r.source, r.source_id), source: r.source, sourceId: r.source_id, title: r.title, snippet: r.content, metadata: r.metadata }));
}

/**
 * hybridKnowledgeSearch(query, { limit }) →
 *   { results: [{ source, sourceId, title, snippet, score, lists }], usedVector }
 * or null when the search cannot run at all (caller falls back to lane A1).
 */
async function hybridKnowledgeSearch(query, { limit = 15 } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;

  try {
    const [vector, chunkFts, unified] = await Promise.all([
      vectorList(q).catch((err) => { logger.warn(`[knowledge-index] vector list failed: ${err.message}`); return { list: [], usedVector: false }; }),
      chunkFtsList(q).catch((err) => { logger.warn(`[knowledge-index] chunk FTS list failed: ${err.message}`); return []; }),
      KnowledgeBridge.unifiedSearch(q, { limit: LIST_LIMIT, trustedOnly: true })
        .catch((err) => { logger.warn(`[knowledge-index] unified list failed: ${err.message}`); return { claudeopedia: [], wiki: [] }; }),
    ]);

    const kbList = (unified.claudeopedia || []).map((r) => ({ key: docKey('kb', r.slug), source: 'kb', sourceId: r.slug, title: r.title, snippet: null, metadata: { category: r.category, confidence: r.confidence } }));
    const wikiList = (unified.wiki || []).map((r) => ({ key: docKey('wiki', r.slug), source: 'wiki', sourceId: r.slug, title: r.title, snippet: null, metadata: { category: r.category, confidence: r.confidence } }));

    const fused = rrfFuse([vector.list, chunkFts, kbList, wikiList]);
    if (!fused.length) return { results: [], usedVector: vector.usedVector };

    const perSource = new Map();
    const results = [];
    for (const doc of fused) {
      const used = perSource.get(doc.source) || 0;
      if (used >= MAX_PER_SOURCE) continue;
      perSource.set(doc.source, used + 1);
      results.push({
        source: doc.source,
        sourceId: doc.sourceId,
        title: doc.title,
        snippet: doc.snippet ? String(doc.snippet).slice(0, 500) : null,
        score: Number(doc.score.toFixed(5)),
        lists: doc.hits,
      });
      if (results.length >= limit) break;
    }
    return { results, usedVector: vector.usedVector };
  } catch (err) {
    logger.error(`[knowledge-index] hybrid search failed: ${err.message}`);
    return null;
  }
}

module.exports = { hybridKnowledgeSearch, rrfFuse, RRF_K };
