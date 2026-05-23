const { evaluateTitleMetaSpam } = require('../services/content/title-meta-spam-gate');

describe('title-meta-spam-gate', () => {
  test('passes clean local service title and meta', () => {
    const result = evaluateTitleMetaSpam({
      title: 'Pest Control in Anna Maria, FL | Waves Pest Control',
      meta_description: 'Same-day pest control for Anna Maria homes and rentals with no contracts and a satisfaction guarantee.',
      city: 'Anna Maria',
      service: 'pest',
      target_keyword: 'pest control anna maria',
    });
    expect(result.ok).toBe(true);
    expect(result.hard_failures).toEqual([]);
  });

  test('hard-fails keyword-stuffed near-me title patterns', () => {
    const result = evaluateTitleMetaSpam({
      title: 'Pest Control Near Me in Anna Maria, FL | THE BEST Pest Control Anna Maria, FL | Top-Rated Exterminator Near Me',
      city: 'Anna Maria',
      service: 'pest',
    });
    expect(result.ok).toBe(false);
    expect(result.hard_failures.map((f) => f.code)).toEqual(expect.arrayContaining([
      'title_the_best_claim',
      'title_forced_near_me',
      'title_too_many_pipes',
      'title_stacked_hype',
    ]));
  });

  test('hard-fails repeated commercial phrases even without near-me wording', () => {
    const result = evaluateTitleMetaSpam({
      title: 'Pest Control Anna Maria | Pest Control Services for Anna Maria',
      city: 'Anna Maria',
      service: 'pest',
    });
    expect(result.ok).toBe(false);
    expect(result.hard_failures.map((f) => f.code)).toContain('title_repeats_phrase');
  });

  test('flags long but not egregious titles as soft warnings', () => {
    const result = evaluateTitleMetaSpam({
      title: 'Anna Maria Pest Control for Coastal Homes, Rentals, and Older Island Structures',
    });
    expect(result.ok).toBe(true);
    expect(result.soft_failures.map((f) => f.code)).toContain('title_long');
  });

  test('hard-fails meta descriptions that repeat near me', () => {
    const result = evaluateTitleMetaSpam({
      title: 'Pest Control in Bradenton, FL | Waves Pest Control',
      meta_description: 'Need pest control near me in Bradenton? Call the pest control near me team for fast help.',
    });
    expect(result.ok).toBe(false);
    expect(result.hard_failures.map((f) => f.code)).toContain('meta_repeats_near_me');
  });
});
