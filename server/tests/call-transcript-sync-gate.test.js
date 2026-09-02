/**
 * GATE_CALL_TRANSCRIPT_SYNC — the admin call log's audio-synced transcript.
 * Read at CALL time (a flip needs no redeploy) and reported to the client as
 * `transcript_sync_enabled` on GET /api/ai/admin/calls. Off unless set.
 */

const fs = require('fs');

describe('GATE_CALL_TRANSCRIPT_SYNC', () => {
  const original = process.env.GATE_CALL_TRANSCRIPT_SYNC;
  afterEach(() => {
    if (original === undefined) delete process.env.GATE_CALL_TRANSCRIPT_SYNC;
    else process.env.GATE_CALL_TRANSCRIPT_SYNC = original;
  });

  test('is registered in the gate listing and off unless set', () => {
    delete process.env.GATE_CALL_TRANSCRIPT_SYNC;
    const { gateEnvValue } = require('../config/feature-gates');
    expect(gateEnvValue('GATE_CALL_TRANSCRIPT_SYNC')).toBe(false);
    for (const v of ['1', 'true', 'ON']) {
      process.env.GATE_CALL_TRANSCRIPT_SYNC = v;
      expect(gateEnvValue('GATE_CALL_TRANSCRIPT_SYNC')).toBe(true);
    }
    process.env.GATE_CALL_TRANSCRIPT_SYNC = 'yes';
    expect(gateEnvValue('GATE_CALL_TRANSCRIPT_SYNC')).toBe(false);
    const src = fs.readFileSync(require.resolve('../config/feature-gates'), 'utf8');
    expect(src).toMatch(/callTranscriptSync: gateEnvValue\('GATE_CALL_TRANSCRIPT_SYNC'\)/);
  });

  test('the calls endpoint reads the gate at call time, not at module load', () => {
    const src = fs.readFileSync(require.resolve('../routes/ai-assistant'), 'utf8');
    expect(src).toMatch(/transcript_sync_enabled: gateEnvValue\('GATE_CALL_TRANSCRIPT_SYNC'\)/);
  });
});
