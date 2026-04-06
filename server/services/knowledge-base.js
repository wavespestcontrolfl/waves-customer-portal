const db = require('../models/db');
const logger = require('./logger');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

// ══════════════════════════════════════════════════════════════
// SLUG GENERATION
// ══════════════════════════════════════════════════════════════
function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 190);
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
// CORE CRUD
// ══════════════════════════════════════════════════════════════
const KnowledgeBaseService = {
  async create({ title, content, category, tags, source, confidence, metadata, status }) {
    const slug = await uniqueSlug(title);
    const [entry] = await db('knowledge_base').insert({
      slug,
      title,
      content: content || '',
      category: category || 'general',
      tags: JSON.stringify(tags || []),
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
    const [entry] = await db('knowledge_base').where({ id }).update(data).returning('*');
    return entry;
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
      .where({ status: 'active' });
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
    return this.update(id, { last_verified_at: new Date(), verified_by: verifiedBy, confidence: 'high' });
  },

  // ── Flag ──
  async flag(id, reason) {
    const entry = await this.update(id, { status: 'flagged' });
    await db('knowledge_base_audits').insert({
      kb_entry_id: id,
      audit_type: 'manual-flag',
      findings: reason || 'Manually flagged for review',
      result: 'flagged',
      audited_by: 'waves',
    });
    return entry;
  },

  // ══════════════════════════════════════════════════════════════
  // AI AUDIT — "Question Your Assumptions" cron
  // ══════════════════════════════════════════════════════════════
  async runAIAudit({ maxEntries = 10, forceAll = false } = {}) {
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      logger.warn('[kb] ANTHROPIC_API_KEY not set — skipping AI audit');
      return { audited: 0, flagged: 0, results: [] };
    }

    // Get entries that need review: stale, low confidence, or unverified
    let query = db('knowledge_base').where({ status: 'active' });
    if (!forceAll) {
      query = query.where(function () {
        this.where('confidence', '!=', 'high')
          .orWhere('last_verified_at', '<', db.raw("NOW() - INTERVAL '30 days'"))
          .orWhereNull('last_verified_at');
      });
    }
    const entries = await query.orderBy('last_verified_at', 'asc').limit(maxEntries);

    if (!entries.length) {
      logger.info('[kb] AI audit: nothing to review');
      return { audited: 0, flagged: 0, results: [] };
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const results = [];
    let flagged = 0;

    for (const entry of entries) {
      try {
        const response = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `You are auditing a knowledge base entry for a pest control & lawn care company (Waves Pest Control) in Southwest Florida. Review this entry for accuracy.

ENTRY:
Title: ${entry.title}
Category: ${entry.category}
Last verified: ${entry.last_verified_at || 'never'}
Content:
${entry.content}

Respond ONLY with a JSON object (no markdown fences):
{
  "status": "pass" | "flag" | "update-needed",
  "confidence": "high" | "medium" | "low",
  "issues": ["list of specific concerns if any"],
  "summary": "one-line assessment"
}

Flag if: outdated regulations, incorrect chemical rates, expired certifications, wrong pricing logic, stale API references, or anything a SWFL pest/lawn pro would catch as wrong. If it looks solid, pass it.`,
          }],
        });

        const text = response.content[0]?.text?.trim() || '{}';
        let parsed;
        try {
          parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        } catch {
          parsed = { status: 'pass', confidence: 'medium', issues: [], summary: 'Could not parse AI response' };
        }

        const auditResult = parsed.status === 'flag' || parsed.status === 'update-needed' ? 'flagged' : 'passed';
        if (auditResult === 'flagged') flagged++;

        await db('knowledge_base_audits').insert({
          kb_entry_id: entry.id,
          audit_type: 'ai-review',
          findings: JSON.stringify(parsed),
          result: auditResult,
          audited_by: 'ai-cron',
        });

        // Update entry confidence and potentially flag it
        const updates = { last_verified_at: new Date(), verified_by: 'ai-cron' };
        if (parsed.confidence) updates.confidence = parsed.confidence;
        if (auditResult === 'flagged') updates.status = 'flagged';
        await db('knowledge_base').where({ id: entry.id }).update(updates);

        results.push({ id: entry.id, title: entry.title, ...parsed });
        logger.info(`[kb] AI audit: ${entry.title} → ${auditResult}`);
      } catch (err) {
        logger.error(`[kb] AI audit failed for "${entry.title}": ${err.message}`);
        results.push({ id: entry.id, title: entry.title, status: 'error', summary: err.message });
      }
    }

    return { audited: entries.length, flagged, results };
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
        const res = await fetch(`https://graph.facebook.com/v21.0/me?access_token=${token}`);
        if (res.ok) {
          // Also check token expiration via debug endpoint
          const debugRes = await fetch(`https://graph.facebook.com/v21.0/debug_token?input_token=${token}&access_token=${token}`);
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
    try {
      const token = process.env.LINKEDIN_ACCESS_TOKEN;
      const credential = { platform: 'linkedin', credential_type: 'oauth-token', env_var_name: 'LINKEDIN_ACCESS_TOKEN' };
      if (!token) {
        results.push({ ...credential, status: 'error', error: 'Not configured' });
      } else {
        const res = await fetch('https://api.linkedin.com/v2/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        results.push({
          ...credential,
          status: res.ok ? 'healthy' : 'expired',
          error: res.ok ? null : `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      results.push({ platform: 'linkedin', credential_type: 'oauth-token', status: 'error', error: err.message });
    }

    // ── GBP (per location) ──
    try {
      const gbpService = require('./google-business');
      const { WAVES_LOCATIONS } = require('../config/locations');
      const LOC_KEYS = { 'lakewood-ranch': 'LWR', 'parrish': 'PARRISH', 'sarasota': 'SARASOTA', 'venice': 'VENICE' };

      for (const loc of WAVES_LOCATIONS) {
        const envKey = LOC_KEYS[loc.id];
        const credential = {
          platform: `gbp-${loc.id}`,
          credential_type: 'refresh-token',
          env_var_name: `GBP_REFRESH_TOKEN_${envKey}`,
        };
        const client = gbpService._getClient(loc.id);
        if (!client) {
          results.push({ ...credential, status: 'error', error: `Missing GBP_CLIENT_ID_${envKey}, GBP_CLIENT_SECRET_${envKey}, or GBP_REFRESH_TOKEN_${envKey}` });
          continue;
        }
        try {
          const { token } = await client.getAccessToken();
          results.push({ ...credential, status: token ? 'healthy' : 'error', error: token ? null : 'No token returned' });
        } catch (err) {
          results.push({ ...credential, status: 'expired', error: err.message });
        }
      }
    } catch (err) {
      logger.warn(`[token-health] GBP check skipped: ${err.message}`);
    }

    // ── Persist results ──
    for (const r of results) {
      try {
        const existing = await db('token_credentials')
          .where({ platform: r.platform, credential_type: r.credential_type }).first();
        const data = {
          status: r.status,
          last_verified_at: new Date(),
          last_error: r.error || null,
          expires_at: r.expires_at || null,
          updated_at: new Date(),
        };
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
    const failures = results.filter(r => r.status === 'expired' || r.status === 'expiring-soon');
    if (failures.length > 0) {
      const alertMsg = `Token Alert: ${failures.length} credential(s) need attention:\n${failures.map(f => `- ${f.platform}: ${f.status}${f.error ? ' — ' + f.error.substring(0, 100) : ''}`).join('\n')}`;
      logger.warn(`[token-health] ${alertMsg}`);

      // SMS alert via Twilio if available
      try {
        const twilioService = require('./twilio');
        const ownerPhone = process.env.OWNER_PHONE || '+19413187612';
        await twilioService.sendSMS(ownerPhone, alertMsg);
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
};

module.exports = KnowledgeBaseService;
