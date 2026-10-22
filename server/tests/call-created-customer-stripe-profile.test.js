'use strict';

/**
 * GATE_CALL_LEAD_LAZY_STRIPE, source fix: a customer created from a call no longer
 * gets a Stripe profile at once. The empty profile of a lead that never pays
 * made a later duplicate merge refuse the pair (two Stripe profiles). Every
 * card-save and payment path creates the profile on demand
 * (StripeService.ensureStripeCustomer), so nothing needs it up front.
 *
 * processRecording is a 14,000-line module that cannot be driven from a unit
 * test, so this runs the exact "Auto-create Stripe customer" block, cut out of
 * the source, with stubbed require/logger (the repo's structural-pin style).
 */
const fs = require('fs');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
const START = SOURCE.indexOf('// Auto-create Stripe customer');
const END = SOURCE.indexOf('newsletterCandidate = {', START);

function runBlock({ gate }) {
  const ensureStripeCustomer = jest.fn(async () => 'cus_syn');
  const logger = { warn: jest.fn() };
  const stubRequire = (id) => {
    if (id === '../config/feature-gates') return { callLeadLazyStripeLive: () => gate };
    if (id === './stripe') return { ensureStripeCustomer };
    throw new Error(`unexpected require ${id}`);
  };
   
  const run = new Function('require', 'logger', 'customerId', `return (async () => {\n${SOURCE.slice(START, END)}\n})();`);
  return { ensureStripeCustomer, logger, done: () => run(stubRequire, logger, 'cust-1') };
}

describe('call-created customer Stripe profile', () => {
  test('the block was found in the processor source', () => {
    expect(START).toBeGreaterThan(0);
    expect(END).toBeGreaterThan(START);
    expect(SOURCE.slice(START, END).match(/ensureStripeCustomer\(/g)).toHaveLength(1);
  });

  test('gate off: the profile is created right away, as before', async () => {
    const t = runBlock({ gate: false });
    await t.done();
    expect(t.ensureStripeCustomer).toHaveBeenCalledWith('cust-1');
  });

  test('gate on: no profile is created for the new customer', async () => {
    const t = runBlock({ gate: true });
    await t.done();
    expect(t.ensureStripeCustomer).not.toHaveBeenCalled();
  });

  test('gate off: a Stripe failure is logged and does not throw', async () => {
    const t = runBlock({ gate: false });
    t.ensureStripeCustomer.mockRejectedValueOnce(new Error('stripe down'));
    await expect(t.done()).resolves.toBeUndefined();
    expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Stripe customer create failed'));
  });

  test('the processor has no other eager ensureStripeCustomer call', () => {
    expect(SOURCE.match(/ensureStripeCustomer\(/g)).toHaveLength(1);
  });
});

describe('GATE_CALL_LEAD_LAZY_STRIPE reader', () => {
  afterEach(() => { delete process.env.GATE_CALL_LEAD_LAZY_STRIPE; });
  it('is dark unless exactly "true", read at call time', () => {
    const { callLeadLazyStripeLive } = jest.requireActual('../config/feature-gates');
    expect(callLeadLazyStripeLive()).toBe(false);
    for (const v of ['1', 'TRUE', 'yes', ' true']) {
      process.env.GATE_CALL_LEAD_LAZY_STRIPE = v;
      expect(callLeadLazyStripeLive()).toBe(false);
    }
    process.env.GATE_CALL_LEAD_LAZY_STRIPE = 'true';
    expect(callLeadLazyStripeLive()).toBe(true);
  });
});
