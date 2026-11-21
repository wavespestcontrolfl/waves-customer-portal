/**
 * estimate-emailed-service-name: the follow-up label comes from the words the
 * estimate delivery email already carried (GATE_ESTIMATE_FOLLOWUP_SERVICE_NAME,
 * owner 2026-11-21). Pins the closed-label parser and the reader's proofs.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { serviceNameFromSummary, emailedServiceName } = require('../services/estimate-emailed-service-name');
const { inferEstimateServiceInterest } = require('../services/estimate-service-lines');

describe('serviceNameFromSummary', () => {
  test.each([
    ['Pest Control', 'pest control'],
    ['Lawn Care', 'lawn care'],
    ['Lawn Care + Pest Control', 'lawn care and pest control'],
    ['Pest Control + Lawn Care', 'lawn care and pest control'],
  ])('%j gives %j', (summary, expected) => {
    expect(serviceNameFromSummary(summary)).toBe(expected);
  });

  test.each([
    ['a third label', 'Lawn Care + Pest Control + Mosquito'],
    ['spaces around a label (exact strings only)', '  Pest Control '],
    ['a repeated label', 'Pest Control + Pest Control'],
    ['a repeated label after the pair', 'Lawn Care + Pest Control + Lawn Care'],
    ['an unlisted label', 'Termite'],
    ['an unlisted label next to a listed one', 'Pest Control + Termite'],
    ['near-miss casing', 'pest control'],
    ['free text', 'Quarterly pest and lawn for the whole house'],
    ['a blank', ''],
    ['only spaces', '   '],
  ])('%s gives null', (_label, summary) => {
    expect(serviceNameFromSummary(summary)).toBeNull();
  });

  test.each([[null], [undefined], [42], [{}], [['Pest Control']]])('non-string %j gives null', (value) => {
    expect(serviceNameFromSummary(value)).toBeNull();
  });
});

// Today's two generic labels, read from the packs (never retyped).
const { PACKS } = require('../services/estimate-followup-copy')._private;
const BUNDLE = PACKS.bundle.label;
const ONE_TIME = PACKS.one_time.label;

describe('emailedServiceName', () => {
  let builder;
  let rows;
  let failure;

  // A lawn + pest estimate whose current inference is "Lawn Care + Pest Control".
  function estimate(extra = {}) {
    return {
      id: 'est-1',
      customer_email: ' Jordan@Example.com ',
      service_interest: 'Lawn Care + Pest Control',
      estimate_data: null,
      ...extra,
    };
  }
  // The stored email shows whatever summary its payload holds, unless a test overrides the text.
  const row = (extra = {}) => {
    const payload = extra.payload_snapshot ?? { service_summary: 'Lawn Care + Pest Control' };
    let shown = payload;
    if (typeof shown === 'string') { try { shown = JSON.parse(shown); } catch { shown = null; } }
    return {
      status: 'sent',
      payload_snapshot: payload,
      text_snapshot: `Hi Jordan,\nService: ${shown?.service_summary ?? ''}\nProperty: 1 Test Way`,
      ...extra,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    rows = [];
    failure = null;
    builder = {};
    for (const m of ['where', 'whereIn', 'whereRaw', 'orderByRaw', 'orderBy', 'select']) {
      builder[m] = jest.fn(() => builder);
    }
    builder.then = (resolve, reject) => (failure
      ? Promise.reject(failure).then(resolve, reject)
      : Promise.resolve(rows).then(resolve, reject));
    db.mockImplementation(() => builder);
  });

  test('the fixture matches the inference the proof uses', () => {
    expect(inferEstimateServiceInterest({ ...estimate(), estimateData: null })).toBe('Lawn Care + Pest Control');
  });

  test('asks for this estimate, the three delivery keys, the current address, newest first, with no limit', async () => {
    rows = [row()];
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBe('lawn care and pest control');
    expect(db).toHaveBeenCalledWith('email_messages');
    expect(builder.where).toHaveBeenCalledWith({ estimate_id: 'est-1' });
    const keysCall = builder.whereIn.mock.calls.find(([col]) => col === 'template_key');
    expect(keysCall[1]).toEqual(['estimate.delivery', 'estimate.proposal_delivery', 'estimate.updated_delivery']);
    expect(builder.whereRaw).toHaveBeenCalledWith('LOWER(TRIM(recipient_email_snapshot)) = ?', ['jordan@example.com']);
    expect(builder.orderByRaw).toHaveBeenCalledWith('COALESCE(sent_at, queued_at) DESC NULLS LAST');
    expect(builder.limit).toBeUndefined();
    const sql = builder.whereRaw.mock.calls.concat(builder.orderByRaw.mock.calls).map((c) => c[0]).join(' ');
    expect(sql).not.toContain('?|');
    expect(sql.replace(/= \?/g, '')).not.toContain('?');
  });

  test('the newest accepted row wins over an older one', async () => {
    rows = [
      row({ payload_snapshot: { service_summary: 'Lawn Care + Pest Control' } }),
      row({ payload_snapshot: { service_summary: 'Pest Control' } }),
    ];
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBe('lawn care and pest control');
  });

  test('a failed or queued newest row is skipped for the next accepted one', async () => {
    rows = [
      row({ status: 'failed', payload_snapshot: { service_summary: 'Pest Control' } }),
      row({ status: 'queued', payload_snapshot: { service_summary: 'Lawn Care' } }),
      row({ status: 'delivered' }),
    ];
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBe('lawn care and pest control');
  });

  test('only failed or queued rows: no name', async () => {
    rows = [row({ status: 'failed' }), row({ status: 'queued' }), row({ status: 'bounced' })];
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBeNull();
  });

  test('the newest accepted row decides even when an older one would have named a service', async () => {
    rows = [
      row({ payload_snapshot: { service_summary: 'Termite' } }),
      row(),
    ];
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBeNull();
  });

  test('no rows (another address, another estimate): no name', async () => {
    rows = [];
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBeNull();
  });

  test('no address on the estimate: no name and no read', async () => {
    await expect(emailedServiceName(estimate({ customer_email: '  ' }), BUNDLE)).resolves.toBeNull();
    await expect(emailedServiceName(estimate({ customer_email: null }), BUNDLE)).resolves.toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('a JSON string payload and an object payload read the same', async () => {
    rows = [row({ payload_snapshot: JSON.stringify({ service_summary: 'Lawn Care + Pest Control' }) })];
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBe('lawn care and pest control');
    rows = [row({ payload_snapshot: { service_summary: 'Lawn Care + Pest Control' } })];
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBe('lawn care and pest control');
  });

  test.each([
    ['unparseable text', 'not json {'],
    ['null', null],
    ['a JSON array', '[]'],
    ['a payload with no summary', { first_name: 'Jordan' }],
  ])('a payload that is %s gives no name', async (_label, payload_snapshot) => {
    rows = [row({ payload_snapshot })];
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBeNull();
  });

  test('a stored summary outside the closed labels gives no name', async () => {
    rows = [row({ payload_snapshot: { service_summary: 'Quarterly Pest Control' } })];
    await expect(emailedServiceName(estimate({ service_interest: 'Quarterly Pest Control' }), BUNDLE)).resolves.toBeNull();
  });

  test('a stored summary that differs from the current inference gives no name', async () => {
    rows = [row({ payload_snapshot: { service_summary: 'Pest Control' } })];
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBeNull();
  });

  test('an estimate that now infers nothing gives no name', async () => {
    rows = [row()];
    await expect(emailedServiceName(estimate({ service_interest: null }), BUNDLE)).resolves.toBeNull();
  });

  test('a failed read gives no name and logs only the error code', async () => {
    failure = Object.assign(new Error('select failed for jordan@example.com'), { code: '57014' });
    await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const logged = logger.warn.mock.calls[0].join(' ');
    expect(logged).toContain('57014');
    expect(logged).not.toContain('example.com');
  });

  describe('the stored email must show the summary on its Service line', () => {
    const WRAPPER = 'Waves Pest Control & Lawn Care\nWaves Pest Control, LLC';
    const pestOnly = { service_interest: 'Pest Control' };
    const pestPayload = { service_summary: 'Pest Control' };

    test('the exact Service line counts, with spaces around it', async () => {
      rows = [row({ text_snapshot: `${WRAPPER}\n  Service: Lawn Care + Pest Control  \nProperty: 1 Test Way` })];
      await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBe('lawn care and pest control');
    });

    test('the branded wrapper alone never counts: a template version without the Service row gives no name', async () => {
      rows = [row({ payload_snapshot: pestPayload, text_snapshot: `${WRAPPER}\nYour estimate is ready.` })];
      await expect(emailedServiceName(estimate(pestOnly), ONE_TIME)).resolves.toBeNull();
    });

    test('a Service line with more words than the summary does not count', async () => {
      rows = [row({ payload_snapshot: pestPayload, text_snapshot: 'Service: Pest Control + Termite' })];
      await expect(emailedServiceName(estimate(pestOnly), ONE_TIME)).resolves.toBeNull();
    });

    test('a row with no stored text gives no name', async () => {
      rows = [row({ text_snapshot: null })];
      await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBeNull();
    });
  });

  describe('only the two generic labels are replaced', () => {
    const pestOnly = { service_interest: 'Pest Control' };
    const pestRow = () => row({ payload_snapshot: { service_summary: 'Pest Control' } });

    test.each([['pest control'], ['lawn care'], ['termite protection'], [undefined], [null], ['']])(
      'today\'s label %j is never replaced, and nothing is read', async (label) => {
        rows = [row()];
        await expect(emailedServiceName(estimate(), label)).resolves.toBeNull();
        expect(db).not.toHaveBeenCalled();
      });

    test('the bundle label takes the two-service name only', async () => {
      rows = [row()];
      await expect(emailedServiceName(estimate(), BUNDLE)).resolves.toBe('lawn care and pest control');
      rows = [pestRow()];
      await expect(emailedServiceName(estimate(pestOnly), BUNDLE)).resolves.toBeNull();
    });

    test('the one-time label takes a single-service name only', async () => {
      rows = [pestRow()];
      await expect(emailedServiceName(estimate(pestOnly), ONE_TIME)).resolves.toBe('pest control');
      rows = [row()];
      await expect(emailedServiceName(estimate(), ONE_TIME)).resolves.toBeNull();
    });
  });
});
