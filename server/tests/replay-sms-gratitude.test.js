'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  inferPreviewFirstName,
  normalizeRows,
  parseJsonLines,
  replayRows,
  run,
} = require('../scripts/replay-sms-gratitude');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'replay-sms-gratitude.js');
const CUSTOMER = '+15550000001';
const WAVES_LINE = '+15550000002';
const OTHER_CUSTOMER = '+15550000003';

function exportRow({
  id,
  at,
  direction,
  from = direction === 'inbound' ? CUSTOMER : WAVES_LINE,
  to = direction === 'inbound' ? WAVES_LINE : CUSTOMER,
  body,
  status = direction === 'inbound' ? 'received' : 'delivered',
  numMedia = 0,
}) {
  return { id, at, direction, from, to, body, status, numMedia };
}

function normalized(rawRows) {
  return normalizeRows(rawRows.map((value, index) => ({ value, lineNumber: index + 1 })));
}

describe('offline gratitude replay', () => {
  test.each(['failed', 'undelivered', null])('a %s outbound cannot establish closure', status => {
    const report = replayRows(normalized([
      exportRow({ id: 'SM-report', at: '2026-09-01T14:00:00Z', direction: 'outbound-api',
        body: 'Your report: https://portal.invalid/report', status }),
      exportRow({ id: 'SM-thanks', at: '2026-09-01T14:01:00Z', direction: 'inbound', body: 'Thank you!' }),
    ]));
    expect(report.candidates).toEqual([]);
    expect(report.exclusions[0].reason).toBe('no_recent_outbound');
  });

  test('normalizes both Twilio outbound directions and groups only the same endpoint pair', () => {
    const rows = normalized([
      exportRow({
        id: 'SM-1', at: 'Tue, 01 Sep 2026 14:00:00 +0000', direction: 'outbound-api',
        body: 'Your service is complete.',
      }),
      exportRow({
        id: 'SM-2', at: 'Tue, 01 Sep 2026 14:01:00 +0000', direction: 'outbound-reply',
        body: 'Your report: https://portal.invalid/report',
      }),
      exportRow({
        id: 'SM-3', at: 'Tue, 01 Sep 2026 14:02:00 +0000', direction: 'inbound', body: 'Thank you!',
      }),
      exportRow({
        id: 'SM-4', at: 'Tue, 01 Sep 2026 14:03:00 +0000', direction: 'inbound',
        from: OTHER_CUSTOMER, to: WAVES_LINE, body: 'Can you call me?',
      }),
    ]);

    expect(rows.map((row) => row.direction)).toEqual(['outbound', 'outbound', 'inbound', 'inbound']);
    expect(rows[0].threadKey).toBe(rows[2].threadKey);
    expect(rows[3].threadKey).not.toBe(rows[2].threadKey);

    const report = replayRows(rows);
    expect(report.stats).toMatchObject({
      totalRows: 4,
      inboundRows: 2,
      evaluatedInboundRows: 2,
      threadCount: 2,
      candidateCount: 1,
      exclusionCount: 1,
    });
    expect(report.stats.coverage).toEqual({
      expectedInboundRows: 2,
      evaluatedInboundRows: 2,
      complete: true,
    });
    expect(report.ids.evaluatedInbound).toEqual(['SM-3', 'SM-4']);
  });

  test('evaluates at exactly two minutes with full history and retains newer inbound activity', () => {
    const start = Date.parse('2026-09-01T14:00:00.000Z');
    const rawRows = [
      exportRow({
        id: 'SM-open', at: new Date(start).toUTCString(), direction: 'outbound-api',
        body: 'Can you confirm the gate code?',
      }),
    ];
    for (let index = 1; index <= 25; index += 1) {
      rawRows.push(exportRow({
        id: `SM-info-${index}`,
        at: new Date(start + index * 1000).toUTCString(),
        direction: 'outbound-api',
        body: `Synthetic update ${index}.`,
      }));
    }
    rawRows.push(
      exportRow({
        id: 'SM-closed', at: new Date(start + 30_000).toUTCString(), direction: 'outbound-api',
        body: 'Your report: https://portal.invalid/report',
      }),
      exportRow({
        id: 'SM-thanks', at: new Date(start + 60_000).toUTCString(), direction: 'inbound', body: 'Thanks!',
      }),
    );

    const fullHistoryReport = replayRows(normalized(rawRows));
    expect(fullHistoryReport.candidates).toEqual([]);
    expect(fullHistoryReport.exclusions).toEqual([
      expect.objectContaining({ id: 'SM-thanks', reason: 'earlier_open_context' }),
    ]);
    expect(fullHistoryReport.exclusions[0].evaluatedAt).toBe('2026-09-01T14:03:00.000Z');

    const advancedRows = normalized([
      exportRow({
        id: 'SM-report', at: 'Tue, 01 Sep 2026 14:00:00 +0000', direction: 'outbound-api',
        body: 'Your report: https://portal.invalid/report',
      }),
      exportRow({
        id: 'SM-first-thanks', at: 'Tue, 01 Sep 2026 14:01:00 +0000', direction: 'inbound', body: 'Thank you!',
      }),
      exportRow({
        id: 'SM-newer', at: 'Tue, 01 Sep 2026 14:02:00 +0000', direction: 'inbound', body: 'One more thing',
      }),
    ]);
    const advancedReport = replayRows(advancedRows);
    expect(advancedReport.exclusions).toContainEqual(
      expect.objectContaining({ id: 'SM-first-thanks', reason: 'thread_advanced' }),
    );
  });

  test('uses Hello-name inference only for a marked unverified preview', () => {
    const rows = normalized([
      exportRow({
        id: 'SM-greeting', at: 'Tue, 01 Sep 2026 14:00:00 +0000', direction: 'outbound-reply',
        body: 'Hello Casey, your service is complete.',
      }),
      exportRow({
        id: 'SM-gratitude', at: 'Tue, 01 Sep 2026 14:01:00 +0000', direction: 'inbound', body: 'Thanks!',
      }),
    ]);
    expect(inferPreviewFirstName(rows)).toBe('Casey');

    const report = replayRows(rows);
    expect(report.candidates).toEqual([
      expect.objectContaining({
        id: 'SM-gratitude',
        replyPreview: 'Our pleasure, Casey!',
        identity: {
          firstName: 'Casey',
          source: 'outbound_hello_preview_only',
          verified: false,
        },
        liveSendEligible: false,
        liveSendBlockers: ['historical_replay', 'unverified_identity'],
      }),
    ]);
    expect(report.disclaimer).toMatch(/No identity is verified/);
  });

  test('rejects malformed and duplicate rows while ordering the export chronologically', () => {
    expect(() => parseJsonLines('{bad json}')).toThrow('Input line 1 is not valid JSON');

    const row = exportRow({
      id: 'SM-duplicate', at: 'Tue, 01 Sep 2026 14:00:00 +0000', direction: 'inbound', body: 'Thanks',
    });
    expect(() => normalized([row, { ...row }])).toThrow('repeats a message id');
    expect(normalized([
      row,
      exportRow({
        id: 'SM-earlier', at: 'Tue, 01 Sep 2026 13:59:00 +0000', direction: 'inbound', body: 'Thanks',
      }),
    ]).map((message) => message.id)).toEqual(['SM-earlier', 'SM-duplicate']);
  });

  test('writes a private report while stdout contains counts only', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-gratitude-replay-'));
    const inputPath = path.join(tempDirectory, 'private-input.jsonl');
    const outputPath = path.join(tempDirectory, 'private-output.json');
    const rawRows = [
      exportRow({
        id: 'SM-private-id', at: 'Tue, 01 Sep 2026 14:00:00 +0000', direction: 'outbound-api',
        body: 'Hello Casey, your service is complete.',
      }),
      exportRow({
        id: 'SM-private-thanks', at: 'Tue, 01 Sep 2026 14:01:00 +0000', direction: 'inbound',
        body: 'Thanks for everything!',
      }),
    ];
    fs.writeFileSync(inputPath, `${rawRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      run(['--input', inputPath, '--output', outputPath]);
      const summary = stdout.mock.calls.map(([value]) => value).join('');
      expect(summary).toMatch(/^Replay complete: 1 inbound messages evaluated across 1 threads;/);
      expect(summary).not.toMatch(/Casey|Thanks for everything|SM-private|\+1555|private-output/);

      const report = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(report.ids.evaluatedInbound).toEqual(['SM-private-thanks']);
      expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
    } finally {
      stdout.mockRestore();
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  test('has an explicit offline dependency boundary', () => {
    const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
    expect(source).not.toMatch(/require\(['"](?:https?|net|tls|dns|axios|twilio|knex|\.\.\/db)['"]\)/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toContain('process.env');
    expect(source).toContain('customerCommunication: false');
  });
});
