import { describe, expect, it } from 'vitest';
import {
  ADDRESS_ASK_REASONS,
  ADDRESS_READBACK_REASONS,
  addressAskNotice,
  filterAddressAsks,
  filterAddressConfirmations,
} from './addressAsks';

const ask = (reason_code, payload = null, call_log_id = null, id = null) => ({
  id, reason_code, payload, call_log_id,
});
const notice = (...cards) => addressAskNotice(cards);
const lowerPriorityReasons = [...ADDRESS_ASK_REASONS, ...ADDRESS_READBACK_REASONS]
  .filter((reason) => reason !== 'on_file_proof_customer_mismatch');
const mismatchPriorityCases = lowerPriorityReasons.flatMap((reason) => (
  [true, false].flatMap((sameCall) => [true, false].map((mismatchFirst) => ({
    reason, sameCall, mismatchFirst,
  })))
));

describe('filterAddressAsks', () => {
  it('keeps validation-ask cards only', () => {
    const items = [
      ask('address_unverified'),
      ask('missing_unit_number'),
      ask('property_role_confirm'),
      ask('second_address_mentioned'),
      ask('dropped_call'),
    ];
    expect(filterAddressAsks(items).map((i) => i.reason_code))
      .toEqual(['address_unverified', 'missing_unit_number']);
  });

  it.each([undefined, null, {}, [null, undefined]])('survives malformed items: %j', (items) => {
    expect(filterAddressAsks(items)).toEqual([]);
  });

  it('covers the routing gate validation reasons', () => {
    expect([...ADDRESS_ASK_REASONS]).toEqual(expect.arrayContaining([
      'address_unverified', 'missing_service_address', 'address_unverifiable',
    ]));
  });
});

