// Property-role classification → fill-or-park (GATE_CALL_PROPERTY_ROLE).
// Origin: a 2026-08-13 multi-property call — the pipeline recorded the
// caller's new primary residence as a secondary property and left the serviced
// rental flagged primary; the correction was a careful by-hand runbook.
// These tests pin the mechanized version of that runbook.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  buildPropertyRoleProposals,
  classifiedPropertiesFromExtraction,
  applyPropertyRoleProposals,
} = require('../services/property-role-proposals');

const OLD_HOME = {
  id: 'prop-old', address_line1: '8380 Sea Breeze Ct', address_line2: null,
  city: 'Bradenton', zip: '34212', occupancy_type: 'owner_occupied', is_primary: true, label: 'Primary',
};
const NEW_HOME = {
  id: 'prop-new', address_line1: '660 Shell Cove', address_line2: null,
  city: 'Bradenton', zip: '34212', occupancy_type: 'unknown', is_primary: false, label: null,
};

describe('classifiedPropertiesFromExtraction', () => {
  test('main address + extras with occupancy fallbacks and tri-state primary flags', () => {
    const out = classifiedPropertiesFromExtraction(
      {
        address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212',
        service_address_occupancy: 'owner_occupied', service_address_is_primary_residence: true,
      },
      [
        { address_line1: '8380 Sea Breeze Ct', city: 'Bradenton', zip: '34212', occupancy: 'rental_investment', is_primary_residence: false },
        { address_line1: '12 Legacy St', city: 'Venice', zip: '34285', is_rental: true }, // legacy V1 shape
      ],
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ occupancy: 'owner_occupied', is_primary_residence: true });
    expect(out[1]).toMatchObject({ occupancy: 'rental_investment', is_primary_residence: false });
    expect(out[2]).toMatchObject({ occupancy: 'rental_investment', is_primary_residence: null });
  });

  test('unstated signals stay null — never coerced', () => {
    const [main] = classifiedPropertiesFromExtraction({ address_line1: '1 Main St' }, []);
    expect(main.occupancy).toBeNull();
    expect(main.is_primary_residence).toBeNull();
  });
});

