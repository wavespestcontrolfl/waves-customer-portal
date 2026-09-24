jest.mock('../models/db', () => jest.fn());
jest.mock('../services/content/editorial-review', () => ({ reviewPlan: jest.fn() }));
const tools = require('../services/content/agents/brief-driven-tools');
const { reviewPlan } = require('../services/content/editorial-review');
const originalGate = process.env.GATE_EDITORIAL_EVIDENCE;
beforeEach(() => { process.env.GATE_EDITORIAL_EVIDENCE = 'true'; jest.clearAllMocks(); });
afterEach(() => { tools.clearDraft('editorial-test'); });
afterAll(() => {
  if (originalGate === undefined) delete process.env.GATE_EDITORIAL_EVIDENCE;
  else process.env.GATE_EDITORIAL_EVIDENCE = originalGate;
});
test('cannot emit depth before independently approved answer plan', async () => {
  tools.registerSessionEditorial('editorial-test', { page_type: 'supporting-blog', working_title: 'Door inspection' });
  const result = await tools.executeBriefTool('emit_draft', { frontmatter: { title: 'Door inspection' }, body: 'Some depth' }, { sessionId: 'editorial-test' });
  expect(result.draft_rejected).toBe(true);
  expect(tools.getDraft('editorial-test')).toBeNull();
});
test('answer plan fails closed with a bounded retry budget', async () => {
  tools.registerSessionEditorial('editorial-test', { page_type: 'supporting-blog' });
  reviewPlan.mockRejectedValue(new Error('provider outage'));
  for (let i = 0; i < 4; i++) {
    const result = await tools.executeBriefTool('validate_answer_plan', { sections: [{ heading: 'Inspect', question: 'How?', answer: 'Look for gaps.' }] }, { sessionId: 'editorial-test' });
    expect(result.pass).toBe(false);
  }
  expect(reviewPlan).toHaveBeenCalledTimes(3);
});
test('a later failed plan revokes the prior approval', async () => {
  tools.registerSessionEditorial('editorial-test', { page_type: 'supporting-blog' });
  reviewPlan.mockResolvedValueOnce({ pass: true }).mockResolvedValueOnce({ pass: false });
  const context = { sessionId: 'editorial-test' };
  const input = { sections: [{ heading: 'Inspect', question: 'How?', answer: 'Look for gaps.' }] };
  expect((await tools.executeBriefTool('validate_answer_plan', input, context)).pass).toBe(true);
  expect((await tools.executeBriefTool('validate_answer_plan', input, context)).pass).toBe(false);
  expect((await tools.executeBriefTool('emit_draft', { frontmatter: { title: 'Inspect' }, body: 'Depth' }, context)).draft_rejected).toBe(true);
});
