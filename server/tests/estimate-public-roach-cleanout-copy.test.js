const {
  isGeneralPestOneTimeItem,
  detectPestOneTime,
  isGermanRoachCleanoutOneTimeItem,
  germanRoachVisitPhrase,
  buildEstimateAskPrompts,
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

  test('German Roach Cleanout shows specialty Ask Waves prompts, not generic billing-only', () => {
    const prompts = buildEstimateAskPrompts([], [germanRoachItem], null, false);
    expect(prompts).toEqual([
      'How do you get rid of German roaches?',
      'How long until the roaches are gone?',
      'Are pets and kids safe?',
      'When am I charged?',
    ]);
    // German-roach prompts replace the generic ant chip.
    expect(prompts).not.toContain('How do you handle ants?');
    // Both specialty prompts carry the "roach" keyword so the Ask Waves
    // fallback routes them to the pest/roach answer branch.
    expect(prompts[0].toLowerCase()).toContain('roach');
    expect(prompts[1].toLowerCase()).toContain('roach');
  });

  test('German Roach detected by name (no service key) still gets specialty prompts', () => {
    const prompts = buildEstimateAskPrompts([], [{ name: 'German Roach Cleanout — 3 Visit Program', price: 450 }], null, false);
    expect(prompts.slice(0, 2)).toEqual([
      'How do you get rid of German roaches?',
      'How long until the roaches are gone?',
    ]);
  });

  test('a general pest estimate (no German roach) still gets the generic ant chip', () => {
    const prompts = buildEstimateAskPrompts([], [generalOneTimePest], null, true);
    expect(prompts[0]).toBe('How do you handle ants?');
    expect(prompts).not.toContain('How do you get rid of German roaches?');
  });

  test('visit phrase reflects the tiered program visit count', () => {
    expect(germanRoachVisitPhrase(2)).toBe('Two visits');
    expect(germanRoachVisitPhrase(3)).toBe('Three visits');
    expect(germanRoachVisitPhrase(4)).toBe('Four visits');
    expect(germanRoachVisitPhrase(0)).toBe('Multiple visits');
    expect(germanRoachVisitPhrase(5)).toBe('5 visits');
  });
});
