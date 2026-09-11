import { describe, expect, it } from 'vitest';
import {
  ADDRESS_ASK_REASONS,
  ADDRESS_READBACK_REASONS,
  addressAskNotice,
  filterAddressAsks,
  filterAddressConfirmations,
} from './addressAsks';

const ask = (reason_code, payload = null) => ({ reason_code, payload });

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

  it('is not unit-only when a validation ask sits alongside it', () => {
    const notice = addressAskNotice([ask('missing_unit_number'), ask('address_unverified')]);

    expect(notice.unitOnly).toBe(false);
    expect(notice.reason).toBe('the address from the call did not validate');
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
  it('a validation failure outranks a read-back card', () => {
    const notice = addressAskNotice([
      ask('address_recovered', { address_as_heard: 'recovered one' }),
      ask('address_unverified', { address_as_heard: 'unvalidated one' }),
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
