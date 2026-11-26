// Owner ruling 2026-11-25: no termite damage-repair promise. My Plan's termite row defers to the customer's signed
// agreement, which also stays true for a bond signed earlier (so it must not say "retreatment only" either).
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const source = readFileSync(new URL('./PortalPage.jsx', import.meta.url), 'utf8');
const termiteLines = source.split('\n').filter((line) => /id: 'termite'|^\s*termite: \{|Termite Bait Monitoring|Premier \(quarterly/.test(line)
  || /Bait station installation/.test(line));

describe('My Plan termite coverage copy', () => {
  test('the termite catalog and coverage rows exist', () => {
    expect(termiteLines.length).toBeGreaterThanOrEqual(3);
  });

  test('no damage warranty or repair promise', () => {
    for (const line of termiteLines) expect(line).not.toMatch(/damage warranty|repair|guarantee|warranty/i);
  });

  test('coverage defers to the signed termite agreement, without saying retreatment only', () => {
    expect(source).toContain('Coverage follows your signed termite agreement');
    for (const line of termiteLines) expect(line).not.toMatch(/retreatment only/i);
  });
});
