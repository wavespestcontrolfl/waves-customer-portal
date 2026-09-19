jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/notification-service', () => ({ markInboundSmsReadAdmin: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const db = require('../models/db');
const { triggerNotification } = require('../services/notification-triggers');
const delivery = require('../services/sms-reply-alert-delivery');
const input = { From: '+12025550101', MessageSid: 'SM-synthetic-delivery', message: 'Synthetic SMS' };
let row, bell, receiptFailure, reads, mutations, priorReceipt, stampFailure, claimHeld;
const afterRead = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  row = { metadata: { sms_reply_eligible: true } };
  bell = null; receiptFailure = null; reads = []; mutations = []; priorReceipt = null; stampFailure = null; claimHeld = false;
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings,
    rows: sql.startsWith('INSERT INTO sms_reply_alert_claims') && !claimHeld ? [{ phone: bindings[0] }] : [] }));
  db.mockImplementation(table => {
    const query = { filter: null, prior: false };
    for (const method of ['whereRaw', 'whereNot', 'where']) {
      query[method] = (...args) => {
        if (method === 'where' && typeof args[0] === 'object') query.filter = args[0];
        if (method === 'whereNot') query.prior = true;
        return query;
      };
    }
    query.first = async () => table === 'notifications' ? bell : table === 'messages'
      ? { is_read: reads.shift() || false } : query.prior ? priorReceipt : row;
    query.update = async patch => {
      mutations.push({ table, filter: query.filter, patch });
      if (patch.metadata) {
        const delta = JSON.parse(patch.metadata.bindings[0]);
        if (delta.sms_reply_alerted && receiptFailure) {
          if (receiptFailure === 'error') throw new Error('Receipt unavailable');
          return 0;
        }
        if ((delta.sms_reply_covered || delta.sms_reply_suppressed) && stampFailure) {
          if (stampFailure === 'error') throw new Error('Marker unavailable');
          return 0;
        }
        row.metadata = { ...row.metadata, ...delta };
      }
      return 1;
    };
    query.del = async () => { mutations.push({ table, filter: query.filter, deleted: true }); return 1; };
    return query;
  });
  triggerNotification.mockResolvedValue({ bellWritten: true, push: { sent: 0 } });
});
const dispatch = (args = {}) => delivery.dispatchUnknownSenderAlert({ ...input, afterRead, ...args });

test.each([
  ['bell', { bellWritten: true, push: null }, true, false],
  ['push only', { bellWritten: false, push: { sent: 1 } }, true, false],
  ['failed', { bellWritten: false, push: null }, false, false],
  ['production suppression', { bellWritten: false, push: null, suppressed: true }, false, true],
  ['policy suppression', { bellWritten: false, push: { sent: 0 }, policySilenced: true }, false, true],
])('%s confirms only actual delivery and records terminal suppression', async (_name, stats, confirmed, suppressed) => {
  triggerNotification.mockResolvedValueOnce(stats);
  await dispatch();
  expect(mutations.some(m => m.table === 'sms_reply_alert_claims' && m.patch)).toBe(confirmed);
  expect(row.metadata.sms_reply_alerted === true).toBe(confirmed);
  expect(row.metadata.sms_reply_suppressed === true).toBe(suppressed);
  if (suppressed) {
    await dispatch({ recovery: true });
    expect(triggerNotification).toHaveBeenCalledTimes(1);
  }
});

test.each(['error', 'missing row'])('committed delivery survives %s receipt loss without replay', async failure => {
  receiptFailure = failure;
  triggerNotification.mockImplementationOnce(async (_key, _payload, options) => {
    expect(options.dedupeKey).toBe(`sms-reply:${input.MessageSid}`);
    bell = { id: 'committed-bell', created_at: new Date() };
    return { bellWritten: true, push: { sent: 1 } };
  });
  await dispatch();
  expect(mutations.some(m => m.table === 'sms_reply_alert_claims' && m.patch)).toBe(false);
  receiptFailure = null;
  await dispatch({ recovery: true });
  expect(triggerNotification).toHaveBeenCalledTimes(1);
  expect(row.metadata.sms_reply_alerted).toBe(true);
  expect(mutations.some(m => m.table === 'sms_reply_alert_claims' && m.patch)).toBe(true);
});

test('old committed evidence repairs its original timestamp instead of restarting coverage', async () => {
  const created_at = new Date(Date.now() - 6 * 60 * 60 * 1000);
  bell = { id: 'retargeted-read-bell', created_at };
  await dispatch({ recovery: true });
  expect(triggerNotification).not.toHaveBeenCalled();
  expect(mutations.find(m => m.patch?.updated_at).patch.updated_at).toEqual(created_at);
  expect(mutations.find(m => m.table === 'sms_reply_alert_claims' && m.patch).patch.expires_at)
    .toEqual(new Date(created_at.getTime() + 4 * 60 * 60 * 1000));
});

