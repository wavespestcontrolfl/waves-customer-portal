// Source contracts for the #3489 follow-up hardening (owner-accepted P1s).
// Each pins an invariant a refactor could silently drop.
const fs = require('fs');
const path = require('path');

const booking = fs.readFileSync(path.join(__dirname, '..', 'routes', 'booking.js'), 'utf8');
const publicQuote = fs.readFileSync(path.join(__dirname, '..', 'routes', 'public-quote.js'), 'utf8');
const dispatch = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');

describe('setup-fee follow-up contracts (#3489 residual P1s)', () => {
  test('solo wizard bookings run the waiver rechecks but NEVER stamp (plan not activated)', () => {
    expect(booking).toContain('const stampDisclosedSetupFee = async (outerTrx, { allowStamp = true, stampServiceRow = null } = {}) =>');
    expect(booking).toMatch(/if \(!shouldSeedQuarterlyPestFollowUps && setupFeeHandoffEligible && !isOneTimeEstimateBooking\) \{/);
    // The rechecks/waivers always run; only the stamp is gated on the visit
    // being able to mint it.
    expect(booking).toMatch(/stampDisclosedSetupFee\(trx, \{ allowStamp: false, stampServiceRow: serviceRow \}\)/);
    expect(booking).toMatch(/if \(!allowStamp \|\| !stampServiceRow\?\.id\) return;/);
    // Replays re-run the waiver disposition (never a stamp). Structural
    // ordering assertion (codex #3504 r27 pre-push): the replay branch
    // ("Double-submit replay") precedes its waiver-only call, and that call
    // sits before the primary path's activation — no distance bound, so
    // hardening inserted between them (r3 bind, r5 reminders, r6 heal,
    // r21+ generation/extension work) never breaks the pin.
    const replayAt = booking.indexOf('Double-submit replay');
    const replayWaiverAt = booking.indexOf('stampDisclosedSetupFee(trx, { allowStamp: false })', replayAt);
    const primaryActivationAt = booking.indexOf('const seriesOutcome = await activateWizardSeries(serviceRow);');
    expect(replayAt).toBeGreaterThan(0);
    expect(replayWaiverAt).toBeGreaterThan(replayAt);
    expect(primaryActivationAt).toBeGreaterThan(replayWaiverAt);
    
    // ...and the pest seeding path still calls the same helper atomically.
    expect(booking).toMatch(/await stampDisclosedSetupFee\(trx, \{ stampServiceRow: serviceRow \}\)/);
  });

  test('the signed funnel key is normalized to the priced family before the setup-fee intersection (codex #3591 r25 P1)', () => {
    expect(booking).toMatch(/const FUNNEL_TO_DRAFT_FAMILY = \{ rodent: \['rodent_bait'\], termite: \['termite_bait'\] \};/);
    expect(booking).toMatch(/!signedFeeComponents\.every\(draftHasComponent\)/);
  });

  test('member-waiver retires a consumed draft, or freezes a zero-waiver into a live one', () => {
    // The member waiver is the membership fee's; a rodent setup quote is
    // never waived by account-level membership (codex #3591 r18 P1).
    expect(booking).toMatch(/if \(activeMember && !rodentSetupQuote\) \{\s*\n\s*await retireOrWaiveDraft\('existing_member'\);/);
    expect(booking).toMatch(/await retireOrWaiveDraft\('fee_already_queued'\);/);
    // Non-invoiceable solo visits keep the draft LIVE with the frozen waiver —
    // kind preserved and the rodent setup row stripped (codex #3591 r28 P1).
    expect(booking).toMatch(/setupFeeQuote: \{ amount: 0, waived: waivedReason, \.\.\.\(priorKind \? \{ kind: priorKind \} : \{\}\) \}/);
    expect(booking).toMatch(/if \(priorKind === 'rodent_bait_setup'\) \{\s*\n\s*const \{ stripWaivedRodentSetupFromDraft \} = require\('\.\/public-quote'\)\._internals;/);
  });

  test('the lookup-failure waiver keeps the setup-fee KIND so the rodent strip + frozen reader honor it (codex #3591 r30 P1)', () => {
    // A lookup failure keeps the engine-priced fee (codex #3591 r43 local
    // P0) — never a persisted zero that strips the authorized line.
    expect(publicQuote).toMatch(/return \{ amount: setupFeeBasis\.amount, kind: setupFeeBasis\?\.kind, unverified: 'membership_undetermined' \};/);
    expect(publicQuote).not.toMatch(/amount: 0, waived: 'membership_undetermined'/);
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
    const verdict = fs.readFileSync(path.join(__dirname, '..', 'services', 'completion-charge-verdict.js'), 'utf8');
    expect(verdict).not.toMatch(/setupLine\?\.secure_claim === true\) wizardFrozenFeeLinked/);
    expect(verdict).not.toMatch(/secure_claim === true\) \{\s*\n\s*wizardFrozenFeeLinked/);
    expect(verdict).not.toMatch(/WAVEGUARD_SETUP_FEE_ALLOWANCE = markedAmt/);
  });

  test('duplicate-draft refresh revalidates under the row lock before minting a handoff', () => {
    expect(publicQuote).toMatch(/lockedDup\.source === 'quote_wizard'[\s\S]{0,120}lockedDup\.status === 'draft'[\s\S]{0,60}!lockedDup\.archived_at/);
    expect(publicQuote).toMatch(/if \(refreshed === 1\) \{\s*\n\s*draftEstimateId = duplicateBlock\.existingEstimateId;/);
  });
});
