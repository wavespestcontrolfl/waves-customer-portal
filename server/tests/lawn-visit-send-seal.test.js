jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { _test: { sendSeal } } = require('../services/lawn-visit-delivery');

const ASSESSMENT = {
  recommendations: { summary: 'Stored copy' },
  ai_summary: 'Stored summary',
  updated_at: new Date('2026-09-13T12:00:00.000Z'),
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const query = {
    where: jest.fn(() => query),
    first: jest.fn(async () => ASSESSMENT),
  };
  const knex = jest.fn(() => query);
  const KnowledgeBridge = {
    SEND_SEAL_MS: 10_000,
    sealRecommendationsForSend: jest.fn(async () => true),
    renewRecommendationSendSeal: jest.fn(),
    releaseRecommendationSendSeal: jest.fn(async () => true),
  };
  return { knex, KnowledgeBridge };
}

describe('lawn visit recommendation send-seal heartbeat', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-13T12:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  test('timer ticks and pre-send checks share one renewal, retain its start deadline, and release drains the next renewal', async () => {
    const { knex, KnowledgeBridge } = fixture();
    const firstRenewal = deferred();
    const secondRenewal = deferred();
    KnowledgeBridge.renewRecommendationSendSeal
      .mockReturnValueOnce(firstRenewal.promise)
      .mockReturnValueOnce(secondRenewal.promise);
    const seal = sendSeal(KnowledgeBridge, knex, 'assessment-1', 1_000, 'owner-1');
    await expect(seal.ensure()).resolves.toBe(true);

    jest.advanceTimersByTime(1_000);
    const renewalStartedAt = Date.now();
    expect(KnowledgeBridge.renewRecommendationSendSeal).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(3_000);
    const firstCheck = seal.assertHeld();
    const secondCheck = seal.assertHeld();
    expect(KnowledgeBridge.renewRecommendationSendSeal).toHaveBeenCalledTimes(1);

    firstRenewal.resolve(true);
    await expect(firstCheck).resolves.toBe(renewalStartedAt + KnowledgeBridge.SEND_SEAL_MS);
    await expect(secondCheck).resolves.toBe(renewalStartedAt + KnowledgeBridge.SEND_SEAL_MS);

    jest.advanceTimersByTime(1_000);
    expect(KnowledgeBridge.renewRecommendationSendSeal).toHaveBeenCalledTimes(2);
    const releasing = seal.release();
    await Promise.resolve();
    expect(KnowledgeBridge.releaseRecommendationSendSeal).not.toHaveBeenCalled();

    secondRenewal.resolve(true);
    await releasing;
    expect(KnowledgeBridge.releaseRecommendationSendSeal).toHaveBeenCalledTimes(1);
    expect(KnowledgeBridge.releaseRecommendationSendSeal)
      .toHaveBeenCalledWith('assessment-1', 'owner-1');
    jest.advanceTimersByTime(5_000);
    expect(KnowledgeBridge.renewRecommendationSendSeal).toHaveBeenCalledTimes(2);
    await expect(seal.assertHeld()).rejects.toMatchObject({ code: 'LAWN_COPY_SEAL_LOST', retryable: true });
  });

  test('a shared failed renewal fences every pre-send check without trying to revive the seal', async () => {
    const { knex, KnowledgeBridge } = fixture();
    const renewal = deferred();
    KnowledgeBridge.renewRecommendationSendSeal.mockReturnValueOnce(renewal.promise);
    const seal = sendSeal(KnowledgeBridge, knex, 'assessment-2', 1_000, 'owner-2');
    await seal.ensure();

    jest.advanceTimersByTime(1_000);
    const firstCheck = seal.assertHeld();
    const secondCheck = seal.assertHeld();
    expect(KnowledgeBridge.renewRecommendationSendSeal).toHaveBeenCalledTimes(1);
    renewal.resolve(false);

    await expect(firstCheck).rejects.toMatchObject({ code: 'LAWN_COPY_SEAL_LOST', retryable: true });
    await expect(secondCheck).rejects.toMatchObject({ code: 'LAWN_COPY_SEAL_LOST', retryable: true });
    await expect(seal.assertHeld()).rejects.toMatchObject({ code: 'LAWN_COPY_SEAL_LOST', retryable: true });
    expect(KnowledgeBridge.renewRecommendationSendSeal).toHaveBeenCalledTimes(1);
    await seal.release();
  });
});
