const db = require('../../models/db');
const logger = require('../logger');
const {
  hashExtractionSource,
  recordExtractionAttempt,
  shouldSkipExtraction,
} = require('./source-extraction-store');
const { upsertSensitiveProposal } = require('./proposal-store');

const EXTRACTOR_VERSION = 'access-codes-v1';
const DEFAULT_LOOKBACK_DAYS = 180;
const DEFAULT_LIMIT = 1000;

const ACCESS_PATTERNS = [
  {
    field: 'property_gate_code',
    label: 'property_gate',
    rule_id: 'extract.gate_code',
    regex: /\b(?:side|back|yard|property)\s+gate(?:\s+(?:code|combo))?\s*(?:is|:|=|-)\s*([^\n.;]+)/i,
  },
  {
    field: 'neighborhood_gate_code',
    label: 'neighborhood_gate',
    rule_id: 'extract.gate_code',
    regex: /\b(?:community|neighborhood|front)?\s*gate(?:\s+code)?\s*(?:is|:|=|-)\s*([^\n.;]+)/i,
  },
  {
    field: 'lockbox_code',
    label: 'lockbox',
    rule_id: 'extract.lockbox_code',
    regex: /\blockbox(?:\s+code)?\s*(?:is|:|=|-)\s*([^\n.;]+)/i,
  },
  {
    field: 'garage_code',
    label: 'garage',
    rule_id: 'extract.garage_code',
    regex: /\bgarage(?:\s+(?:door\s+)?code)?\s*(?:is|:|=|-)\s*([^\n.;]+)/i,
  },
];

async function runMessageExtractionPhase({
  runId,
  dryRun = false,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  limit = DEFAULT_LIMIT,
} = {}) {
  const counts = createCounts();
  const rows = await loadCandidateMessages({ lookbackDays, limit });

  for (const row of rows) {
    counts.scanned.messages += 1;
    try {
      const sourceHash = hashExtractionSource(row.body || '');
      const skip = await shouldSkipExtraction({
        source_type: 'message',
        source_id: row.id,
        extractor_version: EXTRACTOR_VERSION,
        source_hash: sourceHash,
      });
      if (skip.skip) {
        counts.skipped_sources += 1;
        continue;
      }

      const proposals = buildAccessCodeProposals(row);
      if (!proposals.length) {
        if (!dryRun) {
          await recordExtractionAttempt({
            source_type: 'message',
            source_id: row.id,
            extractor_version: EXTRACTOR_VERSION,
            source_hash: sourceHash,
            status: 'no_fields',
            proposal_count: 0,
          });
        }
        counts.no_fields += 1;
        continue;
      }

      let proposalCount = 0;
      for (const proposal of proposals) {
        increment(counts.by_rule, proposal.rule_id);
        increment(counts.by_field, proposal.field);
        if (dryRun) {
          counts.would_create += 1;
          proposalCount += 1;
          continue;
        }

        const result = await upsertSensitiveProposal(proposal, { run_id: runId });
        if (result.inserted) {
          counts.created += 1;
          proposalCount += 1;
        } else {
          counts.duplicates += 1;
        }
      }

      if (!dryRun) {
        await recordExtractionAttempt({
          source_type: 'message',
          source_id: row.id,
          extractor_version: EXTRACTOR_VERSION,
          source_hash: sourceHash,
          status: 'ok',
          proposal_count: proposalCount,
        });
      }
    } catch (err) {
      counts.errors += 1;
      logger.error(`[data-hygiene] message extraction failed for message ${row.id}: ${err.message}`);
      try {
        await recordExtractionAttempt({
          source_type: 'message',
          source_id: row.id,
          extractor_version: EXTRACTOR_VERSION,
          source_hash: hashExtractionSource(row.body || ''),
          status: 'failed',
          proposal_count: 0,
          error_message: err.message,
        });
      } catch (recordErr) {
        logger.error(`[data-hygiene] failed to record message extraction error for ${row.id}: ${recordErr.message}`);
      }
    }
  }

  return counts;
}

