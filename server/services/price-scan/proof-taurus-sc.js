#!/usr/bin/env node
// Taurus SC proof: run the LIVE scanner against the public pest-control vendors
// and compare to the SiteOne baseline. DRY-RUN — it prints what it found plus
// the /report items it WOULD post (each carrying its proof URL); it does not POST
// and does not touch the DB.
//
//   node server/services/price-scan/proof-taurus-sc.js
//
// The baseline below is an EXAMPLE — swap in Adam's real SiteOne 78 oz price
// before trusting the savings figure. Taurus SC EPA reg 53883-279 is real and is
// what the trust gate keys on, so a generic "termiticide" listing can't match.

const { runScan, reportItemsFromScan } = require('./scanner');

const product = {
  name: 'Taurus SC',
  productName: 'Taurus SC Termiticide',
  vendorProductName: 'Taurus SC Termiticide',
  searchQuery: 'Taurus SC 78 oz',
  epaReg: '53883-279',
  packSizeValue: 78,
  packSizeUnit: 'oz',
  // EXAMPLE baseline — replace with the real SiteOne 78 oz price.
  baseline: { price: 95, quantity: '78 oz', vendor: 'SiteOne' },
};

// Direct product URLs are far more reliable than each storefront's search +
// JS-rendered results (and side-step Cloudflare bot challenges). A real catalog
// (PR4) supplies these per (vendor, product); here they're the known Taurus SC
// 78 oz pages. A vendor with no url falls back to its adapter's search.
const vendors = [
  { vendor_id: 'domyown', name: 'DoMyOwn', url: 'https://www.domyown.com/taurus-sc-termiticide-78-oz-p-1817.html' },
  { vendor_id: 'solutions', name: 'Solutions Pest & Lawn', host: 'solutionsstores.com' },
  { vendor_id: 'keystone', name: 'Keystone Pest Solutions', host: 'keystonepestsolutions.com' },
];

(async () => {
  const { price: basePrice, quantity: baseQty } = product.baseline;
  console.log(`Scanning ${product.name} (${product.packSizeValue} ${product.packSizeUnit}) across public vendors…\n`);

  const scan = await runScan(product, vendors, { headless: true });

  console.log('Verified candidates:');
  scan.verified.forEach((c) => console.log(
    `  • ${c.vendor}: $${c.price} / ${c.quantity || '?'}  (${c.availability})  ${c.source_url}`,
  ));
  if (!scan.verified.length) console.log('  (none verified)');

  console.log('\nSkipped:');
  scan.skipped.forEach((s) => console.log(`  • ${s.vendor}: ${s.reason}${s.detail ? ` — ${s.detail}` : ''}`));
  if (!scan.skipped.length) console.log('  (none)');

  const opp = scan.opportunity;
  console.log(`\nOpportunity vs ${product.baseline.vendor} baseline ($${basePrice} / ${baseQty}, EXAMPLE):`);
  if (opp.isOpportunity) {
    console.log(`  ✅ ${opp.best.vendor} beats baseline: $${opp.best.price}`
      + ` (${(opp.savingsPct * 100).toFixed(1)}% cheaper / ~$${opp.estSavingsOnBaseline} per ${baseQty})`);
    console.log(`     proof: ${opp.best.source_url}`);
  } else {
    console.log('  — no cheaper verified price found');
  }

  console.log('\n/report items that WOULD be posted (each carries its proof URL):');
  console.log(JSON.stringify(reportItemsFromScan(product, scan), null, 2));
})().catch((err) => {
  console.error('proof failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
