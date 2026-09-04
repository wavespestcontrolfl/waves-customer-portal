'use strict';
// GET /admin/dispatch/:serviceId/card-hold — the merged two-rail preview
// (mergeCardHoldPreviews). The rails' gates are independent, so which rail
// answers is a correctness question, not a formatting one.
jest.mock('../services/estimate-card-holds', () => ({}));
jest.mock('../services/appointment-card-request', () => ({}));
const { mergeCardHoldPreviews } = require('../routes/admin-dispatch');

const rule = (code, willCharge) => ({ code, willCharge, text: `${code} copy` });
const held = (code = 'in_window') => ({ held: true, feeApplies: true, feeAmount: 49, rule: rule(code, true) });
const askAppt = (preview) => jest.fn(async () => preview);

describe('mergeCardHoldPreviews', () => {
  test('a HELD hold with a determinate verdict answers outright — the appointment rail is never asked', async () => {
    const ask = askAppt({ secured: true, feeApplies: true, rule: rule('charge_in_flight', null) });
    await expect(mergeCardHoldPreviews(held(), ask)).resolves.toEqual(held());
    expect(ask).not.toHaveBeenCalled();
  });
  test('an UNRESOLVED hold verdict yields to a stronger appointment verdict (fee event / undetermined)…', async () => {
    const hold = { held: true, feeApplies: true, feeAmount: null, unresolved: true, rule: rule('unresolved', null) };
    const appt = { secured: true, feeApplies: true, feeAmount: 49, unresolved: true, rule: rule('charge_in_flight', null) };
    await expect(mergeCardHoldPreviews(hold, askAppt(appt))).resolves.toEqual({ held: true, feeApplies: true, feeAmount: 49, unresolved: true, rule: appt.rule });
    const inWindow = { secured: true, feeApplies: true, feeAmount: 49, rule: rule('in_window', true) };
    await expect(mergeCardHoldPreviews(hold, askAppt(inWindow))).resolves.toMatchObject({ rule: inWindow.rule });
  });
  test('…but never to a "nothing will be charged" appointment verdict (pre-push P1s on r7)', async () => {
    const hold = { held: true, feeApplies: true, feeAmount: null, unresolved: true, rule: rule('unresolved', null) };
    for (const code of ['no_card', 'rail_dark', 'card_hold_lane', 'not_secured', 'outside_window']) {
      const appt = { secured: code === 'outside_window', feeApplies: false, rule: rule(code, false) };
      await expect(mergeCardHoldPreviews(hold, askAppt(appt))).resolves.toBe(hold);
    }
  });
  test('a CLOSED hold (fee_settled) survives appointment-rail silence — no row, hold lane, or DARK (Codex #3800 r7 P1)', async () => {
    const closed = { held: false, feeApplies: false, rule: rule('fee_settled', false) };
    for (const code of ['no_card', 'card_hold_lane', 'rail_dark']) {
      await expect(mergeCardHoldPreviews(closed, askAppt({ secured: false, feeApplies: false, rule: rule(code, false) }))).resolves.toBe(closed);
    }
  });
  test('a CLOSED hold does NOT short-circuit an appointment rail with evidence of its own', async () => {
    const closed = { held: false, feeApplies: false, rule: rule('fee_settled', false) };
    const appt = { secured: true, feeApplies: true, feeAmount: 49, unresolved: true, rule: rule('charge_in_flight', null) };
    await expect(mergeCardHoldPreviews(closed, askAppt(appt))).resolves.toEqual({ held: true, feeApplies: true, feeAmount: 49, unresolved: true, rule: appt.rule });
  });
  test('no hold at all → the appointment rail answers in the shared shape', async () => {
    const none = { held: false, feeApplies: false, rule: rule('no_card', false) };
    const appt = { secured: false, feeApplies: false, rule: rule('not_secured', false) };
    await expect(mergeCardHoldPreviews(none, askAppt(appt))).resolves.toEqual({ held: false, feeApplies: false, rule: appt.rule });
  });
});
