/**
 * setIntentMode — the ladder is climbed one rung at a time (Codex r2 on #5531).
 *
 * Judge-graded readiness evidence accrues while an intent is still in shadow,
 * and evaluateAutoSendEligibility evaluates the suggest → auto_send rung
 * without reading the stored mode. The flip path is therefore the place the
 * ladder is enforced: auto_send is written only over a stored suggest mode.
 * Pure-logic coverage with an injected capturing fake; no DB.
 */
const { setIntentMode, autoSendRequiresSuggest, AUTO_SEND_MODE } = require('../services/sms-suggest-mode');
const { GRATITUDE_INTENT } = require('../services/sms-gratitude');

function fakeDb({ updateRows = [], upsertRows = [] } = {}) {
  const calls = [];
  const b = {};
  const record = (name) => (...args) => { calls.push([name, args]); return b; };
  for (const m of ['where', 'update', 'insert', 'onConflict', 'merge']) b[m] = record(m);
  b.returning = (...args) => {
    calls.push(['returning', args]);
    const updating = calls.some(([m]) => m === 'update');
    return Promise.resolve(updating ? updateRows : upsertRows);
  };
  const dbi = () => b;
  dbi.calls = calls;
  dbi.names = () => calls.map(([m]) => m);
  return dbi;
}

const INTENT = 'general_customer_sms_needs_review';

describe('autoSendRequiresSuggest', () => {
  test('every ordinary intent must pass through suggest; the fixed-copy gratitude lane is the one exception', () => {
    expect(autoSendRequiresSuggest(INTENT)).toBe(true);
    expect(autoSendRequiresSuggest('billing_question_needs_review')).toBe(true);
    expect(autoSendRequiresSuggest(GRATITUDE_INTENT)).toBe(false);
  });
});

describe('setIntentMode — auto_send is written only over a stored suggest mode', () => {
  test('from suggest: a conditional update lands on the suggest row and returns it', async () => {
    const dbi = fakeDb({ updateRows: [{ intent: INTENT, mode: AUTO_SEND_MODE }] });
    const row = await setIntentMode({ intent: INTENT, mode: AUTO_SEND_MODE, actor: 'owner', reason: 'earned', dbi });
    expect(row).toEqual({ intent: INTENT, mode: AUTO_SEND_MODE });
    expect(dbi.calls[0]).toEqual(['where', [{ intent: INTENT, mode: 'suggest' }]]);
    expect(dbi.names()).toContain('update');
    expect(dbi.names()).not.toContain('insert');
    const [, [patch]] = dbi.calls.find(([m]) => m === 'update');
    expect(patch).toMatchObject({ mode: AUTO_SEND_MODE, updated_by: 'owner', reason: 'earned' });
  });

  test('from shadow (or with no row at all): refused with 409 and nothing is written', async () => {
    const dbi = fakeDb({ updateRows: [] }); // the conditional update touched nothing
    await expect(setIntentMode({ intent: INTENT, mode: AUTO_SEND_MODE, dbi }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/earned from suggest/) });
    expect(dbi.names()).not.toContain('insert');
  });

  test('the fixed-copy gratitude lane qualifies from shadow: upsert path, no ladder read', async () => {
    const dbi = fakeDb({ upsertRows: [{ intent: GRATITUDE_INTENT, mode: AUTO_SEND_MODE }] });
    const row = await setIntentMode({ intent: GRATITUDE_INTENT, mode: AUTO_SEND_MODE, dbi });
    expect(row.mode).toBe(AUTO_SEND_MODE);
    expect(dbi.names()).toEqual(['insert', 'onConflict', 'merge', 'returning']);
  });

  test('suggest and shadow flips keep the upsert path', async () => {
    for (const mode of ['suggest', 'shadow']) {
      const dbi = fakeDb({ upsertRows: [{ intent: INTENT, mode }] });
      const row = await setIntentMode({ intent: INTENT, mode, dbi });
      expect(row.mode).toBe(mode);
      expect(dbi.names()).toEqual(['insert', 'onConflict', 'merge', 'returning']);
    }
  });

  test('validation still runs first: an escalation intent never reaches the ladder or the DB', async () => {
    const dbi = fakeDb();
    await expect(setIntentMode({ intent: 'customer_issue_needs_review', mode: AUTO_SEND_MODE, dbi }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(dbi.calls).toEqual([]);
  });
});
