/**
 * Live contract test for Google Address Validation. Confirms the API key has
 * the API enabled and shows how real addresses resolve. No DB, no PII (uses
 * synthetic/representative addresses). Run under app env:
 *   ADDRESS_VALIDATION_ENABLED=true node server/scripts/contract-test-address-validation.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
process.env.ADDRESS_VALIDATION_ENABLED = 'true';
const { validateAddress } = require('../services/address-validation');

const CASES = [
  { label: 'Parrish bad zip (61419 → should correct to 34219)', lines: ['17451 State Road 62, Parrish, FL 61419'] },
  { label: 'Parrish no zip', lines: ['17451 State Road 62, Parrish, FL'] },
  { label: 'Clean in-area (Bradenton, Manatee)', lines: ['1010 Manatee Ave W, Bradenton, FL 34205'] },
  { label: 'Out of area (Atlanta, GA)', lines: ['100 Peachtree St NE, Atlanta, GA 30303'] },
  { label: 'Garbage / incomplete', lines: ['somewhere near the trees'] },
];

(async () => {
  for (const c of CASES) {
    const r = await validateAddress({ addressLines: c.lines });
    console.log(`\n— ${c.label}`);
    console.log(`  input: ${c.lines[0]}`);
    console.log(`  status=${r.status} | inServiceArea=${r.inServiceArea} | county=${r.county} | granularity=${r.granularity}`);
    console.log(`  normalized: ${r.normalized ? [r.normalized.street_line_1, r.normalized.city, r.normalized.state, r.normalized.postal_code].filter(Boolean).join(', ') : '—'}`);
    console.log(`  inferred=${r.hasInferred} replaced=${r.hasReplaced} unconfirmed=${r.hasUnconfirmed}`);
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
