import { describe, expect, it } from 'vitest';
import {
  ADDRESS_ASK_REASONS,
  ADDRESS_READBACK_REASONS,
  addressAskNotice,
  filterAddressAsks,
  filterAddressConfirmations,
} from './addressAsks';

const ask = (reason_code, payload = null, call_log_id = null) => ({ reason_code, payload, call_log_id });

describe('filterAddressAsks', () => {
  it('keeps validation-ask cards only', () => {
    const items = [
      ask('address_unverified'),
      ask('missing_unit_number'),
      // Same address_review lane, but these say "which address", not
      // "this address may be wrong".
      ask('property_role_confirm'),
      ask('second_address_mentioned'),
      ask('dropped_call'),
    ];

    expect(filterAddressAsks(items).map((i) => i.reason_code))
      .toEqual(['address_unverified', 'missing_unit_number']);
  });

  it('survives a missing or malformed items list', () => {
    expect(filterAddressAsks(undefined)).toEqual([]);
    expect(filterAddressAsks(null)).toEqual([]);
    expect(filterAddressAsks({})).toEqual([]);
    expect(filterAddressAsks([null, undefined])).toEqual([]);
  });

  it('covers every validation-half reason the routing gate files', () => {
    expect([...ADDRESS_ASK_REASONS]).toEqual(expect.arrayContaining([
      'address_unverified', 'missing_service_address', 'address_unverifiable',
    ]));
  });
});

