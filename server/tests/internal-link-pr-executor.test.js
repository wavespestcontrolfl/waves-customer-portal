jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({
  getFile: jest.fn(),
  getPr: jest.fn(),
  createBranch: jest.fn(),
  putFile: jest.fn(),
  commitFiles: jest.fn(),
  createPr: jest.fn(),
  createIssueComment: jest.fn(),
  findOpenPrByHead: jest.fn(async () => null),
}));

jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_name, fn) => fn()) }));
jest.mock('../services/content/protected-pages', () => ({ isProtected: jest.fn(async () => ({ protected: false })) }));
jest.mock('../services/content/internal-link-judge', () => ({
  judgeLink: jest.fn(async () => ({ ok: true, approve: true, reason: 'fits' })),
}));

const executor = require('../services/content/internal-link-pr-executor');
const { InternalLinkPrExecutor } = executor;
const GitHubClient = require('../services/content-astro/github-client');
const db = require('../models/db');
const {
  evaluateDryRunTask,
  pageFromAstroFile,
  resolveAstroFileForUrl,
  candidateAstroFilesForUrl,
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
  jest.spyOn(InternalLinkPrExecutor.prototype, '_openLinkPr').mockResolvedValue(undefined);
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

  // Regression: the live hub route is the frontmatter slug (Astro's glob
  // loader honors it as the entry id — the path-derived URL 301s to it), and
  // the planner derives URLs slug-first. The executor used to prefer the
  // path-derived URL, so all legacy posts with path-prefixed slugs
  // (190/193 blog posts) skipped with source_canonical_mismatch.
  test('prefers the frontmatter slug URL over the path-derived URL for legacy blog sources', () => {
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
    expect(sourcePage.url).toBe('/pest-control/local-pest-control-tips/');
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

    expect(result.status).toBe('patch_candidate');
    expect(result.source_url).toBe('/pest-control/local-pest-control-tips/');
    expect(result.source_canonical_matches).toBe(true);
  });

  test('falls back to the path-derived URL when frontmatter has no slug', () => {
    const noSlugPage = pageFromAstroFile('src/content/blog/no-slug-post.md', [
      '---',
      'title: No Slug Post',
      '---',
      'Body.',
    ].join('\n'));
    expect(noSlugPage.url).toBe('/no-slug-post/');
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

  test('returns every collection candidate for ambiguous root slugs', () => {
    expect(candidateAstroFilesForUrl('/venice-dollar-spot-guide/')).toEqual([
      'src/content/locations/venice-dollar-spot-guide.md',
      'src/content/blog/venice-dollar-spot-guide.md',
      'src/content/services/venice-dollar-spot-guide.md',
    ]);
    expect(candidateAstroFilesForUrl('/blog/ghost-ants/')).toEqual(['src/content/blog/ghost-ants.md']);
    expect(candidateAstroFilesForUrl('')).toEqual([]);
  });

  test('loads a root-slug blog target by probing collections for existence', async () => {
    const blogPath = 'src/content/blog/venice-dollar-spot-guide.mdx';
    GitHubClient.getFile.mockImplementation(async (file) =>
      file === blogPath
        ? { sha: 'blog-sha', content: '---\ntitle: Dollar Spot in Venice\nslug: /venice-dollar-spot-guide/\n---\nGuide body.' }
        : null
    );

    const target = await new InternalLinkPrExecutor()._loadTargetPage({
      target_url: '/venice-dollar-spot-guide/',
    });

    expect(target.file).toBe(blogPath);
    expect(target.url).toBe('/venice-dollar-spot-guide/');
  });

  test('falls back to URL candidates when a stamped target_file has gone stale', async () => {
    const blogPath = 'src/content/blog/venice-dollar-spot-guide.mdx';
    GitHubClient.getFile.mockImplementation(async (file) =>
      file === blogPath
        ? { sha: 'blog-sha', content: '---\ntitle: Dollar Spot in Venice\n---\nGuide body.' }
        : null
    );

    const target = await new InternalLinkPrExecutor()._loadTargetPage({
      target_url: '/venice-dollar-spot-guide/',
      target_file: 'src/content/locations/venice-dollar-spot-guide.md',
    });

    expect(target.file).toBe(blogPath);
  });

  test('throws target_file_not_found when no candidate exists', async () => {
    GitHubClient.getFile.mockResolvedValue(null);
    await expect(new InternalLinkPrExecutor()._loadTargetPage({
      target_url: '/no-such-page/',
    })).rejects.toThrow('target_file_not_found:src/content/locations/no-such-page.md');
  });

  test('skips sources that render on a spoke domain', () => {
    const spokeSourceBody = sourceBody.replace(
      'category: termite',
      'category: termite\ndomains:\n  - veniceflpestcontrol.com'
    );
    const result = evaluateDryRunTask({
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', spokeSourceBody),
      targetPage: page('src/content/services/termite-inspection.md', targetBody),
    });

    expect(result.status).toBe('skipped');
    expect(result.skip_reason).toBe('source_renders_on_spoke');
  });

  test('skips spoke-canonical sources at execution time', () => {
    const spokeCanonicalBody = sourceBody.replace(
      'canonical: https://www.wavespestcontrol.com/termite-swarmers-bathroom/',
      'canonical: https://sarasotafllawncare.com/termite-swarmers-bathroom/'
    );
    const result = evaluateDryRunTask({
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', spokeCanonicalBody),
      targetPage: page('src/content/services/termite-inspection.md', targetBody),
    });

    expect(result.status).toBe('skipped');
    expect(result.skip_reason).toBe('source_canonical_off_hub');
  });

  test('hub-only domains frontmatter is still an eligible source', () => {
    const hubSourceBody = sourceBody.replace(
      'category: termite',
      'category: termite\ndomains:\n  - wavespestcontrol.com'
    );
    const result = evaluateDryRunTask({
      source_file: 'src/content/blog/termite-swarmers-bathroom.md',
      target_url: '/termite-inspection/',
      anchor_text: 'termite inspection in Florida',
    }, {
      sourcePage: page('src/content/blog/termite-swarmers-bathroom.md', hubSourceBody),
      targetPage: page('src/content/services/termite-inspection.md', targetBody),
    });

    expect(result.status).toBe('patch_candidate');
  });

  test('counts only internal markdown and HTML links', () => {
    expect(countInternalLinks([
      '[Internal](/termite-inspection/)',
      '[External](https://example.com/x)',
      '<a href="https://www.wavespestcontrol.com/pest-control/">Pest</a>',
    ].join('\n'))).toBe(2);
  });

  test('does not count markdown image embeds as internal links', () => {
    expect(countInternalLinks([
      '![Hero image](/images/termite-hero.webp)',
      '![Diagram](/images/diagram.png "Swarmer diagram")',
      'Body text with a real [internal link](/termite-inspection/).',
    ].join('\n'))).toBe(1);
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

  test('opens an auto-merge Astro PR for validated patch candidates', async () => {
    GitHubClient.createBranch.mockResolvedValue({});
    GitHubClient.commitFiles.mockResolvedValue({ commit: { sha: 'link-commit-sha' } });
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
    // One commit for the whole batch (Cloudflare builds only the first
    // commit of a push burst).
    expect(GitHubClient.putFile).not.toHaveBeenCalled();
    expect(GitHubClient.commitFiles).toHaveBeenCalledTimes(1);
    const [{ files }] = GitHubClient.commitFiles.mock.calls[0];
    expect(files).toEqual([expect.objectContaining({
      path: 'src/content/services/pest-control-quote-bradenton-fl.md',
      content: expect.stringContaining('[Bradenton pest control](/pest-control-bradenton-fl/) quote today.'),
    })]);
    expect(files[0].content).toContain('slug: /pest-control-quote-bradenton-fl/');
    expect(GitHubClient.createPr).toHaveBeenCalledWith(expect.objectContaining({
      head: expect.stringMatching(/^content\/internal-link-pest-control-bradenton-fl-/),
      title: expect.stringContaining('SEO links: 1 internal link'),
      body: expect.stringContaining('the diff is exactly these link insertions'),
    }));
    // PR body steers reviewers to the hub preview so spoke 404s aren't a false reject.
    const prBody = GitHubClient.createPr.mock.calls[0][0].body;
    expect(prBody).toContain('## Preview');
    expect(prBody).toContain('Spoke-project previews');
    expect(prBody).toContain('https://www.wavespestcontrol.com/pest-control-quote-bradenton-fl/');
    expect(GitHubClient.createIssueComment).toHaveBeenCalledWith(77, expect.stringContaining('@codex review'));
    expect(instance._markTasksPrOpen).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      branch: expect.stringMatching(/^content\/internal-link-pest-control-bradenton-fl-/),
      commitSha: 'link-commit-sha',
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
    GitHubClient.commitFiles.mockResolvedValue({ commit: { sha: 'link-commit-sha' } });
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
      commitSha: 'link-commit-sha',
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

  test('fails a closed-unmerged PR task AND clears PR lifecycle fields (so it leaves pr_open and is requeue/dismiss-able)', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskMerged = jest.fn(async () => {});
    // Capture the real DB update to assert PR lifecycle fields are cleared —
    // hasPrLifecycle() in the review queue keeps blocking requeue/dismiss
    // unless astro_pr_url/pr_branch/pr_commit_sha are nulled.
    let updatePatch = null;
    const builder = {
      where: jest.fn(() => builder),
      whereIn: jest.fn(() => builder),
      update: jest.fn(async (patch) => { updatePatch = patch; return 1; }),
    };
    db.mockReturnValue(builder);
    GitHubClient.getPr.mockResolvedValue({ number: 178, merged: false, state: 'closed', head: { ref: 'content/internal-link-x' } });
    GitHubClient.retireBranch = jest.fn(async () => true);

    const result = await instance.verifyMergedTask({
      id: 'task-closed',
      status: 'pr_open',
      astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/178',
      pr_branch: 'content/internal-link-x',
      pr_commit_sha: 'deadbeef',
    });

    expect(result).toMatchObject({ status: 'failed', failure_reason: 'internal_link_pr_closed_unmerged', pr_number: 178 });
    expect(updatePatch).toMatchObject({
      status: 'failed',
      failure_reason: 'internal_link_pr_closed_unmerged',
      astro_pr_url: null,
      pr_branch: null,
      pr_commit_sha: null,
    });
    expect(instance._markTaskMerged).not.toHaveBeenCalled();
  });

  test('a closed-unmerged PR keeps its lifecycle until its branch is confirmed retired', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._failAbandonedPrTask = jest.fn();
    GitHubClient.getPr.mockResolvedValue({ number: 178, merged: false, state: 'closed', head: { ref: 'content/internal-link-x' } });
    GitHubClient.retireBranch = jest.fn(async () => false);
    const result = await instance.verifyMergedTask({ id: 't', status: 'pr_open', astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/178' });
    expect(result).toMatchObject({ status: 'pr_open', skipped: 'branch_retire_pending' });
    expect(instance._failAbandonedPrTask).not.toHaveBeenCalled();
  });

  test('fails PR tasks terminally (clearing lifecycle fields) when the stored Astro PR 404s', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskVerificationFailed = jest.fn(async () => {});
    instance._failAbandonedPrTask = jest.fn(async () => {});
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
    // Terminal verdict goes through the abandoned-PR path so astro_pr_url /
    // pr_branch / pr_commit_sha are cleared and the review queue can
    // requeue/dismiss the task instead of dead-ending it.
    expect(instance._failAbandonedPrTask).toHaveBeenCalledWith(
      'task-missing-pr',
      'internal_link_verify_pr_not_found'
    );
    expect(instance._markTaskVerificationFailed).not.toHaveBeenCalled();
  });

  test('fails PR tasks terminally (clearing lifecycle fields) when no PR number can be resolved', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskVerificationFailed = jest.fn(async () => {});
    instance._failAbandonedPrTask = jest.fn(async () => {});

    const result = await instance.verifyMergedTask({
      id: 'task-no-pr-number',
      status: 'pr_open',
      astro_pr_url: 'not-a-pr-url',
    });

    expect(result).toMatchObject({
      status: 'failed',
      failure_reason: 'internal_link_verify_missing_pr_number',
    });
    expect(instance._failAbandonedPrTask).toHaveBeenCalledWith(
      'task-no-pr-number',
      'internal_link_verify_missing_pr_number'
    );
    expect(instance._markTaskVerificationFailed).not.toHaveBeenCalled();
  });

  test('a transient GitHub error during verification leaves the task status unchanged for retry', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._recoverStalePrReservedTasks = jest.fn(async () => 0);
    instance._loadPrOpenTasks = jest.fn(async () => [{
      id: 'task-transient',
      status: 'pr_open',
      astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/172',
    }]);
    instance._recordTransientVerificationError = jest.fn(async () => {});
    instance._markTaskVerificationFailed = jest.fn(async () => {});
    instance._failAbandonedPrTask = jest.fn(async () => {});
    GitHubClient.getPr.mockRejectedValue(new Error('GitHub GET /pulls/172 → 502: bad gateway'));

    const { results } = await instance.runPostMergeVerification({ limit: 1 });

    expect(results[0]).toMatchObject({
      task_id: 'task-transient',
      status: 'pr_open',
      transient: true,
      failure_reason: expect.stringContaining('internal_link_verify_error'),
    });
    expect(instance._recoverStalePrReservedTasks).toHaveBeenCalled();
    expect(instance._recordTransientVerificationError).toHaveBeenCalledWith(
      'task-transient',
      expect.stringContaining('502')
    );
    // The old behavior set status='failed' with PR fields intact — a state
    // the review queue blocks from requeue, dismiss AND verify_now.
    expect(instance._markTaskVerificationFailed).not.toHaveBeenCalled();
    expect(instance._failAbandonedPrTask).not.toHaveBeenCalled();
  });

  test('a stale-reservation sweep failure never blocks the verification pass', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._recoverStalePrReservedTasks = jest.fn(async () => { throw new Error('db hiccup'); });
    instance._loadPrOpenTasks = jest.fn(async () => []);

    const result = await instance.runPostMergeVerification({ limit: 1 });

    expect(result).toEqual({ count: 0, results: [] });
  });

  test('recovers stale pr_reserved crash orphans back to patch_candidate', async () => {
    const updates = [];
    const updateFilters = [];
    const selectChain = {
      where: jest.fn(() => selectChain),
      whereNull: jest.fn(() => selectChain),
      select: jest.fn(async () => [{
        id: 'task-stale',
        pr_branch: 'content/internal-link-orphan-abc123',
        reviewer_notes: 'prior planner note',
      }]),
    };
    const updateChain = {
      where: jest.fn((filter) => { updateFilters.push(filter); return updateChain; }),
      update: jest.fn(async (patch) => { updates.push(patch); return 1; }),
    };
    let dbCall = 0;
    db.mockImplementation(() => (dbCall++ === 0 ? selectChain : updateChain));
    GitHubClient.retireBranch = jest.fn(async () => true);

    const recovered = await new InternalLinkPrExecutor()._recoverStalePrReservedTasks();

    expect(recovered).toBe(1);
    expect(GitHubClient.retireBranch).toHaveBeenCalledWith('content/internal-link-orphan-abc123');
    expect(selectChain.where).toHaveBeenCalledWith('status', 'pr_reserved');
    expect(selectChain.whereNull).toHaveBeenCalledWith('astro_pr_url');
    expect(selectChain.where).toHaveBeenCalledWith('updated_at', '<', expect.any(Date));
    // Guarded update: only flips rows still in pr_reserved.
    expect(updateFilters[0]).toEqual({ id: 'task-stale', status: 'pr_reserved' });
    expect(updates[0]).toMatchObject({
      status: 'patch_candidate',
      pr_branch: null,
    });
    expect(updates[0].reviewer_notes).toContain('prior planner note');
    expect(updates[0].reviewer_notes).toContain('recovered stale pr_reserved reservation');
    expect(updates[0].reviewer_notes).toContain('content/internal-link-orphan-abc123');
    db.mockImplementation(() => undefined);
  });

  test('a failed PR open retires the half-made branch and returns tasks to the candidate pool', async () => {
    let patch = null;
    const builder = {
      whereIn: jest.fn(() => builder),
      where: jest.fn(() => builder),
      update: jest.fn(async (p) => { patch = p; return 1; }),
    };
    db.mockImplementation(() => builder);

    GitHubClient.retireBranch = jest.fn(async () => true);
    GitHubClient.findOpenPrByHead.mockResolvedValueOnce(null);
    await new InternalLinkPrExecutor()._releaseReservedTasks(
      [{ task: { id: 'task-open-failed' } }],
      { branch: 'content/internal-link-x', err: new Error('createPr 502') }
    );

    expect(GitHubClient.retireBranch).toHaveBeenCalledWith('content/internal-link-x');
    expect(patch).toMatchObject({
      status: 'patch_candidate',
      failure_reason: expect.stringContaining('internal_link_pr_open_failed'),
      pr_branch: null,
    });
    db.mockImplementation(() => undefined);
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


describe('internal-link candidate sweep', () => {
  const keys = ['SHADOW_MODE_ADD_INTERNAL_LINKS', 'AUTONOMOUS_INTERNAL_LINK_CANDIDATE_SWEEP', 'AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_PR', 'AUTONOMOUS_INTERNAL_LINK_SWEEP_SCAN_LIMIT'];
  const saved = {};
  beforeEach(() => { for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('does nothing while add_internal_links is in shadow mode or the kill switch is off', async () => {
    const instance = new InternalLinkPrExecutor();
    instance.runPrBatch = jest.fn();
    expect(await instance.runCandidateSweep()).toEqual({ status: 'shadow' });
    process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = 'false';
    process.env.AUTONOMOUS_INTERNAL_LINK_CANDIDATE_SWEEP = 'false';
    expect(await instance.runCandidateSweep()).toEqual({ status: 'disabled' });
    expect(instance.runPrBatch).not.toHaveBeenCalled();
  });

  test('settles finished PRs before shipping candidates with a scan window past the PR cap', async () => {
    process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = 'false';
    process.env.AUTONOMOUS_INTERNAL_LINK_MAX_LINKS_PER_PR = '2';
    const instance = new InternalLinkPrExecutor();
    instance._replanUnplannedPublishes = jest.fn(async () => 0);
    const order = [];
    instance.runPostMergeVerification = jest.fn(async () => { order.push('verify'); return { count: 0, results: [] }; });
    instance.runPrBatch = jest.fn(async () => { order.push('batch'); return { status: 'pr_open', count: 2 }; });
    expect(await instance.runCandidateSweep()).toEqual({ status: 'pr_open', count: 2 });
    expect(order).toEqual(['verify', 'batch']);
    expect(instance.runPrBatch).toHaveBeenCalledWith({ limit: 2, scanLimit: 15 });
  });
});

describe('internal-link PR batch guards', () => {
  test('refuses to open a second PR while one is open, for every caller', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._openLinkPr = jest.fn(async () => ({ id: 't1', astro_pr_url: 'https://github.com/x/y/pull/9' }));
    instance._loadPatchCandidateTasks = jest.fn();
    const result = await instance.runPrBatch({ taskIds: ['t2'], limit: 1 });
    expect(result).toMatchObject({ status: 'pr_already_open', pr_url: 'https://github.com/x/y/pull/9' });
    expect(instance._loadPatchCandidateTasks).not.toHaveBeenCalled();
  });

  test('loads the scan window, not just the cap', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._loadPatchCandidateTasks = jest.fn(async () => []);
    await instance.runPrBatch({ limit: 1, scanLimit: 15 });
    expect(instance._loadPatchCandidateTasks).toHaveBeenCalledWith({ limit: 15, taskIds: null });
  });

  test('a stale candidate is persisted as failed and the batch moves on', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._loadPatchCandidateTasks = jest.fn(async () => [
      { id: 'stale', source_file: 'src/content/blog/gone.md', target_url: '/termite-inspection/', anchor_text: 'x' },
      { id: 'good', source_file: 'src/content/blog/termite-swarmers-bathroom.md', target_url: '/termite-inspection/', anchor_text: 'termite inspection in Florida' },
    ]);
    instance._loadSourcePage = jest.fn(async (task) => {
      if (task.id === 'stale') throw new Error('source_file_not_found:src/content/blog/gone.md');
      return { ...page('src/content/blog/termite-swarmers-bathroom.md', sourceBody), sha: 's' };
    });
    instance._loadTargetPage = jest.fn(async () => page('src/content/services/termite-inspection.md', targetBody));
    instance._persistDryRunResult = jest.fn();
    instance._validateRenderedSourceAnchor = jest.fn(async () => ({ ok: true }));
    instance._reserveTasksForPr = jest.fn(async () => false);
    await instance.runPrBatch({ limit: 1, scanLimit: 5 });
    expect(instance._persistDryRunResult).toHaveBeenCalledWith('stale', expect.objectContaining({ status: 'failed', failure_reason: expect.stringContaining('source_file_not_found') }));
    expect(instance._reserveTasksForPr).toHaveBeenCalledWith([expect.objectContaining({ task: expect.objectContaining({ id: 'good' }) })], expect.any(Object));
  });

  test('a transient live-page fetch failure is retried; a 404 is terminal', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._loadPatchCandidateTasks = jest.fn(async () => [
      { id: 't1', source_file: 'src/content/blog/termite-swarmers-bathroom.md', target_url: '/termite-inspection/', anchor_text: 'termite inspection in Florida' },
    ]);
    instance._loadSourcePage = jest.fn(async () => ({ ...page('src/content/blog/termite-swarmers-bathroom.md', sourceBody), sha: 's' }));
    instance._loadTargetPage = jest.fn(async () => page('src/content/services/termite-inspection.md', targetBody));
    instance._persistDryRunResult = jest.fn();
    instance._validateRenderedSourceAnchor = jest.fn(async () => ({ ok: false, status: 'failed', reason: 'source_rendered_fetch_failed:live_http_503' }));
    await instance.runPrBatch({ limit: 1 });
    expect(instance._persistDryRunResult).not.toHaveBeenCalled();
    instance._validateRenderedSourceAnchor = jest.fn(async () => ({ ok: false, status: 'failed', reason: 'source_rendered_fetch_failed:live_http_404' }));
    await instance.runPrBatch({ limit: 1 });
    expect(instance._persistDryRunResult).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'failed' }));
  });

  test('a transient GitHub failure leaves the candidate untouched for the next sweep', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._loadPatchCandidateTasks = jest.fn(async () => [
      { id: 't1', source_file: 'src/content/blog/a.md', target_url: '/termite-inspection/', anchor_text: 'x' },
    ]);
    instance._loadSourcePage = jest.fn(async () => { throw new Error('GitHub 502: Bad Gateway'); });
    instance._persistDryRunResult = jest.fn();
    expect(await instance.runPrBatch({ limit: 1 })).toMatchObject({ status: 'no_candidates' });
    expect(instance._persistDryRunResult).not.toHaveBeenCalled();
  });

  test('a protected source page is skipped; a check error leaves the task for later', async () => {
    const protectedPages = require('../services/content/protected-pages');
    const instance = new InternalLinkPrExecutor();
    instance._loadPatchCandidateTasks = jest.fn(async () => [
      { id: 't1', source_file: 'src/content/blog/termite-swarmers-bathroom.md', target_url: '/termite-inspection/', anchor_text: 'termite inspection in Florida' },
    ]);
    instance._loadSourcePage = jest.fn(async () => ({ ...page('src/content/blog/termite-swarmers-bathroom.md', sourceBody), sha: 's' }));
    instance._loadTargetPage = jest.fn(async () => page('src/content/services/termite-inspection.md', targetBody));
    instance._persistDryRunResult = jest.fn();
    instance._reserveTasksForPr = jest.fn();

    protectedPages.isProtected.mockResolvedValueOnce({ protected: true, reason: 'money_page' });
    expect(await instance.runPrBatch({ limit: 1 })).toMatchObject({ status: 'no_candidates' });
    expect(protectedPages.isProtected).toHaveBeenCalledWith('/termite-swarmers-bathroom/', expect.any(Object));
    expect(instance._persistDryRunResult).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'skipped', skip_reason: 'source_protected_page:money_page' }));

    instance._persistDryRunResult.mockClear();
    protectedPages.isProtected.mockResolvedValueOnce({ protected: true, reason: 'protected_check_error', source: 'error' });
    expect(await instance.runPrBatch({ limit: 1 })).toMatchObject({ status: 'no_candidates' });
    expect(instance._persistDryRunResult).not.toHaveBeenCalled();
    expect(instance._reserveTasksForPr).not.toHaveBeenCalled();
  });

  test('an LLM judge rejection skips the link; no verdict leaves it for the next sweep', async () => {
    const judge = require('../services/content/internal-link-judge');
    const instance = new InternalLinkPrExecutor();
    instance._loadPatchCandidateTasks = jest.fn(async () => [
      { id: 't1', source_file: 'src/content/blog/termite-swarmers-bathroom.md', target_url: '/termite-inspection/', anchor_text: 'termite inspection in Florida' },
    ]);
    instance._loadSourcePage = jest.fn(async () => ({ ...page('src/content/blog/termite-swarmers-bathroom.md', sourceBody), sha: 's' }));
    instance._loadTargetPage = jest.fn(async () => page('src/content/services/termite-inspection.md', targetBody));
    instance._validateRenderedSourceAnchor = jest.fn(async () => ({ ok: true }));
    instance._persistDryRunResult = jest.fn();
    instance._reserveTasksForPr = jest.fn();

    judge.judgeLink.mockResolvedValueOnce({ ok: true, approve: false, reason: 'tangent in this paragraph' });
    expect(await instance.runPrBatch({ limit: 1 })).toMatchObject({ status: 'no_candidates' });
    expect(instance._persistDryRunResult).toHaveBeenCalledWith('t1', expect.objectContaining({ status: 'skipped', skip_reason: 'llm_judge_rejected:tangent in this paragraph' }));

    instance._persistDryRunResult.mockClear();
    judge.judgeLink.mockResolvedValueOnce({ ok: false, reason: 'judge_unavailable:no_key' });
    expect(await instance.runPrBatch({ limit: 1 })).toMatchObject({ status: 'no_candidates' });
    expect(instance._persistDryRunResult).not.toHaveBeenCalled();
    expect(instance._reserveTasksForPr).not.toHaveBeenCalled();
  });
});