describe('buildPropertyRoleProposals', () => {
  test('the new-home-plus-rental case: flip proposal + rental reclassification of the old primary', () => {
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: 'owner_occupied', is_primary_residence: true, evidence: 'we live at the new house' },
        { address_line1: '8380 Sea Breeze Ct', city: 'Bradenton', zip: '34212', occupancy: 'rental_investment', is_primary_residence: false, evidence: null },
      ],
      properties: [OLD_HOME, NEW_HOME],
    });
    // The new home's stored occupancy is 'unknown' → direct fill, not a proposal.
    expect(fills).toEqual([{ property_id: 'prop-new', occupancy: 'owner_occupied' }]);
    const flip = proposals.find((p) => p.kind === 'primary_flip');
    expect(flip).toMatchObject({
      new_primary_property_id: 'prop-new',
      old_primary_property_id: 'prop-old',
      old_primary_occupancy: 'rental_investment',
      old_primary_label: 'Rental',
    });
    // Sea Breeze owner_occupied → rental_investment is a stored-fact CHANGE → parked.
    const occ = proposals.find((p) => p.kind === 'occupancy_change');
    expect(occ).toMatchObject({ property_id: 'prop-old', current_occupancy: 'owner_occupied', proposed_occupancy: 'rental_investment' });
  });

  test('a primary claim contradicted by its own non-owner occupancy is dropped', () => {
    const { proposals } = buildPropertyRoleProposals({
      classified: [{ address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: 'rental_investment', is_primary_residence: true }],
      properties: [OLD_HOME, NEW_HOME],
    });
    expect(proposals.filter((p) => p.kind === 'primary_flip')).toHaveLength(0);
  });

  test('two primary-residence claimants = contradiction — no flip proposed', () => {
    const { proposals } = buildPropertyRoleProposals({
      classified: [
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true },
        { address_line1: '8380 Sea Breeze Ct', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true },
      ],
      properties: [OLD_HOME, NEW_HOME],
    });
    expect(proposals.filter((p) => p.kind === 'primary_flip')).toHaveLength(0);
  });

  test('claim on the row that is ALREADY primary proposes nothing', () => {
    const { proposals } = buildPropertyRoleProposals({
      classified: [{ address_line1: '8380 Sea Breeze Ct', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true }],
      properties: [OLD_HOME, NEW_HOME],
    });
    expect(proposals).toHaveLength(0);
  });

  test('an address with no matching stored row is ignored (nothing durable to label)', () => {
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [{ address_line1: '99 Nowhere Ln', city: 'Venice', zip: '34285', occupancy: 'seasonal', is_primary_residence: true }],
      properties: [OLD_HOME],
    });
    expect(fills).toHaveLength(0);
    expect(proposals).toHaveLength(0);
  });

  // The extraction schema doesn't enforce unique addresses — one property can
  // appear as the main entry AND again in additional_properties (codex r6).
  test('duplicate entries for one address with CONFLICTING occupancies drop that occupancy signal', () => {
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: 'seasonal', is_primary_residence: null },
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: 'rental_investment', is_primary_residence: null },
      ],
      properties: [OLD_HOME, NEW_HOME],
    });
    expect(fills).toHaveLength(0); // stored 'unknown' — but the model contradicted itself, so no first-write-wins fill
    expect(proposals).toHaveLength(0);
  });

  test('duplicate entries for one address with complementary signals merge into ONE classification', () => {
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true },
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: 'owner_occupied', is_primary_residence: null },
      ],
      properties: [OLD_HOME, NEW_HOME],
    });
    expect(fills).toEqual([{ property_id: 'prop-new', occupancy: 'owner_occupied' }]);
    // Merged = ONE primary claimant, not two — the flip still proposes.
    expect(proposals.filter((p) => p.kind === 'primary_flip')).toHaveLength(1);
  });

  test('conflicting primary-residence claims on ONE address drop the claim; agreeing duplicates count once', () => {
    const conflicted = buildPropertyRoleProposals({
      classified: [
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true },
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: false },
      ],
      properties: [OLD_HOME, NEW_HOME],
    });
    expect(conflicted.proposals.filter((p) => p.kind === 'primary_flip')).toHaveLength(0);
    const agreeing = buildPropertyRoleProposals({
      classified: [
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true },
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true },
      ],
      properties: [OLD_HOME, NEW_HOME],
    });
    // Same address twice ≠ two claimant properties — no false contradiction.
    expect(agreeing.proposals.filter((p) => p.kind === 'primary_flip')).toHaveLength(1);
  });

  test('a flip onto a row STORED as rental adds a companion occupancy_change to owner_occupied (codex r7)', () => {
    const rentalStoredNew = { ...NEW_HOME, occupancy_type: 'rental_investment' };
    const { proposals } = buildPropertyRoleProposals({
      classified: [{ address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true }],
      properties: [OLD_HOME, rentalStoredNew],
    });
    expect(proposals.filter((p) => p.kind === 'primary_flip')).toHaveLength(1);
    // The promote's occupancy fence only fills 'unknown' — the stored
    // conflict must ride the same card as an explicit reviewed change.
    const companion = proposals.filter((p) => p.kind === 'occupancy_change' && p.property_id === 'prop-new');
    expect(companion).toEqual([expect.objectContaining({ current_occupancy: 'rental_investment', proposed_occupancy: 'owner_occupied' })]);
  });

  test('a primary claim on a COMMERCIAL-typed row proposes no flip (taxability rider — codex r8)', () => {
    const commercialNew = { ...NEW_HOME, property_type: 'commercial' };
    const { proposals } = buildPropertyRoleProposals({
      classified: [{ address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true }],
      properties: [OLD_HOME, commercialNew],
    });
    expect(proposals).toHaveLength(0);
  });

  test('a residence claim rejected against a commercial row drops its occupancy signal too (codex r14)', () => {
    const commercialNew = { ...NEW_HOME, property_type: 'commercial', occupancy_type: 'unknown' };
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [{ address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: 'owner_occupied', is_primary_residence: true }],
      properties: [OLD_HOME, commercialNew],
    });
    // Neither the owner_occupied fill nor a flip — the whole claim is
    // contradictory against a commercial-typed row.
    expect(fills).toHaveLength(0);
    expect(proposals).toHaveLength(0);
  });

  test('a partial street-only address matches a UNIQUE stored property; ambiguous streets stay dropped (codex r19)', () => {
    const unique = buildPropertyRoleProposals({
      classified: [{ address_line1: '660 Shell Cove', city: null, zip: null, occupancy: 'seasonal', is_primary_residence: null }],
      properties: [OLD_HOME, NEW_HOME],
    });
    // NEW_HOME is the only Shell Cove row — the partial entry resolves to
    // it and its unknown occupancy takes the fill.
    expect(unique.fills).toEqual([{ property_id: 'prop-new', occupancy: 'seasonal' }]);
    const twin = { ...NEW_HOME, id: 'prop-twin', city: 'Venice', zip: '34285' };
    const ambiguous = buildPropertyRoleProposals({
      classified: [{ address_line1: '660 Shell Cove', city: null, zip: null, occupancy: 'seasonal', is_primary_residence: null }],
      properties: [OLD_HOME, NEW_HOME, twin],
    });
    expect(ambiguous.fills).toHaveLength(0);
    expect(ambiguous.proposals).toHaveLength(0);
    // A FULL address that failed the exact key names a DIFFERENT property —
    // never fuzzy-matched.
    const fullMiss = buildPropertyRoleProposals({
      classified: [{ address_line1: '660 Shell Cove', city: 'Venice', zip: '34293', occupancy: 'seasonal', is_primary_residence: null }],
      properties: [OLD_HOME, NEW_HOME],
    });
    expect(fullMiss.fills).toHaveLength(0);
    expect(fullMiss.proposals).toHaveLength(0);
  });

  test('full + street-only duplicates resolving to ONE row re-dedupe — conflicting occupancies drop (codex r20)', () => {
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: 'seasonal', is_primary_residence: null },
        // Same property stated again by street only, with a DIFFERENT occupancy.
        { address_line1: '660 Shell Cove', city: null, zip: null, occupancy: 'rental_investment', is_primary_residence: null },
      ],
      properties: [OLD_HOME, NEW_HOME],
    });
    // Both resolve to prop-new — the model contradicted itself about ONE
    // property, so the occupancy signal drops instead of array order
    // winning the unknown-row fill.
    expect(fills).toHaveLength(0);
    expect(proposals).toHaveLength(0);
    // Complementary duplicates across the two forms still merge.
    const merged = buildPropertyRoleProposals({
      classified: [
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true },
        { address_line1: '660 Shell Cove', city: null, zip: null, occupancy: 'owner_occupied', is_primary_residence: null },
      ],
      properties: [OLD_HOME, NEW_HOME],
    });
    expect(merged.fills).toEqual([{ property_id: 'prop-new', occupancy: 'owner_occupied' }]);
    expect(merged.proposals.filter((p) => p.kind === 'primary_flip')).toHaveLength(1);
  });

  test('a non-owner classification on the UNKNOWN current primary parks instead of filling (codex r21)', () => {
    const unknownPrimary = { ...OLD_HOME, occupancy_type: 'unknown' };
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [
        { address_line1: '8380 Sea Breeze Ct', city: 'Bradenton', zip: '34212', occupancy: 'rental_investment', is_primary_residence: false },
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: 'owner_occupied', is_primary_residence: true },
      ],
      properties: [unknownPrimary, NEW_HOME],
    });
    // The rental classification of the CURRENT primary must ride the card,
    // not commit during staging — a dismissed card must leave no inverted
    // state. The non-primary unknown row still fills directly.
    expect(fills).toEqual([{ property_id: 'prop-new', occupancy: 'owner_occupied' }]);
    const parked = proposals.find((p) => p.kind === 'occupancy_change' && p.property_id === 'prop-old');
    expect(parked).toMatchObject({ current_occupancy: 'unknown', proposed_occupancy: 'rental_investment' });
    expect(proposals.filter((p) => p.kind === 'primary_flip')).toHaveLength(1);
  });

  test('a commercial type on ANY duplicate entry survives the merge and vetoes the residence claim (codex r29)', () => {
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [
        // Main entry first: type-less residence claim on the unknown row…
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true, property_type: null },
        // …duplicated in additional_properties WITH the commercial type.
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: null, property_type: 'office' },
      ],
      properties: [OLD_HOME, NEW_HOME],
    });
    expect(fills).toHaveLength(0);
    expect(proposals.filter((p) => p.kind === 'primary_flip')).toHaveLength(0);
  });

  test('proposals carry the staged address_key (codex r19)', () => {
    const { proposals } = buildPropertyRoleProposals({
      classified: [
        { address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true },
        { address_line1: '8380 Sea Breeze Ct', city: 'Bradenton', zip: '34212', occupancy: 'rental_investment', is_primary_residence: false },
      ],
      properties: [OLD_HOME, NEW_HOME],
    });
    const occ = proposals.find((p) => p.kind === 'occupancy_change');
    const flip = proposals.find((p) => p.kind === 'primary_flip');
    expect(occ.address_key).toBeTruthy();
    expect(flip.new_primary_address_key).toBeTruthy();
    expect(flip.old_primary_address_key).toBeTruthy();
  });

  test('matching stored occupancy produces neither fill nor proposal', () => {
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [{ address_line1: '8380 Sea Breeze Ct', city: 'Bradenton', zip: '34212', occupancy: 'owner_occupied', is_primary_residence: null }],
      properties: [OLD_HOME],
    });
    expect(fills).toHaveLength(0);
    expect(proposals).toHaveLength(0);
  });
});

