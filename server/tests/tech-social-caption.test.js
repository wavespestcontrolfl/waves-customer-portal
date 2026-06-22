const captionService = require('../services/tech-social-caption');
const techSocial = require('../routes/tech-social');

const { normalizeVision, normalizeCaptions, validateCaptions } = captionService._test;
const { resolveCaptionLocation, PLATFORM_LIMITS } = captionService;
const { selectPublishPlatforms, buildPostLogRow, buildTiktokClipboard, PUBLISHABLE } = techSocial._test;

describe('resolveCaptionLocation', () => {
  test('explicit valid locationId wins', () => {
    expect(resolveCaptionLocation({ locationId: 'sarasota' }).id).toBe('sarasota');
  });

  test('falls back to nearest GBP by device coordinates', () => {
    // Venice office coordinates → nearest must be venice.
    expect(resolveCaptionLocation({ lat: 27.0870, lng: -82.4046 }).id).toBe('venice');
  });

  test('coords beat an unknown id, never crash on junk id', () => {
    expect(resolveCaptionLocation({ locationId: 'not-a-place', lat: 27.0870, lng: -82.4046 }).id).toBe('venice');
  });

  test('defaults to the primary location with nothing to go on', () => {
    expect(resolveCaptionLocation({}).id).toBe('bradenton');
  });
});

describe('normalizeCaptions', () => {
  test('always returns all four platform keys', () => {
    const out = normalizeCaptions({ instagram: 'a' });
    expect(Object.keys(out).sort()).toEqual(['facebook', 'gbp', 'instagram', 'tiktok']);
    expect(out.facebook).toBe('');
  });

  test('clamps each caption to its platform ceiling', () => {
    const out = normalizeCaptions({
      facebook: 'x'.repeat(900),
      instagram: 'y'.repeat(3000),
      gbp: 'z'.repeat(2000),
      tiktok: 't'.repeat(3000),
    });
    expect(out.facebook).toHaveLength(PLATFORM_LIMITS.facebook);
    expect(out.instagram).toHaveLength(PLATFORM_LIMITS.instagram);
    expect(out.gbp).toHaveLength(PLATFORM_LIMITS.gbp);
    expect(out.tiktok).toHaveLength(PLATFORM_LIMITS.tiktok);
  });

  test('trims and ignores non-string values', () => {
    expect(normalizeCaptions({ facebook: '  hi  ', instagram: 42 }).facebook).toBe('hi');
    expect(normalizeCaptions({ instagram: 42 }).instagram).toBe('');
  });
});

describe('validateCaptions', () => {
  test('flags pricing on every platform incl. tiktok (reuses facebook ruleset)', () => {
    const v = validateCaptions({
      instagram: 'Our plan is $99/mo right now',
      facebook: 'Clean and specific copy about chinch bugs in Venice lawns.',
      tiktok: 'Grab it for $49/visit',
      gbp: 'Seeing crispy St. Augustine in Venice? Schedule an inspection.',
    });
    expect(v.instagram.length).toBeGreaterThan(0);
    expect(v.tiktok.length).toBeGreaterThan(0);
    expect(v.facebook).toEqual([]);
    expect(v.gbp).toEqual([]);
  });
});

describe('normalizeVision', () => {
  test('lowercases + caps tags, sanitizes enum fields', () => {
    const out = normalizeVision({
      subject: ' German cockroach ',
      scene: 'On a kitchen floor.',
      category: 'pest',
      beforeAfter: 'sideways',
      notable: '',
      tags: ['Roach', 'KITCHEN', 'a', 'b', 'c', 'd', 'e', 'f'],
    });
    expect(out.subject).toBe('German cockroach');
    expect(out.beforeAfter).toBe('none'); // invalid enum → none
    expect(out.category).toBe('pest');
    expect(out.tags).toHaveLength(6);
    expect(out.tags).toContain('roach');
  });

  test('category defaults to other', () => {
    expect(normalizeVision({}).category).toBe('other');
  });
});

