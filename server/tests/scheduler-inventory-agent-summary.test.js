// Codex round-3 review (PR #5036, item 4): a run where every line is still
// retrying (e.g. every line hit a transient LLM failure and only bumped its
// attempt count) used to log nothing at all, since the cron's own log
// condition never checked `stillPending`. shouldLogInventoryAgentSummary is
// the exact predicate the cron now gates its log line on.
jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  gateEnvValue: jest.fn(() => true),
  logGateStatus: jest.fn(),
}));

const { shouldLogInventoryAgentSummary } = require('../services/scheduler');

describe('shouldLogInventoryAgentSummary (review item 4)', () => {
  test('a run where every line is still pending/retrying is worth logging', () => {
    expect(shouldLogInventoryAgentSummary({ logged: 0, held: 0, ignored: 0, stillPending: 3, errors: 0 })).toBe(true);
  });

  test('a run with something logged, held, ignored, or errored is worth logging', () => {
    expect(shouldLogInventoryAgentSummary({ logged: 1, held: 0, ignored: 0, stillPending: 0, errors: 0 })).toBe(true);
    expect(shouldLogInventoryAgentSummary({ logged: 0, held: 1, ignored: 0, stillPending: 0, errors: 0 })).toBe(true);
    expect(shouldLogInventoryAgentSummary({ logged: 0, held: 0, ignored: 1, stillPending: 0, errors: 0 })).toBe(true);
    expect(shouldLogInventoryAgentSummary({ logged: 0, held: 0, ignored: 0, stillPending: 0, errors: 1 })).toBe(true);
  });

  test('a truly empty run (nothing in any bucket) is not worth logging', () => {
    expect(shouldLogInventoryAgentSummary({ logged: 0, held: 0, ignored: 0, stillPending: 0, errors: 0 })).toBe(false);
  });
});
