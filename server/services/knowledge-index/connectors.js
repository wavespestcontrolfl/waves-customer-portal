/**
 * Knowledge-index connectors — one loader per corpus.
 *
 * Each connector returns [{ sourceId, title, content, metadata, sourceUpdatedAt }]
 * for ingest.js to chunk, hash, and upsert into knowledge_embeddings. Loaders
 * are read-only and defensive: a connector that throws is skipped for the run
 * (logged), never fatal to the sync.
 *
 * v1 corpus decisions (scope doc, Adam-approved 2026-07-18):
 *  - blog_posts EXCLUDED (marketing voice pollutes ops answers)
 *  - SMS/email marketing templates EXCLUDED (prep guides ARE included)
 *  - wiki: TRUSTED pages only (same review gate every agent read uses)
 *  - kb: active rows, wiki-sync mirrors EXCLUDED (their source page is
 *    already indexed — mirrors would double-hit every wiki topic)
 */

const fs = require('fs');
const path = require('path');
const db = require('../../models/db');
const logger = require('../logger');
const { TRUSTED_STATUSES } = require('../agronomic-wiki');

const clean = (v) => String(v || '').trim();
const joinParts = (parts) => parts.map(clean).filter(Boolean).join('\n\n');

// ── wiki: knowledge_entries (agronomic wiki, trusted only) ──────────
async function loadWiki() {
  const rows = await db('knowledge_entries')
    .whereIn('review_status', TRUSTED_STATUSES)
    .select('slug', 'title', 'category', 'summary', 'content', 'confidence', 'data_point_count', 'updated_at');
  return rows
    .filter((r) => !clean(r.content).includes('*Pending AI generation'))
    .map((r) => ({
      sourceId: r.slug,
      title: r.title,
      content: joinParts([r.summary, r.content]),
      metadata: { category: r.category, confidence: r.confidence, dataPoints: r.data_point_count },
      sourceUpdatedAt: r.updated_at,
    }));
}

// ── kb: knowledge_base (Claudeopedia, active, no wiki-sync mirrors) ─
async function loadKb() {
  const rows = await db('knowledge_base')
    .where({ status: 'active' })
    .whereNot({ source: 'wiki-sync' })
    .select('slug', 'title', 'category', 'summary', 'content', 'confidence', 'updated_at');
  return rows.map((r) => ({
    sourceId: r.slug,
    title: r.title,
    content: joinParts([r.summary, r.content]),
    metadata: { category: r.category, confidence: r.confidence },
    sourceUpdatedAt: r.updated_at,
  }));
}

// ── service: services catalog ───────────────────────────────────────
async function loadServices() {
  const rows = await db('services')
    .select('service_key', 'name', 'short_name', 'description', 'category', 'subcategory', 'frequency', 'visits_per_year', 'updated_at');
  return rows.map((r) => ({
    sourceId: r.service_key,
    title: r.name,
    content: joinParts([
      r.description,
      r.frequency ? `Frequency: ${r.frequency}${r.visits_per_year ? ` (${r.visits_per_year} visits/year)` : ''}` : '',
    ]),
    metadata: { category: r.category, subcategory: r.subcategory, shortName: r.short_name },
    sourceUpdatedAt: r.updated_at,
  }));
}

// ── protocol: server/config/protocols.json (static by design) ──────
function renderVisit(v) {
  const parts = [`Visit ${v.visit}${v.month ? ` (${v.month})` : ''}`];
  if (v.primary) parts.push(`Primary: ${v.primary}`);
  if (v.secondary) parts.push(`Secondary: ${v.secondary}`);
  if (v.notes) parts.push(`Notes: ${v.notes}`);
  return parts.join('. ');
}

function loadProtocols() {
  // Require inside the loader so a malformed JSON edit breaks one corpus,
  // not module load of every connector.
   
  const protocols = require('../../config/protocols.json');
  const docs = [];
  const walk = (node, keyPath) => {
    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== 'object') continue;
      const fullKey = keyPath ? `${keyPath}.${key}` : key;
      if (Array.isArray(value.visits)) {
        docs.push({
          sourceId: fullKey,
          title: `${value.name || fullKey} protocol`,
          content: joinParts([
            value.notes,
            ...value.visits.map(renderVisit),
            Array.isArray(value.safety_rules) ? `Safety rules: ${value.safety_rules.join(' ')}` : '',
          ]),
          metadata: { protocolKey: fullKey },
          sourceUpdatedAt: null,
        });
      } else {
        walk(value, fullKey);
      }
    }
  };
  walk(protocols, '');
  return docs;
}

// ── lawn_module: service-outline content modules (approved) ────────
async function loadLawnModules() {
  const rows = await db('lawn_service_content_modules')
    .where({ status: 'approved' })
    .select('key', 'title', 'audience', 'plain_text', 'updated_at');
  return rows.map((r) => ({
    sourceId: r.key,
    title: r.title,
    content: clean(r.plain_text),
    metadata: { audience: r.audience },
    sourceUpdatedAt: r.updated_at,
  }));
}

