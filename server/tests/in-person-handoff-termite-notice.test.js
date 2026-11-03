/**
 * Book at the Table hand-off (GATE_IN_PERSON_CARD): the Florida consumer notice
 * for a TERMITE estimate. The cancel-anytime acceptance terms exclude termite/WDO
 * estimates (acceptanceTermsApplyTo), but those are exactly the estimates that need
 * the separate-signature notice, so the notice must ride the GET's handoff block on
 * its own. This file uses the REAL acceptanceTermsApplyTo and the REAL consumer-notice
 * service with real estimate_data shapes; only the database is faked.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.GATE_IN_PERSON_CARD = 'true';
process.env.GATE_ESTIMATE_ACCEPTANCE_TERMS = 'true';
process.env.GATE_ESTIMATE_CONSUMER_NOTICE = 'true';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/consumer-notices', () => ({
  ...jest.requireActual('../services/consumer-notices'),
  findConsumerNotice: jest.fn(async () => null),
}));

const db = require('../models/db');
const { findConsumerNotice } = require('../services/consumer-notices');
const { acceptanceTermsApplyTo } = require('../routes/estimate-public');
const { HANDOFF_NOTICE_TEXT } = require('../services/estimate-consumer-notice');
const { buildTermsPayload, markTermsRequired } = require('../services/in-person-handoff');

const TOKEN = 'a'.repeat(22);
const estimate = (recurring = [], oneTime = []) => ({
  id: 'est-1', customer_id: 'cust-1', status: 'accepted', terms_version: null, estimate_slug: 'EST-2026-0002',
  estimate_data: { result: { recurring: { services: recurring }, oneTime: { items: oneTime } } },
});
const TERMITE = estimate([{ service: 'termite_bait', name: 'Termite Bait Stations' }]);
const PEST = estimate([{ service: 'pest_control', name: 'Pest Control' }]);

let est;
beforeEach(() => {
  jest.clearAllMocks();
  findConsumerNotice.mockResolvedValue(null);
  db.mockImplementation((table) => {
    const rows = {
      appointment_card_requests: { kind: 'visit', scheduled_service_id: 'visit-1', in_person_terms_required: true },
      scheduled_services: { id: 'visit-1', source_estimate_id: 'est-1', recurring_parent_id: null },
      estimates: est,
    };
    const q = {};
    q.where = () => q;
    q.whereIn = () => q;
    q.whereNull = () => q;
    q.first = async () => rows[table];
    q.update = async () => 1;
    return q;
  });
});

const block = () => buildTermsPayload({ token: TOKEN, data: { state: 'ready' } });

describe('termite estimate notice in the hand-off block', () => {
  test('the real acceptance terms exclude the termite estimate (the exclusion is not relayed)', () => {
    expect(acceptanceTermsApplyTo(TERMITE)).toBe(false);
    expect(acceptanceTermsApplyTo(PEST)).toBe(true);
  });

  test('a termite estimate with no signed notice gets the notice and no acceptance terms', async () => {
    est = TERMITE;
    expect(await block()).toEqual({ consumerNotice: { text: HANDOFF_NOTICE_TEXT } });
  });

  test('a signed notice on file, or the notice gate off, adds nothing', async () => {
    est = TERMITE;
    findConsumerNotice.mockResolvedValue({ id: 'signed-1' });
    expect(await block()).toBeNull();
    findConsumerNotice.mockResolvedValue(null);
    process.env.GATE_ESTIMATE_CONSUMER_NOTICE = 'false';
    expect(await block()).toBeNull();
    process.env.GATE_ESTIMATE_CONSUMER_NOTICE = 'true';
  });

  test('a non-termite estimate gets terms and no notice', async () => {
    est = PEST;
    const result = await block();
    expect(result.terms.estimateRef).toBe('EST-2026-0002');
    expect(result.consumerNotice).toBeUndefined();
  });

  test('the in-person route marks the termite request, so the page gets the notice', async () => {
    est = TERMITE;
    expect(await markTermsRequired('visit-1')).toEqual({ marked: true });
  });

  test('an estimate staff have not accepted gets no notice', async () => {
    est = { ...TERMITE, status: 'sent' };
    expect(await block()).toBeNull();
  });
});
