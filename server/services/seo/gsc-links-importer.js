const { parse } = require('csv-parse/sync');
const db = require('../../models/db');
const { etDateString } = require('../../utils/datetime-et');
const BacklinkMonitor = require('./backlink-monitor');

const DEFAULT_TARGET = 'https://wavespestcontrol.com/';

const SOURCE_FIELDS = [
  'source page',
  'source url',
  'source',
  'linking page',
  'linking url',
  'from url',
  'url from',
  'referring page',
  'referring url',
];

const TARGET_FIELDS = [
  'target page',
  'target url',
  'target',
  'linked page',
  'destination page',
  'destination url',
  'to url',
  'url to',
];

const ANCHOR_FIELDS = [
  'anchor text',
  'anchor',
  'link text',
  'linking text',
  'text',
];

const FIRST_SEEN_FIELDS = [
  'first seen',
  'first detected',
  'discovered',
  'discovered date',
];

const LAST_CHECKED_FIELDS = [
  'last crawled',
  'last checked',
  'last detected',
];

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function getField(row, names) {
  const normalized = new Map();
  for (const [key, value] of Object.entries(row || {})) {
    normalized.set(normalizeHeader(key), value);
  }
  for (const name of names) {
    const value = normalized.get(name);
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return null;
}

function normalizeDate(value, fallback = etDateString()) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString().slice(0, 10);
}

function normalizeUrl(value, { defaultOrigin = DEFAULT_TARGET } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  try {
    if (raw.startsWith('/')) {
      return new URL(raw, defaultOrigin).href;
    }
    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw).href;
    }
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#].*)?$/i.test(raw)) {
      return new URL(`https://${raw}`).href;
    }
  } catch {
    return null;
  }
  return null;
}

