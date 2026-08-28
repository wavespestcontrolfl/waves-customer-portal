// Source contracts for the immutable setup-fee claim record — the
// crash-resume authorization evidence the #3500 hardening deferred.
const fs = require('fs');
const path = require('path');

const dispatch = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-dispatch.js'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '..', 'models', 'migrations', '20260826010000_setup_fee_claims.js'),
  'utf8',
);

describe('immutable setup-fee claim record', () => {
  test('migration creates the server-only claims table keyed uniquely by invoice', () => {
    expect(migration).toContain("createTable('setup_fee_claims'");
    expect(migration).toMatch(/invoice_id'\)\.notNullable\(\)\.unique\(\)/);
    expect(migration).toContain(".references('id').inTable('invoices')");
  });

  test('the mint records the claim BEFORE retiring the durable stamp, only when the fee rode', () => {
    const record = dispatch.indexOf("await db('setup_fee_claims')");
    const retire = dispatch.indexOf('pending_setup_fee: null', record);
    expect(record).toBeGreaterThan(-1);
    expect(retire).toBeGreaterThan(record);
    expect(dispatch).toMatch(/if \(feeRode && invoice\?\.id\) \{/);
    expect(dispatch).toMatch(/\.onConflict\('invoice_id'\)\s*\n\s*\.ignore\(\)/);
  });

  test('crash-resume authorization requires the record AND exact cents against the line', () => {
    const verdict = fs.readFileSync(path.join(__dirname, '..', 'services', 'completion-charge-verdict.js'), 'utf8');
    expect(verdict).toMatch(/recordCents > 0 && recordCents === lineCents/);
    expect(verdict).toMatch(/WAVEGUARD_SETUP_FEE_ALLOWANCE = recordCents \/ 100;/);
    // The editable line marker still never authorizes on its own.
    expect(dispatch).not.toMatch(/secure_claim === true\) wizardFrozenFeeLinked/);
    expect(verdict).not.toMatch(/secure_claim === true\) wizardFrozenFeeLinked/);
  });

  test('no admin route writes the claims table (server-mint only)', () => {
    const routesDir = path.join(__dirname, '..', 'routes');
    for (const f of fs.readdirSync(routesDir)) {
      if (!f.endsWith('.js') || f === 'admin-dispatch.js') continue;
      const src = fs.readFileSync(path.join(routesDir, f), 'utf8');
      expect(src.includes("('setup_fee_claims')")).toBe(false);
    }
  });
});
