const { approvedAgentEstimateMemoryPrompt } = require('../services/agent-estimate-memory');

describe('approved Agent Estimate learning prompt', () => {
  test('selects the newest 30 approvals and presents that window chronologically', async () => {
    const calls = [];
    const newestFirst = Array.from({ length: 35 }, (_, index) => ({
      version: 35 - index,
      rule_text: `rule ${35 - index}`,
    }));
    const database = jest.fn(() => {
      const builder = {
        where: (value) => { calls.push(['where', value]); return builder; },
        orderBy: (...value) => { calls.push(['orderBy', ...value]); return builder; },
        limit: (value) => { calls.push(['limit', value]); return builder; },
        select: async () => newestFirst.slice(0, 30),
      };
      return builder;
    });

    const prompt = await approvedAgentEstimateMemoryPrompt(database);

    expect(calls).toContainEqual(['orderBy', 'version', 'desc']);
    expect(calls).toContainEqual(['limit', 30]);
    expect(prompt).not.toContain('- v5:');
    expect(prompt).toContain('- v6: rule 6');
    expect(prompt).toContain('- v35: rule 35');
    expect(prompt.indexOf('- v6:')).toBeLessThan(prompt.indexOf('- v35:'));
  });
});
