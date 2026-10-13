/**
 * IbTasks.begin request identity across the idle-thread rollover. A request
 * that rolled over to a new conversation stores the ROLLED-OVER request but is
 * matched by the hash of what the client sent, so a retry (lost response,
 * failed run) recovers its saved task instead of answering request_changed,
 * and keeps the first decision.
 */

const rows = [];
jest.mock('../models/db', () => {
  const fn = (table) => {
    if (table !== 'ib_tasks') throw new Error(`unexpected table ${table}`);
    return {
      insert: (row) => ({
        onConflict: () => ({
          ignore: () => ({
            returning: async () => {
              const dup = rows.find((r) => r.actor_id === row.actor_id && r.session_id === row.session_id && r.request_key === row.request_key);
              if (dup) return [];
              const created = { id: `task-${rows.length + 1}`, ...row, request: JSON.parse(row.request), page_context: JSON.parse(row.page_context) };
              rows.push(created);
              return [created];
            },
          }),
        }),
      }),
      where: (cond) => ({ first: async () => rows.find((r) => Object.entries(cond).every(([k, v]) => r[k] === v)) }),
    };
  };
  fn.fn = { now: jest.fn() };
  return fn;
});

const IbTasks = require('../services/intelligence-bar/tasks');

const SESSION = '5a1c2f7a-aaaa-4bbb-8ccc-deadbeef0001';
const THREAD = '5a1c2f7a-aaaa-4bbb-8ccc-deadbeef0002';
const history = [{ role: 'user', content: 'Synthetic old ask' }, { role: 'assistant', content: 'Synthetic old answer' }];
const original = { prompt: 'Synthetic ask', context: 'customers', pageData: {}, selectedTarget: null, images: [], conversationHistory: history, thread_id: THREAD, thread_seq: 4 };
const rolled = { ...original, conversationHistory: [], thread_id: null, thread_seq: null };
const args = (extra = {}) => ({ actorId: 'admin-1', sessionId: SESSION, requestKey: 'key-0000000001', pageContext: {}, ...extra });

beforeEach(() => { rows.length = 0; });

describe('IbTasks.begin identityRequest', () => {
  test('a new request on an idle thread stores the rolled-over request', async () => {
    const started = await IbTasks.begin(args({ request: rolled, identityRequest: original }));
    expect(started.created).toBe(true);
    expect(started.task.request.thread_id).toBeNull();
    expect(started.task.request.conversationHistory).toEqual([]);
  });

  test('a retry sent after the thread went idle recovers the saved task (no request_changed)', async () => {
    // First attempt ran before the deadline: stored and hashed as sent.
    const first = await IbTasks.begin(args({ request: original }));
    expect(first.created).toBe(true);
    // The retry now rolls over, but is matched by the original request.
    const retry = await IbTasks.begin(args({ request: rolled, identityRequest: original }));
    expect(retry.error).toBeUndefined();
    expect(retry.created).toBe(false);
    expect(retry.task.id).toBe(first.task.id);
    expect(retry.task.request.thread_id).toBe(THREAD);
  });

  test('a retried rolled-over request keeps its first decision, whether or not it rolls over again', async () => {
    const first = await IbTasks.begin(args({ request: rolled, identityRequest: original }));
    const again = await IbTasks.begin(args({ request: rolled, identityRequest: original }));
    const noRollover = await IbTasks.begin(args({ request: original }));
    for (const retry of [again, noRollover]) {
      expect(retry.error).toBeUndefined();
      expect(retry.created).toBe(false);
      expect(retry.task.id).toBe(first.task.id);
      expect(retry.task.request.thread_id).toBeNull();
      expect(retry.task.request.conversationHistory).toEqual([]);
    }
  });

  test('a genuinely different request under the same key is still refused', async () => {
    await IbTasks.begin(args({ request: rolled, identityRequest: original }));
    const changed = await IbTasks.begin(args({ request: { ...rolled, prompt: 'Something else' }, identityRequest: { ...original, prompt: 'Something else' } }));
    expect(changed.code).toBe('request_changed');
  });

  test('without identityRequest the stored request is the identity, as before', async () => {
    await IbTasks.begin(args({ request: original }));
    const changed = await IbTasks.begin(args({ request: rolled }));
    expect(changed.code).toBe('request_changed');
  });
});
