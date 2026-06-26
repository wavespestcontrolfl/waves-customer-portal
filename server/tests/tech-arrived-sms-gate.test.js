// The Tech Arrived SMS is a customer-facing auto-send, so its gate must fail
// closed in EVERY environment (off in dev/preview too) — otherwise a preview/dev
// box with real Twilio creds would text real customers the moment markOnProperty
// runs. This locks that behavior in vs the dev-open pattern used by twilioSms.

const ORIGINAL_ENV = process.env;

function loadGates(overrides = {}) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.NODE_ENV;
  delete process.env.GATE_TECH_ARRIVED_SMS;
  delete process.env.GATE_TWILIO_SMS;
  Object.assign(process.env, overrides);
  return require('../config/feature-gates').gates;
}

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe('techArrivedSms gate', () => {
  test('is OFF in dev/preview when GATE_TECH_ARRIVED_SMS is unset', () => {
    expect(loadGates({ NODE_ENV: 'development' }).techArrivedSms).toBe(false);
  });

  test('is OFF in production when GATE_TECH_ARRIVED_SMS is unset', () => {
    expect(loadGates({ NODE_ENV: 'production' }).techArrivedSms).toBe(false);
  });

  test('is ON only when GATE_TECH_ARRIVED_SMS=true, in dev and prod alike', () => {
    expect(loadGates({ NODE_ENV: 'development', GATE_TECH_ARRIVED_SMS: 'true' }).techArrivedSms).toBe(true);
    expect(loadGates({ NODE_ENV: 'production', GATE_TECH_ARRIVED_SMS: 'true' }).techArrivedSms).toBe(true);
  });

  test('does not flip on for a non-"true" value', () => {
    expect(loadGates({ NODE_ENV: 'development', GATE_TECH_ARRIVED_SMS: '1' }).techArrivedSms).toBe(false);
  });

  test('contrast: twilioSms keeps its dev-open default (unset → on in dev, off in prod)', () => {
    expect(loadGates({ NODE_ENV: 'development' }).twilioSms).toBe(true);
    expect(loadGates({ NODE_ENV: 'production' }).twilioSms).toBe(false);
  });
});