// ── jurisdiction: county fertilizer rules ──────────────────────────
async function loadJurisdictions() {
  const rows = await db('jurisdiction_fertilizer_rules')
    .select('county', 'public_summary', 'admin_summary', 'updated_at');
  return rows.map((r) => ({
    sourceId: r.county,
    title: `${r.county} County fertilizer rules`,
    content: joinParts([r.public_summary, r.admin_summary]),
    metadata: { county: r.county },
    sourceUpdatedAt: r.updated_at,
  }));
}

// ── product_label: products_catalog compliance/summary language ────
async function loadProductLabels() {
  const rows = await db('products_catalog')
    .where({ active: true })
    .select('id', 'name', 'display_name', 'category', 'signal_word', 'epa_reg_number',
      'public_summary', 'portal_summary', 'customer_safety_summary', 'service_report_summary',
      'customer_precaution_summary', 'reentry_summary', 'reentry_text', 'heat_restrictions',
      'irrigation_notes', 'pet_kid_guidance_text', 'updated_at');
  return rows
    .map((r) => ({
      sourceId: String(r.id),
      title: r.display_name || r.name,
      content: joinParts([
        r.public_summary, r.portal_summary, r.customer_safety_summary,
        r.service_report_summary, r.customer_precaution_summary,
        r.reentry_summary || r.reentry_text,
        r.heat_restrictions ? `Heat restrictions: ${r.heat_restrictions}` : '',
        r.irrigation_notes ? `Irrigation: ${r.irrigation_notes}` : '',
        r.pet_kid_guidance_text,
      ]),
      metadata: { category: r.category, signalWord: r.signal_word, epaRegNumber: r.epa_reg_number },
      sourceUpdatedAt: r.updated_at,
    }))
    .filter((d) => d.content);
}

// ── prep_guide: published prep.* email-template content ────────────
function blocksToText(blocks) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') parts.push(block.text);
    if (typeof block.content === 'string') parts.push(block.content);
    if (Array.isArray(block.items)) parts.push(block.items.map((x) => (typeof x === 'string' ? x : x?.text || '')).join('\n'));
    if (Array.isArray(block.rows)) {
      for (const row of block.rows) {
        if (row?.q || row?.question) parts.push(`Q: ${row.q || row.question}\nA: ${row.a || row.answer || ''}`);
      }
    }
  }
  return parts.map(clean).filter(Boolean).join('\n\n');
}

async function loadPrepGuides() {
  const rows = await db('email_templates as t')
    .join('email_template_versions as v', 'v.template_id', 't.id')
    .where('t.template_key', 'like', 'prep.%')
    .where('v.status', 'active')
    .select('t.template_key', 't.name', 'v.subject', 'v.blocks', 'v.text_body', 'v.version_number', 'v.updated_at')
    .orderBy('v.version_number', 'desc');
  const latestByKey = new Map();
  for (const r of rows) if (!latestByKey.has(r.template_key)) latestByKey.set(r.template_key, r);
  return [...latestByKey.values()].map((r) => {
    const blocks = typeof r.blocks === 'string' ? JSON.parse(r.blocks) : r.blocks;
    return {
      sourceId: r.template_key,
      title: r.name || r.subject,
      content: joinParts([blocksToText(blocks), r.text_body]),
      metadata: { version: r.version_number },
      sourceUpdatedAt: r.updated_at,
    };
  }).filter((d) => d.content);
}

// ── ops_rule: static wiki/*.md operating rules ─────────────────────
function loadOpsRules() {
  const wikiDir = path.join(__dirname, '..', '..', '..', 'wiki');
  const docs = [];
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkDir(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const content = fs.readFileSync(full, 'utf8');
      const title = content.match(/^#\s+(.+)$/m)?.[1] || entry.name.replace(/\.md$/, '');
      docs.push({
        sourceId: path.relative(wikiDir, full).replace(/\\/g, '/'),
        title,
        content,
        metadata: {},
        sourceUpdatedAt: fs.statSync(full).mtime,
      });
    }
  };
  walkDir(wikiDir);
  return docs;
}

const CONNECTORS = [
  { source: 'wiki', load: loadWiki },
  { source: 'kb', load: loadKb },
  { source: 'service', load: loadServices },
  { source: 'protocol', load: loadProtocols },
  { source: 'lawn_module', load: loadLawnModules },
  { source: 'jurisdiction', load: loadJurisdictions },
  { source: 'product_label', load: loadProductLabels },
  { source: 'prep_guide', load: loadPrepGuides },
  { source: 'ops_rule', load: loadOpsRules },
];

async function loadCorpus(connector) {
  try {
    const docs = await connector.load();
    return docs.filter((d) => d && clean(d.sourceId) && clean(d.content));
  } catch (err) {
    logger.error(`[knowledge-index] connector ${connector.source} failed: ${err.message}`);
    return null; // null = skip corpus this run (leave existing rows alone)
  }
}

module.exports = { CONNECTORS, loadCorpus };