describe('addressAskNotice', () => {
  it('is null when nothing is owed', () => {
    expect(addressAskNotice([])).toBeNull();
    expect(addressAskNotice([ask('property_role_confirm')])).toBeNull();
  });

  it('warns when the only hold is saved-address proof for a different customer', () => {
    const notice = addressAskNotice([ask('on_file_proof_customer_mismatch', null, 'call-a')]);
    expect(notice).toMatchObject({ unitOnly: false, readbackOnly: false });
    expect(notice.reason).toContain('different customer');
  });

  it('a same-call unit ask and recovery cannot hide customer-mismatched address proof', () => {
    const notice = addressAskNotice([
      ask('missing_unit_number', null, 'call-a'),
      ask('address_recovered', { address_as_heard: '100 Port Ave East' }, 'call-a'),
      ask('on_file_proof_customer_mismatch', null, 'call-a'),
    ]);
    expect(notice).toMatchObject({ unitOnly: false, readbackOnly: false });
    expect(notice.reason).toContain('different customer');
    expect(notice.heard).toBeNull();
  });

  it('keeps customer-mismatch copy when the estimate panel passes validation-only cards', () => {
    const notice = addressAskNotice(filterAddressAsks([
      ask('address_unverified', { address_as_heard: 'generic hold' }, 'call-a'),
      ask('missing_unit_number', {
        unit_ask_building: { street_line_1: '100 Test Harbor Drive' },
      }, 'call-a'),
      ask('on_file_proof_customer_mismatch', null, 'call-a'),
      ask('address_recovered', { address_as_heard: 'retired from estimate panel' }, 'call-a'),
    ]));

    expect(notice).toMatchObject({ unitOnly: false, heard: null, building: null });
    expect(notice.reason).toContain('different customer');
  });

  // The 2026-09-10 call (c3c27b01): a spoken ordinal street transcribed as a
  // similar-sounding word. The notice has to name the garble AND what recovery
  // thought the caller said, or the operator books the garble by hand.
  // Strings below are synthetic — never a real lead address (AGENTS.md).
  it('names the heard street and the recovery candidates', () => {
    const notice = addressAskNotice([
      ask('address_unverified', {
        address_as_heard: '100 Port Ave East',
        address_candidates: ['100 4th Avenue East, Palmetto, FL 34221, USA'],
      }),
    ]);

    expect(notice).toMatchObject({
      unitOnly: false,
      reason: 'the address from the call did not validate',
      heard: '100 Port Ave East',
      candidates: ['100 4th Avenue East, Palmetto, FL 34221, USA'],
    });
  });

  it('says the unit is the only thing owed when that is the whole ask', () => {
    expect(addressAskNotice([ask('missing_unit_number')])).toMatchObject({
      unitOnly: true,
      reason: 'the caller gave the building but no unit number',
    });
  });

  // REVERSED at codex #4437 r4. This pair is the NORMAL shape of a real
  // missing-unit result — call-triage-flags files both flags for one call, the
  // generic one as the hold and the unit one as the ask — not two independent
  // problems. Asserting "did not validate" here pinned the bug in place. The
  // genuinely-unrelated case is covered by its own test below.
  it('is unit-only when the companion hold comes from the same call', () => {
    const notice = addressAskNotice([ask('missing_unit_number'), ask('address_unverified')]);

    expect(notice.unitOnly).toBe(true);
    expect(notice.reason).toBe('the caller gave the building but no unit number');
  });

  it('dedups candidates and caps the list', () => {
    const notice = addressAskNotice([
      ask('address_unverified', { address_candidates: ['A', 'A', 'B', 'C', 'D', 'E', 'F'] }),
    ]);

    expect(notice.candidates).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  // Two calls, two open cards: pairing one call's heard street with the
  // other's suggestions would point the operator at an unrelated property.
  it('takes the heard street and the candidates from the SAME card', () => {
    const notice = addressAskNotice([
      ask('address_unverified', { address_as_heard: '100 Port Ave East', address_candidates: ['100 4th Avenue East'] }),
      ask('address_unverified', { address_as_heard: '77 Sea Fawn Trl', address_candidates: ['77 Seafoam Trail'] }),
    ]);

    expect(notice.heard).toBe('100 Port Ave East');
    expect(notice.candidates).toEqual(['100 4th Avenue East']);
  });

  // Cards filed before recovery attached its predictions, and cards from a
  // pass where recovery never ran.
  it('degrades to the plain warning when the payload carries nothing', () => {
    expect(addressAskNotice([ask('address_unverified')])).toMatchObject({
      heard: null,
      candidates: [],
    });
    expect(addressAskNotice([ask('address_unverified', { address_candidates: 'nope' })]).candidates)
      .toEqual([]);
  });
});

// address_recovered / address_readback never block routing, so a call carrying
// only one of them auto-books AND dispatches on a street nobody confirmed —
// the same hole as an unvalidated address.
describe('read-back cards (validated premise, unconfirmed street)', () => {
  it('warns when a recovered street is the only open card', () => {
    const notice = addressAskNotice([
      ask('address_recovered', { address_as_heard: '100 Port Ave East', address_candidates: ['100 4th Avenue East'] }),
    ]);

    expect(notice).toMatchObject({
      readbackOnly: true,
      unitOnly: false,
      heard: '100 Port Ave East',
      candidates: ['100 4th Avenue East'],
    });
    expect(notice.reason).toMatch(/read back/i);
  });

  // address_readback is NOT a reconstructed street: AV accepted the premise and
  // only the extractor's confidence was low. Claiming recovery would tell the
  // operator something untrue about the record.
  it('warns on a low-confidence street WITHOUT claiming it was reconstructed', () => {
    const notice = addressAskNotice([ask('address_readback')]);

    expect(notice.readbackOnly).toBe(true);
    expect(notice.reason).toBe('the street validated, but it was heard with low confidence and has not been read back');
    expect(notice.reason).not.toMatch(/pieced back together/);
  });

  it('a recovered street says so explicitly', () => {
    expect(addressAskNotice([ask('address_recovered')]).reason)
      .toMatch(/pieced back together from a garbled recording/);
  });

  // A card that did not validate at all is the worse problem — it wins the copy.
  // Ids are explicit: these are two INDEPENDENT calls. The same two reason
  // codes on ONE call is the supersede case instead (recovery resolved that
  // call's hold), covered in its own describe below.
  it('a validation failure outranks a read-back card on another call', () => {
    const notice = addressAskNotice([
      ask('address_recovered', { address_as_heard: 'recovered one' }, 'call-A'),
      ask('address_unverified', { address_as_heard: 'unvalidated one' }, 'call-B'),
    ]);

    expect(notice.readbackOnly).toBe(false);
    expect(notice.heard).toBe('unvalidated one');
    expect(notice.reason).toBe('the address from the call did not validate');
  });

  // The estimate tool's panel is scoped to validation failures and must not
  // start claiming a recovered street "did not validate".
  it('filterAddressAsks stays validation-only; filterAddressConfirmations covers both', () => {
    const items = [ask('address_unverified'), ask('address_recovered'), ask('dropped_call')];

    expect(filterAddressAsks(items).map((i) => i.reason_code)).toEqual(['address_unverified']);
    expect(filterAddressConfirmations(items).map((i) => i.reason_code))
      .toEqual(['address_unverified', 'address_recovered']);
    expect([...ADDRESS_READBACK_REASONS]).toEqual(['address_recovered', 'address_readback']);
  });
});

// A PREMISE missing only its subpremise ALWAYS files both cards for the same
// call: address_unverified is the hold, missing_unit_number names the ask
// (call-triage-flags.js). If the generic card wins, the operator is told the
// address "did not validate" for a building we can actually find, and can book
// it with no door to knock on.
describe('missing unit number alongside its companion hold', () => {
  it('the same-call unit card defines the ask', () => {
    const notice = addressAskNotice([
      ask('address_unverified', { address_as_heard: '100 Port Ave East' }, 'call-1'),
      ask('missing_unit_number', {
        unit_ask_building: {
          street_line_1: '100 4th Avenue East',
          city: 'Palmetto',
          postal_code: '34221',
        },
      }, 'call-1'),
    ]);

    expect(notice.unitOnly).toBe(true);
    expect(notice.reason).toBe('the caller gave the building but no unit number');
    // The validated building belongs to the unit card. It is not a
    // transcription and must never be labelled "heard as".
    expect(notice.heard).toBeNull();
    expect(notice.building).toBe('100 4th Avenue East, Palmetto, 34221');
  });

  // Call A is a known building missing its unit; call B genuinely did not
  // validate. B is the worse problem and must not be hidden behind A's unit
  // ask just because A was selected first.
  it('a genuine validation failure on another call outranks a unit ask', () => {
    const notice = addressAskNotice([
      ask('address_unverified', { address_as_heard: 'A building' }, 'call-A'),
      ask('missing_unit_number', null, 'call-A'),
      ask('address_unverified', { address_as_heard: 'B unvalidated' }, 'call-B'),
    ]);

    expect(notice.unitOnly).toBe(false);
    expect(notice.reason).toBe('the address from the call did not validate');
    expect(notice.heard).toBe('B unvalidated');
    expect(notice.building).toBeNull();
  });

  // An unrelated call that simply failed validation must keep generic priority
  // — its address is not "a known building missing a unit".
  it('an unrelated call\'s generic failure is NOT relabelled as a unit ask', () => {
    const notice = addressAskNotice([
      ask('address_unverified', { address_as_heard: 'unvalidated one' }, 'call-1'),
      ask('missing_unit_number', null, 'call-2'),
    ]);

    expect(notice.unitOnly).toBe(false);
    expect(notice.reason).toBe('the address from the call did not validate');
    expect(notice.heard).toBe('unvalidated one');
    expect(notice.building).toBeNull();
  });

  it('does not call a unit building a heard street even if the card carries both fields', () => {
    const notice = addressAskNotice([
      ask('missing_unit_number', {
        address_as_heard: 'synthetic transcription',
        unit_ask_building: { street_line_1: '44 Harbor Way' },
      }, 'call-1'),
    ]);

    expect(notice.heard).toBeNull();
    expect(notice.building).toBe('44 Harbor Way');
  });
});

// Reprocessing a call from failed to successful recovery files a NEW
// address_recovered card and leaves the old address_unverified card active.
// Different reason codes, so no payload merge can update the stale one.
describe('a successful recovery supersedes the same call\'s stale hold', () => {
  it('shows the recovered street, not "did not validate"', () => {
    const notice = addressAskNotice([
      ask('address_unverified', { address_as_heard: '100 Port Ave East' }, 'call-1'),
      ask('address_recovered', { address_as_heard: '100 Port Ave East', address_candidates: ['100 4th Avenue East'] }, 'call-1'),
    ]);

    expect(notice.readbackOnly).toBe(true);
    expect(notice.reason).toMatch(/pieced back together/);
    expect(notice.candidates).toEqual(['100 4th Avenue East']);
  });

  it('does not supersede a DIFFERENT call\'s validation failure', () => {
    const notice = addressAskNotice([
      ask('address_unverified', { address_as_heard: 'B unvalidated' }, 'call-B'),
      ask('address_recovered', null, 'call-A'),
    ]);

    expect(notice.readbackOnly).toBe(false);
    expect(notice.reason).toBe('the address from the call did not validate');
  });

  // Recovery fixed the street and a unit is still owed. The stale hold drops
  // out, leaving the read-back (rank 1) ahead of the unit ask (rank 2) on the
  // existing precedence — the operator is told the street was reconstructed,
  // and confirms the whole address, unit included, on that same callback.
  it('leads with the read-back when a unit is also owed', () => {
    const notice = addressAskNotice([
      ask('address_unverified', null, 'call-1'),
      ask('address_recovered', null, 'call-1'),
      ask('missing_unit_number', null, 'call-1'),
    ]);

    expect(notice.readbackOnly).toBe(true);
    expect(notice.reason).toMatch(/pieced back together/);
  });
  // Recovered once, then reprocessed with recovery FAILING: the processor keeps
  // the address_recovered card open but stamps recovery_superseded_at. Treating
  // it as live would claim the street was reconstructed when this pass could
  // not reconstruct it.
  it('an invalidated recovery card does NOT suppress the live validation failure', () => {
    const notice = addressAskNotice([
      ask('address_unverified', { address_as_heard: '100 Port Ave East' }, 'call-1'),
      ask('address_recovered', { recovery_superseded_at: '2026-09-12T04:00:00.000Z' }, 'call-1'),
    ]);

    expect(notice.readbackOnly).toBe(false);
    expect(notice.reason).toBe('the address from the call did not validate');
    expect(notice.heard).toBe('100 Port Ave East');
  });

  it('a retired recovery does NOT outrank the same call\'s current unit ask', () => {
    const notice = addressAskNotice([
      ask('address_unverified', null, 'call-1'),
      ask('missing_unit_number', null, 'call-1'),
      ask('address_recovered', { recovery_superseded_at: '2026-09-12T04:00:00.000Z' }, 'call-1'),
    ]);

    expect(notice.readbackOnly).toBe(false);
    expect(notice.unitOnly).toBe(true);
    expect(notice.reason).toBe('the caller gave the building but no unit number');
  });

  it('keeps a retired recovery as an owed historical read-back when it is the only card', () => {
    const notice = addressAskNotice([
      ask('address_recovered', { recovery_superseded_at: '2026-09-12T04:00:00.000Z' }, 'call-1'),
    ]);

    expect(notice.readbackOnly).toBe(true);
    expect(notice.reason).toMatch(/pieced back together/);
  });
});
