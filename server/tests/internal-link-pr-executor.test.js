jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  getFile: jest.fn(),
  getPr: jest.fn(),
  createBranch: jest.fn(),
  putFile: jest.fn(),
  createPr: jest.fn(),
  createIssueComment: jest.fn(),
}));

const executor = require('../services/content/internal-link-pr-executor');
const { InternalLinkPrExecutor } = executor;
const GitHubClient = require('../services/content-astro/github-client');
const db = require('../models/db');
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
  parsePrNumber,
  liveUrlForTask,
  htmlContainsCrawlableLink,
  htmlContainsVisibleText,
  stripNonRenderedHtml,
  hiddenElementRanges,
  hasHiddenHtmlAttribute,
  scanHtmlTags,
} = executor._internals;

beforeEach(() => {
  jest.clearAllMocks();
  delete db.transaction;
  global.fetch = jest.fn(async () => ({
    ok: true,
    text: async () => [
      '<html><body>',
      '<p>Call (941) 318-7612 for your free Bradenton pest control quote today.</p>',
      '<p>A termite inspection in Florida helps confirm whether the swarmers came from an active colony.</p>',
      '</body></html>',
    ].join(''),
  }));
});

function page(file, body, extra = {}) {
  return {
    ...pageFromAstroFile(file, body),
    ...extra,
  };
}

