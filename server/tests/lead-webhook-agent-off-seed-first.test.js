/**
 * Agent off (owner 2026-10-25, A3: every web lead gets only the fixed
 * CALL/TEXT text): the intake state is seeded BEFORE the text, in its own
 * step, so a send that throws can no longer skip the seed. The POST handler
 * has no unit harness; this pins the order in the agent-off block.
 */
const fs = require('fs');
const path = require('path');

test('the agent-off path seeds intake first, then sends, each in its own try', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'lead-webhook.js'), 'utf8');
  const start = src.indexOf('    if (!leadAgentConfigured) {\n      try { await seedLeadIntakeState(customer.id); }');
  expect(start).toBeGreaterThan(-1);
  const block = src.slice(start, start + 400);
  expect(block.indexOf('seedLeadIntakeState')).toBeLessThan(block.indexOf('sendLeadAutoReplyOnce'));
  expect(block.match(/try \{/g)).toHaveLength(2);
});