describe('applyPropertyRoleProposals (primary-flip runbook)', () => {
  // Minimal fluent fake of the knex trx surface the apply path uses.
  function makeTrx({ rows }) {
    const updates = [];
    const trx = (table) => {
      const q = {
        _table: table, _wheres: [], _whereNulls: [], _whereNotIn: null,
        where(w) { this._wheres.push(w); return this; },
        whereNull(c) { this._whereNulls.push(c); return this; },
        whereNotNull(c) { this._whereNotNulls = (this._whereNotNulls || []).concat(c); return this; },
        forUpdate() { return this; },
        select() { return this; },
        whereNotIn(c, v) { this._whereNotIn = [c, v]; return this; },
        whereIn(c, v) { this._whereIns = (this._whereIns || []).concat([[c, v]]); return this; },
        // Awaiting a bare builder (a SELECT list) resolves the rows that
        // match the recorded predicates — same honoring as update().
        then(resolve, reject) {
          const preds = Object.assign({}, ...this._wheres.filter((w) => typeof w === 'object'));
          const hits = (rows[table] || []).filter((r) => Object.entries(preds).every(([k, v]) => r[k] === v)
            && this._whereNulls.every((c) => r[c] == null)
            && (this._whereNotNulls || []).every((c) => r[c] != null)
            && (this._whereIns || []).every(([c, v]) => v.includes(r[c]))
            && (!this._whereNotIn || !this._whereNotIn[1].includes(r[this._whereNotIn[0]])));
          return Promise.resolve(hits).then(resolve, reject);
        },
        async first() {
          const preds = Object.assign({}, ...this._wheres);
          return (rows[table] || []).find((r) => Object.entries(preds).every(([k, v]) => r[k] === v)) || null;
        },
        async update(patch) {
          updates.push({ table, wheres: this._wheres, whereNulls: this._whereNulls, whereNotIn: this._whereNotIn, patch });
          const preds = Object.assign({}, ...this._wheres.filter((w) => typeof w === 'object'));
          // Honor whereNull/whereIn/whereNotIn like the real builder — the
          // label fences and the terminal-status pin exclusion are
          // load-bearing in the promote/relabel/parent-stamp assertions.
          const hits = (rows[table] || []).filter((r) => Object.entries(preds).every(([k, v]) => r[k] === v)
            && this._whereNulls.every((c) => r[c] == null)
            && (this._whereIns || []).every(([c, v]) => v.includes(r[c]))
            && (!this._whereNotIn || !this._whereNotIn[1].includes(r[this._whereNotIn[0]])));
          // COALESCE(col, ?) raws evaluate like SQL: keep a present value,
          // fill a null one — matching the fill-only patch semantics.
          hits.forEach((r) => {
            for (const [k, v] of Object.entries(patch)) {
              const m = v && v.__raw && String(v.__raw).match(/^COALESCE\((\w+), \?\)$/);
              r[k] = m ? (r[m[1]] != null ? r[m[1]] : v.bindings[0]) : v;
            }
          });
          return hits.length;
        },
      };
      return q;
    };
    trx.raw = (sql, bindings) => ({ __raw: sql, bindings });
    trx.schema = { hasColumn: async () => true };
    trx._updates = updates;
    return trx;
  }

  test('pins unstamped pending visits to the OLD primary, demotes, promotes, re-mirrors', async () => {
    const old = { ...OLD_HOME, state: 'FL', latitude: 27.4, longitude: -82.4 };
    const neu = { ...NEW_HOME, state: 'FL', latitude: 27.5, longitude: -82.37, active: true, customer_id: 'cust-1' };
    old.active = true; old.customer_id = 'cust-1';
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [] } });

    const { applied, skipped } = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [
        // The staged card carries the old primary's reclassification as its
        // own CAS-fenced proposal; the demote label derives from the row's
        // post-CAS occupancy (r12), so the pair is the realistic shape.
        { kind: 'occupancy_change', property_id: 'prop-old', current_occupancy: 'owner_occupied', proposed_occupancy: 'rental_investment' },
        {
          kind: 'primary_flip',
          new_primary_property_id: 'prop-new',
          old_primary_property_id: 'prop-old',
          old_primary_occupancy: 'rental_investment',
          old_primary_label: 'Rental',
        },
      ],
    });
    expect({ applied, skipped }).toEqual({ applied: 2, skipped: 0 });

    const u = trx._updates;
    // 1. visit pinning targets the old primary, only unstamped non-terminal rows
    const pin = u.find((x) => x.table === 'scheduled_services');
    expect(pin.patch).toMatchObject({ property_id: 'prop-old', service_address_line1: '8380 Sea Breeze Ct', service_address_zip: '34212' });
    expect(pin.whereNulls).toEqual(expect.arrayContaining(['property_id', 'service_address_line1']));
    expect(pin.whereNotIn).toEqual(['status', ['completed', 'cancelled', 'skipped', 'rescheduled', 'no_show']]);
    // 2/3. demote before promote (one_primary partial unique)
    const propUpdates = u.filter((x) => x.table === 'customer_properties');
    // The demote deliberately does NOT write occupancy — the reclassification
    // rides the sibling occupancy_change proposal's compare-and-swap — and
    // every label/occupancy suggestion lands via its own predicate-fenced
    // update (r4 TOCTOU hardening).
    const demote = propUpdates.find((x) => x.patch.is_primary === false);
    expect(demote.patch.occupancy_type).toBeUndefined();
    expect(propUpdates.some((x) => x.patch.label === 'Rental')).toBe(true);
    expect(propUpdates.some((x) => x.patch.is_primary === true)).toBe(true);
    expect(propUpdates.some((x) => x.patch.occupancy_type === 'owner_occupied'
      && x.wheres.some((w) => w && w.occupancy_type === 'unknown'))).toBe(true);
    expect(propUpdates.some((x) => x.patch.label === 'Primary')).toBe(true);
    // 4. customers mirror follows the NEW primary
    const mirror = u.find((x) => x.table === 'customers');
    expect(mirror.patch).toMatchObject({ address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', latitude: 27.5 });
    expect(mirror.patch.nearest_location_id).toBeTruthy();
  });

  test('canonical premise match repairs equivalent-spelling stamps: coords + missing locality (codex r6→r26)', async () => {
    const old = { ...OLD_HOME, state: 'FL', latitude: 27.4, longitude: -82.4, active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', latitude: 27.5, longitude: -82.37, active: true, customer_id: 'cust-1' };
    // Equivalent spelling ('Court' vs 'Ct'), ZIP+4, missing city/state,
    // null coords — the JS canonical judgment must still match it.
    const stamped = {
      id: 'v-stamped', customer_id: 'cust-1', status: 'pending', property_id: null,
      service_address_line1: '8380 Sea Breeze Court', service_address_line2: null,
      service_address_city: null, service_address_state: null, service_address_zip: '34212-1234',
      lat: null, lng: null, source_estimate_id: null, is_recurring: false,
    };
    // Different premise: same street text, explicitly different city.
    const otherCity = {
      id: 'v-other', customer_id: 'cust-1', status: 'pending', property_id: null,
      service_address_line1: '8380 Sea Breeze Ct', service_address_line2: null,
      service_address_city: 'Venice', service_address_state: null, service_address_zip: null,
      lat: null, lng: null, source_estimate_id: null, is_recurring: false,
    };
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [stamped, otherCity] } });
    await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' }],
    });
    // Same premise: coords repaired + missing locality completed from the
    // old primary (line1 spelling preserved — COALESCE fill-only).
    expect(stamped.lat).toBe(27.4);
    expect(stamped.lng).toBe(-82.4);
    expect(stamped.service_address_city).toBe('Bradenton');
    expect(stamped.service_address_line1).toBe('8380 Sea Breeze Court');
    // Different stated city = different premise: untouched.
    expect(otherCity.lat).toBeNull();
    expect(otherCity.service_address_state).toBeNull();
  });

  test('coord repair is skipped when the old primary has no coordinates — completion still runs', async () => {
    const old = { ...OLD_HOME, state: 'FL', latitude: null, longitude: null, active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', active: true, customer_id: 'cust-1' };
    const stamped = {
      id: 'v-stamped', customer_id: 'cust-1', status: 'pending', property_id: null,
      service_address_line1: '8380 Sea Breeze Ct', service_address_line2: null,
      service_address_city: null, service_address_state: null, service_address_zip: null,
      lat: null, lng: null, source_estimate_id: null, is_recurring: false,
    };
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [stamped] } });
    await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' }],
    });
    // Locality completed; coords never stamped NULL-over-NULL.
    expect(stamped.service_address_city).toBe('Bradenton');
    expect(stamped.lat).toBeNull();
    expect(stamped.lng).toBeNull();
  });

  test('pin coords are FILL-ONLY (COALESCE) — existing visit coords survive a coordless old primary (codex r7)', async () => {
    const old = { ...OLD_HOME, state: 'FL', latitude: null, longitude: null, active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', latitude: 27.5, longitude: -82.37, active: true, customer_id: 'cust-1' };
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [] } });
    await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' }],
    });
    const pin = trx._updates.find((x) => x.table === 'scheduled_services');
    // A visit already carrying mirror-copied coords must keep them — the
    // stamp assignment goes through COALESCE(col, old value), never a bare
    // overwrite that could stamp NULL over valid coordinates.
    expect(pin.patch.lat).toMatchObject({ __raw: expect.stringContaining('COALESCE(lat') });
    expect(pin.patch.lng).toMatchObject({ __raw: expect.stringContaining('COALESCE(lng') });
  });

  test('demote clears the literal Primary label even with no rental/seasonal suggestion (codex r7)', async () => {
    const old = { ...OLD_HOME, state: 'FL', latitude: 27.4, longitude: -82.4, active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', latitude: 27.5, longitude: -82.37, active: true, customer_id: 'cust-1' };
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [] } });
    await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{
        kind: 'primary_flip',
        new_primary_property_id: 'prop-new',
        old_primary_property_id: 'prop-old',
        old_primary_label: null,
      }],
    });
    // The vacated literal 'Primary' must not survive on the demoted row —
    // otherwise the list shows two "Primary" properties post-flip.
    expect(old.label).toBeNull();
    expect(neu.label).toBe('Primary');
  });

  test('a COMPLETED-but-live recurring template parent is stamped to the old primary (codex r10)', async () => {
    const old = { ...OLD_HOME, state: 'FL', latitude: 27.4, longitude: -82.4, active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', latitude: 27.5, longitude: -82.37, active: true, customer_id: 'cust-1' };
    // Auto-extension clones the PARENT's stamp: an unstamped completed
    // parent would send every future extension to the flipped mirror.
    const parent = {
      id: 'v-parent', customer_id: 'cust-1', status: 'completed',
      is_recurring: true, recurring_ongoing: true,
      property_id: null, service_address_line1: null, source_estimate_id: null, lat: null, lng: null,
    };
    const done = {
      id: 'v-done', customer_id: 'cust-1', status: 'completed',
      is_recurring: false,
      property_id: null, service_address_line1: null, source_estimate_id: null, lat: null, lng: null,
    };
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [parent, done] } });
    await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' }],
    });
    // The live-series parent gets the old primary's stamp despite its
    // completed status…
    expect(parent.property_id).toBe('prop-old');
    expect(parent.service_address_line1).toBe('8380 Sea Breeze Ct');
    // …while an ordinary completed visit stays untouched (historical).
    expect(done.property_id).toBeNull();
    expect(done.service_address_line1).toBeNull();
  });

  test('companion occupancy_change before the flip still relabels the Rental-labeled promoted row (codex r8)', async () => {
    const old = { ...OLD_HOME, state: 'FL', latitude: 27.4, longitude: -82.4, active: true, customer_id: 'cust-1' };
    const neu = {
      ...NEW_HOME, state: 'FL', latitude: 27.5, longitude: -82.37, active: true, customer_id: 'cust-1',
      occupancy_type: 'rental_investment', label: 'Rental',
    };
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [] } });
    const { applied, skipped } = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [
        // Card order mirrors staging: the companion change lands first and
        // sets occupancy owner_occupied — relabel eligibility must come
        // from the LABEL, not the already-updated occupancy.
        { kind: 'occupancy_change', property_id: 'prop-new', current_occupancy: 'rental_investment', proposed_occupancy: 'owner_occupied' },
        { kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old', old_primary_label: null },
      ],
    });
    expect({ applied, skipped }).toEqual({ applied: 2, skipped: 0 });
    expect(neu.occupancy_type).toBe('owner_occupied');
    expect(neu.label).toBe('Primary');
  });

  test('demote label follows the old primary CURRENT occupancy when its staged CAS went stale (codex r12)', async () => {
    // Admin re-typed the old primary 'seasonal' after the card (which
    // proposed rental) was parked: the CAS skips, and the demote must
    // label from the live occupancy — never the stale staged 'Rental'.
    const old = {
      ...OLD_HOME, state: 'FL', latitude: 27.4, longitude: -82.4, active: true, customer_id: 'cust-1',
      occupancy_type: 'seasonal',
    };
    const neu = { ...NEW_HOME, state: 'FL', latitude: 27.5, longitude: -82.37, active: true, customer_id: 'cust-1' };
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [] } });
    const out = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [
        { kind: 'occupancy_change', property_id: 'prop-old', current_occupancy: 'owner_occupied', proposed_occupancy: 'rental_investment' },
        { kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old', old_primary_label: 'Rental' },
      ],
    });
    expect(out).toEqual({ applied: 1, skipped: 1 }); // CAS skipped, flip applied
    expect(old.occupancy_type).toBe('seasonal');
    expect(old.label).toBe('Seasonal');
    expect(old.is_primary).toBe(false);
  });

  test('a non-viable flip skips the WHOLE batch — companion changes never run alone (codex r13)', async () => {
    // The new primary was re-typed rental after staging (no companion in
    // the batch corrects it). Previously the old primary's companion
    // occupancy_change executed and THEN the flip skipped — leaving the
    // still-primary row re-marked rental with the card resolved. Now the
    // preflight skips everything: nothing mutates.
    const old = { ...OLD_HOME, state: 'FL', latitude: 27.4, longitude: -82.4, active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', active: true, customer_id: 'cust-1', occupancy_type: 'rental_investment' };
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [] } });
    const out = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [
        { kind: 'occupancy_change', property_id: 'prop-old', current_occupancy: 'owner_occupied', proposed_occupancy: 'rental_investment' },
        { kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' },
      ],
    });
    expect(out).toEqual({ applied: 0, skipped: 2 });
    expect(old.occupancy_type).toBe('owner_occupied');
    expect(old.is_primary).toBe(true);
    expect(trx._updates).toHaveLength(0);
  });

  test('a flip whose companion occupancy CAS went stale is skipped, not promoted (codex r9)', async () => {
    // Card: companion rental→owner_occupied + flip. An admin re-typed the
    // row 'seasonal' after staging: the CAS misses, and the flip must not
    // ride on — re-read occupancy is neither owner_occupied nor unknown.
    const old = { ...OLD_HOME, state: 'FL', latitude: 27.4, longitude: -82.4, active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', active: true, customer_id: 'cust-1', occupancy_type: 'seasonal' };
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [] } });
    const out = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [
        { kind: 'occupancy_change', property_id: 'prop-new', current_occupancy: 'rental_investment', proposed_occupancy: 'owner_occupied' },
        { kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' },
      ],
    });
    expect(out).toEqual({ applied: 0, skipped: 2 });
    expect(neu.is_primary).toBe(false);
    expect(neu.occupancy_type).toBe('seasonal');
    expect(old.is_primary).toBe(true);
  });

  test('a flip whose new primary was re-typed COMMERCIAL after parking is skipped (codex r8)', async () => {
    const old = { ...OLD_HOME, state: 'FL', active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', active: true, customer_id: 'cust-1', property_type: 'commercial' };
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [] } });
    const { applied, skipped } = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' }],
    });
    expect({ applied, skipped }).toEqual({ applied: 0, skipped: 1 });
    // Never mirrors a commercial classification onto customers (taxability).
    expect(trx._updates.filter((x) => x.table === 'customers')).toHaveLength(0);
  });

  test('a re-addressed row fails the staged address_key fence — occupancy skips, flip batch skips (codex r19)', async () => {
    const { addressKey } = require('../services/customer-properties');
    // Admin re-addressed prop-old after staging: same id, different address.
    const old = { ...OLD_HOME, address_line1: '77 Relocated Way', state: 'FL', active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', active: true, customer_id: 'cust-1' };
    const stagedOldKey = addressKey(OLD_HOME); // key of the address the reviewer SAW
    const trx = makeTrx({ rows: { customer_properties: [old, neu], customers: [{ id: 'cust-1' }], scheduled_services: [] } });
    const occOut = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{
        kind: 'occupancy_change', property_id: 'prop-old', address_key: stagedOldKey,
        current_occupancy: 'owner_occupied', proposed_occupancy: 'rental_investment',
      }],
    });
    expect(occOut).toEqual({ applied: 0, skipped: 1 });
    expect(old.occupancy_type).toBe('owner_occupied');
    const flipOut = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{
        kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old',
        new_primary_address_key: addressKey(NEW_HOME), old_primary_address_key: stagedOldKey,
      }],
    });
    expect(flipOut).toEqual({ applied: 0, skipped: 1 });
    expect(neu.is_primary).toBe(false);
  });

  test('estimate-born unstamped visits pin unless PROVEN to target another property (codex r19)', async () => {
    const old = { ...OLD_HOME, state: 'FL', latitude: 27.4, longitude: -82.4, active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', latitude: 27.5, longitude: -82.37, active: true, customer_id: 'cust-1' };
    const unresolved = { id: 'v-est-1', customer_id: 'cust-1', status: 'pending', property_id: null, service_address_line1: null, source_estimate_id: 'est-1', lat: null, lng: null };
    const provenOther = { id: 'v-est-2', customer_id: 'cust-1', status: 'pending', property_id: null, service_address_line1: null, source_estimate_id: 'est-2', lat: null, lng: null };
    const trx = makeTrx({
      rows: {
        customer_properties: [old, neu],
        customers: [{ id: 'cust-1' }],
        scheduled_services: [unresolved, provenOther],
        estimates: [
          { id: 'est-1', address: null, property_id: null }, // no address — not proven other
          { id: 'est-2', address: null, property_id: 'prop-new' }, // linked elsewhere — proven
        ],
      },
    });
    await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' }],
    });
    expect(unresolved.property_id).toBe('prop-old');
    expect(unresolved.service_address_line1).toBe('8380 Sea Breeze Ct');
    // property_id staying null proves the pin excluded it (the pin is what
    // assigns linkage). line1 isn't asserted: the mock can't evaluate the
    // completion pass's opaque stamp-match callback, so it over-applies
    // that patch here — real SQL's lower(line1) match skips null-line1 rows.
    expect(provenOther.property_id).toBeNull();
  });

  test('an estimate-born COMPLETED-but-ongoing recurring anchor is pinned via the estimate proof (codex r20)', async () => {
    const old = { ...OLD_HOME, state: 'FL', latitude: 27.4, longitude: -82.4, active: true, customer_id: 'cust-1' };
    const neu = { ...NEW_HOME, state: 'FL', latitude: 27.5, longitude: -82.37, active: true, customer_id: 'cust-1' };
    // Falls between the live-estimate pass (terminal) and the recurring
    // parent stamp (estimate-born) — auto-extension clones its stamp.
    const anchor = {
      id: 'v-anchor', customer_id: 'cust-1', status: 'completed',
      is_recurring: true, recurring_ongoing: true,
      property_id: null, service_address_line1: null, source_estimate_id: 'est-9', lat: null, lng: null,
    };
    const trx = makeTrx({
      rows: {
        customer_properties: [old, neu],
        customers: [{ id: 'cust-1' }],
        scheduled_services: [anchor],
        estimates: [{ id: 'est-9', address: null, property_id: null }], // not proven other
      },
    });
    await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' }],
    });
    expect(anchor.property_id).toBe('prop-old');
    expect(anchor.service_address_line1).toBe('8380 Sea Breeze Ct');
  });

  test('a partial estimate address stating a DIFFERENT unit is proven-other — not pinned (codex r21)', async () => {
    const old = {
      ...OLD_HOME, address_line2: 'Unit 4', state: 'FL', latitude: 27.4, longitude: -82.4, active: true, customer_id: 'cust-1',
    };
    const neu = { ...NEW_HOME, state: 'FL', latitude: 27.5, longitude: -82.37, active: true, customer_id: 'cust-1' };
    const otherUnit = { id: 'v-est-u5', customer_id: 'cust-1', status: 'pending', property_id: null, service_address_line1: null, source_estimate_id: 'est-u5', lat: null, lng: null };
    const sameUnit = { id: 'v-est-u4', customer_id: 'cust-1', status: 'pending', property_id: null, service_address_line1: null, source_estimate_id: 'est-u4', lat: null, lng: null };
    const trx = makeTrx({
      rows: {
        customer_properties: [old, neu],
        customers: [{ id: 'cust-1' }],
        scheduled_services: [otherUnit, sameUnit],
        estimates: [
          // Partial parses (no ", City, ST zip" shape) with explicit units.
          { id: 'est-u5', address: '8380 Sea Breeze Ct Unit 5', property_id: null },
          { id: 'est-u4', address: '8380 Sea Breeze Ct Unit 4', property_id: null },
        ],
      },
    });
    await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' }],
    });
    expect(otherUnit.property_id).toBeNull(); // Unit 5 ≠ Unit 4 — proven other
    expect(sameUnit.property_id).toBe('prop-old'); // matching unit pins
  });

  test('re-click on an already-flipped card is idempotent (applied, no writes)', async () => {
    const neu = { ...NEW_HOME, is_primary: true, active: true, customer_id: 'cust-1' };
    const trx = makeTrx({ rows: { customer_properties: [neu] } });
    const { applied, skipped } = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' }],
    });
    expect({ applied, skipped }).toEqual({ applied: 1, skipped: 0 });
    expect(trx._updates).toHaveLength(0);
  });

  test('a stale proposal (row gone or foreign) is skipped, never guessed', async () => {
    const trx = makeTrx({ rows: { customer_properties: [] } });
    const { applied, skipped } = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [
        { kind: 'primary_flip', new_primary_property_id: 'prop-x' },
        { kind: 'occupancy_change', property_id: 'prop-y', current_occupancy: 'unknown', proposed_occupancy: 'seasonal' },
        { kind: 'something_else' },
      ],
    });
    expect({ applied, skipped }).toEqual({ applied: 0, skipped: 3 });
  });

  test('occupancy_change validates the enum and fences on customer + active', async () => {
    const row = { ...OLD_HOME, active: true, customer_id: 'cust-1' };
    const trx = makeTrx({ rows: { customer_properties: [row] } });
    const { applied } = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'occupancy_change', property_id: 'prop-old', current_occupancy: 'owner_occupied', proposed_occupancy: 'seasonal', proposed_label: 'Seasonal' }],
    });
    expect(applied).toBe(1);
    expect(row.occupancy_type).toBe('seasonal');
    const bogus = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'occupancy_change', property_id: 'prop-old', current_occupancy: 'seasonal', proposed_occupancy: 'penthouse' }],
    });
    expect(bogus).toEqual({ applied: 0, skipped: 1 });
  });
});

