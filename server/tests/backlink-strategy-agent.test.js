const { _test } = require('../services/seo/backlink-strategy-agent');

describe('backlink strategy managed agent session payload', () => {
  test('uses the current Anthropic sessions agent field', () => {
    expect(_test.buildSessionCreateBody('agent_123', 'env_456')).toEqual({
      agent: 'agent_123',
      environment_id: 'env_456',
    });
    expect(_test.buildSessionCreateBody('agent_123', 'env_456')).not.toHaveProperty('agent_id');
  });
});
