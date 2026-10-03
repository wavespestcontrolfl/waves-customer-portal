const { buildEvidence, alertQuality } = require('../../ops/agents/report-evidence');

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
  expect(() => buildEvidence({ capabilities: [{ id: 'alerts', usage: { value: 'successful' } }] })).toThrow('sources');
  expect(() => buildEvidence({ capabilities: [{ id: 'alerts', usage: {
    value: '0', sources: ['sample'], observedAt: '2026-10-02T18:00:00',
  } }] })).toThrow('offset');
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
    morePages: true, coverage: 'partial', counts: { derived: 1, unsorted: 1, missingSubject: 1, missingDoneWhen: 1, missingLink: 1 } });
  expect(quality.unverified).toContain('destination focus');
});

test('an unavailable empty source is partial coverage, not proof of zero defects', () => {
  expect(alertQuality({ items: [], warnings: [{ source: 'notifications', error: 'unavailable' }] }))
    .toMatchObject({ coverage: 'partial', alertDenominator: 0 });
});
