// Source contracts for the #3489 follow-up hardening (owner-accepted P1s).
// Each pins an invariant a refactor could silently drop.
const fs = require('fs');
const path = require('path');

const booking = fs.readFileSync(path.join(__dirname, '..', 'routes', 'booking.js'), 'utf8');
const publicQuote = fs.readFileSync(path.join(__dirname, '..', 'routes', 'public-quote.js'), 'utf8');
const dispatch = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-dispatch.js'), 'utf8');

describe('setup-fee follow-up contracts (#3489 residual P1s)', () => {
  test('solo wizard bookings run the waiver rechecks but NEVER stamp (plan not activated)', () => {
    expect(booking).toContain('const stampDisclosedSetupFee = async (outerTrx, { allowStamp = true, stampServiceRow = null } = {}) =>');
    expect(booking).toMatch(/if \(!shouldSeedQuarterlyPestFollowUps && setupFeeHandoffEligible && !isOneTimeEstimateBooking\) \{/);
    // The rechecks/waivers always run; only the stamp is gated on the visit
    // being able to mint it.
    expect(booking).toMatch(/stampDisclosedSetupFee\(trx, \{ allowStamp: false, stampServiceRow: serviceRow \}\)/);
    expect(booking).toMatch(/if \(!allowStamp \|\| !stampServiceRow\?\.id\) return;/);
    // Replays re-run the waiver disposition (never a stamp).
    // Window widened 3500→6500 for the replay-parent estimate/family bind
    // (codex #3504 r3) and the replay-series reminder registration (r5
    // hook) inserted between them — the pinned ordering is unchanged.
    expect(booking).toMatch(/Double-submit replay[\s\S]{0,6500}stampDisclosedSetupFee\(trx, \{ allowStamp: false \}\)/);
    
    // ...and the pest seeding path still calls the same helper atomically.
    expect(booking).toMatch(/await stampDisclosedSetupFee\(trx, \{ stampServiceRow: serviceRow \}\)/);
  });

  test('member-waiver retires a consumed draft, or freezes a zero-waiver into a live one', () => {
    expect(booking).toMatch(/if \(activeMember\) \{\s*\n\s*await retireOrWaiveDraft\('existing_member'\);/);
    expect(booking).toMatch(/await retireOrWaiveDraft\('fee_already_queued'\);/);
    // Non-invoiceable solo visits keep the draft LIVE with the frozen waiver.
    expect(booking).toMatch(/setupFeeQuote: \{ amount: 0, waived: waivedReason \}/);
  });

  test('consumed-handoff retry identity comes ONLY from the contact-bound shared recovery', () => {
    // The gate arm must never assign identity itself — bindGateEstimate
    // validates only the draft's stored contact.
    expect(booking).not.toContain('consumedByCustomerId');
    expect(booking).toMatch(/const contactMatches = submitted10/);
    expect(booking).toMatch(/if \(contactMatches\) custId = consumed\.customer_id;/);
  });

  test('queued-claim checks ignore claims no live series row can consume (both sites)', () => {
    for (const src of [booking, publicQuote]) {
      expect(src).toMatch(/orWhereIn\('claim\.status', \['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'\]\)/);
      // Negative stamps are completion's in-progress markers — always consumable.
      expect(src).toMatch(/where\('claim\.pending_setup_fee', '<', 0\)/);
      expect(src).toMatch(/whereRaw\('child\.recurring_parent_id = claim\.id'\)/);
      // Pending completion attempts keep a positive claim consumable.
      expect(src).toMatch(/from\('service_completion_attempts as sca'\)/);
      expect(src).toMatch(/whereIn\('sca\.status', \['pending', 'side_effects_pending', 'side_effects_running'\]\)/);
      expect(src).toMatch(/whereIn\('child\.status', \['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'\]\)/);
    }
  });

  test('secure-claim marker is written for provenance but NEVER consumed for authorization', () => {
    const markers = dispatch.match(/secure_claim: true,/g) || [];
    expect(markers.length).toBe(2);
    // Editable line JSON must never authorize a saved-card charge — no
    // predicate, no ceiling. Crash-resume routes to manual review.
    expect(dispatch).not.toMatch(/setupLine\?\.secure_claim === true\) wizardFrozenFeeLinked/);
    expect(dispatch).not.toMatch(/secure_claim === true\) \{\s*\n\s*wizardFrozenFeeLinked/);
    expect(dispatch).not.toMatch(/WAVEGUARD_SETUP_FEE_ALLOWANCE = markedAmt/);
  });

  test('duplicate-draft refresh revalidates under the row lock before minting a handoff', () => {
    expect(publicQuote).toMatch(/lockedDup\.source === 'quote_wizard'[\s\S]{0,120}lockedDup\.status === 'draft'[\s\S]{0,60}!lockedDup\.archived_at/);
    expect(publicQuote).toMatch(/if \(refreshed === 1\) \{\s*\n\s*draftEstimateId = duplicateBlock\.existingEstimateId;/);
  });
});
