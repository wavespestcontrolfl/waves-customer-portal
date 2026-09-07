const { resolveVisit, installedRows, progress, historyIdentity } = require('../services/lawn-assessment-history');

const visitRow = (fields = {}) => ({
  id: 'assessment-a', customer_id: 'customer-a', service_id: 'visit-a',
  history_visit_id: 'visit-a', history_visit_customer_id: 'customer-a',
  history_visit_date: '2026-01-02', service_date: '2026-02-01',
  confirmed_by_tech: true, created_at: '2026-02-01T12:00:00Z', ...fields,
});

test('visit identity resolves both links before falling back to record or assessment identity', () => {
  expect(resolveVisit(visitRow())).toMatchObject({ identity: 'visit:visit-a', visitDate: '2026-01-02', conflict: false });
  expect(resolveVisit(visitRow({ service_id: null, service_record_id: 'record-a', history_record_id: 'record-a', history_record_customer_id: 'customer-a', history_record_visit_id: 'visit-a' })).identity).toBe('visit:visit-a');
  expect(resolveVisit({ id: 'standalone', customer_id: 'customer-a', service_date: '2026-01-01' }).identity).toBe('assessment:standalone');
  expect(resolveVisit(visitRow({ service_record_id: 'record-a', history_record_id: 'record-a', history_record_customer_id: 'customer-a', history_record_visit_id: 'visit-b' })).conflict).toBe(true);
});

test('pinned selection is local to its render and cannot alter canonical installation', () => {
  const a = visitRow({ service_record_id: 'record-a', history_record_id: 'record-a', history_record_customer_id: 'customer-a', history_record_visit_id: 'visit-a' });
  const b = visitRow({ id: 'assessment-b', confirmed_at: '2026-02-02T12:00:00Z' });
  expect(installedRows([b, a]).map((row) => row.id)).toEqual([a.id]);
  expect(installedRows([b, a], { pinned: true, current: b }).map((row) => row.id)).toEqual([b.id]);
  expect(installedRows([b, a]).map((row) => row.id)).toEqual([a.id]);
});

test('progress preserves unknown and zero, with shared weighted scores', () => {
  const previous = { id: 'previous', turf_density: null, weed_suppression: null, color_health: null, stress_damage: null };
  const current = { id: 'current', turf_density: 0, weed_suppression: 0, color_health: 0, stress_damage: 0 };
  expect(progress([previous, current], current)).toEqual({ score: 0, previousScore: null, baselineScore: null, previousDelta: null, baselineDelta: null });
});

test('history signature includes dates and score revisions without current-row changes', () => {
  const rows = [visitRow(), visitRow({ id: 'assessment-b', service_id: 'visit-b' })];
  const before = historyIdentity({ propertyId: 'property-a' }, null, rows);
  expect(historyIdentity({ propertyId: 'property-a' }, null, rows)).toBe(before);
  expect(historyIdentity({ propertyId: 'property-a' }, null, [{ ...rows[0], turf_density: 25 }, rows[1]])).not.toBe(before);
});