describe('selectPublishPlatforms', () => {
  test('omitted (null/undefined) → all publishable, in canonical order', () => {
    expect(selectPublishPlatforms()).toEqual(PUBLISHABLE);
    expect(selectPublishPlatforms(null)).toEqual(PUBLISHABLE);
  });

  test('fail-closed: explicit empty array or malformed value → nothing', () => {
    expect(selectPublishPlatforms([])).toEqual([]);
    expect(selectPublishPlatforms('instagram')).toEqual([]);
  });

  test('drops tiktok (no API) and unknowns; preserves PUBLISHABLE order', () => {
    expect(selectPublishPlatforms(['tiktok', 'instagram'])).toEqual(['instagram']);
    expect(selectPublishPlatforms(['gbp', 'facebook'])).toEqual(['facebook', 'gbp']);
    expect(selectPublishPlatforms(['twitter'])).toEqual([]);
  });
});

describe('buildTiktokClipboard', () => {
  test('not requested → null clipboard, no issues', () => {
    expect(buildTiktokClipboard({ tiktok: 'whatever' }, false)).toEqual({ clipboard: null, tiktokIssues: [] });
  });

  test('valid edited caption → returned for clipboard', () => {
    const r = buildTiktokClipboard({ tiktok: 'Chinch bugs love Venice lawns in June — check the blade base.' }, true);
    expect(r.clipboard.tiktok).toContain('Chinch');
    expect(r.tiktokIssues).toEqual([]);
  });

  test('caption with pricing is withheld (brand rules still apply to manual copy)', () => {
    const r = buildTiktokClipboard({ tiktok: 'DM us — only $49/visit!' }, true);
    expect(r.clipboard).toBeNull();
    expect(r.tiktokIssues.length).toBeGreaterThan(0);
  });

  test('empty caption → withheld', () => {
    expect(buildTiktokClipboard({}, true).clipboard).toBeNull();
  });
});

describe('buildPostLogRow', () => {
  const base = {
    techNote: 'roach behind dishwasher',
    captions: { instagram: 'ig', facebook: 'fb', tiktok: 'tt', gbp: 'gbp' },
    imageUrl: 'https://cdn.example/x.jpg',
    location: { id: 'venice', name: 'Venice' },
  };

  test('published when any platform succeeded', () => {
    const row = buildPostLogRow({ ...base, results: [{ platform: 'gbp', success: true }, { platform: 'facebook', success: false }] });
    expect(row.status).toBe('published');
    expect(row.source_type).toBe('tech_field');
    expect(JSON.parse(row.published_content).gbp).toBe('gbp');
  });

  test('failed when nothing succeeded; dry_run when only dry runs', () => {
    expect(buildPostLogRow({ ...base, results: [{ platform: 'gbp', success: false }] }).status).toBe('failed');
    expect(buildPostLogRow({ ...base, results: [{ platform: 'gbp', dryRun: true, success: false }] }).status).toBe('dry_run');
  });

  test('all-skipped (paused/disabled) logs as skipped, never failed', () => {
    expect(buildPostLogRow({ ...base, results: [{ platform: 'gbp', skipped: 'gbp is disabled' }] }).status).toBe('skipped');
    // A skip mixed with a real failure is still failed.
    expect(buildPostLogRow({ ...base, results: [{ platform: 'gbp', skipped: 'disabled' }, { platform: 'instagram', success: false }] }).status).toBe('failed');
  });

  test('title falls back to location name when note is empty', () => {
    const row = buildPostLogRow({ ...base, techNote: '', results: [{ success: true }] });
    expect(row.title).toContain('Venice');
  });

  test('records the actual caption model, null when unknown (never hardcoded)', () => {
    // Non-Anthropic sentinel — AGENTS.md bans literal Anthropic model IDs outside models.js.
    const SENTINEL = 'unit-test-model-id';
    expect(buildPostLogRow({ ...base, model: SENTINEL, results: [{ success: true }] }).ai_model).toBe(SENTINEL);
    expect(buildPostLogRow({ ...base, results: [{ success: true }] }).ai_model).toBeNull();
  });
});
