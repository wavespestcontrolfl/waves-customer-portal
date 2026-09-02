/**
 * The writer's system prompt must carry the AffiliateLink rules the publish
 * gate enforces (affiliate pilot) — and bind them to briefs that list
 * affiliate_products only, so an ordinary post never emits the component.
 */
jest.mock('../models/db', () => jest.fn());

const { WRITER_AGENT_CONFIG } = require('../services/content/agents/writer-agent-config');

test('writer prompt carries the AffiliateLink rules, scoped to briefs that list affiliate_products', () => {
  const prompt = JSON.stringify(WRITER_AGENT_CONFIG);
  expect(prompt).toContain('AFFILIATE PRODUCT LINKS');
  expect(prompt).toContain('operator_brief.affiliate_products');
  expect(prompt).toContain('<AffiliateLink product=');
  expect(prompt).toMatch(/disclosure: \{ \\"type\\": \\"affiliate\\" \}/);
  expect(prompt).toContain('never before the first');
  expect(prompt).toContain('BEFORE the first affiliate link');
  expect(prompt).toContain('never decision, comparison, cost, case-study, or location');
  expect(prompt).toContain('On every other brief NEVER emit it');
});
