const { _test } = require('../services/seo/backlink-strategy-agent');

describe('backlink strategy managed agent session payload', () => {
  test('uses the current Anthropic sessions agent field', () => {
    expect(_test.buildSessionCreateBody('agent_123', 'env_456')).toEqual({
      agent: 'agent_123',
      environment_id: 'env_456',
    });
    expect(_test.buildSessionCreateBody('agent_123', 'env_456')).not.toHaveProperty('agent_id');
  });

  test('wraps initial messages in the current sessions events schema', () => {
    expect(_test.buildUserMessageEvent('run strategy')).toEqual({
      type: 'user.message',
      content: [{ type: 'text', text: 'run strategy' }],
    });
  });

  test('builds custom tool result events for managed-agent custom tools', () => {
    expect(_test.buildToolResultEvent('toolu_123', { added: 2 })).toEqual({
      type: 'user.custom_tool_result',
      custom_tool_use_id: 'toolu_123',
      content: [{ type: 'text', text: JSON.stringify({ added: 2 }) }],
    });
  });

  test('reads tool use ids from all managed-agent event shapes', () => {
    expect(_test.toolUseIdFromEvent({ id: 'id_1' })).toBe('id_1');
    expect(_test.toolUseIdFromEvent({ custom_tool_use_id: 'custom_1' })).toBe('custom_1');
    expect(_test.toolUseIdFromEvent({ tool_use_id: 'legacy_1' })).toBe('legacy_1');
  });
});
