const { emailTemplateAutomationsMode, isEnabled } = require('../config/feature-gates');

// Read at CALL time (no resetModules needed) — see feature-gates.js's own
// comment above the function for the convention this mirrors.
describe('emailTemplateAutomationsMode', () => {
  const savedGate = process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS;
  const savedEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS;
    else process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = savedGate;
    process.env.NODE_ENV = savedEnv;
  });

  function set(gate, nodeEnv) {
    if (gate === undefined) delete process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS;
    else process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = gate;
    process.env.NODE_ENV = nodeEnv;
  }

  test('prod: unset is off (fail closed)', () => {
    set(undefined, 'production');
    expect(emailTemplateAutomationsMode()).toBe('off');
  });

  test('prod: shadow', () => {
    set('shadow', 'production');
    expect(emailTemplateAutomationsMode()).toBe('shadow');
  });

  test('prod: true is live', () => {
    set('true', 'production');
    expect(emailTemplateAutomationsMode()).toBe('live');
  });

  test('prod: anything else is off', () => {
    set('nonsense', 'production');
    expect(emailTemplateAutomationsMode()).toBe('off');
  });

  test('non-prod: unset keeps today\'s default of live', () => {
    set(undefined, 'test');
    expect(emailTemplateAutomationsMode()).toBe('live');
  });

  test('non-prod: shadow overrides the default for local testing', () => {
    set('shadow', 'test');
    expect(emailTemplateAutomationsMode()).toBe('shadow');
  });

  test('non-prod: true is live', () => {
    set('true', 'test');
    expect(emailTemplateAutomationsMode()).toBe('live');
  });

  test('non-prod: an explicit false/off kill switch is honored', () => {
    set('false', 'test');
    expect(emailTemplateAutomationsMode()).toBe('off');
    set('off', 'test');
    expect(emailTemplateAutomationsMode()).toBe('off');
  });
});

// codex P1 round 4 — the boolean gate is DERIVED from the mode (one source
// of truth), read at call time, in every environment.
describe('isEnabled(\'emailTemplateAutomations\') follows emailTemplateAutomationsMode()', () => {
  const savedGate = process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS;
  const savedEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (savedGate === undefined) delete process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS;
    else process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = savedGate;
    process.env.NODE_ENV = savedEnv;
  });

  test.each([
    ['development', 'false', false],
    ['development', 'off', false],
    ['development', undefined, true],
    ['development', 'shadow', true],
    ['development', 'true', true],
    ['production', undefined, false],
    ['production', 'false', false],
    ['production', 'nonsense', false],
    ['production', 'shadow', true],
    ['production', 'true', true],
  ])('NODE_ENV=%s gate=%s → %s', (nodeEnv, gate, expected) => {
    if (gate === undefined) delete process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS;
    else process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = gate;
    process.env.NODE_ENV = nodeEnv;
    expect(isEnabled('emailTemplateAutomations')).toBe(expected);
    expect(isEnabled('emailTemplateAutomations')).toBe(emailTemplateAutomationsMode() !== 'off');
  });
});