describe('internal-link PR auto-merge', () => {
  const keys = ['SHADOW_MODE_ADD_INTERNAL_LINKS', 'AUTONOMOUS_INTERNAL_LINK_AUTO_MERGE', 'AUTONOMOUS_INTERNAL_LINK_CODEX_GRACE_MIN'];
  const saved = {};
  const HEAD = 'a'.repeat(40);
  const prUrl = 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/77';
  const baseBody = 'Intro.\n\nA termite inspection in Florida helps.\n';
  const headBody = 'Intro.\n\nA [termite inspection in Florida](/termite-inspection/) helps.\n';
  let instance;

  function openTasks(rows, { mergedToday = 0 } = {}) {
    const q = {
      where: jest.fn(() => q),
      whereNotNull: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      orderBy: jest.fn(() => q),
      select: jest.fn(async () => rows),
      countDistinct: jest.fn(() => q),
      first: jest.fn(async () => ({ count: String(mergedToday) })),
      whereIn: jest.fn(() => q),
      update: jest.fn(async () => 1),
    };
    db.mockImplementation(() => q);
  }

  beforeEach(() => {
    for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = 'false';
    openTasks([{ id: 't1', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, executor_version: 'internal-link-pr-executor-v2', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' }]);
    GitHubClient.getPr.mockResolvedValue({ number: 77, state: 'open', title: 'SEO links', user: { login: 'waves-bot' }, created_at: new Date(Date.now() - 3 * 3600e3).toISOString(), head: { sha: HEAD, ref: 'content/internal-link-x' }, base: { ref: 'main' } });
    GitHubClient.listPrFiles = jest.fn(async () => [{ filename: 'src/content/blog/a.md' }]);
    GitHubClient.getFile.mockImplementation(async (_path, ref) => ({ content: ref === HEAD ? headBody : baseBody }));
    GitHubClient.getBranchSha = jest.fn(async () => 'e'.repeat(40));
    GitHubClient.mergePr = jest.fn(async () => ({ sha: 'b'.repeat(40), merged: true }));
    GitHubClient.closePr = jest.fn();
    GitHubClient.retireBranch = jest.fn(async () => true);
    // The executor's own "@codex review" request for this head, 3h ago.
    GitHubClient.listIssueComments = jest.fn(async () => [{ user: { login: 'waves-bot' }, body: `@codex review\n\nPlease review this autonomous internal-link PR on head \`${HEAD}\`.`, created_at: new Date(Date.now() - 3 * 3600e3).toISOString() }]);
    GitHubClient.listPrReviews = jest.fn(async () => []);
    GitHubClient.listPrReviewComments = jest.fn(async () => []);
    instance = new InternalLinkPrExecutor();
    instance._markTaskMerged = jest.fn();
    instance._closeLinkPr = jest.fn(async () => true);
    instance._loadTargetPage = jest.fn(async () => page('src/content/services/termite-inspection.md', targetBody));
    jest.spyOn(require('../services/content-astro/pages-poll'), 'latestDeploymentForBranch')
      .mockResolvedValue({ latest_stage: { status: 'success' }, deployment_trigger: { metadata: { branch: 'content/internal-link-x', commit_hash: HEAD } } });
  });
  afterEach(() => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  test('merges a link-only PR with a green preview once Codex has been silent past the grace window', async () => {
    const result = await instance.runAutoMerge();
    expect(result).toMatchObject({ status: 'merged', pr_number: 77, codex: 'silent' });
    // Base pinned to the commit the link-only check read, merged atomically.
    expect(GitHubClient.getFile).toHaveBeenCalledWith('src/content/blog/a.md', 'e'.repeat(40));
    expect(GitHubClient.mergePr).toHaveBeenCalledWith(77, expect.objectContaining({
      sha: HEAD, expectBaseSha: 'e'.repeat(40), expectBaseRef: 'main', verifyPaths: ['src/content/blog/a.md'],
    }));
    expect(instance._markTaskMerged).toHaveBeenCalledWith('t1', expect.objectContaining({ commitSha: 'b'.repeat(40) }));
  });

  test('never auto-merges a PR opened before the reader check existed', async () => {
    openTasks([{ id: 't0', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, executor_version: 'internal-link-pr-executor-v1', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' }]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'pre_judge_pr' });
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('holds when main moves between the check and the merge, keeping the in-flight marker for the ancestry check', async () => {
    const updates = [];
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = base(table);
      q.update = jest.fn(async (patch) => { updates.push(patch); return 1; });
      return q;
    });
    GitHubClient.mergePr.mockRejectedValueOnce(Object.assign(new Error('moved'), { code: 'BLOG_BASE_MOVED' }));
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'base_moved' });
    expect(instance._markTaskMerged).not.toHaveBeenCalled();
    // Recorded before the write, never cleared on the error path.
    expect(updates).toEqual([expect.objectContaining({ failure_reason: 'internal_link_merge_in_flight' })]);
  });

  test('never merges on "silence" when the review was never requested; re-requests instead', async () => {
    GitHubClient.listIssueComments.mockResolvedValue([]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'codex_review_not_requested' });
    expect(GitHubClient.createIssueComment).toHaveBeenCalledWith(77, expect.stringContaining('@codex review'));
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('a review request from anyone but the PR\'s automation author does not start the silence clock', async () => {
    GitHubClient.listIssueComments.mockResolvedValue([{ user: { login: 'drive-by-user' }, body: `@codex review on \`${HEAD}\``, created_at: new Date(Date.now() - 5 * 3600e3).toISOString() }]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'codex_review_not_requested' });
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('an advanced head records publication first, then closes the PR; a failed close is retried next tick', async () => {
    const updates = [];
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = base(table);
      q.whereIn = jest.fn(() => q);
      q.update = jest.fn(async (patch) => { updates.push(patch); return 1; });
      return q;
    });
    GitHubClient.mergePr.mockResolvedValueOnce({ sha: 'b'.repeat(40), merged: true, headAdvanced: 'c'.repeat(40) });
    GitHubClient.closePr.mockRejectedValueOnce(new Error('github down'));
    await expect(instance.runAutoMerge()).rejects.toThrow('github down');
    // Merge intent before the external write, then publication evidence,
    // both on the rows before cleanup was attempted.
    expect(updates).toEqual([
      expect.objectContaining({ failure_reason: 'internal_link_merge_in_flight' }),
      expect.objectContaining({ merged_at: expect.any(Date) }),
    ]);
    expect(instance._markTaskMerged).not.toHaveBeenCalled();

    // Next tick, branch retirement fails: still held, rows stay pr_open.
    openTasks([{ id: 't1', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, merged_at: new Date().toISOString(), executor_version: 'internal-link-pr-executor-v2', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' }]);
    GitHubClient.getPr.mockResolvedValue({ number: 77, state: 'closed', head: { sha: 'c'.repeat(40), ref: 'content/internal-link-x' }, base: { ref: 'main' } });
    GitHubClient.retireBranch.mockResolvedValueOnce(false);
    expect(await instance.runAutoMerge()).toMatchObject({ settled: 0 });
    expect(instance._markTaskMerged).not.toHaveBeenCalled();

    // Next tick: the rows carry merged_at, so cleanup finishes (never "unmerged").
    openTasks([{ id: 't1', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, merged_at: new Date().toISOString(), executor_version: 'internal-link-pr-executor-v2', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' }]);
    GitHubClient.getPr.mockResolvedValue({ number: 77, state: 'open', head: { sha: 'c'.repeat(40), ref: 'content/internal-link-x' }, base: { ref: 'main' } });
    expect(await instance.runAutoMerge()).toMatchObject({ settled: 1 });
    expect(GitHubClient.closePr).toHaveBeenLastCalledWith(77);
    expect(instance._markTaskMerged).toHaveBeenCalledWith('t1', expect.any(Object));
    expect(GitHubClient.mergePr).toHaveBeenCalledTimes(1);
  });

  test('a PR still open after the merge is closed even when mergePr reported no advanced head', async () => {
    GitHubClient.mergePr.mockResolvedValueOnce({ sha: 'b'.repeat(40), merged: true });
    // getPr: gates read it open; the post-merge re-read still shows it open.
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'merged' });
    expect(GitHubClient.closePr).toHaveBeenCalledWith(77);
    expect(GitHubClient.retireBranch).toHaveBeenCalledWith('content/internal-link-x');
    expect(instance._markTaskMerged).toHaveBeenCalledWith('t1', expect.objectContaining({ commitSha: 'b'.repeat(40) }));
  });

  test('holds inside the grace window while Codex has not answered', async () => {
    GitHubClient.listIssueComments.mockResolvedValue([{ user: { login: 'waves-bot' }, body: `@codex review on \`${HEAD}\``, created_at: new Date().toISOString() }]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'codex_review_pending' });
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('closes the PR when Codex left findings on the head', async () => {
    GitHubClient.listPrReviewComments.mockResolvedValue([{ user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: HEAD, body: 'P1 …' }]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'codex_findings' });
    expect(instance._closeLinkPr).toHaveBeenCalledWith(expect.objectContaining({ number: 77 }), expect.any(Array), expect.objectContaining({ status: 'skipped', skipReason: 'codex_findings' }));
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('a review-level Codex rejection with no inline comments blocks the merge', async () => {
    GitHubClient.listPrReviews.mockResolvedValue([{ user: { login: 'chatgpt-codex-connector' }, commit_id: HEAD, state: 'CHANGES_REQUESTED', body: '### Codex Review\nThe anchor misleads readers.' }]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'codex_findings' });

    GitHubClient.listPrReviews.mockResolvedValue([]);
    GitHubClient.listIssueComments.mockResolvedValue([{ user: { login: 'chatgpt-codex-connector[bot]' }, body: `Codex Review: here are some suggestions.\nReviewed commit: ${HEAD.slice(0, 10)}` }]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'codex_findings' });
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('a usage-limit reply counts as silence, not a rejection', async () => {
    GitHubClient.listIssueComments.mockResolvedValue([
      { user: { login: 'waves-bot' }, body: `@codex review on \`${HEAD}\``, created_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
      { user: { login: 'chatgpt-codex-connector[bot]' }, body: `Codex Review: You have reached your Codex usage limits. ${HEAD.slice(0, 10)}` },
    ]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'merged', codex: 'silent' });
  });

  test('a clean Codex verdict on the head merges inside the grace window', async () => {
    GitHubClient.getPr.mockResolvedValue({ number: 77, state: 'open', created_at: new Date().toISOString(), head: { sha: HEAD, ref: 'content/internal-link-x' }, base: { ref: 'main' } });
    GitHubClient.listPrReviews.mockResolvedValue([{ user: { login: 'chatgpt-codex-connector' }, commit_id: HEAD, state: 'COMMENTED', submitted_at: new Date().toISOString(), body: "### 💡 Codex Review\nDidn't find any major issues." }]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'merged', codex: 'clean' });
  });

  test('closes and returns tasks to the pool when the diff is more than the link (or main moved)', async () => {
    GitHubClient.getFile.mockImplementation(async (_path, ref) => ({ content: ref === HEAD ? `${headBody}Extra line.\n` : baseBody }));
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'diff_not_link_only_or_main_moved' });
    expect(instance._closeLinkPr).toHaveBeenCalledWith(expect.any(Object), expect.any(Array), expect.objectContaining({ status: 'patch_candidate' }));
  });

  test('closes when the PR touches a file no task names', async () => {
    GitHubClient.listPrFiles.mockResolvedValue([{ filename: 'src/content/blog/a.md' }, { filename: 'astro.config.mjs' }]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'diff_files_unexpected' });
  });

  test('never merges a head the executor did not push, or a stale/failed preview', async () => {
    GitHubClient.getPr.mockResolvedValueOnce({ number: 77, state: 'open', head: { sha: 'c'.repeat(40), ref: 'x' }, base: { ref: 'main' } });
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'head_not_executor_commit' });

    const pagesPoll = require('../services/content-astro/pages-poll');
    pagesPoll.latestDeploymentForBranch.mockResolvedValueOnce({ latest_stage: { status: 'success' }, deployment_trigger: { metadata: { commit_hash: 'd'.repeat(40) } } });
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'preview_build_stale_commit' });

    pagesPoll.latestDeploymentForBranch.mockResolvedValueOnce({ latest_stage: { status: 'failure' }, deployment_trigger: { metadata: { commit_hash: HEAD } } });
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'preview_build_failed' });
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('when the poller\'s merge cap is spent, checks run but the merge waits', async () => {
    expect(await instance.runAutoMerge({ allowMerge: false })).toMatchObject({ status: 'hold', reason: 'merge_cap_reached' });
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('accepts a freshness-date bump alongside the link, and nothing else in frontmatter', async () => {
    const base = '---\ntitle: "T"\nmodified: "2026-06-19T00:00:00"\n---\nA termite inspection in Florida helps.\n';
    const head = '---\ntitle: "T"\nmodified: "2026-09-27T12:00:00"\n---\nA [termite inspection in Florida](/termite-inspection/) helps.\n';
    GitHubClient.getFile.mockImplementation(async (_p, ref) => ({ content: ref === HEAD ? head : base }));
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'merged' });

    GitHubClient.mergePr.mockClear();
    GitHubClient.getFile.mockImplementation(async (_p, ref) => ({ content: ref === HEAD ? head.replace('title: "T"', 'title: "Changed"') : base }));
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'diff_not_link_only_or_main_moved' });
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('a PR closed without merging is cleared only after its branch is retired', async () => {
    GitHubClient.getPr.mockResolvedValue({ number: 77, state: 'closed', merged: false, head: { sha: HEAD, ref: 'content/internal-link-x' }, base: { ref: 'main' } });
    instance._closeLinkPr = jest.fn(async () => false);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'branch_retire_pending' });
    instance._closeLinkPr = jest.fn(async () => true);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'pr_closed_unmerged' });
  });


  test('a PR retargeted away from production main is closed, never merged', async () => {
    GitHubClient.getPr.mockResolvedValue({ number: 77, state: 'open', created_at: new Date(0).toISOString(), head: { sha: HEAD, ref: 'content/internal-link-x' }, base: { ref: 'staging' } });
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'base_not_production' });
    expect(instance._closeLinkPr).toHaveBeenCalledWith(expect.any(Object), expect.any(Array), expect.objectContaining({ failureReason: 'internal_link_pr_base_changed' }));
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('a close whose branch is not yet retired holds instead of reporting closed', async () => {
    instance._closeLinkPr = jest.fn(async () => false);
    GitHubClient.listPrReviewComments.mockResolvedValue([{ user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: HEAD, body: 'P1' }]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'branch_retire_pending' });
  });

  test('a Codex rejection whose branch retirement failed stays a rejection on the retry', async () => {
    openTasks([{ id: 't1', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, executor_version: 'internal-link-pr-executor-v2', skip_reason: 'codex_findings', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' }]);
    GitHubClient.getPr.mockResolvedValue({ number: 77, state: 'closed', merged: false, head: { sha: HEAD, ref: 'content/internal-link-x' }, base: { ref: 'main' } });
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'pr_closed_unmerged' });
    expect(instance._closeLinkPr).toHaveBeenCalledWith(expect.any(Object), expect.any(Array), expect.objectContaining({ status: 'skipped', skipReason: 'codex_findings' }));
  });

  test('Codex findings are recorded as a rejection even when main also moved', async () => {
    GitHubClient.listPrReviewComments.mockResolvedValue([{ user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: HEAD, body: 'P1' }]);
    GitHubClient.getFile.mockImplementation(async (_path, ref) => ({ content: ref === HEAD ? `${headBody}moved\n` : baseBody }));
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'codex_findings' });
    expect(instance._closeLinkPr).toHaveBeenCalledWith(expect.any(Object), expect.any(Array), expect.objectContaining({ skipReason: 'codex_findings' }));
  });

  test('a crash-recovered PR is held for a human, never auto-merged', async () => {
    openTasks([{ id: 't1', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, executor_version: 'internal-link-pr-executor-recovered', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' }]);
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'pre_judge_pr' });
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('the autonomous publish freeze (daily cap 0) stops link merges', async () => {
    const saved = process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY;
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY = '0';
    try {
      expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'publish_frozen' });
      expect(GitHubClient.mergePr).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY;
      else process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY = saved;
    }
  });

  test('link merges count against the daily publish cap', async () => {
    const saved = process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY;
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY = '2';
    const row = { id: 't1', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, executor_version: 'internal-link-pr-executor-v2', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' };
    try {
      openTasks([row], { mergedToday: 2 });
      expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'daily_publish_cap_reached' });
      openTasks([row], { mergedToday: 1 });
      expect(await instance.runAutoMerge()).toMatchObject({ status: 'merged' });
    } finally {
      if (saved === undefined) delete process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY;
      else process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_DAY = saved;
    }
  });

  test('the weekly publish cap also holds link merges', async () => {
    const saved = process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK;
    process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK = '7';
    try {
      openTasks([{ id: 't1', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, executor_version: 'internal-link-pr-executor-v2', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' }], { mergedToday: 7 });
      expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'weekly_publish_cap_reached' });
      expect(GitHubClient.mergePr).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK;
      else process.env.AUTONOMOUS_CONTENT_MAX_PUBLISHES_PER_WEEK = saved;
    }
  });

  test('a source page protected after the PR opened blocks the merge; a lookup error holds', async () => {
    const protectedPages = require('../services/content/protected-pages');
    protectedPages.isProtected.mockResolvedValueOnce({ protected: true, reason: 'money_page' });
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'source_now_protected' });
    expect(protectedPages.isProtected).toHaveBeenCalledWith('/a/', expect.any(Object));
    protectedPages.isProtected.mockResolvedValueOnce({ protected: true, reason: 'protected_check_error', source: 'error' });
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'protection_check_unavailable' });
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('a target that vanished, went noindex, or failed to load blocks the merge', async () => {
    instance._loadTargetPage.mockRejectedValueOnce(new Error('target_file_not_found:src/content/services/termite-inspection.md'));
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'target_gone' });
    instance._loadTargetPage.mockResolvedValueOnce({ ...page('src/content/services/termite-inspection.md', targetBody), indexable: false });
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'target_not_linkable' });
    instance._loadTargetPage.mockRejectedValueOnce(new Error('GitHub 502'));
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'hold', reason: 'target_check_unavailable' });
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('a canceled preview build closes the PR and returns the links to the pool', async () => {
    require('../services/content-astro/pages-poll').latestDeploymentForBranch
      .mockResolvedValueOnce({ latest_stage: { status: 'canceled' }, deployment_trigger: { metadata: { commit_hash: HEAD } } });
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'closed', reason: 'preview_build_canceled' });
    expect(instance._closeLinkPr).toHaveBeenCalledWith(expect.any(Object), expect.any(Array), expect.objectContaining({ status: 'patch_candidate' }));
  });

  test('a merge that landed before the process died is recovered from the in-flight marker', async () => {
    openTasks([{ id: 't1', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, failure_reason: 'internal_link_merge_in_flight', executor_version: 'internal-link-pr-executor-v2', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' }]);
    GitHubClient.getPr.mockResolvedValue({ number: 77, state: 'open', user: { login: 'waves-bot' }, head: { sha: 'c'.repeat(40), ref: 'content/internal-link-x' }, base: { ref: 'main' } });
    GitHubClient.compareFiles = jest.fn(async () => ({ files: [], mergeBaseSha: HEAD }));
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'merged', reason: 'published_settled' });
    expect(GitHubClient.closePr).toHaveBeenCalledWith(77);
    expect(instance._markTaskMerged).toHaveBeenCalledWith('t1', expect.any(Object));
    expect(GitHubClient.mergePr).not.toHaveBeenCalled();
  });

  test('an in-flight marker for a merge that never landed is cleared and the gates continue', async () => {
    openTasks([{ id: 't1', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, failure_reason: 'internal_link_merge_in_flight', executor_version: 'internal-link-pr-executor-v2', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' }]);
    GitHubClient.compareFiles = jest.fn(async () => ({ files: [], mergeBaseSha: 'd'.repeat(40) }));
    expect(await instance.runAutoMerge()).toMatchObject({ status: 'merged', codex: 'silent' });
    expect(GitHubClient.mergePr).toHaveBeenCalledTimes(1);
  });

  test('a published PR still settles when the auto-merge kill switch is off (no new merges)', async () => {
    process.env.AUTONOMOUS_INTERNAL_LINK_AUTO_MERGE = 'false';
    try {
      openTasks([{ id: 't1', status: 'pr_open', astro_pr_url: prUrl, pr_commit_sha: HEAD, merged_at: new Date().toISOString(), executor_version: 'internal-link-pr-executor-v2', source_file: 'src/content/blog/a.md', source_url: '/a/', target_url: '/termite-inspection/' }]);
      GitHubClient.getPr.mockResolvedValue({ number: 77, state: 'open', head: { sha: 'c'.repeat(40), ref: 'content/internal-link-x' }, base: { ref: 'main' } });
      expect(await instance.runAutoMerge()).toEqual({ status: 'disabled', settled: 1 });
      expect(GitHubClient.closePr).toHaveBeenCalledWith(77);
      expect(instance._markTaskMerged).toHaveBeenCalledWith('t1', expect.any(Object));
      expect(GitHubClient.mergePr).not.toHaveBeenCalled();
    } finally {
      delete process.env.AUTONOMOUS_INTERNAL_LINK_AUTO_MERGE;
    }
  });

  test('kill switch and shadow mode disable it', async () => {
    process.env.AUTONOMOUS_INTERNAL_LINK_AUTO_MERGE = 'false';
    expect(await instance.runAutoMerge()).toEqual({ status: 'disabled', settled: 0 });
    delete process.env.AUTONOMOUS_INTERNAL_LINK_AUTO_MERGE;
    process.env.SHADOW_MODE_ADD_INTERNAL_LINKS = 'true';
    expect(await instance.runAutoMerge()).toEqual({ status: 'shadow', settled: 0 });
  });
});

describe('internal-link freshness bump', () => {
  const { bumpFreshnessLine, restoreFreshnessLine } = executor._internals;
  test('bumps services modified and blog updated in place, preserving quoting', () => {
    const svc = '---\ntitle: "T"\nmodified: "2026-06-19T00:00:00"\n---\nBody\n';
    expect(bumpFreshnessLine(svc, '2026-09-27')).toBe('---\ntitle: "T"\nmodified: "2026-09-27T12:00:00"\n---\nBody\n');
    const blog = '---\ntitle: T\nupdated: 2026-01-02\n---\nBody\n';
    expect(bumpFreshnessLine(blog, '2026-09-27')).toBe('---\ntitle: T\nupdated: 2026-09-27\n---\nBody\n');
    // Absent: inserted in the page format's own field, and restorable.
    const v1 = '---\ntitle: T\ndate: 2025-01-01\n---\nBody\n';
    expect(bumpFreshnessLine(v1, '2026-09-27')).toBe('---\ntitle: T\ndate: 2025-01-01\nmodified: "2026-09-27T12:00:00"\n---\nBody\n');
    expect(restoreFreshnessLine(bumpFreshnessLine(v1, '2026-09-27'), v1)).toBe(v1);
    const v2 = '---\ntitle: T\npublished: 2025-01-01\n---\nBody\n';
    expect(bumpFreshnessLine(v2, '2026-09-27')).toBe('---\ntitle: T\npublished: 2025-01-01\nupdated: 2026-09-27\n---\nBody\n');
    expect(restoreFreshnessLine(bumpFreshnessLine(v2, '2026-09-27'), v2)).toBe(v2);
  });
  test('restore only undoes a well-formed date on the freshness line', () => {
    const base = '---\nmodified: "2026-06-19T00:00:00"\n---\nB\n';
    expect(restoreFreshnessLine('---\nmodified: "2026-09-27T12:00:00"\n---\nB\n', base)).toBe(base);
    expect(restoreFreshnessLine('---\nmodified: "tomorrow"\n---\nB\n', base)).not.toBe(base);
  });
});

describe('internal-link stale reservation recovery', () => {
  test('restores a reservation whose PR actually opened instead of freeing it', async () => {
    const instance = new InternalLinkPrExecutor();
    const updates = [];
    const q = {
      where: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      select: jest.fn(async () => [{ id: 'r1', pr_branch: 'content/internal-link-x', reviewer_notes: null }]),
      update: jest.fn(async (patch) => { updates.push(patch); return 1; }),
    };
    db.mockImplementation(() => q);
    GitHubClient.findOpenPrByHead.mockResolvedValueOnce({ html_url: 'https://github.com/x/y/pull/88', head: { sha: 'f'.repeat(40) } });
    await instance._recoverStalePrReservedTasks();
    expect(GitHubClient.findOpenPrByHead).toHaveBeenCalledWith('content/internal-link-x');
    expect(updates).toEqual([expect.objectContaining({ status: 'pr_open', astro_pr_url: 'https://github.com/x/y/pull/88', pr_commit_sha: 'f'.repeat(40), executor_version: 'internal-link-pr-executor-recovered' })]);
  });
});


describe('internal-link close records the rejection before cleanup', () => {
  test('skip_reason is written while the task is still pr_open, even if retirement then fails', async () => {
    const instance = new InternalLinkPrExecutor();
    const updates = [];
    const q = { whereIn: jest.fn(() => q), where: jest.fn(() => q), update: jest.fn(async (patch) => { updates.push(patch); return 1; }) };
    db.mockImplementation(() => q);
    GitHubClient.closePr = jest.fn();
    GitHubClient.retireBranch = jest.fn(async () => false);
    const closed = await instance._closeLinkPr(
      { number: 77, state: 'open', head: { ref: 'b' } },
      [{ id: 't1', astro_pr_url: 'u' }],
      { status: 'skipped', skipReason: 'codex_findings', note: 'n' },
    );
    expect(closed).toBe(false);
    expect(updates).toEqual([expect.objectContaining({ skip_reason: 'codex_findings' })]);
  });
});


describe('internal-link verification vs pending advanced-head cleanup', () => {
  test('verification leaves a published-but-uncleaned PR row pr_open for the cleanup gate', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskMerged = jest.fn();
    instance._failAbandonedPrTask = jest.fn();
    GitHubClient.getPr.mockResolvedValue({ number: 77, merged: false, state: 'open', head: { ref: 'b' } });
    const result = await instance.verifyMergedTask({
      id: 't1', status: 'pr_open', merged_at: new Date().toISOString(),
      astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/77',
    });
    expect(result).toMatchObject({ status: 'pr_open', skipped: 'advanced_head_cleanup_pending' });
    expect(instance._markTaskMerged).not.toHaveBeenCalled();
    expect(instance._failAbandonedPrTask).not.toHaveBeenCalled();
  });
});

describe('internal-link recycle intent survives a failed branch retirement', () => {
  test('close records the recycle marker first; both settle paths return links to the pool', async () => {
    const instance = new InternalLinkPrExecutor();
    const updates = [];
    const q = { whereIn: jest.fn(() => q), where: jest.fn(() => q), update: jest.fn(async (patch) => { updates.push(patch); return 1; }) };
    db.mockImplementation(() => q);
    GitHubClient.closePr = jest.fn();
    GitHubClient.retireBranch = jest.fn(async () => false);
    expect(await instance._closeLinkPr({ number: 77, state: 'open', head: { ref: 'b' } }, [{ id: 't1' }], { status: 'patch_candidate', note: 'n' })).toBe(false);
    expect(updates).toEqual([expect.objectContaining({ skip_reason: 'internal_link_recycle_pending' })]);

    // Verification settles it back to patch_candidate, not failed.
    updates.length = 0;
    GitHubClient.getPr.mockResolvedValue({ number: 77, merged: false, state: 'closed', head: { ref: 'b' } });
    GitHubClient.retireBranch = jest.fn(async () => true);
    instance._failAbandonedPrTask = jest.fn();
    const result = await instance.verifyMergedTask({ id: 't1', status: 'pr_open', skip_reason: 'internal_link_recycle_pending', astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/77' });
    expect(result).toMatchObject({ status: 'patch_candidate' });
    expect(instance._failAbandonedPrTask).not.toHaveBeenCalled();
    expect(updates).toEqual([expect.objectContaining({ status: 'patch_candidate', skip_reason: null })]);
    db.mockImplementation(() => undefined);
  });
});

describe('internal-link ambiguous PR-open failure', () => {
  function capture() {
    const updates = [];
    const q = { whereIn: jest.fn(() => q), where: jest.fn(() => q), update: jest.fn(async (patch) => { updates.push(patch); return 1; }) };
    db.mockImplementation(() => q);
    return updates;
  }
  afterEach(() => db.mockImplementation(() => undefined));

  test('a PR that opened despite the error is tracked (held for a human), never duplicated', async () => {
    const updates = capture();
    GitHubClient.findOpenPrByHead.mockResolvedValueOnce({ html_url: 'https://github.com/x/y/pull/90', head: { sha: 'e'.repeat(40) } });
    GitHubClient.retireBranch = jest.fn();
    await new InternalLinkPrExecutor()._releaseReservedTasks([{ task: { id: 't1' } }], { branch: 'b', err: new Error('createPr timeout') });
    expect(updates).toEqual([expect.objectContaining({ status: 'pr_open', astro_pr_url: 'https://github.com/x/y/pull/90', executor_version: 'internal-link-pr-executor-recovered' })]);
    expect(GitHubClient.retireBranch).not.toHaveBeenCalled();
  });

  test('an unconfirmed branch retirement keeps the reservation', async () => {
    const updates = capture();
    GitHubClient.findOpenPrByHead.mockResolvedValueOnce(null);
    GitHubClient.retireBranch = jest.fn(async () => false);
    await new InternalLinkPrExecutor()._releaseReservedTasks([{ task: { id: 't1' } }], { branch: 'b', err: new Error('x') });
    expect(updates).toEqual([]);
  });
});

describe('internal-link stale reservation keeps its branch reference until retired', () => {
  test('an unconfirmed branch retirement leaves the reservation for the next sweep', async () => {
    const updates = [];
    const q = {
      where: jest.fn(() => q),
      whereNull: jest.fn(() => q),
      select: jest.fn(async () => [{ id: 'r1', pr_branch: 'content/internal-link-x', reviewer_notes: null }]),
      update: jest.fn(async (patch) => { updates.push(patch); return 1; }),
    };
    db.mockImplementation(() => q);
    GitHubClient.findOpenPrByHead.mockResolvedValueOnce(null);
    GitHubClient.retireBranch = jest.fn(async () => false);
    expect(await new InternalLinkPrExecutor()._recoverStalePrReservedTasks()).toBe(0);
    expect(updates).toEqual([]);
    db.mockImplementation(() => undefined);
  });
});

describe('internal-link close vs a concurrent human merge', () => {
  test('a PR merged while we closed it is recorded as published, not rejected', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._markTaskMerged = jest.fn();
    const updates = [];
    const q = { whereIn: jest.fn(() => q), where: jest.fn(() => q), update: jest.fn(async (patch) => { updates.push(patch); return 1; }) };
    db.mockImplementation(() => q);
    GitHubClient.closePr = jest.fn();
    GitHubClient.getPr.mockResolvedValueOnce({ number: 77, state: 'closed', merged: true, merged_at: '2026-09-28T01:00:00Z', merge_commit_sha: 'm'.repeat(40) });
    GitHubClient.retireBranch = jest.fn();
    expect(await instance._closeLinkPr({ number: 77, state: 'open', head: { ref: 'b' } }, [{ id: 't1' }], { status: 'skipped', skipReason: 'codex_findings', note: 'n' })).toBe(true);
    expect(instance._markTaskMerged).toHaveBeenCalledWith('t1', expect.objectContaining({ commitSha: 'm'.repeat(40) }));
    expect(updates.at(-1)).toMatchObject({ skip_reason: null, merged_at: expect.any(Date) });
    db.mockImplementation(() => undefined);
  });
});

describe('internal-link transient dry-run failures from planners', () => {
  test('are returned to the candidate pool; confirmed-missing files are not', async () => {
    const updates = [];
    const q = { whereIn: jest.fn((col, ids) => { q.ids = ids; return q; }), where: jest.fn(() => q), update: jest.fn(async (patch) => { updates.push({ ids: q.ids, patch }); return 1; }) };
    db.mockImplementation(() => q);
    const n = await executor.requeueTransientDryRunFailures([
      { task_id: 'a', status: 'failed', failure_reason: 'GitHub 502' },
      { task_id: 'b', status: 'failed', failure_reason: 'source_file_not_found:x.md' },
      { task_id: 'c', status: 'patch_candidate' },
    ]);
    expect(n).toBe(1);
    expect(updates).toEqual([{ ids: ['a'], patch: expect.objectContaining({ status: 'patch_candidate' }) }]);
    db.mockImplementation(() => undefined);
  });
});

describe('internal-link verification vs a concurrent publication', () => {
  test('a closed-unmerged settle that finds the row already published backs off for the next pass', async () => {
    const instance = new InternalLinkPrExecutor();
    instance._failAbandonedPrTask = jest.fn(async () => 0); // conditional update matched nothing
    GitHubClient.getPr.mockResolvedValue({ number: 77, merged: false, state: 'closed', head: { ref: 'b' } });
    GitHubClient.retireBranch = jest.fn(async () => true);
    const result = await instance.verifyMergedTask({ id: 't1', status: 'pr_open', astro_pr_url: 'https://github.com/wavespestcontrolfl/wavespestcontrol-astro/pull/77' });
    expect(result).toMatchObject({ transient: true, skipped: 'publication_state_changed' });
    expect(instance._failAbandonedPrTask).toHaveBeenCalledWith('t1', 'internal_link_pr_closed_unmerged', { onlyIf: expect.any(Function) });
  });
});

describe('internal-link replan of publishes whose post-merge planning failed', () => {
  test('replans recent publishes stamped link_planning_failed_at and clears the marker', async () => {
    jest.resetModules();
    const updates = [];
    jest.doMock('../models/db', () => {
      const db = jest.fn((table) => {
        const q = {};
        for (const m of ['where', 'whereNull', 'whereNotNull', 'orderBy', 'limit']) q[m] = jest.fn((col) => { if (col === 'link_planning_failed_at') q.usedMarker = true; return q; });
        q.select = jest.fn(async () => (table === 'autonomous_runs' ? [{ id: 'run1', published_url: 'https://www.wavespestcontrol.com/new-post/', action_type: 'new_supporting_blog' }] : []));
        q.update = jest.fn(async (patch) => { updates.push({ table, patch }); return 1; });
        return q;
      });
      return db;
    });
    // The draft canonical is stale; the verified published_url must win.
    jest.doMock('../services/content/autonomous-pr-poller', () => ({ _internals: { resolveTargetForRun: jest.fn(async () => ({ url: 'https://www.wavespestcontrol.com/stale-draft-canonical/', keyword: 'kw', planLinks: true })) } }));
    const planInternalLinksForTarget = jest.fn()
      .mockResolvedValueOnce(null) // no corpus: planning could not run
      .mockResolvedValueOnce({ queued: 4 });
    const internalLinkPlanningDisabled = jest.fn(() => false);
    jest.doMock('../services/content-astro/astro-publisher', () => ({ planInternalLinksForTarget, internalLinkPlanningDisabled }));
    const fresh = require('../services/content/internal-link-pr-executor');
    const instance = new fresh.InternalLinkPrExecutor();
    // A null result keeps the marker (re-stamped to the back of the queue)…
    expect(await instance._replanUnplannedPublishes()).toBe(0);
    expect(updates).toEqual([{ table: 'autonomous_runs', patch: expect.objectContaining({ link_planning_failed_at: expect.any(Date) }) }]);
    updates.length = 0;
    // …the next sweep plans it and stamps the result.
    const replanned = await instance._replanUnplannedPublishes();
    expect(replanned).toBe(1);
    expect(planInternalLinksForTarget).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'https://www.wavespestcontrol.com/new-post/', keyword: 'kw' }));
    expect(updates).toEqual([{ table: 'autonomous_runs', patch: expect.objectContaining({ link_tasks_queued: 4, link_planning_failed_at: null }) }]);
    // The post-merge planning kill switch stops the replan too.
    internalLinkPlanningDisabled.mockReturnValueOnce(true);
    planInternalLinksForTarget.mockClear();
    expect(await instance._replanUnplannedPublishes()).toBe(0);
    expect(planInternalLinksForTarget).not.toHaveBeenCalled();
    jest.dontMock('../models/db');
    jest.dontMock('../services/content/autonomous-pr-poller');
    jest.dontMock('../services/content-astro/astro-publisher');
  });
});
