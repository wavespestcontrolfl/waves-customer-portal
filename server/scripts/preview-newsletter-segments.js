#!/usr/bin/env node
/**
 * Read-only preview of service-line newsletter segments.
 *
 * Prints how many active subscribers fall into the cross-sell segments the
 * "Agora play" depends on (pest-but-not-lawn, pest+lawn-but-not-mosquito,
 * single-line members, by region) so we can size the opportunity BEFORE
 * building any campaign. Sends nothing.
 *
 *   node server/scripts/preview-newsletter-segments.js
 *   node server/scripts/preview-newsletter-segments.js --loose   # count one-offs too
 *
 * NOTE: classification is regex over free-text scheduled_services.service_type.
 * Eyeball the numbers — implausibly low "has" counts usually mean recurring
 * rows predate the is_recurring column; rerun with --loose to compare.
 */

const db = require('../models/db');
const {
  buildProfiles,
  matchesFilter,
  SELLABLE_LINES,
} = require('../services/newsletter-audience-profiles');

const recurringOnly = !process.argv.includes('--loose');

const SEGMENTS = [
  { label: 'Pest customers WITHOUT lawn (campaign #1)', filter: { audience: 'customers', has_service: ['pest'], missing_service: ['lawn'] } },
  { label: 'Pest+Lawn WITHOUT mosquito (campaign #2)', filter: { audience: 'customers', has_service: ['pest', 'lawn'], missing_service: ['mosquito'] } },
  { label: 'Single-line members (campaign #3: WaveGuard Insider)', filter: { audience: 'customers', min_line_count: 1, max_line_count: 1 } },
  { label: 'Pest customers WITHOUT termite', filter: { audience: 'customers', has_service: ['pest'], missing_service: ['termite'] } },
  { label: 'Lawn customers WITHOUT tree & shrub', filter: { audience: 'customers', has_service: ['lawn'], missing_service: ['tree_shrub'] } },
  { label: 'Pest customers WITHOUT rodent', filter: { audience: 'customers', has_service: ['pest'], missing_service: ['rodent'] } },
];

function pct(n, total) {
  return total ? `${((n / total) * 100).toFixed(1)}%` : '0%';
}

function count(profiles, filter) {
  return profiles.filter((p) => matchesFilter(p, filter)).length;
}

(async () => {
  try {
    // Read-only preview: best-effort on a scheduled_services hiccup (sends
    // nothing, so transient over-counting is harmless). The send path defaults
    // to failClosedOnServiceError:true and refuses instead of broadening.
    const profiles = await buildProfiles({ recurringOnly, failClosedOnServiceError: false });
    const total = profiles.length;
    const customers = profiles.filter((p) => p.is_customer);
    const leads = total - customers.length;

    console.log('\n=== Newsletter audience — service-line segmentation ===');
    console.log(`Mode: ${recurringOnly ? 'recurring-only (active membership)' : 'loose (recurring + one-offs)'}`);
    console.log(`Active subscribers: ${total}  |  linked customers: ${customers.length}  |  pure leads: ${leads}\n`);

    console.log('-- Held service lines (among linked customers) --');
    for (const line of SELLABLE_LINES) {
      const n = customers.filter((p) => p.has[line]).length;
      console.log(`  ${line.padEnd(11)} ${String(n).padStart(4)}  (${pct(n, customers.length)})`);
    }

    console.log('\n-- Line-count distribution (linked customers) --');
    const dist = {};
    for (const p of customers) dist[p.line_count] = (dist[p.line_count] || 0) + 1;
    Object.keys(dist).sort((a, b) => a - b).forEach((k) => {
      console.log(`  ${k} line(s): ${String(dist[k]).padStart(4)}`);
    });

    console.log('\n-- Cross-sell segments --');
    for (const seg of SEGMENTS) {
      console.log(`  ${String(count(profiles, seg.filter)).padStart(4)}  ${seg.label}`);
    }

    console.log('\n-- By region zone (linked customers) --');
    const byZone = {};
    for (const p of customers) byZone[p.region_zone || '(none)'] = (byZone[p.region_zone || '(none)'] || 0) + 1;
    Object.entries(byZone).sort((a, b) => b[1] - a[1]).forEach(([z, n]) => {
      console.log(`  ${String(n).padStart(4)}  ${z}`);
    });
    console.log('');
  } catch (err) {
    console.error('[preview-newsletter-segments] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.destroy().catch(() => {});
  }
})();
