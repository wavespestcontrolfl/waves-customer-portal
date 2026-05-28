jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  getFile: jest.fn(),
  createBranch: jest.fn(),
  putFile: jest.fn(),
  createPr: jest.fn(),
  createIssueComment: jest.fn(),
}));

const executor = require('../services/content/internal-link-pr-executor');
const { InternalLinkPrExecutor } = executor;
const GitHubClient = require('../services/content-astro/github-client');
const {
  evaluateDryRunTask,
  pageFromAstroFile,
  resolveAstroFileForUrl,
  countInternalLinks,
  firstValidInternalUrl,
  canonicalUrlFromFrontmatter,
  slugToInternalUrl,
  patchContainsCrawlableMarkdownLink,
  frontmatterUnchanged,
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

  test('skips anchors that leave a dangling state qualifier in context', () => {
    const danglingGeoBody = sourceBody.replace(
      'A termite inspection in Florida helps confirm whether the swarmers came from an active colony.',
      'Call for pest control in Bradenton, FL today.'
    );
    const result = evaluateDryRunTask({
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/pest-control-bradenton-fl/',
      anchor_text: 'pest control in Bradenton',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', danglingGeoBody, {
        topic: 'Bradenton pest control',
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
    expect(result.skip_reason).toContain('anchor_leaves_geo_qualifier');
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
      sha: `${file}-sha`,
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

  test('opens a review-only Astro PR for validated patch candidates', async () => {
    GitHubClient.createBranch.mockResolvedValue({});
    GitHubClient.putFile.mockResolvedValue({ commit: { sha: 'link-commit-sha' } });
    GitHubClient.createPr.mockResolvedValue({
      number: 77,
      html_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/77',
      head: { sha: 'link-head-sha' },
    });
    GitHubClient.createIssueComment.mockResolvedValue({});

    const serviceSource = [
      '---',
      'title: Bradenton Pest Control Quote',
      'slug: /pest-control-quote-bradenton-fl/',
      'canonical: https://www.wavespestcontrol.com/pest-control-quote-bradenton-fl/',
      'category: pest',
      'primary_keyword: bradenton pest control quote',
      '---',
      'Call (941) 318-7612 for your free Bradenton pest control quote today.',
    ].join('\n');
    const serviceTarget = [
      '---',
      'title: Pest Control in Bradenton',
      'slug: /pest-control-bradenton-fl/',
      'canonical: https://www.wavespestcontrol.com/pest-control-bradenton-fl/',
      'category: pest',
      'primary_keyword: bradenton pest control',
      '---',
      'Bradenton pest control service body.',
    ].join('\n');

    const instance = new InternalLinkPrExecutor();
    instance._loadPatchCandidateTasks = jest.fn(async () => [{
      id: 'task-bradenton',
      source_file: 'src/content/services/pest-control-quote-bradenton-fl.md',
      target_url: '/pest-control-bradenton-fl/',
      anchor_text: 'Bradenton pest control',
      status: 'patch_candidate',
    }]);
    instance._loadSourcePage = jest.fn(async () => ({
      ...page('src/content/services/pest-control-quote-bradenton-fl.md', serviceSource),
      sha: 'source-sha',
    }));
    instance._loadTargetPage = jest.fn(async () => page('src/content/services/pest-control-bradenton-fl.md', serviceTarget));
    instance._markTasksPrOpen = jest.fn(async () => {});

    const result = await instance.runPrBatch({ limit: 1 });

    expect(result.status).toBe('pr_open');
    expect(result.count).toBe(1);
    expect(GitHubClient.createBranch).toHaveBeenCalledWith(expect.stringMatching(/^content\/internal-link-pest-control-bradenton-fl-/));
    expect(GitHubClient.putFile).toHaveBeenCalledWith(expect.objectContaining({
      path: 'src/content/services/pest-control-quote-bradenton-fl.md',
      sha: 'source-sha',
      content: expect.stringContaining('[Bradenton pest control](/pest-control-bradenton-fl/) quote today.'),
    }));
    expect(GitHubClient.putFile.mock.calls[0][0].content).toContain('slug: /pest-control-quote-bradenton-fl/');
    expect(GitHubClient.createPr).toHaveBeenCalledWith(expect.objectContaining({
      head: expect.stringMatching(/^content\/internal-link-pest-control-bradenton-fl-/),
      title: expect.stringContaining('SEO links: 1 internal link'),
      body: expect.stringContaining('Diff contains only intended internal-link insertions'),
    }));
    expect(GitHubClient.createIssueComment).toHaveBeenCalledWith(77, expect.stringContaining('@codex review'));
    expect(instance._markTasksPrOpen).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      branch: expect.stringMatching(/^content\/internal-link-pest-control-bradenton-fl-/),
      commitSha: 'link-head-sha',
    }));
  });

  test('validates crawlable markdown link and unchanged frontmatter helpers', () => {
    const patched = sourceBody.replace(
      'termite inspection in Florida',
      '[termite inspection in Florida](/termite-inspection/)'
    );
    expect(patchContainsCrawlableMarkdownLink(patched, 'termite inspection in Florida', '/termite-inspection/')).toBe(true);
    expect(frontmatterUnchanged(sourceBody, patched)).toBe(true);
    expect(frontmatterUnchanged(sourceBody, sourceBody.replace('title: Termite', 'title: Changed'))).toBe(false);
  });
});
