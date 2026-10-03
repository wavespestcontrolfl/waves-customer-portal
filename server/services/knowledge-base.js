const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const { createDeepMessage } = require('./llm/deep');
const { etDateString } = require('../utils/datetime-et');
const { convertToOz, costLineFromUsage, countUnitsCompatible, normalizeUnit, parsePackCount } = require('./product-costing');

// ══════════════════════════════════════════════════════════════
// SLUG GENERATION
// ══════════════════════════════════════════════════════════════
function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function slugify(text, fallback = 'knowledge-entry') {
  const slug = cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 190);
  return slug || fallback;
}

function humanizeSlug(slug) {
  return cleanText(slug)
    .replace(/^(product|protocol|cogs)-/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
    || 'Knowledge Base Entry';
}

function normalizeCategory(category) {
  return slugify(category || 'general', 'general').substring(0, 80);
}

function knowledgePath(category, slug) {
  return `kb/${normalizeCategory(category)}/${slugify(slug)}.md`;
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(cleanText).filter(Boolean);
  if (typeof tags === 'string') {
    try {
      const parsed = JSON.parse(tags);
      if (Array.isArray(parsed)) return normalizeTags(parsed);
    } catch {}
    return tags.split(',').map(cleanText).filter(Boolean);
  }
  return [];
}

async function uniqueSlug(base) {
  let slug = slugify(base);
  let counter = 0;
  while (true) {
    const candidate = counter === 0 ? slug : `${slug}-${counter}`;
    const exists = await db('knowledge_base').where({ slug: candidate }).first();
    if (!exists) return candidate;
    counter++;
  }
}

// ══════════════════════════════════════════════════════════════
// AI AUDIT HELPERS
// ══════════════════════════════════════════════════════════════
// Auto-sync entries are rebuilt from live data on every sync, so a finding on
// one is fixed at its source, never in the KB row (the next sync would
// overwrite the edit). Those rows stay searchable; the finding routes to the
// source's admin screen instead of hiding the entry. Wiki mirrors
// (source='wiki-sync') are the same: agronomic-wiki.js syncKbCopyTrust owns
// their status, so the audit never hides or restores them.
function auditSourceFor(entry) {
  if (entry && entry.source === 'wiki-sync') return { fixIn: 'agronomic_wiki', label: 'Agronomic wiki', link: '/admin/knowledge' };
  if (entry && entry.source === 'protocol-sync') return { fixIn: 'protocols', label: 'Protocols', link: '/admin/service-library?tab=protocols' };
  if (!entry || entry.source !== 'auto-sync') return null;
  const slug = cleanText(entry.slug);
  if (slug.startsWith('product-')) return { fixIn: 'products_catalog', label: 'Products catalog', link: '/admin/inventory?tab=products' };
  if (slug.startsWith('cogs-')) return { fixIn: 'service_product_usage', label: 'Service product usage', link: '/admin/inventory?tab=protocols' };
  if (slug.startsWith('pricing-')) return { fixIn: 'pricing_config', label: 'Pricing config', link: '/admin/pricing-logic' };
  return { fixIn: 'protocols', label: 'Protocols', link: '/admin/service-library?tab=protocols' };
}

function buildAuditPrompt(entry, now = new Date()) {
  const source = auditSourceFor(entry);
  return `You are auditing a knowledge base entry for a pest control & lawn care company (Waves Pest Control) in Southwest Florida. Review this entry for accuracy.

Today's date: ${etDateString(now)}. Timestamps on or before today are not errors — judge the content, not when it was verified.
${source ? `This entry is generated from the ${source.label} data; a finding means that source record needs fixing.
` : ''}
ENTRY:
Title: ${entry.title}
Category: ${entry.category}
Content:
${entry.content}

Respond ONLY with a JSON object (no markdown fences):
{
  "status": "pass" | "flag" | "update-needed",
  "confidence": "high" | "medium" | "low",
  "issues": ["list of specific concerns if any"],
  "summary": "one-line assessment"
}

Flag if: outdated regulations, incorrect chemical rates, expired certifications, wrong pricing logic, stale API references, or anything a SWFL pest/lawn pro would catch as wrong. Only call a label rate or active-ingredient percentage wrong when you are sure of the label value, and state that value; if you are unsure, say "verify against label" and do not flag for that alone. If it looks solid, pass it.`;
}

const AUDIT_CONFIDENCE = new Set(['high', 'medium', 'low']);

// Decide what one AI verdict does to its entry. Only an explicit pass
// verifies; an unparsed or unknown verdict changes nothing. A flagged verdict
// never stamps last_verified_at (a flag is not a verification) and never hides
// a generated row. A pass restores an entry only when the AI audit hid it — a
// person's flag stays until a person clears it.
function planAuditOutcome(entry, parsed, now = new Date()) {
  const verdict = parsed && parsed.status;
  const source = auditSourceFor(entry);
  if (verdict !== 'pass' && verdict !== 'flag' && verdict !== 'update-needed') {
    return { auditResult: 'error', rowResult: 'error', updates: {}, findings: parsed || {}, source };
  }
  const flagged = verdict !== 'pass';
  const updates = {};
  if (flagged) {
    if (!source && entry.status !== 'flagged') updates.status = 'flagged';
  } else {
    updates.last_verified_at = now;
    updates.verified_by = 'ai-cron';
    if (AUDIT_CONFIDENCE.has(parsed.confidence)) updates.confidence = parsed.confidence;
    if (entry.status === 'flagged' && entry.flag_owner === 'ai-review') updates.status = 'active';
  }
  const findings = source && flagged
    ? { ...parsed, fix_in: source.fixIn, fix_link: source.link }
    : parsed;
  // The stored row result is what flag ownership reads: 'flagged' only when
  // this verdict is what hides the entry; a generated row's finding is
  // 'flagged-source' and never owns a flag.
  const rowResult = !flagged ? 'passed' : (updates.status === 'flagged' ? 'flagged' : 'flagged-source');
  return { auditResult: flagged ? 'flagged' : 'passed', rowResult, updates, findings, source };
}

// Latest flag provenance for an entry: 'ai-review' or 'manual-flag'.
const FLAG_OWNER_SQL = `(SELECT a.audit_type FROM knowledge_base_audits a
  WHERE a.kb_entry_id = knowledge_base.id AND a.audit_type IN ('ai-review', 'manual-flag')
    AND a.result = 'flagged'
  ORDER BY a.created_at DESC LIMIT 1)`;

// True when an entry's current flag came from the AI audit (not a person), so
// a content change — the fix — should put it back in search. Callers hold the
// entry's row lock (every flag write takes it), so the answer cannot move
// under them.
async function flagIsFromAIAudit(entry, conn = db) {
  if (!entry || entry.source === 'wiki-sync') return false;
  const latest = await conn('knowledge_base_audits')
    .where({ kb_entry_id: entry.id })
    .whereIn('audit_type', ['ai-review', 'manual-flag'])
    .where({ result: 'flagged' })
    .orderBy('created_at', 'desc')
    .first();
  return !!latest && latest.audit_type === 'ai-review';
}

// ══════════════════════════════════════════════════════════════
// CORE CRUD
// ══════════════════════════════════════════════════════════════
// One COGS line per usage row. The per-unit cost comes from
// product-costing.costLineFromUsage (cost_per_unit, or the package price
// scaled by unit_size_oz) so the write-up never prices an ounce at the whole
// jug; usage counted in whole containers (1 bottle, 2 bags) prices at the
// package. The amount mirrors usageAmountForArea: a usage_per_1000sf row
// scales with the treated area, plus its flat amount on base-plus rows, and
// at least its flat amount on max rows (kept as its own term, never folded
// into a linear total).
const CONTAINER_USAGE_UNITS = new Set(['bottle', 'bottles', 'jug', 'jugs', 'container', 'containers', 'can', 'cans', 'bag', 'bags', 'pail', 'pails', 'box', 'boxes', 'case', 'cases', 'each', 'ea', 'unit', 'units']);

// How many usage units one catalog package holds when both are counts:
// "1 trap" for traps, "4 x 30g tubes" for tubes. Null when the pack is
// measured by weight/volume ("500 g" of packets, an "18 lb pail" of blocks).
function packCountForUsage(containerSize, usageUnit) {
  // Same count-noun normalization parsePackCount applies (boxes -> box,
  // blox -> block); anything it does not know just drops a trailing s.
  const singular = (w) => {
    const word = String(w || '').trim().toLowerCase();
    return parsePackCount(`1 ${word}`)?.unit || word.replace(/s$/, '');
  };
  const pack = parsePackCount(containerSize);
  if (pack && countUnitsCompatible(pack.unit, singular(usageUnit))) return pack.count;
  const multi = String(containerSize || '').trim().toLowerCase().match(/^(\d+)\s*x\s.*?([a-z]+)$/);
  // "4 x 1 gal case": a trailing case/pack/box/kit names the outer wrapper,
  // not the multiplied item, so one case keeps the full package price.
  const outer = /^(?:case|pack|box|kit|carton)$/;
  if (multi && Number(multi[1]) > 0 && !outer.test(singular(multi[2])) && singular(multi[2]) === singular(usageUnit)) return Number(multi[1]);
  return null;
}

function cogsUnitCost(p) {
  // cost_per_unit only applies when its unit is the usage unit or both
  // convert to ounces — an $/oz cost never prices a bottle or a block.
  const costUnit = p.cost_unit || p.usage_unit;
  const sameUnit = normalizeUnit(costUnit) === normalizeUnit(p.usage_unit);
  const bothMeasured = convertToOz(1, costUnit) != null && convertToOz(1, p.usage_unit) != null;
  const usable = p.cost_per_unit != null && (sameUnit || bothMeasured);
  // A zero is a placeholder, never a real unit cost: fall back to the
  // package price scaled by unit_size_oz.
  const unitLine = (withCostPerUnit) => costLineFromUsage({
    ...p, ...(withCostPerUnit ? {} : { cost_per_unit: null }), usage_amount: 1, usage_per_1000sf: null, notes: '',
  }, 0);
  for (const line of usable ? [unitLine(true), unitLine(false)] : [unitLine(false)]) {
    if (!line.warning && Number.isFinite(line.cost) && line.cost > 0) return line.cost;
  }
  const price = parseFloat(p.best_price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const count = packCountForUsage(p.container_size, p.usage_unit);
  if (count) return price / count;
  if (CONTAINER_USAGE_UNITS.has(String(p.usage_unit || '').trim().toLowerCase())) return price;
  return null;
}

function cogsLineForUsage(p) {
  const base = parseFloat(p.usage_amount || 0) || 0;
  const rate = parseFloat(p.usage_per_1000sf || 0) || 0;
  const unit = p.usage_unit || '';
  const n = (x) => Number(x.toFixed(4));
  const $ = (x) => `$${x.toFixed(2)}`;
  const head = `- ${p.product_name} (${p.active_ingredient || 'n/a'}):`;
  const notes = String(p.notes || '');
  const kind = rate <= 0 ? 'flat'
    : notes.includes('[usage:base_plus_per_1000]') ? 'base_plus'
      : notes.includes('[usage:max_base_or_per_1000]') ? 'max' : 'area';
  const amount = kind === 'flat' ? `${p.usage_amount || '?'} ${unit}`
    : kind === 'base_plus' ? `${n(base)} ${unit} + ${n(rate)} ${unit} per 1,000 sq ft`
      : kind === 'max' ? `greater of ${n(base)} ${unit} or ${n(rate)} ${unit} per 1,000 sq ft`
        : `${n(rate)} ${unit} per 1,000 sq ft`;
  const unitCost = cogsUnitCost(p);
  if (unitCost == null) return { term: null, line: `${head} ${amount} — cost unavailable (no normalized price)` };
  const at = `@ ${$(unitCost)}/${unit || 'unit'}`;
  const fixed = base * unitCost;
  const per1000 = rate * unitCost;
  if (kind === 'flat') return { term: { fixed, per1000: 0 }, line: `${head} ${amount} ${at} = ${$(fixed)}` };
  if (kind === 'base_plus') return { term: { fixed, per1000 }, line: `${head} ${amount} ${at} = ${$(fixed)} + ${$(per1000)} per 1,000 sq ft` };
  if (kind === 'max') return { term: { floor: fixed, per1000 }, line: `${head} ${amount} ${at} = greater of ${$(fixed)} or ${$(per1000)} per 1,000 sq ft` };
  return { term: { fixed: 0, per1000 }, line: `${head} ${amount} ${at} = ${$(per1000)} per 1,000 sq ft` };
}

function cogsTotalLine(terms) {
  const $ = (x) => `$${x.toFixed(2)}`;
  let fixed = 0;
  let per1000 = 0;
  const maxes = [];
  let missing = 0;
  for (const t of terms) {
    if (!t) { missing++; continue; }
    if (t.floor != null) { maxes.push(t); continue; }
    fixed += t.fixed;
    per1000 += t.per1000;
  }
  const parts = [];
  if (fixed > 0 || (per1000 === 0 && maxes.length === 0)) parts.push($(fixed));
  if (per1000 > 0) parts.push(`${$(per1000)} per 1,000 sq ft`);
  for (const m of maxes) parts.push(`the greater of ${$(m.floor)} or ${$(m.per1000)} per 1,000 sq ft`);
  const suffix = missing ? ` (excludes ${missing} product${missing === 1 ? '' : 's'} with no normalized price)` : '';
  return `Total COGS per application: ${parts.join(' + ')}${suffix}`;
}

const KnowledgeBaseService = {
  async create({ title, content, category, tags, source, confidence, metadata, status }) {
    const safeTitle = cleanText(title) || 'Knowledge Base Entry';
    const safeCategory = normalizeCategory(category);
    const slug = await uniqueSlug(safeTitle);
    const [entry] = await db('knowledge_base').insert({
      path: knowledgePath(safeCategory, slug),
      slug,
      title: safeTitle,
      content: cleanText(content),
      category: safeCategory,
      tags: JSON.stringify(normalizeTags(tags)),
      source: source || 'manual',
      confidence: confidence || 'medium',
      metadata: JSON.stringify(metadata || {}),
      status: status || 'active',
      last_verified_at: new Date(),
      verified_by: source === 'wiki-import' ? 'wiki-import' : 'waves',
    }).returning('*');
    return entry;
  },

  async update(id, updates) {
    const allowed = ['title', 'content', 'category', 'tags', 'source', 'confidence',
      'metadata', 'status', 'last_verified_at', 'verified_by', 'supersedes'];
    const data = { updated_at: new Date() };
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        data[key] = (key === 'tags' || key === 'metadata')
          ? JSON.stringify(updates[key]) : updates[key];
      }
    }
    return db.transaction(async (trx) => {
      const current = await trx('knowledge_base').where({ id }).forUpdate().first();
      if (!current) return undefined;
      // An edit that changes an AI-hidden entry's content returns it to
      // search — the kb_restore_ai_flag_on_content_change trigger does that
      // for every writer.
      // A person's Verify is the review a flag asks for. It never overrides
      // a wiki mirror's trust gate or a non-flag status like archived.
      if (updates.restoreFlag && updates.status === undefined
        && current.status === 'flagged' && current.source !== 'wiki-sync') {
        data.status = 'active';
      }
      // A person's flag records its owner in the same transaction — an
      // explicit Flag always, an editor status change when it hides the entry
      // — and before the row write, so the content trigger sees it.
      if (updates.flagReason !== undefined || (data.status === 'flagged' && current.status !== 'flagged')) {
        await trx('knowledge_base_audits').insert({
          kb_entry_id: id,
          audit_type: 'manual-flag',
          findings: cleanText(updates.flagReason) || 'Manually flagged for review',
          result: 'flagged',
          audited_by: 'waves',
        });
      }
      const [entry] = await trx('knowledge_base').where({ id }).update(data).returning('*');
      return entry;
    });
  },

  async getById(id) {
    return db('knowledge_base').where({ id }).first();
  },

  async getBySlug(slug) {
    return db('knowledge_base').where({ slug }).first();
  },

  async delete(id) {
    await db('knowledge_base_audits').where({ kb_entry_id: id }).del();
    await db('knowledge_base').where({ id }).del();
    return true;
  },

  async list({ category, status, confidence, limit = 50, offset = 0, sort = 'updated_at', order = 'desc' } = {}) {
    let query = db('knowledge_base');
    if (category) query = query.where({ category });
    if (status) query = query.where({ status });
    if (confidence) query = query.where({ confidence });
    query = query.orderBy(sort, order).limit(limit).offset(offset);

    const entries = await query;

    let countQuery = db('knowledge_base');
    if (category) countQuery = countQuery.where({ category });
    if (status) countQuery = countQuery.where({ status });
    if (confidence) countQuery = countQuery.where({ confidence });
    const [{ count }] = await countQuery.count('* as count');

    return { entries, total: parseInt(count) };
  },

  // ── Full-Text Search ──
  async search(query, { category, limit = 20 } = {}) {
    let q = db('knowledge_base')
      .select('*', db.raw("ts_rank(search_vector, websearch_to_tsquery('english', ?)) as rank", [query]))
      .whereRaw("search_vector @@ websearch_to_tsquery('english', ?)", [query])
      .where({ status: 'active' })
      // An admin's active=false (status left 'active') hides the row too;
      // a NULL flag on an old row still counts as on.
      .whereRaw('active IS NOT FALSE');
    if (category) q = q.where({ category });
    q = q.orderBy('rank', 'desc').limit(limit);
    return q;
  },

  // ── Stats ──
  async getStats() {
    const [totals] = await db('knowledge_base').select(
      db.raw("COUNT(*) as total"),
      db.raw("COUNT(*) FILTER (WHERE status = 'active') as active"),
      db.raw("COUNT(*) FILTER (WHERE status = 'flagged') as flagged"),
      db.raw("COUNT(*) FILTER (WHERE status = 'archived') as archived"),
      db.raw("COUNT(*) FILTER (WHERE confidence = 'high') as high_confidence"),
      db.raw("COUNT(*) FILTER (WHERE confidence = 'medium') as medium_confidence"),
      db.raw("COUNT(*) FILTER (WHERE confidence = 'low' OR confidence = 'unverified') as low_confidence"),
      db.raw("COUNT(*) FILTER (WHERE last_verified_at < NOW() - INTERVAL '30 days' OR last_verified_at IS NULL) as stale"),
    );
    const categories = await db('knowledge_base')
      .where({ status: 'active' })
      .select('category')
      .count('* as count')
      .groupBy('category')
      .orderBy('count', 'desc');
    return {
      total: parseInt(totals.total),
      active: parseInt(totals.active),
      flagged: parseInt(totals.flagged),
      archived: parseInt(totals.archived),
      highConfidence: parseInt(totals.high_confidence),
      mediumConfidence: parseInt(totals.medium_confidence),
      lowConfidence: parseInt(totals.low_confidence),
      stale: parseInt(totals.stale),
      categories,
    };
  },

  // ── Verify (mark as reviewed) ──
  async verify(id, verifiedBy = 'waves') {
    return this.update(id, { last_verified_at: new Date(), verified_by: verifiedBy, confidence: 'high', restoreFlag: true });
  },

  // ── Flag ──
  async flag(id, reason) {
    return this.update(id, { status: 'flagged', flagReason: reason || '' });
  },

  // ══════════════════════════════════════════════════════════════
  // AI AUDIT — "Question Your Assumptions" cron
  // ══════════════════════════════════════════════════════════════
  async runAIAudit({ maxEntries = 10, forceAll = false, flaggedOnly = false, ids = null } = {}) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      logger.warn('[kb] ANTHROPIC_API_KEY not set — skipping AI audit');
      return { audited: 0, flagged: 0, results: [] };
    }

    // Get entries that need review: stale, low confidence, or unverified.
    // flaggedOnly re-reviews entries an earlier audit hid. Rotation is by the
    // last AI review, not last_verified_at — a flag no longer stamps that, so
    // ordering on it would re-pick the same rows every week.
    let query = db('knowledge_base')
      .select('knowledge_base.*', db.raw(
        '(SELECT MAX(a.created_at) FROM knowledge_base_audits a WHERE a.kb_entry_id = knowledge_base.id AND a.audit_type = ?) AS last_ai_review_at',
        ['ai-review'],
      ));
    if (Array.isArray(ids)) query = query.whereIn('knowledge_base.id', ids);
    if (flaggedOnly) {
      // Only entries the AI audit hid — a person's flag is a person's call.
      query = query.where({ status: 'flagged' }).whereNot({ source: 'wiki-sync' })
        .whereRaw(`${FLAG_OWNER_SQL} = 'ai-review'`);
    } else {
      query = query.where({ status: 'active' });
      if (!forceAll) {
        query = query.where(function () {
          this.where('confidence', '!=', 'high')
            .orWhere('last_verified_at', '<', db.raw("NOW() - INTERVAL '30 days'"))
            .orWhereNull('last_verified_at');
        });
      }
    }
    const entries = await query
      .orderByRaw('last_ai_review_at ASC NULLS FIRST')
      .orderBy('last_verified_at', 'asc')
      .limit(maxEntries);

    if (!entries.length) {
      logger.info('[kb] AI audit: nothing to review');
      return { audited: 0, flagged: 0, results: [] };
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const results = [];
    let flagged = 0;
    let passed = 0;

    for (const entry of entries) {
      try {
        const response = await createDeepMessage(client, {
          laneId: 'kb_audit',
          model: MODELS.DEEP,
          max_tokens: 4096, // DEEP: thinking spends from max_tokens — keep headroom for the visible answer
          messages: [{
            role: 'user',
            content: buildAuditPrompt(entry),
          }],
        });

        const text = response.content[0]?.text?.trim() || '{}';
        let parsed;
        try {
          parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        } catch {
          parsed = { status: 'unparsed', issues: [], summary: 'Could not parse AI response' };
        }

        // The model call is slow: apply the verdict under the row lock, and
        // only to the version that was audited. An edit or a person's flag in
        // the meantime wins; the verdict is kept as a 'stale' audit row.
        const { auditResult, source } = await db.transaction(async (trx) => {
          const current = await trx('knowledge_base').where({ id: entry.id }).forUpdate().first();
          // updated_at moves on every write (edit, verify, flag, sync) but
          // not on an audit verdict, so any change since the read shows here.
          const stamp = (v) => (v ? new Date(v).getTime() : null);
          if (!current || stamp(current.updated_at) !== stamp(entry.updated_at)
            || current.content !== entry.content || current.status !== entry.status) {
            await trx('knowledge_base_audits').insert({
              kb_entry_id: entry.id, audit_type: 'ai-review', findings: JSON.stringify(parsed || {}), result: 'stale', audited_by: 'ai-cron',
            });
            return { auditResult: 'stale', updates: {}, findings: parsed, source: null };
          }
          const flagOwner = current.status === 'flagged' && await flagIsFromAIAudit(current, trx) ? 'ai-review' : null;
          const outcome = planAuditOutcome({ ...current, flag_owner: flagOwner }, parsed);
          await trx('knowledge_base_audits').insert({
            kb_entry_id: entry.id,
            audit_type: 'ai-review',
            findings: JSON.stringify(outcome.findings),
            result: outcome.rowResult,
            audited_by: 'ai-cron',
          });
          if (Object.keys(outcome.updates).length) {
            await trx('knowledge_base').where({ id: entry.id }).update(outcome.updates);
          }
          return outcome;
        });
        if (auditResult === 'flagged') flagged++;
        if (auditResult === 'passed') passed++;

        results.push({
          id: entry.id,
          title: entry.title,
          ...parsed,
          ...(auditResult === 'stale' ? { status: 'stale', summary: 'Entry changed during the audit; verdict not applied' } : {}),
          ...(source && auditResult === 'flagged' ? { fixIn: source.fixIn, fixLabel: source.label, fixLink: source.link } : {}),
        });
        logger.info(`[kb] AI audit: ${entry.title} → ${auditResult}`);
      } catch (err) {
        logger.error(`[kb] AI audit failed for "${entry.title}": ${err.message}`);
        results.push({ id: entry.id, title: entry.title, status: 'error', summary: err.message });
      }
    }

    return { audited: entries.length, flagged, passed, results };
  },

  // ── Get audits for an entry ──
  async getAudits(kbEntryId) {
    return db('knowledge_base_audits')
      .where({ kb_entry_id: kbEntryId })
      .orderBy('created_at', 'desc')
      .limit(20);
  },

  // ══════════════════════════════════════════════════════════════
  // TOKEN HEALTH CHECKS
  // ══════════════════════════════════════════════════════════════
  async checkTokenHealth() {
    const results = [];

    // ── Facebook ──
    try {
      const token = process.env.FACEBOOK_ACCESS_TOKEN;
      const credential = { platform: 'facebook', credential_type: 'oauth-token', env_var_name: 'FACEBOOK_ACCESS_TOKEN' };
      if (!token) {
        results.push({ ...credential, status: 'error', error: 'Not configured' });
      } else {
        const res = await fetch(`https://graph.facebook.com/v25.0/me?access_token=${token}`);
        if (res.ok) {
          // Also check token expiration via debug endpoint
          const debugRes = await fetch(`https://graph.facebook.com/v25.0/debug_token?input_token=${token}&access_token=${token}`);
          let expiresAt = null;
          if (debugRes.ok) {
            const debug = await debugRes.json();
            if (debug.data?.expires_at) expiresAt = new Date(debug.data.expires_at * 1000);
          }
          results.push({ ...credential, status: expiresAt && expiresAt < new Date(Date.now() + 7 * 86400000) ? 'expiring-soon' : 'healthy', expires_at: expiresAt });
        } else {
          const err = await res.text();
          results.push({ ...credential, status: 'expired', error: err });
        }
      }
    } catch (err) {
      results.push({ platform: 'facebook', credential_type: 'oauth-token', status: 'error', error: err.message });
    }

    // ── LinkedIn ──
    // OAuth model (services/linkedin.js): app creds in env, page token stored in
    // the DB by the Settings → Integrations connect flow. The legacy
    // LINKEDIN_ACCESS_TOKEN env path is retired — reading it here would report a
    // false failure after the OAuth connection succeeds. Mirrors token-health.js.
    try {
      const credential = { platform: 'linkedin', credential_type: 'oauth-token', env_var_name: 'LINKEDIN_CLIENT_ID' };
      const linkedin = require('./linkedin');
      if (!linkedin.configured) {
        results.push({ ...credential, status: 'error', error: 'LINKEDIN_CLIENT_ID/SECRET not set' });
      } else {
        const status = await linkedin.getStatus();
        if (!status.connected) {
          results.push({ ...credential, status: 'error', error: 'Not connected — authorize via Admin Settings → Integrations' });
        } else if (!status.companyId) {
          // Creds + OAuth present but no org to post to — createPost() throws
          // "LINKEDIN_COMPANY_ID not configured", so don't report a health the
          // publish path can't honor (same guard as token-health.js).
          results.push({ ...credential, status: 'error', error: 'LINKEDIN_COMPANY_ID not set' });
        } else {
          const expiresAt = status.tokenExpiresAt ? new Date(status.tokenExpiresAt) : null;
          if (expiresAt && expiresAt.getTime() <= Date.now()) {
            // Expired by stored metadata: run the refresh exchange (as
            // token-health does) so a refreshable grant reads healthy and a
            // revoked one surfaces here instead of at the next publish.
            const refresh = await linkedin.tryRefresh();
            results.push(refresh.ok
              ? { ...credential, status: 'healthy', expires_at: refresh.expiresAt ? new Date(refresh.expiresAt) : expiresAt }
              : { ...credential, status: 'expired', error: `Re-authorize — ${refresh.error}`, expires_at: refresh.expiresAt ? new Date(refresh.expiresAt) : expiresAt });
          } else {
            // Stored expiry alone can't catch a revoked grant — getStatus()
            // only reads system_settings. Send the token to LinkedIn
            // (organizationAcls, the same call the connect flow soft-verifies
            // with) before persisting a green status; otherwise createPost()
            // is the first thing to discover the 401.
            const okStatus = expiresAt && expiresAt < new Date(Date.now() + 7 * 86400000) ? 'expiring-soon' : 'healthy';
            try {
              const { adminedOrganizations } = await linkedin.verifyOrgAccess();
              // Same comparison as _recordOrgVerification(): numeric org id,
              // EQUALITY not substring. An authorized user removed from the
              // page after connecting would otherwise read green until
              // createPost() hits the page-permission 403.
              const target = String(status.companyId).trim();
              const orgId = (o) => String(o).trim().replace(/^urn:li:organization:/, '');
              const adminsTarget = (adminedOrganizations || []).some((o) => orgId(o) === target);
              results.push(adminsTarget
                ? { ...credential, status: okStatus, expires_at: expiresAt }
                : { ...credential, status: 'error', error: `Authorized account does not administer org ${target} — reconnect with a page admin`, expires_at: expiresAt });
            } catch (verifyErr) {
              if (/\b401\b/.test(verifyErr.message)) {
                results.push({ ...credential, status: 'expired', error: `Re-authorize — ${verifyErr.message}`, expires_at: expiresAt });
              } else if (/\b403\b/.test(verifyErr.message)) {
                // Expected under the default scopes: /organizationAcls needs an
                // org-admin READ scope we deliberately don't request
                // (linkedin.js SCOPES note), and the connect flow records this
                // same 403 as "verification skipped" — never a false negative.
                // The token can still publish, so keep the green status.
                results.push({ ...credential, status: okStatus, expires_at: expiresAt });
              } else {
                results.push({ ...credential, status: 'error', error: verifyErr.message, expires_at: expiresAt });
              }
            }
          }
        }
      }
    } catch (err) {
      results.push({ platform: 'linkedin', credential_type: 'oauth-token', status: 'error', error: err.message });
    }

    // ── GBP (per location) ──
    // Delegated to TokenHealthService.checkSingle: it exchanges the refresh
    // token on every check (catching invalid_grant after a revocation), whereas
    // google-business's cached client can hand back a still-valid access token
    // and report a revoked grant as healthy. Same canonical gbp_* keys the
    // scheduled checker maintains; this loop only persists the result.
    try {
      const TokenHealthService = require('./token-health');
      const GBP_PLATFORMS = { gbp_lwr: 'LWR', gbp_parrish: 'PARRISH', gbp_sarasota: 'SARASOTA', gbp_venice: 'VENICE' };
      for (const [platform, envKey] of Object.entries(GBP_PLATFORMS)) {
        const res = await TokenHealthService.checkSingle(platform);
        // TokenHealth vocabulary → this route's contract (healthy / expired /
        // expiring-soon / error): a missing credential set was always reported
        // here as status 'error' with the reason, and the KB page has no badge
        // for 'not_configured'.
        const notConfigured = res.status === 'not_configured';
        results.push({
          platform,
          credential_type: 'refresh-token',
          env_var_name: `GBP_REFRESH_TOKEN_${envKey}`,
          status: notConfigured ? 'error' : res.status,
          error: res.lastError || (notConfigured ? `Missing GBP OAuth credentials for ${envKey}` : null),
          expires_at: res.expiresAt || null,
        });
      }
    } catch (err) {
      logger.warn(`[token-health] GBP check skipped: ${err.message}`);
    }

    // ── Persist results ──
    for (const r of results) {
      try {
        // platform is the table's unique key (migration 079). token-health.js
        // creates rows without credential_type, so matching on it misses those
        // rows and the fallback insert trips the unique constraint (swallowed
        // below) — the row would never receive this check's result.
        const existing = await db('token_credentials')
          .where({ platform: r.platform }).first();
        const data = {
          credential_type: r.credential_type || null,
          status: r.status,
          last_verified_at: new Date(),
          last_error: r.error || null,
          expires_at: r.expires_at || null,
          updated_at: new Date(),
        };
        // Keep the stored env var pointer current on updates too — the LinkedIn
        // check's source var changed (LINKEDIN_ACCESS_TOKEN → LINKEDIN_CLIENT_ID)
        // and a pre-existing row would otherwise keep showing the retired var.
        // Only when the result carries one: the catch-path results don't, and a
        // transient failure must not null out a good pointer.
        if (r.env_var_name) data.env_var_name = r.env_var_name;
        if (existing) {
          await db('token_credentials').where({ id: existing.id }).update(data);
        } else {
          await db('token_credentials').insert({
            platform: r.platform,
            credential_type: r.credential_type,
            env_var_name: r.env_var_name || null,
            ...data,
          });
        }
      } catch (err) {
        logger.warn(`[token-health] Could not persist result for ${r.platform}: ${err.message}`);
      }
    }

    // ── Alert on failures ──
    // 'error' (invalid credentials, provider/API failure, not configured) is a
    // failure needing attention too — excluding it made an all-error check
    // report zero failures and send no alert.
    const failures = results.filter(r => r.status === 'expired' || r.status === 'expiring-soon' || r.status === 'error');
    if (failures.length > 0) {
      const alertMsg = `Token Alert: ${failures.length} credential(s) need attention:\n${failures.map(f => `- ${f.platform}: ${f.status}${f.error ? ' — ' + f.error.substring(0, 100) : ''}`).join('\n')}`;
      logger.warn(`[token-health] ${alertMsg}`);

      // SMS alert via Twilio if available
      try {
        const twilioService = require('./twilio');
        const ownerPhone = process.env.OWNER_PHONE || '+19415993489';
        await twilioService.sendSMS(ownerPhone, alertMsg, { messageType: 'internal_alert', link: '/admin/credentials' });
        logger.info('[token-health] SMS alert sent');
      } catch {
        logger.warn('[token-health] Could not send SMS alert — Twilio not available');
      }
    }

    return { checked: results.length, healthy: results.filter(r => r.status === 'healthy').length, failures: failures.length, results };
  },

  async getTokenStatus() {
    return db('token_credentials').orderBy('platform', 'asc');
  },

  // ══════════════════════════════════════════════════════════════
  // AI ASSISTANT TOOL — for the chat widget / SMS assistant
  // ══════════════════════════════════════════════════════════════
  async assistantSearch(query) {
    const results = await this.search(query, { limit: 5 });
    if (!results.length) return 'No knowledge base entries found for that query.';
    return results.map(r => `[${r.category}] ${r.title}\n${r.content?.substring(0, 500)}`).join('\n\n---\n\n');
  },

  // ══════════════════════════════════════════════════════════════
  // AUTO-SYNC — populate KB from live data sources
  // ══════════════════════════════════════════════════════════════
  async autoSync() {
    let created = 0, updated = 0, skipped = 0;

    // Helper: upsert by slug
    async function upsert(slug, title, content, category, tags = []) {
      const safeSlug = slugify(slug || title);
      const safeTitle = cleanText(title) || humanizeSlug(safeSlug);
      const safeCategory = normalizeCategory(category);
      const safeContent = cleanText(content);
      const safeTags = normalizeTags(tags);
      const safePath = knowledgePath(safeCategory, safeSlug);
      const existing = await db('knowledge_base')
        .where({ slug: safeSlug })
        .orWhere({ path: safePath })
        .first();
      if (existing) {
        const tagJson = JSON.stringify(safeTags);
        const existingTagJson = JSON.stringify(normalizeTags(existing.tags));
        if (existing.content !== safeContent || existing.title !== safeTitle || existing.path !== safePath || existing.category !== safeCategory || existingTagJson !== tagJson) {
          // A content change returns an AI-hidden entry to search
          // (kb_restore_ai_flag_on_content_change trigger).
          await db('knowledge_base').where({ id: existing.id }).update({
            slug: safeSlug,
            path: safePath,
            content: safeContent,
            title: safeTitle,
            category: safeCategory,
            tags: tagJson,
            last_verified_at: new Date(), verified_by: 'auto-sync', updated_at: new Date(),
          });
          updated++;
        } else { skipped++; }
      } else {
        try {
          await db('knowledge_base').insert({
            path: safePath,
            slug: safeSlug,
            title: safeTitle,
            content: safeContent,
            category: safeCategory,
            tags: JSON.stringify(safeTags),
            source: 'auto-sync', confidence: 'high', status: 'active',
            last_verified_at: new Date(), verified_by: 'auto-sync',
          });
          created++;
        } catch (e) {
          if (!e.message?.includes('duplicate')) logger.error(`[kb-sync] Insert failed: ${e.message}`);
          skipped++;
        }
      }
    }

    // ── 1. PRODUCTS from products_catalog ──
    try {
      const products = await db('products_catalog').where({ active: true }).orderBy('name');
      for (const p of products) {
        const lines = [`**${p.name}**`];
        if (p.active_ingredient) lines.push(`Active Ingredient: ${p.active_ingredient}`);
        if (p.moa_group) lines.push(`MOA Group: ${p.moa_group}`);
        if (p.formulation) lines.push(`Formulation: ${p.formulation}`);
        if (p.container_size) lines.push(`Container: ${p.container_size}`);
        if (p.default_rate) lines.push(`Default Rate: ${p.default_rate} ${p.default_unit || ''}`);
        if (p.best_price) lines.push(`Best Price: $${parseFloat(p.best_price).toFixed(2)} (${p.best_vendor || 'unknown'})`);
        if (p.signal_word) lines.push(`Signal Word: ${p.signal_word}`);
        if (p.rei_hours) lines.push(`REI: ${p.rei_hours} hours`);
        if (p.rain_free_hours) lines.push(`Rain-Free: ${p.rain_free_hours} hours`);
        if (p.max_wind_mph) lines.push(`Max Wind: ${p.max_wind_mph} mph`);
        if (p.restricted_use) lines.push(`⚠ RESTRICTED USE PRODUCT`);
        if (p.pollinator_precautions) lines.push(`🐝 Pollinator: ${p.pollinator_precautions}`);
        if (p.compatibility_notes) lines.push(`Compatibility: ${p.compatibility_notes}`);

        const slug = `product-${slugify(p.name)}`;
        const tags = [p.category, p.moa_group, p.active_ingredient].filter(Boolean);
        await upsert(slug, p.name, lines.join('\n'), 'chemicals', tags);
      }
      logger.info(`[kb-sync] Products: ${products.length} processed`);
    } catch (e) { logger.error(`[kb-sync] Products sync failed: ${e.message}`); }

    // ── 2. PROTOCOLS from protocols.json ──
    // Every program category syncs (lawn nests per-turf tracks; the rest are
    // single programs at the top level). Visit costs are NUMERIC only on the
    // lawn tracks — the other programs carry token costs ('inventory',
    // 'standard'), which previously rendered as literal "$inventory" garbage.
    try {
      const protocols = require('../config/protocols.json');
      const costLine = (v) => {
        const mc = Number(v.material_cost);
        const lc = Number(v.labor_cost);
        // Zero-zero placeholders (termite v1) are as uninformative as tokens.
        if (Number.isFinite(mc) && Number.isFinite(lc) && (mc > 0 || lc > 0)) {
          return `  Legacy materials: $${mc} | Labor: $${lc}`;
        }
        return '  Materials: inventory/rate-based (see admin protocols for product detail)';
      };
      const syncProgram = async (programKey, track, tags) => {
        if (!track || typeof track !== 'object') return;
        const lines = [`**${track.name || programKey}**\n`];
        if (track.notes?.length) lines.push('Key Notes:\n' + track.notes.map(n => `- ${n}`).join('\n') + '\n');
        if (track.visits?.length) {
          lines.push(`**${track.visits.length} Visits/Year:**\n`);
          for (const v of track.visits) {
            const tierList = Object.entries(v.tiers || {}).filter(([, on]) => on).map(([t]) => t).join(', ');
            lines.push(`Visit ${v.visit} (${v.month}): ${v.primary?.split('\n')[0] || ''}`);
            lines.push(`${costLine(v)}${tierList ? ` | Tiers: ${tierList}` : ''}`);
            if (v.notes) lines.push(`  Notes: ${v.notes}`);
          }
        }
        const slug = `protocol-${slugify(programKey)}`;
        await upsert(slug, track.name || programKey, lines.join('\n'), 'protocols', tags);
      };

      for (const [trackId, track] of Object.entries(protocols.lawn || {})) {
        await syncProgram(trackId, track, ['lawn', trackId]);
      }
      for (const [programKey, program] of Object.entries(protocols)) {
        if (programKey === 'lawn') continue;
        await syncProgram(programKey, program, [programKey]);
      }
      logger.info(`[kb-sync] Protocols synced (all categories)`);
    } catch (e) { logger.error(`[kb-sync] Protocols sync failed: ${e.message}`); }

    // ── 3. PRICING ENGINE snapshot ──
    try {
      // Rendered from the LIVE engine constants after a DB sync — pricing is
      // DB-authoritative, and this doc's previous hardcoded copy drifted
      // (retired v1 cadence curve, invented tree/driveway adjustments that
      // never existed in the engine; audit 2026-07-28). Values here now move
      // with pricing_config / admin edits on the next KB sync, no code edit.
      const pricingEngine = require('./pricing-engine');
      // syncConstantsFromDB reports failure by RETURNING false (it restores
      // defaults/cached constants instead of throwing) — a failed sync must
      // not overwrite the KB doc with values that may not match pricing_config
      // (codex P2 on #3040). Keep the previous snapshot and let the next sync
      // refresh it.
      const pricingSyncOk = await pricingEngine.syncConstantsFromDB(db);
      if (pricingSyncOk === false) {
        throw new Error('live pricing sync unavailable — keeping previous snapshot');
      }
      const { PEST, PROPERTY_TYPE_ADJ, WAVEGUARD, LAWN_TIERS, LAWN_PRICING_V2 } = pricingEngine.constants;
      const signed = (n) => (n > 0 ? `+$${n}` : n < 0 ? `-$${Math.abs(n)}` : '$0');
      const adj = PEST.additionalAdjustments || {};
      const roachTierText = (rows) => (rows || [])
        .map((r) => `$${r.price}`)
        .join('/');
      const curve = PEST.frequencyDiscounts?.v2 || {};
      const tierPct = (t) => `${Math.round(((WAVEGUARD.tiers?.[t]?.discount) || 0) * 100)}%`;
      const pricingContent = [
        '**Pest Control Pricing**',
        `Base price: $${PEST.base}/visit | Floor: $${PEST.floor}`,
        '',
        'Footprint modifiers (interpolated):',
        (PEST.footprintBrackets || []).map((b) => `${b.sqft.toLocaleString()}sf: ${signed(b.adj)}`).join(' | '),
        '',
        'Property features:',
        `Pool cage: small ${signed(adj.poolCageSmall)} | medium ${signed(adj.poolCageMedium)} | large ${signed(adj.poolCageLarge)} | oversized ${signed(adj.poolCageOversized)} | Pool (no cage): ${signed(adj.poolNoCage)}`,
        `Shrubs: light ${signed(adj.shrubs_light)} | moderate ${signed(adj.shrubs_moderate)} | heavy ${signed(adj.shrubs_heavy)} | Landscape: simple ${signed(adj.complexity_simple)} | moderate ${signed(adj.complexity_moderate)} | complex ${signed(adj.complexity_complex)}`,
        `Near water: ${signed(adj.nearWater)} | Indoor service: ${signed(adj.indoor)} | Attached garage: ${signed(adj.attachedGarage)}`,
        '',
        `Property type: Townhome end ${signed(PROPERTY_TYPE_ADJ.townhome_end)} | Townhome interior ${signed(PROPERTY_TYPE_ADJ.townhome_interior)} | Duplex ${signed(PROPERTY_TYPE_ADJ.duplex)} | Condo ground ${signed(PROPERTY_TYPE_ADJ.condo_ground)} | Condo upper ${signed(PROPERTY_TYPE_ADJ.condo_upper)}`,
        '',
        `Per-visit cadence multipliers (v2, LIVE default): Quarterly ${curve.quarterly}x | Bi-Monthly ${curve.bimonthly}x | Monthly ${curve.monthly}x`,
        '(v1 0.85/0.70 is RETIRED — replay-only for estimates sold under it; never quote v1 prices on new estimates)',
        `Roach: recurring roach percentages are retired. Recurring pest with native roach adds a one-time ${PEST.pestInitialRoach?.display?.regular?.name || 'Cockroach Treatment Service'} (${roachTierText(PEST.pestInitialRoach?.regular)}); German adds ${PEST.pestInitialRoach?.display?.german?.name || 'German Cockroach Treatment'} (${roachTierText(PEST.pestInitialRoach?.german)}). These first-visit fees are not waived with annual prepay and do not receive the recurring-customer one-time discount. Standalone regular roach uses ${roachTierText(PEST.pestInitialRoach?.regular_standalone)} by footprint | WaveGuard Membership: flat $${PEST.initialFee} (waived with annual prepay)`,
        '',
        `WaveGuard tiers: Bronze ${tierPct('bronze')} | Silver ${tierPct('silver')} | Gold ${tierPct('gold')} | Platinum ${tierPct('platinum')}`,
        'Tier qualification: 1 service = Bronze | 2 = Silver | 3 = Gold | 4+ = Platinum',
        '',
        '**Lawn Care Pricing**',
        `Version: ${LAWN_PRICING_V2?.pricingVersion || 'LAWN_PRICING_V2'} — market bracket table (grass track × turf sqft × tier), DB-authoritative via lawn_pricing_brackets`,
        `Tiers: ${Object.values(LAWN_TIERS || {}).map((t) => `${t.label}${t.hidden ? ' (retired/hidden)' : ''}`).join(' | ')}`,
        'Tracks: St. Augustine | Bermuda | Zoysia | Bahia',
        'Turf area: fixed hardscape (800sf base + 3% excess) + complexity scoring + smoothed turf factor',
      ].join('\n');
      await upsert('pricing-engine-current', 'Pest & Lawn Pricing Engine', pricingContent, 'pricing', ['pest', 'lawn', 'modifiers']);
      logger.info('[kb-sync] Pricing snapshot synced');
    } catch (e) { logger.error(`[kb-sync] Pricing sync failed: ${e.message}`); }

    // ── 4. SERVICE COGS from service_product_usage ──
    try {
      const usage = await db('service_product_usage')
        .join('products_catalog', 'service_product_usage.product_id', 'products_catalog.id')
        .select('service_product_usage.*', 'products_catalog.name as product_name',
          'products_catalog.best_price', 'products_catalog.active_ingredient',
          'products_catalog.unit_size_oz', 'products_catalog.cost_per_unit', 'products_catalog.cost_unit',
          'products_catalog.container_size')
        .orderBy('service_type');

      const grouped = {};
      usage.forEach(u => {
        if (!grouped[u.service_type]) grouped[u.service_type] = [];
        grouped[u.service_type].push(u);
      });

      for (const [svcType, products] of Object.entries(grouped)) {
        const lines = [`**${svcType} — Cost of Goods**\n`];
        const terms = [];
        for (const p of products) {
          const c = cogsLineForUsage(p);
          terms.push(c.term);
          lines.push(c.line);
        }
        lines.push(`\n${cogsTotalLine(terms)}`);
        const slug = `cogs-${slugify(svcType)}`;
        await upsert(slug, `${svcType} — COGS Breakdown`, lines.join('\n'), 'pricing', ['cogs', svcType.toLowerCase()]);
      }
      logger.info('[kb-sync] COGS synced');
    } catch (e) { logger.error(`[kb-sync] COGS sync failed: ${e.message}`); }

    logger.info(`[kb-sync] Auto-sync complete: ${created} created, ${updated} updated, ${skipped} unchanged`);
    return { created, updated, skipped };
  },
};

module.exports = KnowledgeBaseService;
module.exports._internals = { auditSourceFor, buildAuditPrompt, planAuditOutcome, flagIsFromAIAudit, cogsLineForUsage, cogsTotalLine };
