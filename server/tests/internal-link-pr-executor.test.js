jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  getFile: jest.fn(),
}));

const executor = require('../services/content/internal-link-pr-executor');
const GitHubClient = require('../services/content-astro/github-client');
const {
  evaluateDryRunTask,
  pageFromAstroFile,
  resolveAstroFileForUrl,
  countInternalLinks,
  firstValidInternalUrl,
  canonicalUrlFromFrontmatter,
  slugToInternalUrl,
} = executor._internals;

function page(file, body, extra = {}) {
  return {
    ...pageFromAstroFile(file, body),
    ...extra,
  };
}

const sourceBody = [
  '---',
  'title: Termite Swarmers in Bathrooms',
  'slug: /blog/termite-swarmers-bathroom/',
  'canonical: https://www.wavespestcontrol.com/blog/termite-swarmers-bathroom/',
  'category: termite',
  'primary_keyword: termite inspection swarmers florida',
  '---',
  'Termite swarmers in a bathroom can point to moisture and hidden activity.',
  '',
  'A termite inspection in Florida helps confirm whether the swarmers came from an active colony.',
].join('\n');

const targetBody = [
  '---',
  'title: Termite Inspection in Florida',
  'slug: /termite-inspection/',
  'canonical: https://www.wavespestcontrol.com/termite-inspection/',
  'category: termite',
  'primary_keyword: termite inspection florida',
  '---',
  'Waves termite inspection guidance.',
].join('\n');

describe('internal-link dry-run executor pure evaluation', () => {
  test('produces patch_candidate with SEO fields and paragraph preview', () => {
    const result = evaluateDryRunTask({
      id: 'task-1',
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', sourceBody),
      targetPage: page('src/content/services/termite-inspection.md', targetBody),
    });

    expect(result.status).toBe('patch_candidate');
    expect(result.source_url).toBe('/blog/termite-swarmers-bathroom/');
    expect(result.target_canonical_url).toBe('/termite-inspection/');
    expect(result.anchor_type).toBe('partial_match');
    expect(result.topical_relevance_score).toBeGreaterThanOrEqual(0.75);
    expect(result.link_context_before).toContain('termite inspection in Florida');
    expect(result.link_context_after).toContain('[termite inspection in Florida](/termite-inspection/)');
    expect(result.paragraph_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.executor_version).toBe('internal-link-dry-run-v1');
  });

  test('skips if source already links target by normalized URL variant', () => {
    const body = sourceBody.replace(
      'A termite inspection in Florida helps confirm whether the swarmers came from an active colony.',
      '[A termite inspection in Florida](/termite-inspection?utm_source=x#faq) helps confirm whether the swarmers came from an active colony.'
    );
    const result = evaluateDryRunTask({
      id: 'task-2',
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', body),
      targetPage: page('src/content/services/termite-inspection.md', targetBody),
    });

    expect(result.status).toBe('skipped');
    expect(result.skip_reason).toBe('source_already_links_target');
  });

  test('skips anchors inside headings and paragraphs that already contain links', () => {
    const headingBody = sourceBody.replace(
      'A termite inspection in Florida helps confirm whether the swarmers came from an active colony.',
      '   ## termite inspection in Florida'
    );
    expect(evaluateDryRunTask({
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', headingBody),
      targetPage: page('src/content/services/termite-inspection.md', targetBody),
    }).skip_reason).toBe('anchor_not_found');

    const linkedParagraph = sourceBody.replace(
      'A termite inspection in Florida helps confirm whether the swarmers came from an active colony.',
      'A termite inspection in Florida helps confirm whether the swarmers came from an [active colony](/termite-control/).'
    );
    expect(evaluateDryRunTask({
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', linkedParagraph),
      targetPage: page('src/content/services/termite-inspection.md', targetBody),
    }).skip_reason).toBe('paragraph_already_has_link');
  });

  test('skips generic CTA anchors via SEO policy', () => {
    const ctaBody = sourceBody.replace('termite inspection in Florida', 'learn more about termite inspection');
    const result = evaluateDryRunTask({
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'learn more about termite inspection',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', ctaBody),
      targetPage: page('src/content/services/termite-inspection.md', targetBody),
    });

    expect(result.status).toBe('skipped');
    expect(result.skip_reason).toContain('anchor_generic_cta_prefix');
  });

  test('skips anchors that split a service phrase in context', () => {
    const splitPhraseBody = sourceBody.replace(
      'A termite inspection in Florida helps confirm whether the swarmers came from an active colony.',
      'Call for your free Bradenton pest control quote today.'
    );
    const result = evaluateDryRunTask({
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/pest-control-bradenton-fl/',
      anchor_text: 'Bradenton pest',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', splitPhraseBody, {
        topic: 'Bradenton pest control quote',
        topic_cluster: 'pest',
      }),
      targetPage: page('src/content/services/pest-control-bradenton-fl.md', [
        '---',
        'title: Pest Control in Bradenton',
        'slug: /pest-control-bradenton-fl/',
        'canonical: https://www.wavespestcontrol.com/pest-control-bradenton-fl/',
        'category: pest',
        'primary_keyword: pest control bradenton fl',
        '---',
        'Bradenton pest control service body.',
      ].join('\n')),
    });

    expect(result.status).toBe('skipped');
    expect(result.skip_reason).toContain('anchor_splits_service_phrase');
  });

  test('skips noncanonical or noindex targets', () => {
    const result = evaluateDryRunTask({
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', sourceBody),
      targetPage: page('src/content/services/termite-inspection.md', targetBody.replace(
        'canonical: https://www.wavespestcontrol.com/termite-inspection/',
        'canonical: https://www.wavespestcontrol.com/other/'
      )),
    });

    expect(result.status).toBe('skipped');
    expect(result.skip_reason).toContain('target_canonical_mismatch');
  });
});

