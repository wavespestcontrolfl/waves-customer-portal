/**
 * Knowledge-index ingestion — sync + embed passes.
 *
 * syncKnowledgeIndex():
 *  1. SYNC: per connector, load docs → chunk → sha256-hash → diff against the
 *     stored rows for that source: insert new chunks, update changed ones
 *     (resetting embedding to NULL), delete vanished ones. A connector that
 *     errors is skipped — its stored rows stay untouched.
 *  2. EMBED: rows with embedding IS NULL are embedded in batches (bounded per
 *     run). No OPENAI_API_KEY / provider outage leaves rows pending — the
 *     chunk is still full-text-searchable, and the next run retries.
 *
 * Runs nightly via scheduler.js under runExclusive('knowledge-index-sync')
 * (advisory lock + job_health recording), and manually via
 * scripts/backfill-knowledge-embeddings.js.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { chunkDocument } = require('./chunker');
const { CONNECTORS, loadCorpus } = require('./connectors');
const { embedTexts } = require('../llm/embed');

const EMBED_BATCH_SIZE = 64;
const DEFAULT_MAX_EMBEDS_PER_RUN = 2000;

const hashChunk = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const toVectorLiteral = (vector) => `[${vector.join(',')}]`;

// The two corpora the lawn program feeds: each keeps a marker of the program its chunks hold.
const LAWN_PROGRAM_CORPORA = new Set(['protocol', 'kb']);

async function syncCorpus(connector) {
  // The lawn program this corpus is about to load, read before the load. The marker is
  // written below, by whoever runs the sync (nightly or the lawn reconcile), and only after
  // a sync that really ran.
  const lawnKnowledge = LAWN_PROGRAM_CORPORA.has(connector.source) ? require('../knowledge-base') : null;
  const lawnProgram = lawnKnowledge ? await lawnKnowledge.lawnCorpusProgram(connector.source) : null;
  const docs = await loadCorpus(connector);
  if (docs === null) return { source: connector.source, skipped: true };

  const stats = { source: connector.source, docs: docs.length, chunks: 0, added: 0, updated: 0, deleted: 0, unchanged: 0 };

  const existing = await db('knowledge_embeddings')
    .where({ source: connector.source })
    .select('id', 'source_id', 'chunk_index', 'content_hash');
  const existingByKey = new Map(existing.map((r) => [`${r.source_id}\u0000${r.chunk_index}`, r]));

  // Constraint guard: a connector emitting two docs with the same sourceId
  // (versioned tables, bad joins) must degrade to keep-first + warn — never
  // a unique-constraint abort that kills the corpus sync.
  const seenDocIds = new Set();
  const uniqueDocs = [];
  for (const doc of docs) {
    if (seenDocIds.has(doc.sourceId)) {
      logger.warn(`[knowledge-index] ${connector.source}: duplicate sourceId '${doc.sourceId}' — keeping first`);
      continue;
    }
    seenDocIds.add(doc.sourceId);
    uniqueDocs.push(doc);
  }

  const seen = new Set();
  for (const doc of uniqueDocs) {
    const chunks = chunkDocument(doc);
    stats.chunks += chunks.length;
    for (const chunk of chunks) {
      const key = `${doc.sourceId}\u0000${chunk.chunkIndex}`;
      seen.add(key);
      const hash = hashChunk(chunk.text);
      const row = existingByKey.get(key);
      if (row && row.content_hash === hash) { stats.unchanged += 1; continue; }
      const record = {
        title: String(doc.title || '').slice(0, 500),
        content: chunk.text,
        metadata: JSON.stringify(doc.metadata || {}),
        content_hash: hash,
        embedding: null,
        embedded_at: null,
        source_updated_at: doc.sourceUpdatedAt || null,
        updated_at: db.fn.now(),
      };
      if (row) {
        await db('knowledge_embeddings').where({ id: row.id }).update(record);
        stats.updated += 1;
      } else {
        await db('knowledge_embeddings').insert({
          source: connector.source,
          source_id: String(doc.sourceId).slice(0, 200),
          chunk_index: chunk.chunkIndex,
          ...record,
        });
        stats.added += 1;
      }
    }
  }

  const staleIds = existing.filter((r) => !seen.has(`${r.source_id}\u0000${r.chunk_index}`)).map((r) => r.id);
  if (staleIds.length) {
    await db('knowledge_embeddings').whereIn('id', staleIds).del();
    stats.deleted = staleIds.length;
  }

  if (lawnKnowledge) await lawnKnowledge.recordLawnCorpusProgram(connector.source, lawnProgram);
  return stats;
}

async function embedPending({ maxEmbeds = DEFAULT_MAX_EMBEDS_PER_RUN } = {}) {
  const result = { embedded: 0, failed: 0, pending: 0, reason: null };
  for (let remaining = maxEmbeds; remaining > 0; ) {
    const batch = await db('knowledge_embeddings')
      .whereNull('embedding')
      .orderBy('created_at', 'asc')
      .limit(Math.min(EMBED_BATCH_SIZE, remaining))
      .select('id', 'content');
    if (!batch.length) break;

    const embed = await embedTexts(batch.map((r) => r.content));
    if (!embed.ok) {
      // no_key / provider outage: rows stay pending, next run retries.
      result.reason = embed.reason;
      result.failed = batch.length;
      break;
    }
    for (let i = 0; i < batch.length; i += 1) {
      await db('knowledge_embeddings').where({ id: batch[i].id }).update({
        embedding: db.raw('?::vector', [toVectorLiteral(embed.vectors[i])]),
        embedded_at: db.fn.now(),
        updated_at: db.fn.now(),
      });
    }
    result.embedded += batch.length;
    remaining -= batch.length;
  }
  const [{ count }] = await db('knowledge_embeddings').whereNull('embedding').count('id as count');
  result.pending = parseInt(count, 10);
  return result;
}

async function syncKnowledgeIndex({ maxEmbeds } = {}) {
  const perSource = [];
  for (const connector of CONNECTORS) {
    try {
      perSource.push(await syncCorpus(connector));
    } catch (err) {
      // One corpus's upsert failure must not kill the rest of the run.
      logger.error(`[knowledge-index] sync of ${connector.source} failed: ${err.message}`);
      perSource.push({ source: connector.source, skipped: true, error: err.message });
    }
  }
  const embeds = await embedPending({ maxEmbeds });
  const summary = { perSource, embeds };
  logger.info(`[knowledge-index] sync complete: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = { syncKnowledgeIndex, syncCorpus, embedPending, hashChunk, toVectorLiteral };
