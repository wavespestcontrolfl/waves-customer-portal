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

  it('TimeGridDays renders the Unassigned label at the 14px readability floor (F0212, dispatch audit 10-29)', () => {
    const label = read('components/schedule/TimeGridDays.jsx')
      .split('\n')
      .find((line) => line.includes('>Unassigned</span>'));
    expect(label).toBeDefined();
    expect(label).toMatch(/\btext-14\b/);
    expect(label).not.toMatch(/fontSize:\s*\d+/);
  });
});

// Schedule audit S9 (owner 2026-10-31): the Schedule tab's Day, 5-Day, Week
// and Month views and the phone date strip draw no text under 14px. The
// "Closeout owed" chip keeps its size (the dispatch audit, #7051, left it so
// it does not crowd the name), and WeekViewV2 is skipped: nothing imports
// it, so it never renders.
const SCHEDULE_TAB_FILES = [
  'components/schedule/TimeGridDay.jsx',
  'components/schedule/TimeGridDays.jsx',
  'components/schedule/MobileDayStrip.jsx',
  'components/schedule/CalendarViewsV2.jsx',
];
const CLOSEOUT_CHIP = 'h-4 px-1 rounded-xs bg-alert-bg text-alert-fg text-10';

function withoutUnusedWeekView(src) {
  const start = src.indexOf('// ─── WEEK VIEW');
  const end = src.indexOf('// ─── MONTH VIEW');
  return start >= 0 && end > start ? src.slice(0, start) + src.slice(end) : src;
}

describe('Schedule tab 14px floor (schedule audit S9)', () => {
  for (const rel of SCHEDULE_TAB_FILES) {
    it(`${rel} draws no text under 14px`, () => {
      const hits = [];
      withoutUnusedWeekView(read(rel)).split('\n').forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line)) return;
        if (/\btext-1[0-3]\b/.test(line) && !line.includes(CLOSEOUT_CHIP)) hits.push(`${i + 1}: ${line.trim()}`);
        if (/\bu-label\b/.test(line) || /fontSize:\s*(9|1[0-3])\b/.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
      });
      expect(hits).toEqual([]);
    });
  }
});
