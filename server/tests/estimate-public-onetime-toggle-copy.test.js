/**
 * oneTimeToggleCopyForCategory — SSR mirror of the SPA's category-aware
 * recurring/one-time toggle (codex P2 on #2754: the sent-link page is
 * server-rendered, so the client-only fix left lawn customers seeing
 * "One-Time Pest Control"). Pins: lawn gets lawn labels and NO pest
 * callback line; mosquito/tree_shrub get their own labels but keep the
 * callback; pest/bundle/unknown return null so the template's legacy pest
 * strings render byte-identical.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { oneTimeToggleCopyForCategory, isOneTimeChoiceItemForCategory } = require('../routes/estimate-public');

describe('oneTimeToggleCopyForCategory', () => {
  test('lawn_care: lawn labels, turf note, NO pest callback line', () => {
    const copy = oneTimeToggleCopyForCategory('lawn_care');
    expect(copy.recurringLabel).toBe('Recurring Lawn Program');
    expect(copy.oneTimeLabel).toBe('One-Time Lawn Treatment');
    expect(copy.oneTimeNote).toMatch(/lawn treatment for the measured turf/i);
    expect(copy.oneTimeNote).not.toMatch(/if pests return/);
    expect(copy.callbackNote).toBeNull();
  });

  test('mosquito and tree_shrub get their own labels and keep the callback note', () => {
    expect(oneTimeToggleCopyForCategory('mosquito').oneTimeLabel).toBe('One-Time Mosquito Treatment');
    expect(oneTimeToggleCopyForCategory('mosquito').callbackNote).toMatch(/30-day callback/);
    expect(oneTimeToggleCopyForCategory('tree_shrub').oneTimeLabel).toBe('One-Time Tree & Shrub Visit');
  });

  test('pest / bundle / unknown return null so legacy pest strings render unchanged', () => {
    expect(oneTimeToggleCopyForCategory('pest_control')).toBeNull();
    expect(oneTimeToggleCopyForCategory('bundle')).toBeNull();
    expect(oneTimeToggleCopyForCategory(undefined)).toBeNull();
  });

  test('one-time mode closing headline is category-aware (codex r2)', () => {
    expect(oneTimeToggleCopyForCategory('lawn_care').finalHeading).toBe('Go Waves! Wave Goodbye to Lawn Pests!');
    expect(oneTimeToggleCopyForCategory('mosquito').finalHeading).toBe('Go Waves! Wave Goodbye to Mosquitoes!');
  });

  test('the lawn choice row is recognized so recurring mode can suppress it (codex r2)', () => {
    // The SSR "billed separately" filter drops the alternate choice row via
    // isOneTimeChoiceItemForCategory for non-pest choice shapes — pin that
    // the real one_time_lawn engine row matches (and a genuine add-on
    // without one-time wording does not).
    expect(isOneTimeChoiceItemForCategory(
      { service: 'one_time_lawn', name: 'One-Time Lawn', price: 174 }, 'lawn_care',
    )).toBe(true);
    expect(isOneTimeChoiceItemForCategory(
      { service: 'top_dressing', name: 'Top Dressing', price: 420 }, 'lawn_care',
    )).toBe(false);
  });

  test('labels match the SPA map in EstimateViewPage (cross-surface contract)', () => {
    // Kept as literal strings on purpose: if either surface rewords a label,
    // this test forces the other to move in the same PR.
    expect(oneTimeToggleCopyForCategory('lawn_care').oneTimeLabel).toBe('One-Time Lawn Treatment');
    expect(oneTimeToggleCopyForCategory('lawn_care').recurringLabel).toBe('Recurring Lawn Program');
  });
});
