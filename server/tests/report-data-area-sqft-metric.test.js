// The lawn report payload's "Sq ft" metric (area_sqft) counts the whole-lawn rows only: a spot
// treatment's area (the technician's Fast Complete spot area, owner 2026-10-08) never adds to it.
// The per-row area stays on the application itself. Synthetic rows.
const { metricValue } = require('../services/service-report/report-data');
const { getServiceLineConfig } = require('../services/service-report/service-line-configs');

const metric = getServiceLineConfig('lawn').metrics.find((m) => m.key === 'area_sqft');
const app = (method, areaValue, areaUnit = 'sqft') => ({ method, areaValue, areaUnit });
const sqft = (...applications) => metricValue(metric, { applications });

describe('area_sqft counts whole-lawn rows only', () => {
  test('the lawn line carries the metric', () => {
    expect(metric).toMatchObject({ key: 'area_sqft', label: 'Sq ft' });
  });

  test('a 6,000 sq ft lawn with a 250 sq ft weed spot reads 6,000', () => {
    expect(sqft(app('broadcast_spray', 6000), app('spot_treatment', 250))).toBe(6000);
  });

  test.each(['spot_treatment', 'Spot treatment', 'spot_spray', ' SPOT-TREATMENT '])('the method %j is a spot row however it is spelled', (method) => {
    expect(sqft(app('granular_broadcast', 6000), app(method, 250))).toBe(6000);
  });

  // A legacy row with no stored method gets one inferred from its category (every herbicide
  // reads as a spot): its recorded area is a whole-lawn area and still counts.
  test('an INFERRED spot method keeps its area in the total', () => {
    expect(sqft({ ...app('spot_treatment', 6000), methodInferred: true }, app('spot_treatment', 250))).toBe(6000);
  });

  test('only spot rows: no area (null, as with no area at all)', () => {
    expect(sqft(app('spot_treatment', 250), app('spot_treatment', 100))).toBeNull();
  });

  test('whole-lawn methods are unchanged, including a row with no recorded method', () => {
    expect(sqft(app('broadcast_spray', 6000), app('granular_broadcast', 6000))).toBe(12000);
    expect(sqft(app(null, 6000), app(undefined, 500))).toBe(6500);
  });

  test('linear feet never count toward square feet, and the linear_ft metric is unchanged', () => {
    expect(sqft(app('perimeter_spray', 300, 'linear_ft'), app('broadcast_spray', 6000))).toBe(6000);
    const linear = { key: 'linear_ft' };
    expect(metricValue(linear, { applications: [app('perimeter_spray', 300, 'linear_ft'), app('spot_treatment', 40, 'linear_ft')] })).toBe(340);
  });
});