describe('stale-state fences (codex r1)', () => {
  const makeTrx = (rows) => {
    const updates = [];
    const trx = (table) => ({
      _wheres: [], _whereNulls: [],
      where(w) { this._wheres.push(w); return this; },
      whereNull(c) { this._whereNulls.push(c); return this; },
      forUpdate() { return this; },
      whereNotIn() { return this; },
      whereIn() { return this; },
      async first() {
        const preds = Object.assign({}, ...this._wheres);
        return (rows[table] || []).find((r) => Object.entries(preds).every(([k, v]) => r[k] === v)) || null;
      },
      async update(patch) {
        updates.push({ table, patch });
        const preds = Object.assign({}, ...this._wheres.filter((w) => typeof w === 'object'));
        const hits = (rows[table] || []).filter((r) => Object.entries(preds).every(([k, v]) => r[k] === v));
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
    });
    trx.raw = (sql, bindings) => ({ __raw: sql, bindings });
    trx._updates = updates;
    return trx;
  };

  test('occupancy CAS: a newer admin edit wins over the parked proposal', async () => {
    // Card proposed owner_occupied → rental, but an admin set 'seasonal' after parking.
    const row = { id: 'prop-1', customer_id: 'cust-1', active: true, occupancy_type: 'seasonal' };
    const trx = makeTrx({ customer_properties: [row] });
    const out = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'occupancy_change', property_id: 'prop-1', current_occupancy: 'owner_occupied', proposed_occupancy: 'rental_investment' }],
    });
    expect(out).toEqual({ applied: 0, skipped: 1 });
    expect(row.occupancy_type).toBe('seasonal');
  });

  test('primary flip skips when the CURRENT primary differs from the card', async () => {
    // Portfolio re-arranged since the call: primary is now prop-3, card says prop-old.
    const rows = [
      { ...NEW_HOME, active: true, customer_id: 'cust-1' },
      { id: 'prop-3', customer_id: 'cust-1', active: true, is_primary: true, address_line1: '1 Other St', city: 'Venice', zip: '34285' },
    ];
    const trx = makeTrx({ customer_properties: rows });
    const out = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: 'prop-old' }],
    });
    expect(out).toEqual({ applied: 0, skipped: 1 });
    expect(trx._updates).toHaveLength(0);
  });
});

