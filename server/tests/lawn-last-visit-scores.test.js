const { previousFromCustomerRows, shape } = require('../services/lawn-last-visit-scores');

describe('last visit scores: customer-wide pick (GATE_LAWN_PROPERTY_HISTORY off)', () => {
  const history = [
    { id: 'future', service_date: '2026-10-01', confirmed_by_tech: true },
    { id: 'draft', service_date: '2026-08-30', confirmed_by_tech: false },
    { id: 'current', service_date: '2026-09-05', confirmed_by_tech: true },
    { id: 'previous', service_date: '2026-08-01', confirmed_by_tech: true },
    { id: 'baseline', service_date: '2026-07-01', confirmed_by_tech: true },
  ];

  test('the latest earlier confirmed visit, whatever the row order', () => {
    expect(previousFromCustomerRows(history, { visitDate: '2026-09-05' }).id).toBe('previous');
    expect(previousFromCustomerRows([...history].reverse(), { visitDate: '2026-09-05' }).id).toBe('previous');
  });

  test('a backdated visit reads the visit before its own date', () => {
    expect(previousFromCustomerRows(history, { visitDate: '2026-07-20' }).id).toBe('baseline');
    expect(previousFromCustomerRows([], { visitDate: '2026-09-05' })).toBeNull();
  });

  test('a linked row dates by its appointment, and this visit never counts', () => {
    const rows = [
      { id: 'current', service_id: 'current', appointment_date: '2026-08-01', service_date: '2026-08-01', confirmed_by_tech: true },
      { id: 'backfilled', service_id: 'previous', appointment_date: '2026-08-15', service_date: '2026-10-01', confirmed_by_tech: true },
      { id: 'future', service_id: 'future', appointment_date: '2026-10-01', service_date: '2026-08-20', confirmed_by_tech: true },
      { id: 'missing-appointment', service_id: 'missing', service_date: '2026-08-31', confirmed_by_tech: true },
    ];
    expect(previousFromCustomerRows(rows, { serviceId: 'current', visitDate: '2026-09-05' }).id).toBe('backfilled');
    expect(previousFromCustomerRows([rows[0]], { serviceId: 'current', visitDate: '2026-09-05' })).toBeNull();
  });

  test('the newest confirmed retake wins when appointment dates tie', () => {
    const original = { id: 'original', service_id: 'prior', appointment_date: '2026-08-01', confirmed_by_tech: true, created_at: '2026-08-01T14:00:00Z' };
    const retake = { ...original, id: 'retake', created_at: '2026-08-01T14:10:00Z' };
    for (const rows of [[original, retake], [retake, original]]) {
      expect(previousFromCustomerRows(rows, { serviceId: 'today', visitDate: '2026-09-05' }).id).toBe('retake');
    }
  });
});

describe('last visit scores: shape', () => {
  test('four scores and the overall, legacy rows normalized like the customer report', () => {
    const row = { overall_score: 99, turf_density: 80, weed_suppression: 80, color_health: 80, stress_damage: null, fungus_control: 60, thatch_level: 70 };
    expect(shape(row, '2026-07-10')).toEqual({
      date: '2026-07-10',
      overall: 76,
      scores: { turf_density: 80, weed_suppression: 80, color_health: 80, stress_damage: 60 },
    });
  });

  test('no row is null; a missing score stays null', () => {
    expect(shape(null, null)).toBeNull();
    expect(shape({ turf_density: 70 }, '2026-08-01').scores.color_health).toBeNull();
  });
});
