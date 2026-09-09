import { expect, it } from 'vitest';
import { retainTaskReceipt } from './ibTaskReceipts';

const action = { id: 'a1', tool: 'send_sms', summary: 'Text the customer', contract: { action_label: 'Send SMS' } };
const task = { taskId: 't1', taskState: 'awaiting_approval', pendingActions: [action], receipts: [] };

it('a cancel response settles the action as canceled', () => {
  const next = retainTaskReceipt(task, action, 'cancel', { cancelled: true });
  expect(next.pendingActions).toEqual([]);
  expect(next.receipts).toEqual([expect.objectContaining({ id: 'a1', outcome: 'canceled', tool: 'send_sms' })]);
});

it('a reconciled receipt after a dropped cancel response is also settled, not discarded', () => {
  const next = retainTaskReceipt(task, action, 'cancel', { id: 'a1', outcome: 'canceled' });
  expect(next.pendingActions).toEqual([]);
  expect(next.receipts).toEqual([expect.objectContaining({ id: 'a1', outcome: 'canceled' })]);
});

it('an unsettled cancel keeps the pending action', () => {
  expect(retainTaskReceipt(task, action, 'cancel', { cancelled: false })).toBe(task);
  expect(retainTaskReceipt(task, action, 'cancel', { id: 'a1', outcome: 'awaiting_approval' })).toBe(task);
});