describe('promote occupancy fence (codex r3 → r9)', () => {
  test('an admin-set non-owner occupancy on the new primary SKIPS the flip entirely', async () => {
    // Superseded r3 behavior (promote anyway, occupancy survives): since
    // r9 a row currently rental/seasonal/commercial/vacant cannot become
    // the primary residence — the companion occupancy_change went stale
    // (or never existed), so promoting would store a non-owner-occupied
    // primary residence. The admin's occupancy still survives.
    const rows = [{ id: 'prop-new', customer_id: 'cust-1', active: true, is_primary: false, occupancy_type: 'seasonal', address_line1: '660 Shell Cove', city: 'Bradenton', zip: '34212', state: 'FL' }];
    const updates = [];
    const trx = (table) => ({
      _wheres: [],
      where(w) { this._wheres.push(w); return this; },
      whereNull() { return this; }, whereNotIn() { return this; }, whereIn() { return this; }, forUpdate() { return this; },
      async first() {
        const preds = Object.assign({}, ...this._wheres);
        return (table === 'customer_properties' ? rows : []).find((r) => Object.entries(preds).every(([k, v]) => r[k] === v)) || null;
      },
      async update(patch) { updates.push({ table, patch }); return 1; },
    });
    trx.raw = (sql, bindings) => ({ __raw: sql, bindings });
    const out = await applyPropertyRoleProposals(trx, {
      customerId: 'cust-1',
      proposals: [{ kind: 'primary_flip', new_primary_property_id: 'prop-new', old_primary_property_id: null }],
    });
    expect(out).toEqual({ applied: 0, skipped: 1 });
    expect(updates.filter((u) => u.table === 'customer_properties')).toHaveLength(0);
    expect(rows[0].occupancy_type).toBe('seasonal');
    expect(rows[0].is_primary).toBe(false);
  });

});

describe('already-primary residence correction (codex r9)', () => {
  test('a primary claim on the already-primary row stored non-owner parks an occupancy_change', () => {
    const rentalPrimary = { ...OLD_HOME, occupancy_type: 'rental_investment' };
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [{ address_line1: '8380 Sea Breeze Ct', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true }],
      properties: [rentalPrimary, NEW_HOME],
    });
    expect(fills).toHaveLength(0);
    expect(proposals).toEqual([expect.objectContaining({
      kind: 'occupancy_change', property_id: 'prop-old',
      current_occupancy: 'rental_investment', proposed_occupancy: 'owner_occupied',
    })]);
  });

  test('a primary claim on the already-primary row stored unknown fills owner_occupied directly', () => {
    const unknownPrimary = { ...OLD_HOME, occupancy_type: 'unknown' };
    const { fills, proposals } = buildPropertyRoleProposals({
      classified: [{ address_line1: '8380 Sea Breeze Ct', city: 'Bradenton', zip: '34212', occupancy: null, is_primary_residence: true }],
      properties: [unknownPrimary, NEW_HOME],
    });
    expect(fills).toEqual([{ property_id: 'prop-old', occupancy: 'owner_occupied' }]);
    expect(proposals).toHaveLength(0);
  });
});