describe('internal-link dry-run executor helpers', () => {
  test('normalizes bare Astro slugs and templated canonicals', () => {
    const loaded = pageFromAstroFile('src/content/services/pest-control-bradenton-fl.md', [
      '---',
      'title: Pest Control in Bradenton',
      'slug: "pest-control-bradenton-fl"',
      'canonical: "{{siteUrl}}/pest-control-bradenton-fl/"',
      'category: pest',
      '---',
      'Bradenton pest control body.',
    ].join('\n'));

    expect(loaded.url).toBe('/pest-control-bradenton-fl/');
    expect(loaded.canonical_url).toBe('/pest-control-bradenton-fl/');
    expect(firstValidInternalUrl('{{siteUrl}}/pest-control-bradenton-fl/')).toBe('/pest-control-bradenton-fl/');
    expect(slugToInternalUrl('pest-control-bradenton-fl')).toBe('/pest-control-bradenton-fl/');
  });

  test('preserves invalid explicit canonicals so dry-run reports a mismatch', () => {
    const loaded = pageFromAstroFile('src/content/services/pest-control-bradenton-fl.md', [
      '---',
      'title: Pest Control in Bradenton',
      'slug: "pest-control-bradenton-fl"',
      'canonical: "https://example.com/pest-control-bradenton-fl/"',
      'category: pest',
      '---',
      'Bradenton pest control body.',
    ].join('\n'));

    expect(loaded.url).toBe('/pest-control-bradenton-fl/');
    expect(loaded.canonical_url).toBe('https://example.com/pest-control-bradenton-fl/');
    expect(canonicalUrlFromFrontmatter({ canonical: 'https://example.com/page/' }, '/page/')).toBe('https://example.com/page/');
  });

  test('resolves Astro file paths from target URLs', () => {
    expect(resolveAstroFileForUrl('/blog/ghost-ants/')).toBe('src/content/blog/ghost-ants.md');
    expect(resolveAstroFileForUrl('/pest-control-bradenton-fl/')).toBe('src/content/services/pest-control-bradenton-fl.md');
    expect(resolveAstroFileForUrl('/termite-inspection/')).toBe('src/content/services/termite-inspection.md');
    expect(resolveAstroFileForUrl('/sarasota/')).toBe('src/content/locations/sarasota.md');
  });

  test('counts only internal markdown and HTML links', () => {
    expect(countInternalLinks([
      '[Internal](/termite-inspection/)',
      '[External](https://example.com/x)',
      '<a href="https://www.wavespestcontrol.com/pest-control/">Pest</a>',
    ].join('\n'))).toBe(2);
  });

  test('loads source and target pages from GitHub for dryRunTask', async () => {
    GitHubClient.getFile.mockImplementation(async (file) => ({
      content: file.includes('termite-swarmers') ? sourceBody : targetBody,
    }));

    const result = await executor.dryRunTask({
      id: 'task-github',
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
    });

    expect(GitHubClient.getFile).toHaveBeenCalledWith('src/content/blog/termite-swarmers-bathroom.md');
    expect(GitHubClient.getFile).toHaveBeenCalledWith('src/content/services/termite-inspection.md');
    expect(result.status).toBe('patch_candidate');
  });
});