const sourceBody = [
  '---',
  'title: Termite Swarmers in Bathrooms',
  'slug: /termite-swarmers-bathroom/',
  'canonical: https://www.wavespestcontrol.com/termite-swarmers-bathroom/',
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
    expect(result.source_url).toBe('/termite-swarmers-bathroom/');
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

  test('uses Astro entry-id route before legacy blog slug and blocks canonical mismatch', () => {
    const legacyBlogBody = [
      '---',
      'title: Local Pest Control Tips',
      'slug: /pest-control/local-pest-control-tips/',
      'canonical: https://www.wavespestcontrol.com/pest-control/local-pest-control-tips/',
      'category: pest',
      'primary_keyword: pest control lakewood ranch fl',
      '---',
      'When it comes to pest control in Lakewood Ranch, FL, prevention is the best strategy.',
    ].join('\n');
    const target = [
      '---',
      'title: Pest Control in Lakewood Ranch',
      'slug: /pest-control-lakewood-ranch-fl/',
      'canonical: https://www.wavespestcontrol.com/pest-control-lakewood-ranch-fl/',
      'category: pest',
      'primary_keyword: pest control lakewood ranch fl',
      '---',
      'Lakewood Ranch pest control service body.',
    ].join('\n');

    const sourcePage = page('src/content/blog/local-pest-control-tips.md', legacyBlogBody);
    expect(sourcePage.url).toBe('/local-pest-control-tips/');
    expect(sourcePage.canonical_url).toBe('/pest-control/local-pest-control-tips/');

    const result = evaluateDryRunTask({
      source_file: 'src/content/blog/local-pest-control-tips.md',
      source_url: '/pest-control/local-pest-control-tips/',
      target_url: '/pest-control-lakewood-ranch-fl/',
      anchor_text: 'pest control in Lakewood Ranch, FL',
    }, {
      sourcePage,
      targetPage: page('src/content/services/pest-control-lakewood-ranch-fl.md', target),
    });

    expect(result.status).toBe('skipped');
    expect(result.skip_reason).toContain('source_canonical_mismatch');
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
    GitHubClient.getFile.mockImplementation(async (file) =>
      file.endsWith('.mdx')
        ? null
        : { sha: `${file}-sha`, content: file.includes('termite-swarmers') ? sourceBody : targetBody }
    );

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
    instance._validateRenderedSourceAnchor = jest.fn(async () => ({ ok: true }));
    instance._reserveTasksForPr = jest.fn(async () => true);
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

  test('does not create GitHub side effects when patch candidate reservation conflicts', async () => {
    const serviceSource = sourceBody;
    const instance = new InternalLinkPrExecutor();
    instance._loadPatchCandidateTasks = jest.fn(async () => [{
      id: 'task-race',
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
      status: 'patch_candidate',
    }]);
    instance._loadSourcePage = jest.fn(async () => ({
      ...page('src/content/blog/termite-swarmers-bathroom.md', serviceSource),
      sha: 'source-sha',
    }));
    instance._loadTargetPage = jest.fn(async () => page('src/content/services/termite-inspection.md', targetBody));
    instance._reserveTasksForPr = jest.fn(async () => false);

    const result = await instance.runPrBatch({ limit: 1 });

    expect(result.status).toBe('reservation_conflict');
    expect(GitHubClient.createBranch).not.toHaveBeenCalled();
    expect(GitHubClient.putFile).not.toHaveBeenCalled();
    expect(GitHubClient.createPr).not.toHaveBeenCalled();
  });

  test('does not open a PR when current rendered source page lacks the source paragraph', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      text: async () => '<html><body>termite inspection in Florida appears only in unrelated chrome.</body></html>',
    }));

    const instance = new InternalLinkPrExecutor();
    instance._loadPatchCandidateTasks = jest.fn(async () => [{
      id: 'task-unrendered-body',
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
      status: 'patch_candidate',
    }]);
    instance._loadSourcePage = jest.fn(async () => ({
      ...page('src/content/blog/termite-swarmers-bathroom.md', sourceBody),
      sha: 'source-sha',
    }));
    instance._loadTargetPage = jest.fn(async () => page('src/content/services/termite-inspection.md', targetBody));
    instance._persistDryRunResult = jest.fn(async () => {});

    const result = await instance.runPrBatch({ limit: 1 });

    expect(result.status).toBe('no_candidates');
    expect(instance._persistDryRunResult).toHaveBeenCalledWith(
      'task-unrendered-body',
      expect.objectContaining({
        status: 'skipped',
        skip_reason: 'source_rendered_context_missing',
      })
    );
    expect(GitHubClient.createBranch).not.toHaveBeenCalled();
    expect(GitHubClient.putFile).not.toHaveBeenCalled();
    expect(GitHubClient.createPr).not.toHaveBeenCalled();
  });

  test('rolls back partial patch-candidate reservations before aborting', async () => {
    const reserveUpdate = jest.fn().mockResolvedValue(1);
    const rollbackUpdate = jest.fn().mockResolvedValue(1);
    const reserveChain = {
      whereIn: jest.fn(() => reserveChain),
      where: jest.fn(() => reserveChain),
      update: reserveUpdate,
    };
    const rollbackChain = {
      whereIn: jest.fn(() => rollbackChain),
      where: jest.fn(() => rollbackChain),
      update: rollbackUpdate,
    };
    const trx = jest.fn()
      .mockReturnValueOnce(reserveChain)
      .mockReturnValueOnce(rollbackChain);
    db.transaction = jest.fn(async (fn) => fn(trx));

    const instance = new InternalLinkPrExecutor();
    const result = await instance._reserveTasksForPr([
      { task: { id: 'task-1' } },
      { task: { id: 'task-2' } },
    ], { branch: 'content/internal-link-target-abc123' });

    expect(result).toBe(false);
    expect(db.transaction).toHaveBeenCalled();
    expect(reserveChain.where).toHaveBeenCalledWith('status', 'patch_candidate');
    expect(rollbackChain.where).toHaveBeenCalledWith({
      status: 'pr_reserved',
      pr_branch: 'content/internal-link-target-abc123',
    });
    expect(rollbackUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: 'patch_candidate',
      pr_branch: null,
    }));
  });

  test('records opened PRs even when Codex review comment fails', async () => {
    GitHubClient.createBranch.mockResolvedValue({});
    GitHubClient.putFile.mockResolvedValue({ commit: { sha: 'link-commit-sha' } });
    GitHubClient.createPr.mockResolvedValue({
      number: 78,
      html_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/78',
      head: { sha: 'link-head-sha' },
    });
    GitHubClient.createIssueComment.mockRejectedValue(new Error('issues permission denied'));

    const instance = new InternalLinkPrExecutor();
    instance._loadPatchCandidateTasks = jest.fn(async () => [{
      id: 'task-comment-fail',
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
      status: 'patch_candidate',
    }]);
    instance._loadSourcePage = jest.fn(async () => ({
      ...page('src/content/blog/termite-swarmers-bathroom.md', sourceBody),
      sha: 'source-sha',
    }));
    instance._loadTargetPage = jest.fn(async () => page('src/content/services/termite-inspection.md', targetBody));
    instance._reserveTasksForPr = jest.fn(async () => true);
    instance._markTasksPrOpen = jest.fn(async () => {});

    const result = await instance.runPrBatch({ limit: 1 });

    expect(result.status).toBe('pr_open');
    expect(GitHubClient.createIssueComment).toHaveBeenCalledWith(78, expect.stringContaining('@codex review'));
    expect(instance._markTasksPrOpen).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      pr: expect.objectContaining({ number: 78 }),
      branch: expect.stringMatching(/^content\/internal-link-termite-inspection-/),
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

  test('parses PR numbers, builds live URLs, and detects crawlable rendered links', () => {
    expect(parsePrNumber('https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/172')).toBe(172);
    expect(parsePrNumber('not-a-pr')).toBeNull();
    expect(liveUrlForTask({ source_url: '/pest-control-quote-bradenton-fl/' }))
      .toBe('https://www.wavespestcontrol.com/pest-control-quote-bradenton-fl/');
    expect(htmlContainsCrawlableLink(
      '<p>Call for your free <a href="/pest-control-bradenton-fl/">Bradenton pest control</a> quote.</p>',
      '/pest-control-bradenton-fl/',
      'Bradenton pest control'
    )).toBe(true);
    expect(htmlContainsCrawlableLink(
      '<p>Call for your free <a href="/pest-control-bradenton-fl/">Bradenton termite control</a> quote.</p>',
      '/pest-control-bradenton-fl/',
      'Bradenton pest control'
    )).toBe(false);
    expect(htmlContainsVisibleText(
      '<main><p>Call for Bradenton pest control today.</p></main>',
      'Bradenton pest control'
    )).toBe(true);
    expect(htmlContainsVisibleText(
      '<main><p hidden>Bradenton pest control</p><p>Other text</p></main>',
      'Bradenton pest control'
    )).toBe(false);
    expect(htmlContainsVisibleText(
      '<main><div class="hidden">Bradenton pest control</div><p>Other text</p></main>',
      'Bradenton pest control'
    )).toBe(false);
    expect(htmlContainsVisibleText(
      '<main><p>A termite inspection in Florida helps confirm activity.</p></main>',
      'A **termite inspection in Florida** helps confirm activity.'
    )).toBe(true);
  });

  test('ignores anchors inside non-rendered HTML blocks during live verification', () => {
    const hidden = [
      '<!-- <a href="/pest-control-bradenton-fl/">Bradenton pest control</a> -->',
      '<script>const link = `<a href="/pest-control-bradenton-fl/">Bradenton pest control</a>`;</script>',
      '<template><a href="/pest-control-bradenton-fl/">Bradenton pest control</a></template>',
      '<noscript><a href="/pest-control-bradenton-fl/">Bradenton pest control</a></noscript>',
      '<p>Call for your free Bradenton pest control quote.</p>',
    ].join('\n');

    expect(stripNonRenderedHtml(hidden)).not.toContain('<script>');
    expect(htmlContainsCrawlableLink(
      hidden,
      '/pest-control-bradenton-fl/',
      'Bradenton pest control'
    )).toBe(false);
    expect(htmlContainsCrawlableLink(
      `${hidden}<p><a href="/pest-control-bradenton-fl/">Bradenton pest control</a></p>`,
      '/pest-control-bradenton-fl/',
      'Bradenton pest control'
    )).toBe(true);
  });

  test('ignores anchors hidden by attributes or hidden ancestors during live verification', () => {
    const target = '/pest-control-bradenton-fl/';
    const anchor = 'Bradenton pest control';
    const hiddenCases = [
      `<a hidden href="${target}">${anchor}</a>`,
      `<a inert href="${target}">${anchor}</a>`,
      `<a aria-hidden="true" href="${target}">${anchor}</a>`,
      `<a style="display:none" href="${target}">${anchor}</a>`,
      `<a style="visibility: hidden" href="${target}">${anchor}</a>`,
      `<div hidden><a href="${target}">${anchor}</a></div>`,
      `<section style="display: none"><p><a href="${target}">${anchor}</a></p></section>`,
      `<div aria-hidden="true"><span><a href="${target}">${anchor}</a></span></div>`,
    ];

    expect(hasHiddenHtmlAttribute('data-hidden="true"')).toBe(false);
    expect(hasHiddenHtmlAttribute(' hidden')).toBe(true);
    expect(hiddenElementRanges(`<div hidden><a href="${target}">${anchor}</a></div>`)).toHaveLength(1);
    for (const html of hiddenCases) {
      expect(htmlContainsCrawlableLink(html, target, anchor)).toBe(false);
    }
    expect(htmlContainsCrawlableLink(
      `<div data-hidden="true"><a href="${target}">${anchor}</a></div>`,
      target,
      anchor
    )).toBe(true);
  });

  test('handles quoted greater-than characters when scanning hidden ancestors', () => {
    const target = '/pest-control-bradenton-fl/';
    const anchor = 'Bradenton pest control';
    const hiddenAfterQuotedGt = `<div data-title="A > B" hidden><a href="${target}">${anchor}</a></div>`;
    const hiddenStyleAfterJson = `<div data-json='{"copy": "A > B"}' style="display:none"><a href="${target}">${anchor}</a></div>`;

    expect(scanHtmlTags(hiddenAfterQuotedGt)[0]).toMatchObject({
      tag: 'div',
      attrs: expect.stringContaining('hidden'),
    });
    expect(hiddenElementRanges(hiddenAfterQuotedGt)).toHaveLength(1);
    expect(htmlContainsCrawlableLink(hiddenAfterQuotedGt, target, anchor)).toBe(false);
    expect(htmlContainsCrawlableLink(hiddenStyleAfterJson, target, anchor)).toBe(false);
  });

  test('verifies merged PR tasks when live HTML contains the expected link', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskMerged = jest.fn(async () => {});
    instance._markTaskVerified = jest.fn(async () => {});
    instance._markTaskVerificationFailed = jest.fn(async () => {});
    GitHubClient.getPr.mockResolvedValue({
      number: 172,
      merged: true,
      merged_at: '2026-05-28T06:57:10Z',
      merge_commit_sha: 'merge-sha',
    });

    const result = await instance.verifyMergedTask({
      id: 'task-verified',
      status: 'pr_open',
      astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/172',
      source_url: '/pest-control-quote-bradenton-fl/',
      target_url: '/pest-control-bradenton-fl/',
      anchor_text: 'Bradenton pest control',
    }, {
      html: '<p>Call for your free <a href="/pest-control-bradenton-fl/">Bradenton pest control</a> quote.</p>',
    });

    expect(result.status).toBe('verified');
    expect(GitHubClient.getPr).toHaveBeenCalledWith(172);
    expect(instance._markTaskMerged).toHaveBeenCalledWith('task-verified', expect.objectContaining({
      commitSha: 'merge-sha',
    }));
    expect(instance._markTaskVerified).toHaveBeenCalledWith('task-verified', expect.objectContaining({
      commitSha: 'merge-sha',
      liveUrl: 'https://www.wavespestcontrol.com/pest-control-quote-bradenton-fl/',
    }));
    expect(instance._markTaskVerificationFailed).not.toHaveBeenCalled();
  });

  test('leaves still-open unmerged PR tasks open', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskMerged = jest.fn(async () => {});
    instance._markTaskVerificationFailed = jest.fn(async () => {});
    GitHubClient.getPr.mockResolvedValue({ number: 172, merged: false, state: 'open' });

    const result = await instance.verifyMergedTask({
      id: 'task-open',
      status: 'pr_open',
      astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/172',
    });

    expect(result).toMatchObject({ status: 'pr_open', skipped: 'pr_not_merged' });
    expect(instance._markTaskMerged).not.toHaveBeenCalled();
    expect(instance._markTaskVerificationFailed).not.toHaveBeenCalled();
  });

  test('fails a task whose PR was closed unmerged (so it leaves pr_open and is requeue/dismiss-able)', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskMerged = jest.fn(async () => {});
    instance._markTaskVerificationFailed = jest.fn(async () => {});
    GitHubClient.getPr.mockResolvedValue({ number: 178, merged: false, state: 'closed' });

    const result = await instance.verifyMergedTask({
      id: 'task-closed',
      status: 'pr_open',
      astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/178',
    });

    expect(result).toMatchObject({ status: 'failed', failure_reason: 'internal_link_pr_closed_unmerged', pr_number: 178 });
    expect(instance._markTaskVerificationFailed).toHaveBeenCalledWith('task-closed', 'internal_link_pr_closed_unmerged');
    expect(instance._markTaskMerged).not.toHaveBeenCalled();
  });

  test('fails PR tasks when the stored Astro PR cannot be loaded', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskVerificationFailed = jest.fn(async () => {});
    GitHubClient.getPr.mockResolvedValue(null);

    const result = await instance.verifyMergedTask({
      id: 'task-missing-pr',
      status: 'pr_open',
      astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/999',
    });

    expect(result).toMatchObject({
      status: 'failed',
      failure_reason: 'internal_link_verify_pr_not_found',
      pr_number: 999,
    });
    expect(instance._markTaskVerificationFailed).toHaveBeenCalledWith(
      'task-missing-pr',
      'internal_link_verify_pr_not_found'
    );
  });

  test('keeps merged PR tasks merged when live HTML is empty', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskMerged = jest.fn(async () => {});
    instance._markTaskVerificationFailed = jest.fn(async () => {});

    const result = await instance.verifyMergedTask({
      id: 'task-fetch-failed',
      status: 'pr_open',
      source_url: '/pest-control-quote-bradenton-fl/',
      target_url: '/pest-control-bradenton-fl/',
      anchor_text: 'Bradenton pest control',
    }, {
      pr: {
        number: 172,
        merged: true,
        merged_at: '2026-05-28T06:57:10Z',
        merge_commit_sha: 'merge-sha',
      },
      html: '',
    });

    expect(result).toMatchObject({
      status: 'merged',
      failure_reason: 'internal_link_verify_empty_live_html',
      pr_number: 172,
    });
    expect(instance._markTaskVerificationFailed).toHaveBeenCalledWith(
      'task-fetch-failed',
      'internal_link_verify_empty_live_html',
      expect.objectContaining({ status: 'merged' })
    );
  });

  test('marks deployed tasks with failure when live HTML is missing the link', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskMerged = jest.fn(async () => {});
    instance._markTaskVerified = jest.fn(async () => {});
    instance._markTaskVerificationFailed = jest.fn(async () => {});
    GitHubClient.getPr.mockResolvedValue({
      number: 172,
      merged: true,
      merged_at: '2026-05-28T06:57:10Z',
      merge_commit_sha: 'merge-sha',
    });

    const result = await instance.verifyMergedTask({
      id: 'task-missing-link',
      status: 'pr_open',
      astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/172',
      source_url: '/pest-control-quote-bradenton-fl/',
      target_url: '/pest-control-bradenton-fl/',
      anchor_text: 'Bradenton pest control',
    }, {
      html: '<p>Call for your free Bradenton pest control quote.</p>',
    });

    expect(result).toMatchObject({
      status: 'deployed',
      failure_reason: 'internal_link_verify_link_missing',
    });
    expect(instance._markTaskVerified).not.toHaveBeenCalled();
    expect(instance._markTaskVerificationFailed).toHaveBeenCalledWith(
      'task-missing-link',
      'internal_link_verify_link_missing',
      expect.objectContaining({ status: 'deployed' })
    );
  });
});
