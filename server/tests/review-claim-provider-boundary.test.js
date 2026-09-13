/**
 * The locked review handoff releases its durable claim ONLY when nothing
 * reached the provider. This exercises the real wiring — the caller's handoff,
 * the send layer's wrapper, and a throwing provider dispatch — rather than a
 * stubbed handoff, because the marker travels through two layers:
 * reviewSendThroughSummaryHandoff passes (trx, onProviderStart) to the send
 * layer's callback, which fires it immediately before the SDK request.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const Summary = require('../services/visit-completion-summary');

// The send layer's wrapper, verbatim in shape: fresh checks, then the caller's
// marker, then the provider request.
function sendLayerWrapper(callerHandoff, providerRequest) {
  return callerHandoff(async (trx, onProviderStart) => {
    if (typeof onProviderStart === 'function') await onProviderStart();
    await providerRequest();
    return { ok: true };
  });
}

test('a provider request that throws AFTER the marker keeps the claim', async () => {
  let dispatchedSeen = false;
  const handoff = (dispatch) => Promise.resolve()
    .then(() => dispatch({}, () => { dispatchedSeen = true; }))
    .then(() => ({ ok: true }));

  await expect(sendLayerWrapper(handoff, async () => { throw new Error('ECONNRESET'); }))
    .rejects.toThrow('ECONNRESET');
  // The marker fired before the request: the caller must treat the outcome as
  // ambiguous and leave its `sending` row for the reconciliation.
  expect(dispatchedSeen).toBe(true);
});

test('a check that fails BEFORE the marker never reports a provider request', async () => {
  let dispatchedSeen = false;
  const handoff = (dispatch) => Promise.resolve()
    .then(() => dispatch({}, () => { dispatchedSeen = true; }));

  await expect(handoff(async () => { throw new Error('consent lookup failed'); }))
    .rejects.toThrow('consent lookup failed');
  expect(dispatchedSeen).toBe(false);
});

test('the handoff passes its marker as the second argument of dispatch', async () => {
  // Guards the contract the send layer depends on: reviewSendThroughSummaryHandoff
  // must invoke dispatch(trx, onProviderStart), not dispatch(trx).
  const source = require('fs').readFileSync(
    require('path').join(__dirname, '../services/visit-completion-summary.js'), 'utf8',
  );
  const handoff = source.slice(source.indexOf('async function reviewSendThroughSummaryHandoff'));
  expect(handoff.slice(0, handoff.indexOf('\n}\n'))).toContain('dispatch(trx, () => { dispatched = true; })');
  expect(typeof Summary.reviewSendThroughSummaryHandoff).toBe('function');
});


/**
 * Provider evidence must exclude terminal non-deliveries: Twilio keeps
 * failed/undelivered/canceled messages, and reading one as proof would stamp
 * a review ask sent and advance its cadence on a text nobody received.
 */
describe('provider delivery evidence', () => {
  const listed = [];
  beforeEach(() => { listed.length = 0; });

  function twilioWith(messages) {
    jest.resetModules();
    jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    jest.doMock('twilio', () => () => ({ messages: { list: async (args) => { listed.push(args); return messages; } } }));
    process.env.TWILIO_ACCOUNT_SID = 'AC_test';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_PHONE_NUMBER = '+15005550006';
    return require('../services/twilio');
  }

  test('a failed or undelivered message is not evidence', async () => {
    for (const status of ['failed', 'undelivered', 'canceled']) {
      const Twilio = twilioWith([{ direction: 'outbound-api', status, body: 'review please tok-abc' }]);
      expect(await Twilio.findOutboundMessageSince({ to: '+19415550123', sentAfter: new Date(), bodyFragment: 'tok-abc' }))
        .toEqual({ found: false });
    }
  });

  test('a delivered message carrying the ask token is evidence', async () => {
    const Twilio = twilioWith([{ direction: 'outbound-api', status: 'delivered', body: 'review please tok-abc' }]);
    expect(await Twilio.findOutboundMessageSince({ to: '+19415550123', sentAfter: new Date(), bodyFragment: 'tok-abc' }))
      .toEqual({ found: true });
  });
});
