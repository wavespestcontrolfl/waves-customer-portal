// The fan-out service rewrites lead/estimate address SNAPSHOTS after a
// customer address edit — but ONLY rows that still match the customer's old
// (or new) street line, only non-terminal rows, and never on an address
// removal. The matching key strips spacing/punctuation so speech-to-text
// variants of the same street ("4867 Tober Morey Way" vs "4867 Tobermorey
// Way") heal instead of stranding.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  addressMatchKey,
  snapshotMatchesContact,
  snapshotMatchesLine1,
  propagateCustomerAddressChange,
} = require('../services/customer-address-fanout');

// Minimal knex-shaped stub: select() resolves the preset rows for the table,
// update() records { table, ids, patch } and resolves the id count. Captures
// targets from both whereIn('id', [...]) (leads) and where({ id }) (per-row
// estimate updates).
function makeConn(rowsByTable) {
  const updates = [];
  const conn = (table) => {
    let updateIds = null;
    const qb = {
      where: (arg) => {
        if (arg && typeof arg === 'object' && typeof arg !== 'function' && arg.id) updateIds = [arg.id];
        return qb;
      },
      whereIn: (col, vals) => { if (col === 'id') updateIds = vals; return qb; },
      whereNull: () => qb,
      select: () => Promise.resolve(rowsByTable[table] || []),
      update: (patch) => {
        updates.push({ table, ids: updateIds, patch });
        return Promise.resolve((updateIds || []).length);
      },
    };
    return qb;
  };
  conn.raw = (sql, bindings) => ({ __raw: sql, bindings });
  conn.__updates = updates;
  return conn;
}

const BEFORE = {
  id: 'cust-1',
  address_line1: '4867 Tobermorey Way', city: 'Lakewood Ranch', state: 'FL', zip: '34211',
};
const AFTER = {
  id: 'cust-1',
  address_line1: '4857 Tobermory Way', city: 'Bradenton', state: 'FL', zip: '34211',
};

describe('addressMatchKey / snapshotMatchesLine1', () => {
  test('spacing, punctuation, and case differences compare equal', () => {
    expect(addressMatchKey('4867 Tober Morey Way')).toBe(addressMatchKey('4867 Tobermorey Way'));
    expect(addressMatchKey('123 Main St.')).toBe(addressMatchKey('123 main st'));
  });

  test('full single-line snapshots match their street line via the first comma segment', () => {
    expect(snapshotMatchesLine1('4857 Tobermory Way, Bradenton, FL 34211, USA', '4857 Tobermory Way')).toBe(true);
  });

  test('a different house number on the same street does not match', () => {
    expect(snapshotMatchesLine1('5109 Tobermory Way', '4857 Tobermory Way')).toBe(false);
  });

  test('a distinct unit under the same street line does not match (no prefix swallowing)', () => {
    expect(snapshotMatchesLine1('123 Main St Apt 2', '123 Main St')).toBe(false);
    expect(snapshotMatchesLine1('123 Main St Apt 2, Bradenton, FL 34205', '123 Main St')).toBe(false);
  });

  test('a unit carried as its own comma segment does not match either', () => {
    expect(snapshotMatchesLine1('123 Main St, Apt 2, Bradenton, FL 34205', '123 Main St')).toBe(false);
    expect(snapshotMatchesLine1('123 Main St, # 4, Bradenton, FL', '123 Main St')).toBe(false);
    // a city segment is NOT a unit segment
    expect(snapshotMatchesLine1('123 Main St, Bradenton, FL 34205', '123 Main St')).toBe(true);
  });

  test('suffix spelling differences compare equal (Street vs St)', () => {
    expect(snapshotMatchesLine1('123 Main Street', '123 Main St')).toBe(true);
    expect(snapshotMatchesLine1('123 Main Street, Bradenton, FL 34205', '123 Main St')).toBe(true);
  });

  test('a full snapshot for the same street name in a DIFFERENT place never matches', () => {
    // zip is the discriminator when both sides have one
    expect(snapshotMatchesContact('100 Main St, Sarasota, FL 34240', {
      address_line1: '100 Main St', city: 'Bradenton', zip: '34205',
    })).toBe(false);
    // no zips to compare → city decides
    expect(snapshotMatchesContact('100 Main St, Sarasota, FL', {
      address_line1: '100 Main St', city: 'Bradenton',
    })).toBe(false);
  });

  test('postal-city aliases match when the zip agrees (Bradenton/Lakewood Ranch share 34211)', () => {
    expect(snapshotMatchesContact('4867 Tobermorey Way, Lakewood Ranch, FL 34211', {
      address_line1: '4867 Tobermorey Way', city: 'Bradenton', zip: '34211',
    })).toBe(true);
  });

  test('empty snapshot or empty line never matches', () => {
    expect(snapshotMatchesLine1('', '4857 Tobermory Way')).toBe(false);
    expect(snapshotMatchesLine1('4857 Tobermory Way', '')).toBe(false);
    expect(snapshotMatchesLine1(null, null)).toBe(false);
  });
});

