// call_log.processed_at (migration 20261010250000) is the one plain column
// that says WHEN the current terminal verdict landed; updated_at moves on
// every later write. The 2026-10-09 audit could read latency only as an
// upper bound. This static guard keeps every terminal-verdict write stamping
// it, so a new or moved terminal write cannot silently drop the stamp. Retry
// lanes (no_transcription, extraction_failed) deliberately do not stamp.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8').split('\n');

const TERMINAL_WRITES = [
  "processing_status: 'processed',",                                 // tech follow-up finalization
  "processing_status: extracted.is_spam ? 'spam' : 'voicemail',",    // spam / non-workable voicemail
  "processing_status: extracted.is_spam ? 'spam' : 'processed',",    // definitive rejection / veto verdict
  'processing_status: finalStatus,',                                 // main finalization
  "processing_status: 'voicemail',",                                 // rejected implausible transcription (transcriptRejectionUpdate)
];

describe('every terminal-verdict write stamps processed_at', () => {
  test.each(TERMINAL_WRITES)('%s', (marker) => {
    const hits = src.map((l, i) => (l.trim() === marker ? i : -1)).filter((i) => i >= 0);
    expect(hits.length).toBeGreaterThan(0);
    for (const i of hits) {
      const window = src.slice(i, i + 6).join('\n');
      expect(window).toMatch(/processed_at: new Date\(\)/);
    }
  });

  test('both claim writes clear the previous verdict time', () => {
    // A claim on a settled row (admin Reprocess) must not carry the old
    // stamp into a pass that ends in no_transcription / extraction_failed.
    const hits = src.map((l, i) => (l.trim() === 'processing_heartbeat_at: new Date(),' ? i : -1)).filter((i) => i >= 0);
    expect(hits).toHaveLength(2);
    for (const i of hits) expect(src.slice(i, i + 8).join('\n')).toMatch(/processed_at: null,/);
  });

  test('retry-lane statuses do not stamp', () => {
    for (const status of ['no_transcription', 'extraction_failed']) {
      src.forEach((l, i) => {
        if (l.includes(`processing_status: '${status}'`)) {
          expect(src.slice(i, i + 6).join('\n')).not.toMatch(/processed_at/);
        }
      });
    }
  });
});

describe('migration 20261010250000', () => {
  const m = require('../models/migrations/20261010250000_call_log_processed_at');
  const fakeKnex = (hasColumn) => {
    const calls = [];
    return {
      calls,
      schema: {
        hasTable: async () => true,
        hasColumn: async () => hasColumn,
        alterTable: async (table, fn) => {
          fn({ timestamp: (name, opts) => calls.push(['add', table, name, opts]), dropColumn: (name) => calls.push(['drop', table, name]) });
        },
      },
    };
  };
  test('up adds a timestamptz column once; down drops it', async () => {
    const k = fakeKnex(false);
    await m.up(k);
    expect(k.calls).toEqual([['add', 'call_log', 'processed_at', { useTz: true }]]);
    const again = fakeKnex(true);
    await m.up(again);
    expect(again.calls).toEqual([]);
    await m.down(again);
    expect(again.calls).toEqual([['drop', 'call_log', 'processed_at']]);
  });
});
