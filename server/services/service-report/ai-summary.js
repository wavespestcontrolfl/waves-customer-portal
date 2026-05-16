const crypto = require('crypto');
const db = require('../../models/db');
const { METHOD_LABELS } = require('./treatment-map');

const PROMPT_VERSION = 'service_report_ai_summary_v1';
const FORBIDDEN_PATTERNS = [
  /\binfestation\b/i,
  /\beliminated\b/i,
  /\bguaranteed\b/i,
  /\bdangerous\b/i,
  /\btoxic\b/i,
  /\bpoison\b/i,
  /\bsafe\b/i,
];

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sourceList(findings = [], applications = []) {
  return [
    { key: 'pressure_trend', label: 'Pressure trend', type: 'pressure_trend' },
    ...findings.map((finding) => ({
      key: `finding:${finding.id}`,
      label: cleanText(finding.title) || 'Finding',
      type: 'finding',
      id: finding.id,
    })),
    ...applications.map((app) => ({
      key: `application:${app.id}`,
      label: cleanText(app.product_name) || 'Application',
      type: 'application',
      id: app.id,
    })),
  ];
}

function pickMainFinding(findings = []) {
  const rank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  return [...findings].sort((a, b) => (rank[String(b.severity || '').toLowerCase()] || 0) - (rank[String(a.severity || '').toLowerCase()] || 0))[0] || null;
}

function pickRecommendation(findings = []) {
  return findings.find((finding) => cleanText(finding.recommendation)) || null;
}

function applicationSummary(applications = []) {
  if (!applications.length) return '';
  const methods = [...new Set(applications.map((app) => METHOD_LABELS[app.application_method] || cleanText(app.application_method).replace(/_/g, ' ')).filter(Boolean))];
  return methods.length ? `Treatment included ${methods.join(', ').toLowerCase()}.` : '';
}

async function loadAiSummaryRows(recordId, knex = db) {
  const [findings, applications] = await Promise.all([
    knex('service_findings')
      .where({ service_record_id: recordId })
      .select('id', 'severity', 'title', 'detail', 'recommendation', 'zone_id')
      .catch(() => []),
    knex('service_products')
      .where({ service_record_id: recordId })
      .select('id', 'product_name', 'application_method', 'application_area', 'targets')
      .catch(() => []),
  ]);
  return { findings, applications };
}

function buildAiSummaryFacts({ record, pressureTrend, reentry, sinceLastVisit, findings = [], applications = [] } = {}) {
  return {
    serviceLine: record?.service_line || record?.service_type || null,
    serviceDate: record?.started_at || record?.service_date || null,
    pressure: pressureTrend ? {
      current: pressureTrend.current?.pressureIndex,
      scale: '0-5',
      percentChange: pressureTrend.percentChange,
      direction: pressureTrend.direction,
      lowerIsBetter: true,
      summary: pressureTrend.customerSummary,
    } : undefined,
    reentry,
    sinceLastVisit,
    findings: findings.map((finding) => ({
      id: finding.id,
      sourceKey: `finding:${finding.id}`,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      recommendation: finding.recommendation,
      zoneId: finding.zone_id,
    })),
    applications: applications.map((app) => ({
      id: app.id,
      sourceKey: `application:${app.id}`,
      productName: app.product_name,
      method: app.application_method,
      area: app.application_area,
      targets: app.targets,
    })),
  };
}

function validateSummary(summary, validSourceKeys) {
  const text = [
    summary?.headline,
    summary?.body,
    ...(summary?.bullets || []).map((bullet) => bullet.text),
    summary?.recommendedNextStep?.text,
  ].filter(Boolean).join(' ');
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: `forbidden_language:${pattern}` };
    }
  }
  for (const bullet of summary?.bullets || []) {
    if (!Array.isArray(bullet.sourceKeys) || !bullet.sourceKeys.length) return { ok: false, reason: 'missing_source_keys' };
    if (bullet.sourceKeys.some((key) => !validSourceKeys.has(key))) return { ok: false, reason: 'invalid_source_key' };
  }
  if (summary?.recommendedNextStep?.sourceKeys?.some((key) => !validSourceKeys.has(key))) {
    return { ok: false, reason: 'invalid_recommendation_source_key' };
  }
  return { ok: true };
}

