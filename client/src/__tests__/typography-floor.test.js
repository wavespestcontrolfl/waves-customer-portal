// UI audit K.1 unit 7: the surfaces swept for sub-11px type must not regress.
// Inline `fontSize: N` with N < 11 is the pattern the audit found (8px chips,
// 9px table headers, 10px badges); the 11–13px population is a separate
// owner ruling (K.2-1) and is deliberately not asserted here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';

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

const HERE = dirname(fileURLToPath(import.meta.url));

describe('typography floor (UI audit unit 7)', () => {
  for (const rel of FILES) {
    it(`${rel} has no inline fontSize below 11px`, () => {
      const src = readFileSync(resolve(HERE, '..', rel), 'utf8');
      const hits = [];
      src.split('\n').forEach((line, i) => {
        const m = line.match(/fontSize:\s*(\d+)\b/);
        if (m && Number(m[1]) < 11) hits.push(`${i + 1}: ${line.trim()}`);
      });
      expect(hits).toEqual([]);
    });
  }
});