function sourceDomain(sourceUrl) {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

function isWavesTarget(targetUrl) {
  try {
    const host = new URL(targetUrl).hostname.replace(/^www\./i, '').toLowerCase();
    return host === 'wavespestcontrol.com' || host.endsWith('.wavespestcontrol.com');
  } catch {
    return false;
  }
}

function parseRows(csvText) {
  return parse(csvText, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
}

function normalizeRow(row, { defaultTargetUrl = DEFAULT_TARGET } = {}) {
  const sourceUrl = normalizeUrl(getField(row, SOURCE_FIELDS));
  const targetRaw = getField(row, TARGET_FIELDS) || defaultTargetUrl;
  const targetUrl = normalizeUrl(targetRaw, { defaultOrigin: defaultTargetUrl });
  const domain = sourceDomain(sourceUrl);

  if (!sourceUrl) return { skipped: true, reason: 'missing_source_url' };
  if (!targetUrl) return { skipped: true, reason: 'missing_target_url', sourceUrl };
  if (!domain) return { skipped: true, reason: 'invalid_source_domain', sourceUrl, targetUrl };
  if (!isWavesTarget(targetUrl)) return { skipped: true, reason: 'non_waves_target', sourceUrl, targetUrl };

  const firstSeen = normalizeDate(getField(row, FIRST_SEEN_FIELDS));
  const lastChecked = normalizeDate(getField(row, LAST_CHECKED_FIELDS), etDateString());
  const anchorText = getField(row, ANCHOR_FIELDS);

  return {
    source_url: sourceUrl,
    source_domain: domain,
    target_url: targetUrl,
    anchor_text: anchorText,
    first_seen: firstSeen,
    last_checked: lastChecked,
    discovered_date: firstSeen,
  };
}

async function importCsv(csvText, {
  apply = true,
  defaultTargetUrl = DEFAULT_TARGET,
  sourceLabel = 'gsc_links_export',
} = {}) {
  const rows = parseRows(csvText);
  const today = etDateString();
  const skipped = {};
  const seen = new Set();
  const candidates = [];

  for (const row of rows) {
    const normalized = normalizeRow(row, { defaultTargetUrl });
    if (normalized.skipped) {
      skipped[normalized.reason] = (skipped[normalized.reason] || 0) + 1;
      continue;
    }

    const key = `${normalized.source_url}::${normalized.target_url}`;
    if (seen.has(key)) {
      skipped.duplicate_in_file = (skipped.duplicate_in_file || 0) + 1;
      continue;
    }
    seen.add(key);
    candidates.push(normalized);
  }

  if (!apply) {
    return {
      apply: false,
      parsed: rows.length,
      candidates: candidates.length,
      inserted: 0,
      updated: 0,
      skipped,
      sample: candidates.slice(0, 10),
    };
  }

  let inserted = 0;
  let updated = 0;
  const imported = [];

  for (const candidate of candidates) {
    const existing = await db('seo_backlinks')
      .where({ source_url: candidate.source_url, target_url: candidate.target_url })
      .first();

    const toxicity = BacklinkMonitor.scoreToxicity({
      domain_from: candidate.source_domain,
      url_from: candidate.source_url,
      anchor: candidate.anchor_text,
      domain_from_rank: null,
      external_links_count: null,
    });

    const patch = {
      source_domain: candidate.source_domain,
      anchor_text: candidate.anchor_text,
      toxicity_score: toxicity.score,
      toxicity_reasons: JSON.stringify(toxicity.reasons),
      severity: toxicity.severity,
      status: 'active',
      last_checked: candidate.last_checked || today,
      notes: `Imported from ${sourceLabel}. GSC Links exports do not include dofollow or authority metrics; verify separately.`,
      link_type: BacklinkMonitor.classifyLinkType(candidate),
      is_dofollow: null,
      target_page_type: BacklinkMonitor.classifyTargetPage(candidate.target_url),
      discovered_date: candidate.discovered_date || candidate.first_seen || today,
      updated_at: new Date(),
    };

    if (existing) {
      const existingDofollow = existing.is_dofollow === undefined ? existing.isDofollow : existing.is_dofollow;
      const existingAnchor = existing.anchor_text === undefined ? existing.anchorText : existing.anchor_text;
      const existingToxicityScore = Number(existing.toxicity_score || 0);
      const hasExistingSafetySignal = existingToxicityScore > 0 || (existing.severity && existing.severity !== 'clean');
      const existingSafetyPatch = hasExistingSafetySignal
        ? {
            toxicity_score: existing.toxicity_score,
            toxicity_reasons: existing.toxicity_reasons,
            severity: existing.severity,
          }
        : {};

      await db('seo_backlinks')
        .where({ id: existing.id })
        .update({
          ...patch,
          ...existingSafetyPatch,
          anchor_text: candidate.anchor_text || existingAnchor || null,
          status: existing.status === 'disavowed' ? 'disavowed' : patch.status,
          is_dofollow: existingDofollow ?? null,
          first_seen: existing.first_seen || candidate.first_seen || today,
        });
      updated++;
      imported.push({ id: existing.id, action: 'updated', source_url: candidate.source_url, target_url: candidate.target_url });
    } else {
      const insertedRows = await db('seo_backlinks')
        .insert({
          ...patch,
          source_url: candidate.source_url,
          target_url: candidate.target_url,
          first_seen: candidate.first_seen || today,
        })
        .returning('id');
      inserted++;
      imported.push({
        id: insertedRows?.[0]?.id || insertedRows?.[0],
        action: 'inserted',
        source_url: candidate.source_url,
        target_url: candidate.target_url,
      });
    }
  }

  await BacklinkMonitor.takeSnapshot();

  return {
    apply: true,
    parsed: rows.length,
    candidates: candidates.length,
    inserted,
    updated,
    skipped,
    imported: imported.slice(0, 25),
  };
}

module.exports = {
  importCsv,
  normalizeRow,
  parseRows,
  _internals: {
    getField,
    normalizeHeader,
    normalizeUrl,
    sourceDomain,
    isWavesTarget,
  },
};
