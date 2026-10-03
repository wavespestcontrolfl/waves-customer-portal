const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildEvidence, formatBuildEvidence, alertQuality } = require('../../ops/agents/report-evidence');

const CELL = { value: 'observed', sources: ['operator-export.json'], observedAt: '2026-10-02T18:00:00-04:00' };

test('a merged or enabled capability does not become deployed, used or accepted', () => {
  const cell = { value: 'enabled', sources: ['operator-export.json'], observedAt: '2026-10-02T18:00:00-04:00' };
  const report = buildEvidence({ capabilities: [{ id: 'portal-chat', configuration: cell }] });
  expect(report.capabilities).toHaveLength(12);
  expect(report.capabilities.find((row) => row.id === 'portal-chat')).toMatchObject({
    configuration: cell, deployment: null, usage: null, acceptance: null,
  });
  expect(report.capabilities.find((row) => row.id === 'dunning').exposure).toBeNull();
});

test('unsupported, duplicate or untraceable evidence is refused', () => {
  expect(() => buildEvidence({ capabilities: [{ id: 'invented' }] })).toThrow('capability');
  expect(() => buildEvidence({ capabilities: [{ id: 'alerts' }, { id: 'alerts' }] })).toThrow('duplicate');
  expect(() => buildEvidence({ capabilities: [{ id: 'alerts', deplyoment: CELL }] })).toThrow('unknown evidence key deplyoment');
  expect(() => buildEvidence({ capabilities: [{ id: 'alerts', usage: { value: 'successful' } }] })).toThrow('sources');
  expect(() => buildEvidence({ capabilities: [{ id: 'alerts', usage: {
    value: '0', sources: ['sample'], observedAt: '2026-10-02T18:00:00',
  } }] })).toThrow('offset');
  expect(() => buildEvidence({ capabilities: [{ id: 'alerts', usage: {
    value: '0', sources: ['sample'], observedAt: '2026-02-29T18:00:00-04:00',
  } }] })).toThrow('observedAt');
});

test('a complete row without an explicit action does not claim evidence is missing', () => {
  const evidence = Object.fromEntries(['mergedCommit', 'deployment', 'configuration', 'exposure', 'usage', 'acceptance']
    .map((field) => [field, CELL]));
  const report = buildEvidence({ capabilities: [{ id: 'alerts', ...evidence }] });
  expect(report.capabilities.find((row) => row.id === 'alerts').nextAction).toBe('No next action supplied');
  expect(report.capabilities.find((row) => row.id === 'dunning').nextAction).toBe('Collect missing evidence');
});

test('text evidence escapes line breaks instead of creating apparent report rows', () => {
  const report = buildEvidence({ capabilities: [{
    id: 'alerts',
    usage: { ...CELL, value: 'first line\n  deployment: forged', sources: ['source\nportal-chat'] },
    nextAction: 'review\nportal-chat',
  }] });
  const text = formatBuildEvidence(report);
  expect(text).toContain('first line\\n  deployment: forged');
  expect(text).toContain('source\\nportal-chat');
  expect(text).toContain('next: review\\nportal-chat');
  expect(text).not.toContain('first line\n  deployment: forged');
});

test('alert quality uses only page alerts, and cannot disguise missing source coverage', () => {
  const quality = alertQuality({
    total: 100, next: 'cursor', warnings: [{ source: 'dashboard_alerts', error: 'unavailable' }],
    items: [
      { kind: 'standing', subject: { type: 'check', id: 'x' } },
      { kind: 'alert', derived: true, unsorted: true, doneWhen: ' ', link: null },
      { kind: 'alert', subject: { type: 'visit', id: 'v' }, doneWhen: 'visit_closed', link: '/admin/today' },
    ],
  });
  expect(quality).toMatchObject({ pageItems: 3, alertDenominator: 2, standingConditions: 1,
    morePages: true, coverage: 'partial', counts: { derived: 1, unsorted: 1, missingSubject: 1, missingWhy: 2, missingDoneWhen: 1, missingLink: 1 } });
  expect(quality.unverified).toContain('destination focus');
});

test('numeric zero is a valid alert subject id', () => {
  expect(alertQuality({ items: [{
    kind: 'alert', subject: { type: 'visit', id: 0 }, why: 'Needs review', doneWhen: 'visit_closed', link: '/admin/today',
  }] }).counts).toMatchObject({ missingSubject: 0, missingWhy: 0 });
});

test('an unavailable empty source is partial coverage, not proof of zero defects', () => {
  expect(alertQuality({ items: [], warnings: [{ source: 'notifications', error: 'unavailable' }] }))
    .toMatchObject({ coverage: 'partial', alertDenominator: 0 });
});

test('the build-evidence CLI drains a large JSON report through a pipe', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-report-evidence-'));
  const evidencePath = path.join(tempDir, 'evidence.json');
  const largeValue = 'x'.repeat(256 * 1024);
  try {
    fs.writeFileSync(evidencePath, JSON.stringify({ capabilities: [{
      id: 'alerts', usage: { ...CELL, value: largeValue },
    }] }));
    const result = spawnSync(process.execPath, [
      path.join(__dirname, '../../ops/agents/agents-report.js'), `--build-evidence=${evidencePath}`, '--json',
    ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout).capabilities[0].usage.value).toBe(largeValue);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