describe('propagateCustomerAddressChange', () => {
  test('rewrites matching open lead + estimate snapshots, leaves others alone', async () => {
    const conn = makeConn({
      leads: [
        { id: 'lead-match', address: '4867 Tober Morey Way' }, // transcription variant of BEFORE
        { id: 'lead-other', address: '999 Somewhere Else Blvd' }, // different property — untouched
      ],
      estimates: [
        { id: 'est-match', address: '4867 Tobermorey Way, Lakewood Ranch, FL 34211' },
        { id: 'est-other', address: '999 Somewhere Else Blvd, Venice, FL 34285' },
      ],
    });

    const counts = await propagateCustomerAddressChange({ before: BEFORE, after: AFTER }, conn);

    expect(counts).toEqual({ leads: 1, estimates: 1 });
    const leadUpdate = conn.__updates.find((u) => u.table === 'leads');
    expect(leadUpdate.ids).toEqual(['lead-match']);
    expect(leadUpdate.patch).toMatchObject({
      address: '4857 Tobermory Way', city: 'Bradenton', zip: '34211',
    });
    const estUpdate = conn.__updates.find((u) => u.table === 'estimates');
    expect(estUpdate.ids).toEqual(['est-match']);
    expect(estUpdate.patch).toMatchObject({ address: '4857 Tobermory Way, Bradenton, FL 34211' });
  });

  test('an authored proposal snapshot (estimate_data.proposal.propertyAddress) is patched under the same guard', async () => {
    const conn = makeConn({
      leads: [],
      estimates: [{
        id: 'est-prop',
        address: '4867 Tobermorey Way, Lakewood Ranch, FL 34211',
        estimate_data: {
          proposal: { propertyAddress: '4867 Tobermorey Way, Lakewood Ranch, FL 34211' },
          other: 'kept',
        },
      }],
    });

    const counts = await propagateCustomerAddressChange({ before: BEFORE, after: AFTER }, conn);

    expect(counts.estimates).toBe(1);
    const patch = conn.__updates.find((u) => u.table === 'estimates').patch;
    // Targeted jsonb_set (never a full estimate_data overwrite) that also
    // drops the now-stale proposalDelivery "PDF emailed" marker.
    expect(patch.estimate_data.__raw).toContain("jsonb_set(COALESCE(estimate_data, '{}'::jsonb), '{proposal,propertyAddress}'");
    expect(patch.estimate_data.__raw).toContain("- 'proposalDelivery'");
    expect(patch.estimate_data.bindings).toEqual(['4857 Tobermory Way, Bradenton, FL 34211']);
  });

  test('a proposal holding a deliberately different address is left alone', async () => {
    const conn = makeConn({
      leads: [],
      estimates: [{
        id: 'est-prop',
        address: '4867 Tobermorey Way, Lakewood Ranch, FL 34211',
        estimate_data: { proposal: { propertyAddress: '999 Warehouse Blvd, Venice, FL 34285' } },
      }],
    });

    await propagateCustomerAddressChange({ before: BEFORE, after: AFTER }, conn);

    const patch = conn.__updates.find((u) => u.table === 'estimates').patch;
    expect(patch.estimate_data).toBeUndefined();
    expect(patch.address).toBe('4857 Tobermory Way, Bradenton, FL 34211');
  });

  test('snapshots already holding the NEW street line self-heal city/zip', async () => {
    const conn = makeConn({
      leads: [{ id: 'lead-new-line', address: '4857 Tobermory Way' }],
      estimates: [],
    });

    const counts = await propagateCustomerAddressChange({ before: BEFORE, after: AFTER }, conn);

    expect(counts.leads).toBe(1);
    expect(conn.__updates[0].patch).toMatchObject({ city: 'Bradenton', zip: '34211' });
  });

  test('an address removal propagates nothing', async () => {
    const conn = makeConn({
      leads: [{ id: 'lead-match', address: '4867 Tobermorey Way' }],
      estimates: [{ id: 'est-match', address: '4867 Tobermorey Way, Lakewood Ranch, FL 34211' }],
    });

    const counts = await propagateCustomerAddressChange(
      { before: BEFORE, after: { ...AFTER, address_line1: '' } },
      conn,
    );

    expect(counts).toEqual({ leads: 0, estimates: 0 });
    expect(conn.__updates).toHaveLength(0);
  });

  test('no matching rows → no update statements at all', async () => {
    const conn = makeConn({
      leads: [{ id: 'lead-other', address: '999 Somewhere Else Blvd' }],
      estimates: [],
    });

    const counts = await propagateCustomerAddressChange({ before: BEFORE, after: AFTER }, conn);

    expect(counts).toEqual({ leads: 0, estimates: 0 });
    expect(conn.__updates).toHaveLength(0);
  });

  test('a FULL-string lead snapshot is rewritten with the full address, not just the street line', async () => {
    const conn = makeConn({
      leads: [{ id: 'lead-full', address: '4867 Tobermorey Way, Lakewood Ranch, FL 34211' }],
      estimates: [],
    });

    const counts = await propagateCustomerAddressChange({ before: BEFORE, after: AFTER }, conn);

    expect(counts.leads).toBe(1);
    const patch = conn.__updates.find((u) => u.table === 'leads').patch;
    expect(patch.address).toBe('4857 Tobermory Way, Bradenton, FL 34211');
  });

  test('a resave where the proposal already holds the target address never drops proposalDelivery', async () => {
    const target = '4857 Tobermory Way, Bradenton, FL 34211';
    const conn = makeConn({
      leads: [],
      estimates: [{
        id: 'est-current',
        address: target,
        estimate_data: { proposal: { propertyAddress: target }, proposalDelivery: { pdfEmailed: true } },
      }],
    });

    await propagateCustomerAddressChange({ before: AFTER, after: AFTER }, conn);

    const patch = conn.__updates.find((u) => u.table === 'estimates').patch;
    expect(patch.estimate_data).toBeUndefined();
  });

  test('a suffix-spelling-only difference from the target never drops proposalDelivery', async () => {
    const conn = makeConn({
      leads: [],
      estimates: [{
        id: 'est-suffix',
        // Proposal authored with the unabbreviated suffix; the rebuilt target
        // uses the customer's abbreviated line — same place either way.
        address: '123 Main Street, Bradenton, FL 34211',
        estimate_data: {
          proposal: { propertyAddress: '123 Main Street, Bradenton, FL 34211' },
          proposalDelivery: { pdfEmailed: true },
        },
      }],
    });

    await propagateCustomerAddressChange({
      before: { ...AFTER, address_line1: '123 Main St' },
      after: { ...AFTER, address_line1: '123 Main St' },
    }, conn);

    const patch = conn.__updates.find((u) => u.table === 'estimates').patch;
    expect(patch.estimate_data).toBeUndefined();
  });

  test('a street-only customer row patches lead address but never blanks city/zip, and skips estimates', async () => {
    const conn = makeConn({
      leads: [{ id: 'lead-match', address: '4867 Tober Morey Way' }],
      estimates: [{ id: 'est-match', address: '4867 Tobermorey Way, Lakewood Ranch, FL 34211' }],
    });

    const counts = await propagateCustomerAddressChange(
      { before: BEFORE, after: { ...AFTER, city: '', zip: null } },
      conn,
    );

    expect(counts).toEqual({ leads: 1, estimates: 0 });
    const leadPatch = conn.__updates.find((u) => u.table === 'leads').patch;
    expect(leadPatch.address).toBe('4857 Tobermory Way');
    expect(leadPatch).not.toHaveProperty('city');
    expect(leadPatch).not.toHaveProperty('zip');
    expect(conn.__updates.filter((u) => u.table === 'estimates')).toHaveLength(0);
  });

  test('missing customer id is a safe no-op', async () => {
    const conn = makeConn({ leads: [], estimates: [] });
    const counts = await propagateCustomerAddressChange({ before: null, after: null }, conn);
    expect(counts).toEqual({ leads: 0, estimates: 0 });
  });
});
