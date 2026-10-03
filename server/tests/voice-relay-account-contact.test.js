// Sandy P1 (#5751): a known customer is not asked again for the name, address
// and email already on the account. The exception is written at system
// priority and names the two tools that still need those details.

describe('the exception lives at system priority, only when the caller-context lane is on', () => {
  test('context on: the intake exception is in the system prompt (so a late-arriving caller block is covered); context off: untouched', () => {
    const { buildBasePrompt } = require('../services/voice-agent/relay-conversation');
    expect(buildBasePrompt(true)).toMatch(/is the exception to gathering a name, address and\s+email/);
    expect(buildBasePrompt(true)).toMatch(/start of the call or partway through/);
    // The two tools that need those details are named, so the rule and the tools agree.
    expect(buildBasePrompt(true)).toMatch(/checking open times needs the\s+service address or ZIP/);
    expect(buildBasePrompt(true)).toMatch(/written estimate needs the full name, email\s+and service address/);
    expect(buildBasePrompt(false)).not.toMatch(/KNOWN CALLER/);
  });
});