test.each(['sms_reply_alerted', 'sms_reply_covered', 'sms_reply_suppressed', 'sms_reply_ai_answered'])('recovery rechecks terminal %s under its lease', async marker => {
  row.metadata[marker] = true;
  expect(await dispatch({ recovery: true })).toBe(false);
  expect(triggerNotification).not.toHaveBeenCalled();
});
test('a message covered by a recent receipt is stamped terminal before its claim is released', async () => {
  priorReceipt = { id: 'prior-delivered-receipt' };
  expect(await dispatch()).toBe(true);
  expect(triggerNotification).not.toHaveBeenCalled();
  expect(row.metadata.sms_reply_covered).toBe(true);
  expect(row.metadata.sms_reply_alerted).toBeUndefined();
  const stampIndex = mutations.findIndex(m => m.table === 'sms_log' && m.patch && JSON.parse(m.patch.metadata.bindings[0]).sms_reply_covered);
  const releaseIndex = mutations.findIndex(m => m.table === 'sms_reply_alert_claims' && m.deleted);
  expect(stampIndex).toBeGreaterThanOrEqual(0);
  expect(releaseIndex).toBeGreaterThan(stampIndex);
  // Once the covering receipt ages out, recovery still treats this message as settled.
  priorReceipt = null;
  expect(await dispatch({ recovery: true })).toBe(false);
  expect(triggerNotification).not.toHaveBeenCalled();
});
const stamps = key => mutations.filter(m => m.table === 'sms_log' && m.patch && JSON.parse(m.patch.metadata.bindings[0])[key]);
test.each([['error', 2], ['missing row', 1]])('unrecorded coverage (%s) is not reported handled and keeps recovery able to retry', async (failure, attempts) => {
  priorReceipt = { id: 'prior-delivered-receipt' };
  stampFailure = failure;
  expect(await dispatch()).toBe(false);
  expect(triggerNotification).not.toHaveBeenCalled();
  expect(stamps('sms_reply_covered')).toHaveLength(attempts);
  expect(row.metadata.sms_reply_covered).toBeUndefined();
  expect(mutations.some(m => m.table === 'sms_reply_alert_claims' && m.deleted)).toBe(true);
});
test('losing the claim to a confirmed receipt stamps coverage and reports handled', async () => {
  claimHeld = true;
  priorReceipt = { id: 'prior-delivered-receipt' };
  expect(await dispatch()).toBe(true);
  expect(triggerNotification).not.toHaveBeenCalled();
  expect(row.metadata.sms_reply_covered).toBe(true);
  expect(mutations.some(m => m.table === 'sms_reply_alert_claims')).toBe(false);
  priorReceipt = null; claimHeld = false;
  expect(await dispatch({ recovery: true })).toBe(false);
  expect(triggerNotification).not.toHaveBeenCalled();
});
test('losing the claim to an in-progress lease leaves the message eligible for recovery', async () => {
  claimHeld = true;
  expect(await dispatch()).toBe(true);
  expect(triggerNotification).not.toHaveBeenCalled();
  expect(row.metadata).toEqual({ sms_reply_eligible: true });
  claimHeld = false;
  expect(await dispatch({ recovery: true })).toBe(true);
  expect(triggerNotification).toHaveBeenCalledTimes(1);
});
test('suppression is terminal only once its marker is recorded', async () => {
  triggerNotification.mockResolvedValueOnce({ bellWritten: false, push: null, suppressed: true });
  stampFailure = 'error';
  expect(await dispatch()).toBe(false);
  expect(stamps('sms_reply_suppressed')).toHaveLength(2);
  expect(row.metadata.sms_reply_suppressed).toBeUndefined();
  expect(mutations.some(m => m.table === 'sms_reply_alert_claims' && m.deleted)).toBe(true);
});
test('recovery waits for live AI work', async () => {
  row.metadata.sms_reply_processing_until = new Date(Date.now() + 60000).toISOString();
  expect(await dispatch({ recovery: true })).toBe(false);
  expect(triggerNotification).not.toHaveBeenCalled();
});
test('a read before delivery sends nothing; a read during delivery invokes reconciliation', async () => {
  reads = [true];
  expect(await dispatch()).toBe(true);
  expect(triggerNotification).not.toHaveBeenCalled();
  reads = [false, true];
  await dispatch();
  expect(afterRead).toHaveBeenCalledWith({ From: input.From, MessageSid: input.MessageSid });
});
test('unknown delivery requires the consumer read-reconciliation hook', async () => {
  await expect(delivery.ringSmsReplyBell({ ...input, customer: null })).rejects.toThrow('requires read reconciliation');
  expect(triggerNotification).not.toHaveBeenCalled();
});
test('failed claims have no ownership token; stale owners mutate only their own lease', async () => {
  db.raw.mockImplementationOnce(() => { throw new Error('Claim unavailable'); });
  const claim = await delivery.claimUnknownSenderAlertWindow(input.From);
  expect(claim).toEqual({ claimed: true, token: null });
  await delivery.confirmUnknownSenderAlertWindow(input.From, null);
  await delivery.releaseUnknownSenderAlertClaim(input.From, null);
  expect(mutations).toHaveLength(0);
  const token = new Date();
  await delivery.confirmUnknownSenderAlertWindow(input.From, token);
  await delivery.releaseUnknownSenderAlertClaim(input.From, token);
  expect(mutations.map(m => m.filter)).toEqual([{ phone: input.From, expires_at: token }, { phone: input.From, expires_at: token }]);
});
