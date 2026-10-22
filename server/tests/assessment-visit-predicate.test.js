// isAssessmentVisit: the pure "is this scheduled row the free Waves Assessment"
// predicate estimate adoption uses, plus appointmentMatchesEstimateFamily's
// refusal of such rows. The assessment's catalog key (lawn_inspection) sits in
// the lawn family, so family matching alone would let a lawn plan adopt it.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { isAssessmentVisit, withoutAssessmentVisits, excludeAssessmentBookings } = require('../services/assessment-booking');
const { appointmentMatchesEstimateFamily } = require('../routes/estimate-public');

describe('isAssessmentVisit', () => {
  test('catalog key lawn_inspection, whatever the labels say', () => {
    expect(isAssessmentVisit({ catalog_service_key: 'lawn_inspection', service_type: 'Lawn Care Service' })).toBe(true);
  });

  test('catalog name Waves Assessment (case and spacing tolerant)', () => {
    expect(isAssessmentVisit({ catalog_service_name: '  waves assessment ', service_type: 'x' })).toBe(true);
  });

  test('catalog identity wins: a row repointed to a paid service stays adoptable despite a stale label', () => {
    expect(isAssessmentVisit({
      catalog_service_key: 'lawn_care_monthly', catalog_service_name: 'Monthly Lawn Care Service', service_type: 'Waves Assessment',
    })).toBe(false);
    expect(isAssessmentVisit({ catalog_service_key: 'lawn_care_monthly', service_type: 'waves assessment' })).toBe(false);
  });

  test('catalog identity wins the other way: the assessment catalog row is one whatever service_type says', () => {
    expect(isAssessmentVisit({
      catalog_service_key: 'lawn_inspection', catalog_service_name: 'Waves Assessment', service_type: 'Lawn Care Visit',
    })).toBe(true);
  });

  test('unlinked legacy row identified by service_type', () => {
    expect(isAssessmentVisit({ service_type: 'Waves Assessment' })).toBe(true);
    expect(isAssessmentVisit({ service_type: 'WAVES ASSESSMENT' })).toBe(true);
  });

  test('real service visits are not assessments', () => {
    expect(isAssessmentVisit({ service_type: 'Lawn Care Service', catalog_service_key: 'lawn_care_monthly' })).toBe(false);
    expect(isAssessmentVisit({ service_type: 'Quarterly Pest Control Service' })).toBe(false);
    // A paid inspection is a real sale, not the free consultation.
    expect(isAssessmentVisit({ service_type: 'WDO Inspection', catalog_service_key: 'wdo_inspection' })).toBe(false);
    expect(isAssessmentVisit({ service_type: 'Waves Assessment Plus' })).toBe(false);
  });

  test('empty input is not an assessment', () => {
    expect(isAssessmentVisit(null)).toBe(false);
    expect(isAssessmentVisit(undefined)).toBe(false);
    expect(isAssessmentVisit({})).toBe(false);
  });
});

