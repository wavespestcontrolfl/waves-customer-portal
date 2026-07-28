const { previewText, stripSchedulerAuditText } = require('../utils/visit-notes');

describe('previewText', () => {
  test('returns null for empty input', () => {
    expect(previewText('')).toBeNull();
    expect(previewText(null)).toBeNull();
    expect(previewText('   ')).toBeNull();
  });

  test('passes short text through untouched', () => {
    expect(previewText('Treated the exterior perimeter.')).toBe('Treated the exterior perimeter.');
  });

  test('truncates at a word boundary with an ellipsis instead of mid-word', () => {
    const text = `${'word '.repeat(40)}potassium support application`;
    const out = previewText(text, 200);
    expect(out.length).toBeLessThanOrEqual(201); // 200 + ellipsis, minus trimmed tail
    expect(out.endsWith('…')).toBe(true);
    // The old .slice(0, 200) produced a mid-word cut ("pota") — the preview
    // must end on the last complete word before the limit.
    expect(out).toMatch(/ word…$/);
    expect(out).not.toContain('pota');
  });

  test('falls back to a hard cut for a single giant token', () => {
    const out = previewText('x'.repeat(300), 200);
    expect(out.length).toBe(201);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('stripSchedulerAuditText', () => {
  test('returns null for empty input', () => {
    expect(stripSchedulerAuditText('')).toBeNull();
    expect(stripSchedulerAuditText(null)).toBeNull();
  });

  test('leaves genuine property notes untouched', () => {
    const note = 'Gate code 4412. Dog in yard — text before arrival.';
    expect(stripSchedulerAuditText(note)).toBe(note);
  });

  test('drops scheduler audit segments (tagged moves + No SMS sent markers)', () => {
    const note = [
      'Clarified Dale Brush service line: Termite Bond Service (1-Year Term). No SMS sent.',
      'recurring_align_2026_06: moved from 2026-09-02 10:00:00 to 2026-08-20 10:00:00 to align with last past termite_bond visit on 2026-02-20. No SMS sent.',
      'route_density_2026_06: moved from 2026-08-20 10:00:00 to 2026-08-17 12:00:00 for route density (lakewood_ranch; score +13.45). No SMS sent.',
    ].join(' ');
    expect(stripSchedulerAuditText(note)).toBeNull();
  });

  test('keeps the real note when audit trails are appended after it', () => {
    const note = 'Side gate sticks — lift while opening. recurring_align_2026_06: moved from 2026-09-02 to 2026-08-20. No SMS sent.';
    expect(stripSchedulerAuditText(note)).toBe('Side gate sticks — lift while opening.');
  });

  test('keeps the real prefix when an audit tag shares its segment', () => {
    const note = 'Gate code 4412; recurring_align_2026_06: moved from 2026-09-02 to 2026-08-20. No SMS sent.';
    expect(stripSchedulerAuditText(note)).toBe('Gate code 4412');
  });

  test('does not false-positive on prose containing underscores or years', () => {
    const note = 'Customer prefers service_area notes in 2026 format. Treat lanai edges.';
    expect(stripSchedulerAuditText(note)).toBe(note);
  });
});
