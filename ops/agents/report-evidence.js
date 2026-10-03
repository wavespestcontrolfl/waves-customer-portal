'use strict';
// READ-ONLY — evidence formatting for the existing terminal reports. No I/O.
const CAPABILITIES = [
  'alerts', 'dunning', 'offline', 'lawn-progress', 'portal-chat', 'pest-forecast',
  'build-operation', 'corrections', 'lawn-diagnosis', 'product-use', 'photo-id', 'sms-booking',
];
const FIELDS = ['mergedCommit', 'deployment', 'configuration', 'exposure', 'usage', 'acceptance'];

function buildEvidence(input) {
  if (!input || !Array.isArray(input.capabilities)) throw new Error('build evidence needs a capabilities array');
  const supplied = new Map();
  for (const row of input.capabilities) {
    if (!row || !CAPABILITIES.includes(row.id) || supplied.has(row.id)) throw new Error('unknown or duplicate capability id');
    supplied.set(row.id, row);
  }
  return {
    basis: 'operator-supplied evidence; no live reads or release decisions',
    capabilities: CAPABILITIES.map((id) => {
      const row = supplied.get(id) || {};
      const result = { id };
      for (const field of FIELDS) {
        const cell = row[field];
        if (cell == null) { result[field] = null; continue; }
        if (typeof cell.value !== 'string' || !cell.value.trim()
          || !Array.isArray(cell.sources) || !cell.sources.length
          || cell.sources.some((source) => typeof source !== 'string' || !source.trim())
          || typeof cell.observedAt !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(cell.observedAt)
          || !Number.isFinite(Date.parse(cell.observedAt))) {
          throw new Error(`${id}.${field} needs value, sources and offset-bearing observedAt`);
        }
        result[field] = { value: cell.value, sources: cell.sources, observedAt: cell.observedAt };
      }
      if (row.nextAction != null && (typeof row.nextAction !== 'string' || !row.nextAction.trim())) throw new Error(`${id}.nextAction must be text`);
      result.nextAction = row.nextAction || 'Collect missing evidence';
      return result;
    }),
  };
}

function alertQuality(page) {
  const alerts = page.items.filter((item) => item.kind === 'alert');
  const warnings = page.warnings || [];
  return {
    scope: 'returned page only; open non-FYI work and unsorted alerts, after requested filters',
    pageItems: page.items.length,
    alertDenominator: alerts.length,
    standingConditions: page.items.length - alerts.length,
    morePages: Boolean(page.next),
    coverage: warnings.length ? 'partial' : 'available',
    unavailableSources: warnings,
    counts: {
      derived: alerts.filter((item) => item.derived).length,
      unsorted: alerts.filter((item) => item.unsorted).length,
      missingSubject: alerts.filter((item) => !item.subject?.type || !item.subject?.id).length,
      missingDoneWhen: alerts.filter((item) => !item.doneWhen?.trim()).length,
      missingLink: alerts.filter((item) => !item.link?.trim()).length,
    },
    unverified: ['destination focus', 'clearing predicate behavior', 'repeat episodes', 'usefulness', 'rule fallbacks'],
  };
}

function formatBuildEvidence(report) {
  const rows = report.capabilities.map((row) => {
    const cells = FIELDS.map((field) => {
      const cell = row[field];
      return `  ${field}: ${cell ? `${cell.value} (observed ${cell.observedAt}; ${cell.sources.join(', ')})` : 'unknown'}`;
    });
    return [row.id, ...cells, `  next: ${row.nextAction}`].join('\n');
  });
  return [report.basis, ...rows].join('\n\n');
}

module.exports = { buildEvidence, formatBuildEvidence, alertQuality };