describe('addressAskNotice', () => {
  it('is null when nothing is owed', () => {
    expect(addressAskNotice([])).toBeNull();
    expect(notice(ask('property_role_confirm'))).toBeNull();
  });

  it('warns when only saved-address proof for another customer remains', () => {
    const result = notice(ask('on_file_proof_customer_mismatch', null, 'call-a'));
    expect(result).toMatchObject({ unitOnly: false, readbackOnly: false });
    expect(result.reason).toContain('different customer');
  });

  it.each(mismatchPriorityCases)(
    'customer mismatch outranks $reason (sameCall=$sameCall, first=$mismatchFirst)',
    ({ reason, sameCall, mismatchFirst }) => {
      const mismatch = ask('on_file_proof_customer_mismatch', null, 'call-a');
      const other = ask(reason, {
        address_as_heard: 'lower-priority evidence',
        unit_ask_building: { street_line_1: '100 Test Harbor Drive' },
      }, sameCall ? 'call-a' : 'call-b');
      const result = addressAskNotice(mismatchFirst ? [mismatch, other] : [other, mismatch]);
      expect(result).toMatchObject({
        unitOnly: false, readbackOnly: false, heard: null, building: null,
      });
      expect(result.reason).toContain('different customer');
    },
  );

  it('unit and recovery companions cannot hide a mismatch', () => {
    const result = notice(
      ask('missing_unit_number', null, 'call-a'),
      ask('address_recovered', { address_as_heard: '100 Port Ave East' }, 'call-a'),
      ask('on_file_proof_customer_mismatch', null, 'call-a'),
    );
    expect(result).toMatchObject({ unitOnly: false, readbackOnly: false, heard: null });
    expect(result.reason).toContain('different customer');
  });

  it('keeps mismatch copy after validation-only filtering', () => {
    const result = addressAskNotice(filterAddressAsks([
      ask('address_unverified', { address_as_heard: 'generic hold' }, 'call-a'),
      ask('on_file_proof_customer_mismatch', null, 'call-a'),
      ask('address_recovered', { address_as_heard: 'filtered recovery' }, 'call-a'),
    ]));
    expect(result).toMatchObject({ unitOnly: false, heard: null, building: null });
    expect(result.reason).toContain('different customer');
  });

  it('names the heard street and recovery candidates', () => {
    expect(notice(ask('address_unverified', {
      address_as_heard: '100 Port Ave East',
      address_candidates: ['100 4th Avenue East, Palmetto, FL 34221, USA'],
    }))).toMatchObject({
      unitOnly: false,
      reason: 'the address from the call did not validate',
      heard: '100 Port Ave East',
      candidates: ['100 4th Avenue East, Palmetto, FL 34221, USA'],
    });
  });

  it('reports a lone missing-unit ask', () => {
    expect(notice(ask('missing_unit_number'))).toMatchObject({
      unitOnly: true, reason: 'the caller gave the building but no unit number',
    });
  });

  it('treats a same-call generic hold as the unit companion', () => {
    expect(notice(ask('missing_unit_number'), ask('address_unverified'))).toMatchObject({
      unitOnly: true, reason: 'the caller gave the building but no unit number',
    });
  });

  it('deduplicates and caps candidates', () => {
    expect(notice(ask('address_unverified', {
      address_candidates: ['A', 'A', 'B', 'C', 'D', 'E', 'F'],
    })).candidates).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('takes heard street and candidates from one card', () => {
    expect(notice(
      ask('address_unverified', {
        address_as_heard: '100 Port Ave East', address_candidates: ['100 4th Avenue East'],
      }),
      ask('address_unverified', {
        address_as_heard: '77 Sea Fawn Trl', address_candidates: ['77 Seafoam Trail'],
      }),
    )).toMatchObject({ heard: '100 Port Ave East', candidates: ['100 4th Avenue East'] });
  });

  it('degrades when evidence is absent or malformed', () => {
    expect(notice(ask('address_unverified'))).toMatchObject({ heard: null, candidates: [] });
    expect(notice(ask('address_unverified', { address_candidates: 'nope' })).candidates)
      .toEqual([]);
  });

  it.each([
    [{ street_line_1: '100 4th Avenue East', street_line_2: 'Suite 2', city: 'Palmetto', postal_code: '34221', raw_text: 'ignored raw' }, '100 4th Avenue East, Suite 2, Palmetto, 34221'],
    [{ street_line_1: null, city: 'Palmetto', postal_code: '34221', raw_text: '100 fourth avenue east near the marina' }, '100 fourth avenue east near the marina'],
  ])('uses the filing-time heard snapshot %#', (heard_address, expected) => {
    expect(notice(ask('address_unverified', { heard_address })).heard).toBe(expected);
  });

  it('keeps snapshot evidence and candidates on one card', () => {
    expect(notice(
      ask('address_unverified', {
        heard_address: { street_line_1: '100 First Card Way' },
        address_candidates: ['100 First Candidate Way'],
      }, 'call-a'),
      ask('address_unverified', {
        heard_address: { street_line_1: '200 Second Card Way' },
        address_candidates: ['200 Second Candidate Way'],
      }, 'call-b'),
    )).toMatchObject({ heard: '100 First Card Way', candidates: ['100 First Candidate Way'] });
  });

  it('distinguishes identical visible evidence from replacement cards and calls', () => {
    const payload = { address_as_heard: 'same', address_candidates: ['same candidate'] };
    const first = notice(ask('address_unverified', payload, 'call-a', 'card-a'));
    const replacement = notice(ask('address_unverified', payload, 'call-b', 'card-b'));
    expect(first).toMatchObject({ cardId: 'card-a', callId: 'call-a' });
    expect(replacement).toMatchObject({ cardId: 'card-b', callId: 'call-b' });
    expect({ ...first, cardId: null, callId: null })
      .toEqual({ ...replacement, cardId: null, callId: null });
  });

  it('returns null identity for legacy cards without ids', () => {
    expect(notice(ask('address_unverified'))).toMatchObject({ cardId: null, callId: null });
  });

  it.each([
    ['unit companion', [
      ask('address_unverified', { address_as_heard: 'generic' }, 'call-unit', 'generic-card'),
      ask('missing_unit_number', null, 'call-unit', 'unit-card'),
    ], { cardId: 'unit-card', callId: 'call-unit' }],
    ['live recovery', [
      ask('address_unverified', { address_as_heard: 'stale' }, 'call-recovery', 'stale-card'),
      ask('address_recovered', { address_as_heard: 'recovered' }, 'call-recovery', 'recovery-card'),
    ], { cardId: 'recovery-card', callId: 'call-recovery' }],
    ['customer mismatch', [
      ask('address_unverified', { address_as_heard: 'other' }, 'call-other', 'other-card'),
      ask('on_file_proof_customer_mismatch', null, 'call-mismatch', 'mismatch-card'),
    ], { cardId: 'mismatch-card', callId: 'call-mismatch' }],
  ])('takes identity from the selected %s', (_selection, cards, expected) => {
    expect(addressAskNotice(cards)).toMatchObject(expected);
  });
});

describe('read-back cards', () => {
  it('warns when a recovered street is the only card', () => {
    const result = notice(ask('address_recovered', {
      address_as_heard: '100 Port Ave East', address_candidates: ['100 4th Avenue East'],
    }));
    expect(result).toMatchObject({
      readbackOnly: true,
      unitOnly: false,
      heard: '100 Port Ave East',
      candidates: ['100 4th Avenue East'],
    });
    expect(result.reason).toMatch(/read back/i);
  });

  it('describes low confidence without claiming recovery', () => {
    const result = notice(ask('address_readback'));
    expect(result).toMatchObject({
      readbackOnly: true,
      reason: 'the street validated, but it was heard with low confidence and has not been read back',
    });
    expect(result.reason).not.toMatch(/pieced back together/);
  });

  it('describes a recovered street explicitly', () => {
    expect(notice(ask('address_recovered')).reason)
      .toMatch(/pieced back together from a garbled recording/);
  });

  it('lets another call validation failure outrank read-back', () => {
    expect(notice(
      ask('address_recovered', { address_as_heard: 'recovered one' }, 'call-A'),
      ask('address_unverified', { address_as_heard: 'unvalidated one' }, 'call-B'),
    )).toMatchObject({
      readbackOnly: false,
      heard: 'unvalidated one',
      reason: 'the address from the call did not validate',
    });
  });

  it('keeps validation and read-back filters distinct', () => {
    const items = [ask('address_unverified'), ask('address_recovered'), ask('dropped_call')];
    expect(filterAddressAsks(items).map((i) => i.reason_code)).toEqual(['address_unverified']);
    expect(filterAddressConfirmations(items).map((i) => i.reason_code))
      .toEqual(['address_unverified', 'address_recovered']);
    expect([...ADDRESS_READBACK_REASONS]).toEqual(['address_recovered', 'address_readback']);
  });
});

describe('missing unit companions', () => {
  it('takes the ask and validated building from the same-call unit card', () => {
    expect(notice(
      ask('address_unverified', { address_as_heard: '100 Port Ave East' }, 'call-1'),
      ask('missing_unit_number', { unit_ask_building: {
        street_line_1: '100 4th Avenue East', city: 'Palmetto', postal_code: '34221',
      } }, 'call-1'),
    )).toMatchObject({
      unitOnly: true,
      reason: 'the caller gave the building but no unit number',
      heard: null,
      building: '100 4th Avenue East, Palmetto, 34221',
    });
  });

  it('lets another call validation failure outrank a unit pair', () => {
    expect(notice(
      ask('address_unverified', { address_as_heard: 'A building' }, 'call-A'),
      ask('missing_unit_number', null, 'call-A'),
      ask('address_unverified', { address_as_heard: 'B unvalidated' }, 'call-B'),
    )).toMatchObject({
      unitOnly: false,
      reason: 'the address from the call did not validate',
      heard: 'B unvalidated',
      building: null,
    });
  });

  it('does not relabel an unrelated call failure as a unit ask', () => {
    expect(notice(
      ask('address_unverified', { address_as_heard: 'unvalidated one' }, 'call-1'),
      ask('missing_unit_number', null, 'call-2'),
    )).toMatchObject({
      unitOnly: false,
      reason: 'the address from the call did not validate',
      heard: 'unvalidated one',
      building: null,
    });
  });

  it('never labels a unit building as heard evidence', () => {
    expect(notice(ask('missing_unit_number', {
      address_as_heard: 'synthetic transcription',
      heard_address: { street_line_1: 'snapshot' },
      unit_ask_building: { street_line_1: '44 Harbor Way' },
    }, 'call-1'))).toMatchObject({ heard: null, building: '44 Harbor Way' });
  });
});

describe('same-call recovery supersession', () => {
  it('shows recovered evidence instead of the stale generic hold', () => {
    const result = notice(
      ask('address_unverified', { address_as_heard: '100 Port Ave East' }, 'call-1'),
      ask('address_recovered', {
        address_as_heard: '100 Port Ave East', address_candidates: ['100 4th Avenue East'],
      }, 'call-1'),
    );
    expect(result).toMatchObject({ readbackOnly: true, candidates: ['100 4th Avenue East'] });
    expect(result.reason).toMatch(/pieced back together/);
  });

  it('does not supersede another call validation failure', () => {
    expect(notice(
      ask('address_unverified', { address_as_heard: 'B unvalidated' }, 'call-B'),
      ask('address_recovered', null, 'call-A'),
    )).toMatchObject({
      readbackOnly: false, reason: 'the address from the call did not validate',
    });
  });

  it('leads with read-back when a unit is also owed', () => {
    const result = notice(
      ask('address_unverified', null, 'call-1'),
      ask('address_recovered', null, 'call-1'),
      ask('missing_unit_number', null, 'call-1'),
    );
    expect(result.readbackOnly).toBe(true);
    expect(result.reason).toMatch(/pieced back together/);
  });

  it('does not let retired recovery suppress a current failure', () => {
    expect(notice(
      ask('address_unverified', { address_as_heard: '100 Port Ave East' }, 'call-1'),
      ask('address_recovered', { recovery_superseded_at: '2026-09-12T04:00:00.000Z' }, 'call-1'),
    )).toMatchObject({
      readbackOnly: false,
      reason: 'the address from the call did not validate',
      heard: '100 Port Ave East',
    });
  });

  it('does not let retired recovery outrank a current unit ask', () => {
    expect(notice(
      ask('address_unverified', null, 'call-1'),
      ask('missing_unit_number', null, 'call-1'),
      ask('address_recovered', { recovery_superseded_at: '2026-09-12T04:00:00.000Z' }, 'call-1'),
    )).toMatchObject({
      readbackOnly: false,
      unitOnly: true,
      reason: 'the caller gave the building but no unit number',
    });
  });

  it('keeps a lone retired recovery as an owed historical read-back', () => {
    const result = notice(ask(
      'address_recovered', { recovery_superseded_at: '2026-09-12T04:00:00.000Z' }, 'call-1',
    ));
    expect(result.readbackOnly).toBe(true);
    expect(result.reason).toMatch(/pieced back together/);
  });
});
