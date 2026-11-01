const { classifyServiceSensitivity, rainFreeHoursFor } = require('../services/service-sensitivity');
const forecastAnalyzer = require('../services/forecast-analyzer');
const RESCHEDULE_RULES = require('../config/reschedule-rules');

// forecast-analyzer.js's classifier as it was before the shared module.
function legacyClassify(str) {
  const s = (str || '').toLowerCase();
  if (s.includes('mosquito')) return 'mosquito';
  if (s.includes('termite') && (s.includes('bait') || s.includes('monitor'))) return 'termite_bait';
  if (s.includes('rodent') || s.includes('rat')) return 'rodent';
  if (s.includes('tree') && s.includes('inject')) return 'tree_injection';
  if (s.includes('tree') || s.includes('shrub')) return 'tree_shrub_spray';
  if ((s.includes('lawn') || s.includes('turf')) && s.includes('granular')) return 'lawn_granular';
  if (s.includes('lawn') || s.includes('turf')) return 'lawn_spray';
  if (s.includes('pest') && s.includes('interior')) return 'pest_interior';
  return 'pest_exterior';
}

const NAMES = [
  ['WaveGuard Mosquito Treatment', 'mosquito'],
  ['Termite Bait Station Monitoring', 'termite_bait'],
  ['Termite Liquid Treatment', 'pest_exterior'],
  ['Rodent Trapping Followup', 'rodent'],
  ['Rat Control', 'rodent'],
  ['Tree Injection', 'tree_injection'],
  ['Tree & Shrub Program', 'tree_shrub_spray'],
  ['Lawn Granular Fertilization', 'lawn_granular'],
  ['Turf Granular Application', 'lawn_granular'],
  ['Lawn Care Visit #3', 'lawn_spray'],
  ['Interior Pest Control', 'pest_interior'],
  ['Quarterly Pest Control', 'pest_exterior'],
  ['Exterior Pest Control', 'pest_exterior'],
  ['', 'pest_exterior'],
  [null, 'pest_exterior'],
  [undefined, 'pest_exterior'],
];

describe('shared service-sensitivity classifier', () => {
  test.each(NAMES)('%s -> %s, the same as forecast-analyzer before', (name, key) => {
    expect(classifyServiceSensitivity(name)).toBe(key);
    expect(legacyClassify(name)).toBe(key);
    expect(forecastAnalyzer.classifyServiceType(name)).toBe(key);
  });

  test('every name gives the answer the old classifier gave, odd words included', () => {
    ['Integrated Pest Management', 'Operate', 'Palm Injection', 'Fertilization & Weed Control', 'Interior and Exterior Pest', 'LAWN GRANULAR', 'tree injection']
      .forEach((name) => expect(classifyServiceSensitivity(name)).toBe(legacyClassify(name)));
  });

  test('the job card uses the same classifier', () => {
    const src = require('fs').readFileSync(require.resolve('../services/job-card'), 'utf8');
    expect(src).toContain("require('./service-sensitivity').classifyServiceSensitivity(serviceType)");
    expect(src).not.toContain('forecast-analyzer');
  });

  test('a catalog key joins the name; underscores read as spaces', () => {
    expect(classifyServiceSensitivity('Fertilization', 'lawn_granular')).toBe('lawn_granular');
    expect(classifyServiceSensitivity('', 'tree_injection')).toBe('tree_injection');
    expect(classifyServiceSensitivity('Quarterly Pest Control', 'pest_quarterly')).toBe('pest_exterior');
  });

  test('rain-free hours: Tree Injection and Lawn Granular need none', () => {
    expect(rainFreeHoursFor('Tree Injection')).toBe(0);
    expect(rainFreeHoursFor('Lawn Granular Fertilization')).toBe(0);
    expect(rainFreeHoursFor('', 'lawn_granular')).toBe(0);
    expect(rainFreeHoursFor('Lawn Care Visit')).toBe(RESCHEDULE_RULES.serviceSensitivity.lawn_spray.rain_free_hours);
    expect(rainFreeHoursFor('Tree & Shrub Program')).toBe(3);
    expect(rainFreeHoursFor('Mosquito')).toBe(2);
  });
});
