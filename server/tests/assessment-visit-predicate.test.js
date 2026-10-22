// isAssessmentVisit: the pure "is this scheduled row the free Waves Assessment"
// predicate estimate adoption uses, plus appointmentMatchesEstimateFamily's
// refusal of such rows. The assessment's catalog key (lawn_inspection) sits in
// the lawn family, so family matching alone would let a lawn plan adopt it.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { isAssessmentVisit, withoutAssessmentVisits } = require('../services/assessment-booking');
const { appointmentMatchesEstimateFamily } = require('../routes/estimate-public');

describe('isAssessmentVisit', () => {
  test('catalog key lawn_inspection, whatever the labels say', () => {
    expect(isAssessmentVisit({ catalog_service_key: 'lawn_inspection', service_type: 'Lawn Care Service' })).toBe(true);
  });

  test('catalog name Waves Assessment (case and spacing tolerant)', () => {
    expect(isAssessmentVisit({ catalog_service_name: '  waves assessment ', service_type: 'x' })).toBe(true);
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

describe('withoutAssessmentVisits', () => {
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

  test('drops assessment rows by name and by catalog link; keeps real visits in order', async () => {
    const { database, calls } = makeDb();
    const rows = [
      { id: 'a', service_type: 'Waves Assessment', service_id: null },
      { id: 'b', service_type: 'Lawn Care Visit', service_id: 'svc-assess' },
      { id: 'c', service_type: 'Monthly Lawn Care Service', service_id: 'svc-lawn' },
      { id: 'd', service_type: 'Quarterly Pest Control Service', service_id: null },
    ];
    const kept = await withoutAssessmentVisits(rows, database);
    expect(kept.map((row) => row.id)).toEqual(['c', 'd']);
    // One batched catalog read, only for the rows the name did not settle.
    expect(calls).toEqual([['services', 'id', ['svc-assess', 'svc-lawn']]]);
  });

  test('no catalog read when no remaining row carries a service_id', async () => {
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
