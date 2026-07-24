// Secure plan-choice setup fee — completion wiring (owner decision
// 2026-07-24: a per-application selection on a solo pest/mosquito series
// bills the $99 WaveGuard setup fee on the FIRST completion invoice).
// Source contracts in the style of admin-dispatch-backfill-completion's
// route-wiring tests: the claim/mint/restore lifecycle and the bounded
// auto-charge allowance live inside the completion route, whose behavior
// harness is the frozen-money machinery — these pins keep the wiring from
// silently drifting out of the mint path.

const fs = require('fs');
const path = require('path');

const dispatchSource = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
const invoiceSource = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');

describe('setup-fee claim → mint → restore lifecycle (admin-dispatch)', () => {
  test('the claim is a DURABLE value-guarded compare-and-swap on the series parent, live completions only', () => {
    // Guarded off for backfill (frozen-money posture) and callbacks.
    expect(dispatchSource).toMatch(/if \(shouldInvoice && !isBackfillCompletion && !svc\.is_callback\) \{/);
    // Series parent, not the completing child.
    expect(dispatchSource).toMatch(/const setupParentId = svc\.recurring_parent_id \|\| svc\.id;/);
    // Fresh claim flips the stamp NEGATIVE (durable in-progress marker) via
    // an exact-value CAS — concurrent completions collapse to one claim,
    // and a crash mid-window leaves the marker for recovery.
    expect(dispatchSource).toMatch(/\.where\(\{ id: setupParentId, pending_setup_fee: parentRow\.pending_setup_fee \}\)\s*\n\s*\.update\(\{ pending_setup_fee: -amount/);
    expect(dispatchSource).toMatch(/if \(claimed === 1\) \{\s*\n\s*secureSetupFee = \{ parentId: setupParentId, amount \};/);
  });

  test('orphaned (negative) claims recover from the invoice truth: heal when the line exists, adopt under an updated_at lease when it does not', () => {
    expect(dispatchSource).toMatch(/if \(rawFee < 0\) \{/);
    // Recovery consults the durable record — a non-void series invoice
    // carrying the setup line.
    expect(dispatchSource).toMatch(/\.whereNot\('status', 'void'\)\s*\n\s*\.whereRaw\('line_items::text ILIKE \?', \['%one-time setup fee%'\]\)/);
    // Heal: line exists → clear the marker, never a second line.
    expect(dispatchSource).toMatch(/orphaned setup-fee claim healed/);
    // Adopt: no line → exactly one adopter via the updated_at lease CAS.
    expect(dispatchSource).toMatch(/pending_setup_fee: parentRow\.pending_setup_fee, updated_at: parentRow\.updated_at \}\)\s*\n\s*\.update\(\{ updated_at: new Date\(\) \}\)/);
  });

  test('a successful mint retires the claim; the clear is guarded on the exact negative marker', () => {
    expect(dispatchSource).toMatch(/\.where\(\{ id: secureSetupFee\.parentId, pending_setup_fee: -secureSetupFee\.amount \}\)\s*\n\s*\.update\(\{ pending_setup_fee: null/);
  });

  test('the claimed fee rides the SAME completion mint as its own line', () => {
    expect(dispatchSource).toMatch(/invoice = await InvoiceService\.createFromService\(record\.id, \{[\s\S]{0,3600}extraLineItems: secureSetupFee\s*\n\s*\? \[\{\s*\n\s*description: 'One-time setup fee',/);
    // The line amount is the CLAIMED (stamped-at-selection) value — the
    // billed fee always equals the disclosed fee.
    expect(dispatchSource).toMatch(/unit_price: secureSetupFee\.amount,\s*\n\s*amount: secureSetupFee\.amount,/);
  });

  test('a failed mint restores the stamp POSITIVE (guarded on the negative marker) instead of eating the fee', () => {
    expect(dispatchSource).toMatch(/\} catch \(invErr\) \{[\s\S]{0,900}if \(secureSetupFee\) \{[\s\S]{0,500}pending_setup_fee: -secureSetupFee\.amount \}\)\s*\n\s*\.update\(\{ pending_setup_fee: secureSetupFee\.amount/);
  });

  test('the auto-charge hard cap grants the bounded allowance to plan-choice setup-fee invoices via the DURABLE selection row', () => {
    // Keyed on appointment_card_requests.selected_plan — not the in-request
    // claim variable (resumes reuse an already-minted invoice) and not a
    // notes marker (Codex #2680: office edits survive markers).
    // The selection row may live on any series visit (parent or child) —
    // the allowance searches the whole series.
    expect(dispatchSource).toMatch(/planChoiceSetupFeeSelected = !!\(await db\('appointment_card_requests'\)\s*\n\s*\.whereIn\('scheduled_service_id', db\('scheduled_services'\)\.select\('id'\)/);
    expect(dispatchSource).toMatch(/\.where\(\{ selected_plan: 'per_application' \}\)/);
    expect(dispatchSource).toMatch(/if \(acceptMintedInvoice \|\| planChoiceSetupFeeSelected\) \{/);
    // The bound itself is untouched: min(line, 99), line detected by text.
    expect(dispatchSource).toMatch(/setupFeeAllowance = Math\.min\(lineAmt, WAVEGUARD_SETUP_FEE_ALLOWANCE\);/);
  });
});

describe('createFromService extraLineItems (services/invoice.js)', () => {
  test('extra lines append AFTER the service lines in both line-item branches', () => {
    expect(invoiceSource).toMatch(/extraLineItems = \[\],/);
    expect(invoiceSource).toMatch(/if \(Array\.isArray\(extraLineItems\) && extraLineItems\.length\) \{\s*\n\s*lineItems = \[\.\.\.lineItems, \.\.\.extraLineItems\];/);
  });
});
