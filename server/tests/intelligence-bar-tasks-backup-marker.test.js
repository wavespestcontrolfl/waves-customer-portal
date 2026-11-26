/**
 * A saved task marked `model_provider: 'openai_backup'` (written by the retired OpenAI backup; none is saved in
 * production) is never continued: its history is not sent to Anthropic half-way through. An unmarked task is unaffected.
 */
jest.mock('../models/db', () => Object.assign(jest.fn(), { raw: jest.fn(), fn: { now: jest.fn() } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const IbTasks = require('../services/intelligence-bar/tasks');

const task = (request) => ({ id: 't', state: 'failed', request, checkpoint: [], lease_expires_at: new Date(0) });

test('a task marked by the retired OpenAI backup is refused as not resumable', () => {
  expect(IbTasks.continuationError(task({ model_provider: 'openai_backup' }), [])).toMatchObject({ code: 'not_resumable' });
});

test('an unmarked task is unaffected', () => {
  expect(IbTasks.continuationError(task({}), [])).toBeNull();
});