async function loadCandidateMessages({ lookbackDays, limit }) {
  return db('messages as m')
    .join('conversations as c', 'm.conversation_id', 'c.id')
    .leftJoin('property_preferences as pp', 'pp.customer_id', 'c.customer_id')
    .where('m.direction', 'inbound')
    .whereIn('m.channel', ['sms', 'voice', 'voicemail'])
    .whereNotNull('c.customer_id')
    .whereNotNull('m.body')
    .where('m.created_at', '>=', db.raw(`now() - (? * interval '1 day')`, [lookbackDays]))
    .orderBy('m.created_at', 'desc')
    .limit(limit)
    .select(
      'm.id',
      'm.channel',
      'm.body',
      'm.created_at',
      'c.customer_id',
      'pp.id as property_preferences_id',
      'pp.neighborhood_gate_code',
      'pp.property_gate_code',
      'pp.lockbox_code',
      'pp.garage_code'
    );
}

function buildAccessCodeProposals(row) {
  const body = String(row.body || '');
  if (!body.trim()) return [];

  const proposals = [];
  for (const pattern of ACCESS_PATTERNS) {
    const match = body.match(pattern.regex);
    if (!match) continue;

    const code = normalizeAccessCode(match[1]);
    if (!code) continue;

    const current = row[pattern.field] || null;
    if (current && normalizeForCompare(current) === normalizeForCompare(code)) continue;

    proposals.push({
      rule_id: pattern.rule_id,
      rule_version: '1',
      resource_type: 'property_preferences',
      resource_id: row.property_preferences_id || null,
      scope_type: 'customer',
      scope_id: row.customer_id,
      field: pattern.field,
      current_value: current,
      proposed_value: code,
      source: 'message-extraction',
      confidence: 0.860,
      tier: 'medium',
      evidence: {
        evidence_source_type: 'message',
        evidence_source_id: row.id,
        message_id: row.id,
        channel: row.channel,
        matched_label: pattern.label,
        extractor_version: EXTRACTOR_VERSION,
        source_excerpt: redactExcerpt(body, code),
      },
    });
  }

  return dedupeByField(proposals);
}

function normalizeAccessCode(value) {
  if (!value) return null;
  const raw = String(value)
    .replace(/[)\]}]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = raw.match(/^([#*\d][#*\d\s-]{1,15}?)(?:\s+(then\s+press\s+\d+))?(?:\s|$)/i);
  if (!match) return null;

  const code = [match[1], match[2]].filter(Boolean).join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const digits = code.replace(/\D/g, '');
  if (digits.length < 2 || digits.length > 16) return null;
  return code;
}

function normalizeForCompare(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function redactExcerpt(body, code) {
  const compact = String(body || '').replace(/\s+/g, ' ').trim();
  const idx = compact.toLowerCase().indexOf(String(code).toLowerCase());
  const start = idx >= 0 ? Math.max(0, idx - 60) : 0;
  const excerpt = compact.slice(start, start + 120);
  return excerpt
    .replace(new RegExp(escapeRegex(code), 'ig'), '[redacted access code]')
    .replace(/[#*]?\d[\d\s-]{1,15}(?:\s+then\s+press\s+\d+)?/gi, '[redacted access code]');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dedupeByField(proposals) {
  const seen = new Set();
  return proposals.filter((proposal) => {
    if (seen.has(proposal.field)) return false;
    seen.add(proposal.field);
    return true;
  });
}

function createCounts() {
  return {
    created: 0,
    would_create: 0,
    duplicates: 0,
    errors: 0,
    no_fields: 0,
    skipped_sources: 0,
    scanned: { messages: 0 },
    by_rule: {},
    by_field: {},
  };
}

function increment(target, key) {
  target[key] = (target[key] || 0) + 1;
}

module.exports = {
  EXTRACTOR_VERSION,
  runMessageExtractionPhase,
  buildAccessCodeProposals,
  normalizeAccessCode,
  redactExcerpt,
};
