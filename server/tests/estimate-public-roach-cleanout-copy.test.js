const {
  isGeneralPestOneTimeItem,
  detectPestOneTime,
  isGermanRoachCleanoutOneTimeItem,
  germanRoachVisitPhrase,
} = require('../routes/estimate-public');

describe('German Roach Cleanout customer-facing estimate copy', () => {
  const germanRoachItem = {
    service: 'german_roach',
    name: 'German Roach Cleanout — 2 Visit Program',
    visits: 2,
    price: 350,
  };
  const generalOneTimePest = { service: 'one_time_pest', name: 'One-Time Pest', price: 257 };
  const standaloneCockroach = { service: 'pest_initial_roach', name: 'Standalone Native Cockroach Treatment', price: 239 };

  test('the interior-spray / eave-sweep toggles are gated to general pest only', () => {
    // General one-time pest still surfaces the preference toggles…
    expect(isGeneralPestOneTimeItem(generalOneTimePest)).toBe(true);
    expect(detectPestOneTime([generalOneTimePest])).toBe(true);

    // …but specialty roach services do not.
    expect(isGeneralPestOneTimeItem(germanRoachItem)).toBe(false);
    expect(isGeneralPestOneTimeItem(standaloneCockroach)).toBe(false);
    expect(detectPestOneTime([germanRoachItem])).toBe(false);
    expect(detectPestOneTime([standaloneCockroach])).toBe(false);
  });

  test('falls back to name matching when the item carries no service key', () => {
    expect(isGeneralPestOneTimeItem({ name: 'One-Time Pest Control' })).toBe(true);
    expect(isGeneralPestOneTimeItem({ name: 'German Roach Cleanout — 3 Visit Program' })).toBe(false);
    expect(isGeneralPestOneTimeItem({ name: 'Wasp / Stinging Insect Treatment' })).toBe(false);
    expect(isGeneralPestOneTimeItem({ name: 'Rodent Exclusion' })).toBe(false);
  });

  test('the non-roach "Initial Pest Cleanout" is general pest and keeps its toggles', () => {
    const initialPestCleanout = { service: 'pest_initial_cleanout', name: 'Initial Pest Cleanout', price: 199 };
    // A plain pest "cleanout" is general pest control — not the roach specialty.
    expect(isGeneralPestOneTimeItem(initialPestCleanout)).toBe(true);
    expect(isGermanRoachCleanoutOneTimeItem(initialPestCleanout)).toBe(false);
  });

  test('German Roach Cleanout is detected by service key and by name', () => {
    expect(isGermanRoachCleanoutOneTimeItem(germanRoachItem)).toBe(true);
    expect(isGermanRoachCleanoutOneTimeItem({ name: 'German Roach Cleanout — 4 Visit Program' })).toBe(true);
    expect(isGermanRoachCleanoutOneTimeItem({ name: 'Roach Cleanout' })).toBe(true);
    expect(isGermanRoachCleanoutOneTimeItem(generalOneTimePest)).toBe(false);
    expect(isGermanRoachCleanoutOneTimeItem(standaloneCockroach)).toBe(false);
  });

  test('visit phrase reflects the tiered program visit count', () => {
    expect(germanRoachVisitPhrase(2)).toBe('Two visits');
    expect(germanRoachVisitPhrase(3)).toBe('Three visits');
    expect(germanRoachVisitPhrase(4)).toBe('Four visits');
    expect(germanRoachVisitPhrase(0)).toBe('Multiple visits');
    expect(germanRoachVisitPhrase(5)).toBe('5 visits');
  });
});
