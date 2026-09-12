// #4292 — send seals protect the exact copy being dispatched. The report queue
// and lawn recovery can overlap on one assessment, so acquisition, renewal, and
// release must all be fenced by the same nonempty owner token.
let mockStored;
let mockUpdated;

jest.mock('../models/db', () => {
  const makeQuery = () => {
    const query = {
      where: jest.fn(() => query),
      first: jest.fn(async () => ({
        recommendations: JSON.stringify(mockStored),
        ai_summary: 'fixture summary',
        updated_at: '2026-09-12T12:00:00.000Z',
      })),
      update: jest.fn(async (fields) => {
        mockUpdated = fields;
        mockStored = JSON.parse(fields.recommendations);
        return 1;
      }),
    };
    return query;
  };
  const trx = jest.fn(() => makeQuery());
  trx.raw = jest.fn(async () => ({}));
  const db = jest.fn(() => makeQuery());
  db.transaction = jest.fn(async (work) => work(trx));
  db.__trx = trx;
  return db;
});

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const db = require('../models/db');
const {
  sealRecommendationsForSend,
  renewRecommendationSendSeal,
  releaseRecommendationSendSeal,
} = require('../services/knowledge-bridge');

const ASSESSMENT_ID = 'assessment-4292';
const OWNER_A = 'report-delivery:attempt-a';
const OWNER_B = 'lawn-recovery:attempt-b';
const versionOf = () => 'fixture-version';
const future = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

describe('knowledge bridge send-seal ownership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStored = { summary: 'settled copy' };
    mockUpdated = null;
  });

  test.each([undefined, null, ''])('a new seal requires a nonempty owner (%p)', async (owner) => {
    await expect(sealRecommendationsForSend(
      ASSESSMENT_ID, 'fixture-version', versionOf, owner,
    )).resolves.toBe(false);

    expect(mockUpdated).toBeNull();
    expect(mockStored).toEqual({ summary: 'settled copy' });
  });

  test('a second owner cannot steal, renew, or release an active seal', async () => {
    await expect(sealRecommendationsForSend(
      ASSESSMENT_ID, 'fixture-version', versionOf, OWNER_A,
    )).resolves.toBe(true);
    const firstExpiry = mockStored._sendSealUntil;

    await expect(sealRecommendationsForSend(
      ASSESSMENT_ID, 'fixture-version', versionOf, OWNER_B,
    )).resolves.toBe(false);
    await expect(renewRecommendationSendSeal(ASSESSMENT_ID, OWNER_B)).resolves.toBe(false);
    await expect(releaseRecommendationSendSeal(ASSESSMENT_ID, OWNER_B)).resolves.toBe(false);

    expect(mockStored).toMatchObject({
      summary: 'settled copy',
      _sendSealOwner: OWNER_A,
      _sendSealUntil: firstExpiry,
    });
  });

  test('an active legacy unowned seal cannot be claimed or cleared', async () => {
    mockStored = { summary: 'settled copy', _sendSealUntil: future() };
    const original = { ...mockStored };

    await expect(sealRecommendationsForSend(
      ASSESSMENT_ID, 'fixture-version', versionOf, OWNER_A,
    )).resolves.toBe(false);
    await expect(renewRecommendationSendSeal(ASSESSMENT_ID, OWNER_A)).resolves.toBe(false);
    await expect(releaseRecommendationSendSeal(ASSESSMENT_ID, OWNER_A)).resolves.toBe(false);

    expect(mockStored).toEqual(original);
    expect(mockUpdated).toBeNull();
  });

  test('even its former owner cannot renew an expired seal', async () => {
    mockStored = {
      summary: 'settled copy',
      _sendSealOwner: OWNER_A,
      _sendSealUntil: past(),
    };
    const original = { ...mockStored };

    await expect(renewRecommendationSendSeal(ASSESSMENT_ID, OWNER_A)).resolves.toBe(false);

    expect(mockStored).toEqual(original);
    expect(mockUpdated).toBeNull();
  });

  test('a new owner may take over an expired seal', async () => {
    mockStored = {
      summary: 'settled copy',
      _sendSealOwner: OWNER_A,
      _sendSealUntil: past(),
    };

    await expect(sealRecommendationsForSend(
      ASSESSMENT_ID, 'fixture-version', versionOf, OWNER_B,
    )).resolves.toBe(true);

    expect(mockStored).toMatchObject({
      summary: 'settled copy',
      _sendSealOwner: OWNER_B,
    });
    expect(Date.parse(mockStored._sendSealUntil)).toBeGreaterThan(Date.now());
  });

  test('renew and release require the current owner', async () => {
    mockStored = {
      summary: 'settled copy',
      _sendSealOwner: OWNER_A,
      _sendSealUntil: future(),
    };

    await expect(renewRecommendationSendSeal(ASSESSMENT_ID)).resolves.toBe(false);
    await expect(releaseRecommendationSendSeal(ASSESSMENT_ID)).resolves.toBe(false);
    expect(mockUpdated).toBeNull();

    await expect(renewRecommendationSendSeal(ASSESSMENT_ID, OWNER_A)).resolves.toBe(true);
    await expect(releaseRecommendationSendSeal(ASSESSMENT_ID, OWNER_A)).resolves.toBe(true);
    expect(mockStored).toEqual({ summary: 'settled copy' });
  });

  test('each mutation takes the advisory lock inside a transaction', async () => {
    await sealRecommendationsForSend(ASSESSMENT_ID, 'fixture-version', versionOf, OWNER_A);
    await renewRecommendationSendSeal(ASSESSMENT_ID, OWNER_A);
    await releaseRecommendationSendSeal(ASSESSMENT_ID, OWNER_A);

    expect(db.transaction).toHaveBeenCalledTimes(3);
    expect(db.__trx.raw).toHaveBeenCalledTimes(3);
    expect(db.__trx.raw).toHaveBeenNthCalledWith(
      1, 'SELECT pg_advisory_xact_lock(hashtext(?))', [`lawn_rec_${ASSESSMENT_ID}`],
    );
  });
});
