// Gates the code reads (docs/gate-index.md, as the code implies it) that have
// no described header line in server/config/feature-gates.js, so Settings →
// Advanced → Features cannot say what they do or flip them (owner
// 2026-11-06). Used by check-domain-rules rule 8 and to write its baseline:
//   node scripts/gate-catalogue.js --write-baseline
const fs = require('fs');
const path = require('path');
const { expectedIndex } = require('./generate-gate-index');

const BASELINE = path.join(__dirname, 'gate-catalogue-baseline.json');

function gatesMissingCatalogueLine() {
  const catalog = require('../server/config/feature-gates').knownGateCatalog();
  const names = (expectedIndex().match(/^- `(GATE_[A-Z0-9_]+)`/gm) || []).map((line) => line.slice(3, -1));
  return names.filter((name) => {
    const entry = catalog.get(name);
    return !entry || !entry.description || entry.kind === 'unverified';
  }).sort();
}

if (require.main === module && process.argv.includes('--write-baseline')) {
  const gates = gatesMissingCatalogueLine();
  fs.writeFileSync(BASELINE, `${JSON.stringify({
    note: 'Gates with no described header line in server/config/feature-gates.js on 2026-11-06. Shrink only: remove a name when its line is added (check-domain-rules rule 8).',
    gates,
  }, null, 1)}\n`);
  console.log(`wrote ${gates.length} gates to ${path.relative(process.cwd(), BASELINE)}`);
}

module.exports = { gatesMissingCatalogueLine };
