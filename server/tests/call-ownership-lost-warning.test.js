// The heartbeat's "ownership LOST" warning must fire only when the claim was lost while the
// pass still owned its work. A normal finish clears processing_token in the pass's own terminal
// write, and the steps after it (commitments, alerts) run with the timer still on: a beat that
// matches no row there is not a lost claim. Pure test of the decision the tick makes.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/twilio-numbers', () => ({
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

const fs = require('fs');
const path = require('path');
const { _test } = require('../services/call-recording-processor');

const { shouldWarnOwnershipLost } = _test;

describe('shouldWarnOwnershipLost', () => {
  test('a beat that matches no row before any terminal write still warns (a peer reclaimed the call)', () => {
    expect(shouldWarnOwnershipLost(0, false)).toBe(true);
  });

  test('a beat after the pass\'s own successful terminal write stays quiet', () => {
    expect(shouldWarnOwnershipLost(0, true)).toBe(false);
  });

  test('a beat that matches a row never warns', () => {
    expect(shouldWarnOwnershipLost(1, false)).toBe(false);
    expect(shouldWarnOwnershipLost(1, true)).toBe(false);
  });
});

// The decision is only as good as the sites that set the flag. Each of this pass's own
// token-clearing writes (tech follow-up, spam/voicemail, hard veto, no transcript, extraction
// failure, main finalization) must raise it; the tick must read it.
describe('claimReleased wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');

  test('the heartbeat tick asks the decision function with the pass-local flag', () => {
    expect(src).toContain('if (shouldWarnOwnershipLost(rows, claimReleased)) {');
  });

  test('every terminal write site raises the flag', () => {
    const sets = src.match(/claimReleased = true/g) || [];
    // deferred, no_transcription, extraction_failed (V1), spam/voicemail, hard veto, main, outer release, tech follow-up callback
    expect(sets.length).toBeGreaterThanOrEqual(8);
  });
});