describe('withoutAssessmentVisits (catalog wins, one batched lookup)', () => {
  const catalog = [
    { id: 'svc-assess', service_key: 'lawn_inspection', name: 'Waves Assessment' },
    { id: 'svc-lawn', service_key: 'lawn_care_monthly', name: 'Monthly Lawn Care Service' },
  ];
  const makeDb = () => {
    const calls = [];
    const database = (table) => {
      const q = {
        whereIn: (col, ids) => { calls.push([table, col, ids]); return q; },
        select: async () => catalog.filter((row) => calls[calls.length - 1][2].includes(row.id)),
      };
      return q;
    };
    return { database, calls };
  };

  test('drops assessment rows by catalog link and by name when unlinked; keeps real visits in order', async () => {
    const { database, calls } = makeDb();
    const rows = [
      { id: 'a', service_type: 'Waves Assessment', service_id: null },
      { id: 'b', service_type: 'Lawn Care Visit', service_id: 'svc-assess' },
      { id: 'c', service_type: 'Monthly Lawn Care Service', service_id: 'svc-lawn' },
      { id: 'd', service_type: 'Quarterly Pest Control Service', service_id: null },
    ];
    const kept = await withoutAssessmentVisits(rows, database);
    expect(kept.map((row) => row.id)).toEqual(['c', 'd']);
    expect(calls).toEqual([['services', 'id', ['svc-assess', 'svc-lawn']]]);
  });

  test('a row repointed to a paid service keeps its place despite a stale Waves Assessment label', async () => {
    const { database } = makeDb();
    const kept = await withoutAssessmentVisits([
      { id: 'repointed', service_type: 'Waves Assessment', service_id: 'svc-lawn' },
      { id: 'assess', service_type: 'Lawn Care Visit', service_id: 'svc-assess' },
    ], database);
    expect(kept.map((row) => row.id)).toEqual(['repointed']);
  });

  test('a service_id that resolves to no catalog row falls back to service_type', async () => {
    const { database } = makeDb();
    const kept = await withoutAssessmentVisits([
      { id: 'orphan-assess', service_type: 'Waves Assessment', service_id: 'svc-gone' },
      { id: 'orphan-real', service_type: 'Pest Visit', service_id: 'svc-gone' },
    ], database);
    expect(kept.map((row) => row.id)).toEqual(['orphan-real']);
  });

  test('no catalog read when no row carries a service_id', async () => {
    const { database, calls } = makeDb();
    const kept = await withoutAssessmentVisits([{ id: 'd', service_type: 'Pest Visit', service_id: null }], database);
    expect(kept).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test('empty or non-array input yields an empty list', async () => {
    expect(await withoutAssessmentVisits([])).toEqual([]);
    expect(await withoutAssessmentVisits(null)).toEqual([]);
  });
});

describe('excludeAssessmentBookings (SQL twin, catalog wins)', () => {
  test('adds one NULL-safe NOT(CASE ...) clause with the aliased columns', () => {
    const calls = [];
    const query = { whereRaw: (...args) => { calls.push(args); return query; } };
    expect(excludeAssessmentBookings(query, 'ss', 'svc')).toBe(query);
    expect(calls).toHaveLength(1);
    const [sql, bindings] = calls[0];
    expect(sql).toMatch(/^NOT \(CASE WHEN \?\? IS NOT NULL/);
    expect(sql).toMatch(/ELSE LOWER\(TRIM\(COALESCE\(\?\?, ''\)\)\) = \? END\)$/);
    expect(bindings).toEqual([
      'svc.id',
      'svc.service_key', 'lawn_inspection',
      'svc.name', 'waves assessment',
      'ss.service_type', 'waves assessment',
    ]);
  });
});

describe('appointmentMatchesEstimateFamily — assessment rows', () => {
  const lawn = new Set(['lawn_care']);
  const pest = new Set(['pest_control']);

  test('assessment by catalog key never matches the lawn family', () => {
    expect(appointmentMatchesEstimateFamily({
      catalog_service_key: 'lawn_inspection', catalog_service_name: 'Waves Assessment', service_type: 'Waves Assessment',
    }, lawn)).toBe(false);
    expect(appointmentMatchesEstimateFamily({
      catalog_service_key: 'lawn_inspection', service_type: 'Lawn Care Visit',
    }, lawn)).toBe(false);
  });

  test('assessment by name (no catalog link) never matches', () => {
    expect(appointmentMatchesEstimateFamily({ service_type: 'Waves Assessment' }, lawn)).toBe(false);
    expect(appointmentMatchesEstimateFamily({ service_type: 'Waves Assessment' }, pest)).toBe(false);
  });

  test('a row repointed to a paid lawn service with a stale Waves Assessment label still adopts', () => {
    expect(appointmentMatchesEstimateFamily({
      catalog_service_key: 'lawn_care_monthly', catalog_service_name: 'Monthly Lawn Care Service', service_type: 'Waves Assessment',
    }, lawn)).toBe(true);
  });

  test('a real lawn visit still adopts', () => {
    expect(appointmentMatchesEstimateFamily({
      catalog_service_key: 'lawn_care_monthly', catalog_service_name: 'Lawn Care Service', service_type: 'Lawn Care Service',
    }, lawn)).toBe(true);
    expect(appointmentMatchesEstimateFamily({ service_type: 'Lawn Care Visit' }, lawn)).toBe(true);
  });

  test('pest family behavior is unchanged', () => {
    expect(appointmentMatchesEstimateFamily({ service_type: 'Quarterly Pest Control Service' }, pest)).toBe(true);
    expect(appointmentMatchesEstimateFamily({ service_type: 'Quarterly Pest Control Service' }, lawn)).toBe(false);
  });
});