function buildFallbackAiSummary({ record, pressureTrend, reentry, sinceLastVisit, findings = [], applications = [], now = new Date(), inputHash } = {}) {
  const mainFinding = pickMainFinding(findings);
  const recommendation = pickRecommendation(findings);
  const appSummary = applicationSummary(applications);
  const findingSentence = mainFinding
    ? `${cleanText(mainFinding.title)}${mainFinding.detail ? `. ${cleanText(mainFinding.detail)}` : '.'}`
    : 'Your routine service is complete.';
  const body = [findingSentence, appSummary].filter(Boolean).join(' ').slice(0, 280);
  const bullets = [
    pressureTrend?.customerSummary ? {
      text: pressureTrend.customerSummary,
      sourceKeys: ['pressure_trend'],
      severity: 'info',
    } : null,
    sinceLastVisit?.pressureLine ? {
      text: sinceLastVisit.pressureLine,
      sourceKeys: ['pressure_trend'],
      severity: 'info',
    } : null,
    reentry?.customerSummary ? {
      text: reentry.customerSummary,
      sourceKeys: ['advisory'],
      severity: 'info',
    } : null,
  ].filter(Boolean).slice(0, 4);

  return {
    headline: pressureTrend?.customerSummary
      ? `Service is complete. ${pressureTrend.customerSummary}`
      : 'Service is complete.',
    body,
    bullets,
    recommendedNextStep: recommendation?.recommendation ? {
      text: cleanText(recommendation.recommendation),
      sourceKeys: [`finding:${recommendation.id}`],
      status: 'open',
    } : undefined,
    sources: [
      { key: 'advisory', label: 'Customer advisory', type: 'advisory' },
      ...sourceList(findings, applications),
    ],
    generatedAt: now.toISOString(),
    inputHash,
    promptVersion: PROMPT_VERSION,
    mode: 'deterministic_fallback',
  };
}

async function buildWavesAiSummaryContext({
  record,
  pressureTrend,
  reentry,
  sinceLastVisit,
  now = new Date(),
  knex = db,
} = {}) {
  if (!record?.id) return undefined;
  const { findings, applications } = await loadAiSummaryRows(record.id, knex);
  const facts = buildAiSummaryFacts({ record, pressureTrend, reentry, sinceLastVisit, findings, applications });
  const inputHash = sha256(stableStringify(facts));
  const existing = await knex('service_report_ai_summaries')
    .where({ service_record_id: record.id, input_hash: inputHash, prompt_version: PROMPT_VERSION })
    .first()
    .catch(() => null);
  if (existing?.summary_json) return typeof existing.summary_json === 'string' ? JSON.parse(existing.summary_json) : existing.summary_json;

  const summary = buildFallbackAiSummary({
    record,
    pressureTrend,
    reentry,
    sinceLastVisit,
    findings,
    applications,
    now,
    inputHash,
  });
  const validSourceKeys = new Set((summary.sources || []).map((source) => source.key));
  const validation = validateSummary(summary, validSourceKeys);
  const status = validation.ok ? 'fallback' : 'hidden';

  await knex('service_report_ai_summaries').insert({
    service_record_id: record.id,
    input_hash: inputHash,
    prompt_version: PROMPT_VERSION,
    model: null,
    status,
    summary_json: JSON.stringify(summary),
    validation_json: JSON.stringify(validation),
    generated_at: now,
  }).onConflict(['service_record_id', 'input_hash', 'prompt_version']).ignore().catch(() => {});

  return validation.ok ? summary : undefined;
}

module.exports = {
  PROMPT_VERSION,
  buildAiSummaryFacts,
  buildFallbackAiSummary,
  buildWavesAiSummaryContext,
  stableStringify,
  validateSummary,
};
