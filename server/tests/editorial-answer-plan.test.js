jest.mock('../models/db', () => jest.fn());
jest.mock('../services/content/editorial-review', () => ({ reviewPlan: jest.fn() }));
jest.mock('../services/content-astro/github-client', () => ({ getFile: jest.fn() }));

const tools = require('../services/content/agents/brief-driven-tools');
const { reviewPlan } = require('../services/content/editorial-review');
const gh = require('../services/content-astro/github-client');

const originalGate = process.env.GATE_EDITORIAL_EVIDENCE;
const sessionId = 'editorial-test';
const sections = [{ heading: 'Inspect', question: 'How?', answer: 'Look for gaps.' }];

beforeEach(() => {
  process.env.GATE_EDITORIAL_EVIDENCE = 'true';
  reviewPlan.mockReset();
  gh.getFile.mockReset();
});
afterEach(() => { tools.clearDraft(sessionId); });
afterAll(() => {
  if (originalGate === undefined) delete process.env.GATE_EDITORIAL_EVIDENCE;
  else process.env.GATE_EDITORIAL_EVIDENCE = originalGate;
});

test('cannot emit depth before independently approved answer plan', async () => {
  await tools.registerSessionEditorial(sessionId, { page_type: 'supporting-blog', working_title: 'Door inspection' });
  const result = await tools.executeBriefTool('emit_draft', { frontmatter: { title: 'Door inspection' }, body: 'Some depth' }, { sessionId });
  expect(result.draft_rejected).toBe(true);
  expect(tools.getDraft(sessionId)).toBeNull();
});

test('answer plan fails closed with a bounded retry budget', async () => {
  await tools.registerSessionEditorial(sessionId, { page_type: 'supporting-blog', working_title: 'Door inspection' });
  reviewPlan.mockRejectedValue(new Error('provider outage'));
  for (let i = 0; i < 4; i++) {
    const result = await tools.executeBriefTool('validate_answer_plan', { sections }, { sessionId });
    expect(result.pass).toBe(false);
  }
  expect(reviewPlan).toHaveBeenCalledTimes(3);
});

test('a later failed plan revokes the prior approval', async () => {
  await tools.registerSessionEditorial(sessionId, { page_type: 'supporting-blog', working_title: 'Door inspection' });
  reviewPlan.mockResolvedValueOnce({ pass: true }).mockResolvedValueOnce({ pass: false });
  const context = { sessionId };
  const input = { sections };
  expect((await tools.executeBriefTool('validate_answer_plan', input, context)).pass).toBe(true);
  expect((await tools.executeBriefTool('validate_answer_plan', input, context)).pass).toBe(false);
  expect(reviewPlan).toHaveBeenNthCalledWith(1, { title: 'Door inspection', sections });
  expect((await tools.executeBriefTool('emit_draft', { frontmatter: { title: 'Inspect' }, body: 'Depth' }, context)).draft_rejected).toBe(true);
});

test('a keywordless decay refresh validates against the bound existing blog title', async () => {
  gh.getFile.mockImplementation(async (filePath) => {
    if (filePath === 'src/content/blog/other.md') return { content: '---\ntitle: Unrelated Research Page\n---\n\nOther body.' };
    if (filePath === 'src/content/blog/door.md') return { content: '---\ntitle: Door Inspection Guide\n---\n\nExisting body.' };
    return null;
  });
  await tools.registerSessionEditorial(sessionId, {
    page_type: 'refresh',
    action_type: 'refresh_existing_page',
    working_title: null,
    target_keyword: null,
    target_url: '/blog/door/',
  });
  reviewPlan.mockResolvedValue({ pass: true });

  const researchPage = await tools.executeBriefTool('get_existing_page', { page_url: '/blog/other/' }, { sessionId });
  const result = await tools.executeBriefTool('validate_answer_plan', { sections }, { sessionId });

  expect(researchPage.frontmatter.title).toBe('Unrelated Research Page');
  expect(result.pass).toBe(true);
  expect(reviewPlan).toHaveBeenCalledWith({ title: 'Door Inspection Guide', sections });
});

test('a resolved non-blog refresh skips the blog answer-plan gate and may emit without a model call', async () => {
  gh.getFile.mockImplementation(async (filePath) => filePath === 'src/content/services/pest-control-venice-fl.md'
    ? { content: '---\ntitle: Pest Control Venice\n---\n\nExisting body.' }
    : null);
  await tools.registerSessionEditorial(sessionId, {
    page_type: 'refresh',
    action_type: 'refresh_existing_page',
    target_url: '/pest-control-venice-fl/',
  });

  await expect(tools.executeBriefTool('validate_answer_plan', { sections }, { sessionId }))
    .resolves.toEqual({ pass: true, skipped: 'editorial_gate_not_applicable' });
  const emitted = await tools.executeBriefTool('emit_draft', {
    frontmatter: { title: 'Pest Control Venice' },
    body: 'Updated service page.',
  }, { sessionId });

  expect(emitted.ok).toBe(true);
  expect(tools.getDraft(sessionId).body).toBe('Updated service page.');
  expect(reviewPlan).not.toHaveBeenCalled();
});

test.each([
  ['the existing page has no title', '/blog/door/', { content: '---\nupdated: 2026-09-24\n---\n\nExisting body.' }],
  ['the existing page cannot be resolved', '/blog/door/', null],
  ['the brief has no target', null, null],
])('a refresh plan fails closed when %s', async (_label, targetUrl, existingFile) => {
  gh.getFile.mockImplementation(async (filePath) => filePath === 'src/content/blog/door.md' ? existingFile : null);
  await tools.registerSessionEditorial(sessionId, {
    page_type: 'refresh',
    action_type: 'refresh_existing_page',
    working_title: null,
    target_keyword: null,
    target_url: targetUrl,
  });

  const result = await tools.executeBriefTool('validate_answer_plan', { sections }, { sessionId });

  expect(result).toEqual(expect.objectContaining({ pass: false, error: expect.stringContaining('Existing page title unavailable') }));
  expect(reviewPlan).not.toHaveBeenCalled();
});

test('gate-off registration does not fetch the refresh target', async () => {
  process.env.GATE_EDITORIAL_EVIDENCE = 'false';
  await tools.registerSessionEditorial(sessionId, {
    page_type: 'refresh',
    action_type: 'refresh_existing_page',
    target_url: '/blog/door/',
  });

  expect(gh.getFile).not.toHaveBeenCalled();
  await expect(tools.executeBriefTool('validate_answer_plan', { sections }, { sessionId }))
    .resolves.toEqual({ pass: true, skipped: 'editorial_gate_not_applicable' });
});
