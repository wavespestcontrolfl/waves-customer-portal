const { stripModelWrapper } = require('../services/social-media');

// Fixtures below are (lightly trimmed) real published posts from
// social_media_posts.platforms_posted — the wrapper text went out verbatim
// on LinkedIn and GBP between 2026-06-27 and 2026-07-03.

describe('stripModelWrapper', () => {
  test('strips a leading "Here\'s a … post:" meta line + trailing count + fence (LinkedIn, 07-03)', () => {
    const raw = 'Here\'s a LinkedIn post within your 100–200 character limit:\n\n' +
      '**Venice pest pressure is peaking. Heat + humidity = maximum activity. Now\'s the time to stay ahead of it.**\n\n' +
      '---\n*197 characters*';
    expect(stripModelWrapper(raw)).toBe(
      'Venice pest pressure is peaking. Heat + humidity = maximum activity. Now\'s the time to stay ahead of it.'
    );
  });

  test('strips an inline preamble with --- fences and "(Character count: ~240)" (GBP, 07-03)', () => {
    const raw = 'Here\'s a Google Business Profile post for Waves Pest Control Venice: --- ' +
      'Venice homeowners, peak summer heat and humidity push pest pressure to its highest levels of the year. ' +
      'Schedule an inspection. --- *(Character count: ~240)*';
    expect(stripModelWrapper(raw)).toBe(
      'Venice homeowners, peak summer heat and humidity push pest pressure to its highest levels of the year. ' +
      'Schedule an inspection.'
    );
  });

  test('strips "Here\'s a LinkedIn post within your parameters:" (LinkedIn, 06-29)', () => {
    const raw = 'Here\'s a LinkedIn post within your parameters:\n\nParrish lawns are showing fungus after the rain. Get ahead of it.';
    expect(stripModelWrapper(raw)).toBe('Parrish lawns are showing fungus after the rain. Get ahead of it.');
  });

  test('unwraps markdown bold anywhere in the copy', () => {
    expect(stripModelWrapper('**Sarasota mosquito pressure is at a 5.** Standing water is the driver. **Act now.**'))
      .toBe('Sarasota mosquito pressure is at a 5. Standing water is the driver. Act now.');
  });

  test('strips a count note enclosed inside the --- fences', () => {
    const raw = '---\nSarasota mosquito pressure is at a 5 right now. Standing water is the driver.\n*(Character count: ~240)*\n---';
    expect(stripModelWrapper(raw)).toBe('Sarasota mosquito pressure is at a 5 right now. Standing water is the driver.');
  });

  test('keeps hyphenated "post-" hooks — adjective, not artifact noun', () => {
    const hook = "Here's a post-storm mosquito tip: dump standing water within 48 hours.";
    expect(stripModelWrapper(hook)).toBe(hook);
    const hook2 = "Here's a post-treatment reminder: keep pets off the lawn for 2 hours.";
    expect(stripModelWrapper(hook2)).toBe(hook2);
  });

  test('keeps legit "Here\'s what we\'re seeing" hooks untouched', () => {
    const hook = "Here's what we're seeing in Venice after the rain… chinch bug damage that looks like drought.";
    expect(stripModelWrapper(hook)).toBe(hook);
    const watching = 'Here is what we are watching around Venice: peak summer pest pressure.';
    expect(stripModelWrapper(watching)).toBe(watching);
  });

  test('keeps clean copy byte-identical (hashtag block, emoji, question)', () => {
    const clean = 'Mosquito pressure in Sarasota right now? It\'s a 5 out of 5. 🦟\n\n' +
      'The hum after those afternoon storms is real.\n\n#wavespestcontrol #swfl #mosquitoes';
    expect(stripModelWrapper(clean)).toBe(clean);
  });

  test('returns empty string for null/undefined/empty', () => {
    expect(stripModelWrapper(null)).toBe('');
    expect(stripModelWrapper(undefined)).toBe('');
    expect(stripModelWrapper('   ')).toBe('');
  });
});
