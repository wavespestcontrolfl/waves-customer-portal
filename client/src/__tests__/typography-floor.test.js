// UI audit K.1 unit 7: the surfaces swept for sub-11px type must not regress.
// Inline `fontSize: N` with N < 11 is the pattern the audit found (8px chips,
// 9px table headers, 10px badges); the 11–13px population is a separate
// owner ruling (K.2-1) and is deliberately not asserted here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

const FILES = [
  'pages/admin/BankingPage.jsx',
  'pages/admin/TaxPage.jsx',
  'pages/admin/InventoryPage.jsx',
  'pages/admin/AdminInvoicesPage.jsx',
  'pages/admin/AdsPage.jsx',
  'pages/admin/PPCDashboardPage.jsx',
  'pages/admin/GBPManagement.jsx',
  'pages/admin/SocialMediaPage.jsx',
  'components/admin/GlobalCommandPalette.jsx',
  'pages/admin/ReviewVelocityEngine.jsx',
  'components/schedule/TimeGridDay.jsx',
  'components/schedule/TimeGridDays.jsx',
];

function read(rel) {
  return readFileSync(resolve(HERE, '..', rel), 'utf8');
}

describe('typography floor (UI audit unit 7)', () => {
  for (const rel of FILES) {
    it(`${rel} has no inline or class-based size below the floor`, () => {
      const hits = [];
      read(rel).split('\n').forEach((line, i) => {
        const inline = line.match(/fontSize:\s*(\d+)\b/);
        if (inline && Number(inline[1]) < 11) hits.push(`${i + 1}: ${line.trim()}`);
        // Class-based sizes below the floor (`text-8`, `text-9`). `text-10` is
        // excluded on purpose: it is not a Tailwind token and emits no CSS
        // (F0606), so its mapping is the separate text-10 → text-11 sweep.
        for (const cls of line.matchAll(/\btext-(\d+)\b/g)) {
          if (Number(cls[1]) < 10) hits.push(`${i + 1}: ${line.trim()}`);
        }
      });
      expect(hits).toEqual([]);
    });
  }

  it('TimeGridDays renders the Unassigned label at the 11px caption class (F0212)', () => {
    const label = read('components/schedule/TimeGridDays.jsx')
      .split('\n')
      .find((line) => line.includes('>Unassigned</span>'));
    expect(label).toBeDefined();
    expect(label).toMatch(/\btext-11\b/);
    expect(label).not.toMatch(/fontSize:\s*\d+/);
  });
});
