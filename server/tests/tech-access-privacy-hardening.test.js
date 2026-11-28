/**
 * Tech #2 access-code window, property match, and assessment-context isolation
 * (P0-1, P0-2 access codes, P2-T3).
 */
const { etDateString, addETDays } = require('../utils/datetime-et');
const {
  technicianMayReadVisitAccessCodes,
  propertyPrefsMatchVisitHome,
  visitMatchesPrimaryHomeForTechAccess,
  recheckTechFeedAccessRows,
  stripAccessCodePrefs,
  stripAccessCodesFromBriefBlock,
} = require('../services/technician-visit-scope');

describe('technicianMayReadVisitAccessCodes', () => {
  const tech = { techRole: 'technician', technicianId: 'tech-1' };
  const admin = { techRole: 'admin', technicianId: 'admin-1' };
  const today = etDateString();
  const yesterday = etDateString(addETDays(new Date(), -1));
  const tomorrow = etDateString(addETDays(new Date(), 1));
  const inTwoDays = etDateString(addETDays(new Date(), 2));
  const twoDaysAgo = etDateString(addETDays(new Date(), -2));

  test('admits own non-ended visit in [yesterday..tomorrow] ET', () => {
    for (const scheduled_date of [yesterday, today, tomorrow]) {
      expect(technicianMayReadVisitAccessCodes(tech, { technician_id: 'tech-1', status: 'confirmed', scheduled_date })).toBe(true);
    }
  });

  test('refuses completed, terminal, foreign, and out-of-window visits for technicians', () => {
    expect(technicianMayReadVisitAccessCodes(tech, { technician_id: 'tech-1', status: 'completed', scheduled_date: today })).toBe(false);
    expect(technicianMayReadVisitAccessCodes(tech, { technician_id: 'tech-1', status: 'cancelled', scheduled_date: today })).toBe(false);
    expect(technicianMayReadVisitAccessCodes(tech, { technician_id: 'tech-2', status: 'confirmed', scheduled_date: today })).toBe(false);
    expect(technicianMayReadVisitAccessCodes(tech, { technician_id: 'tech-1', status: 'confirmed', scheduled_date: inTwoDays })).toBe(false);
    expect(technicianMayReadVisitAccessCodes(tech, { technician_id: 'tech-1', status: 'confirmed', scheduled_date: twoDaysAgo })).toBe(false);
  });

  test('admins remain unscoped', () => {
    expect(technicianMayReadVisitAccessCodes(admin, { technician_id: 'tech-2', status: 'completed', scheduled_date: inTwoDays })).toBe(true);
  });
});

describe('propertyPrefsMatchVisitHome', () => {
  test('legacy unbackfilled customer (0 active homes) matches; null lookup fails closed', () => {
    expect(propertyPrefsMatchVisitHome({ property_id: null }, [])).toBe(true);
    expect(propertyPrefsMatchVisitHome({ property_id: 'h1' }, null)).toBe(false);
  });

  test('single active home matches unstamped or matching property_id and rejects mismatch or divergent address/unit stamp', () => {
    const homes = [{ id: 'h1', is_primary: true, address_line1: '100 Main St', address_line2: 'Apt 1', city: 'Sarasota', zip: '34231' }];
    expect(propertyPrefsMatchVisitHome({ property_id: null }, homes)).toBe(true);
    expect(propertyPrefsMatchVisitHome({ property_id: 'h1' }, homes)).toBe(true);
    expect(propertyPrefsMatchVisitHome({ property_id: 'h2' }, homes)).toBe(false);
    // Unstamped property_id with a different street or apartment unit fails closed.
    expect(propertyPrefsMatchVisitHome({ property_id: null, service_address_line1: '200 Other Rd', service_address_city: 'Sarasota', service_address_zip: '34231' }, homes)).toBe(false);
    expect(propertyPrefsMatchVisitHome({ property_id: null, service_address_line1: '100 Main St', service_address_line2: 'Apt 2', service_address_city: 'Sarasota', service_address_zip: '34231' }, homes)).toBe(false);
    expect(propertyPrefsMatchVisitHome({ property_id: null, service_address_line1: '100 Main St', service_address_line2: 'Apt 1', service_address_city: 'Sarasota', service_address_zip: '34231' }, homes)).toBe(true);
  });

  test('legacy 0-home customer rejects divergent stamped address and fails closed when primary address is unknown', () => {
    const primary = { address_line1: '100 Main St', address_line2: null, city: 'Sarasota', zip: '34231' };
    expect(propertyPrefsMatchVisitHome({ property_id: null, service_address_line1: '200 Other Rd' }, [], primary)).toBe(false);
    expect(propertyPrefsMatchVisitHome({ property_id: null, service_address_line1: '200 Other Rd' }, [], null)).toBe(false);
    expect(propertyPrefsMatchVisitHome({ property_id: null, service_address_line1: '100 Main St', service_address_city: 'Sarasota', service_address_zip: '34231' }, [], primary)).toBe(true);
  });

  test('single active non-primary home fails closed so primary-home codes never release onto a secondary visit', () => {
    const secondaryOnly = [{ id: 'h2', is_primary: false, address_line1: '200 Rental Ave', city: 'Sarasota', zip: '34231' }];
    expect(propertyPrefsMatchVisitHome({ property_id: 'h2' }, secondaryOnly)).toBe(false);
    expect(propertyPrefsMatchVisitHome({ property_id: null }, secondaryOnly)).toBe(false);
  });

  test('multi-home customer matches ONLY visits stamped with the primary home', () => {
    const homes = [{ id: 'h1', is_primary: true }, { id: 'h2', is_primary: false }];
    expect(propertyPrefsMatchVisitHome({ property_id: 'h1' }, homes)).toBe(true);
    expect(propertyPrefsMatchVisitHome({ property_id: 'h2' }, homes)).toBe(false);
    expect(propertyPrefsMatchVisitHome({ property_id: null }, homes)).toBe(false);
  });
});

describe('stripAccessCodePrefs & stripAccessCodesFromBriefBlock', () => {
  test('strips entry codes, access notes, special_instructions, and away_mode_until while scrubbing codes in pets_secured_plan', () => {
    const raw = {
      neighborhood_gate_code: '#1234', property_gate_code: '5678', garage_code: '9999', lockbox_code: '0000',
      access_notes: 'Side gate', side_gate_access: 'Left', parking_notes: 'Driveway',
      special_instructions: 'Lockbox 4321 behind planter', away_mode_until: '2026-12-30',
      pet_details: '2 dogs', pets_secured_plan: 'Dogs inside; use 5678 on side keypad #4499', chemical_sensitivities: true,
    };
    const stripped = stripAccessCodePrefs(raw);
    expect(stripped.neighborhood_gate_code).toBeUndefined();
    expect(stripped.pet_details).toBe('2 dogs');
    expect(stripped.chemical_sensitivities).toBe(true);
    expect(stripped.pets_secured_plan).not.toContain('5678');
    expect(stripped.pets_secured_plan).not.toContain('4499');
    expect(raw.neighborhood_gate_code).toBe('#1234');
  });

  test('redactFreeTextAccessCodes scrubs bare PINs, keypad codes, action-verb PINs, and known codes without mangling street/sqft prose', () => {
    const { redactFreeTextAccessCodes } = require('../services/technician-visit-scope');
    expect(redactFreeTextAccessCodes('4821')).toBe('[redacted]');
    expect(redactFreeTextAccessCodes('Try #4821 or 9912#')).not.toMatch(/4821|9912/);
    expect(redactFreeTextAccessCodes('Enter 7352 at back door')).not.toContain('7352');
    expect(redactFreeTextAccessCodes('Side box is 6140', ['6140'])).not.toContain('6140');
    expect(redactFreeTextAccessCodes('2500 sq ft yard at 4867 Main St built 2024')).toBe('2500 sq ft yard at 4867 Main St built 2024');
  });

  test('strips codes, notes, specialInstructions, and gate/access/special/away alerts and redacts note alerts', () => {
    const out = stripAccessCodesFromBriefBlock({
      codes: { neighborhoodGate: '1111', propertyGate: '2222', garage: '3333', lockbox: '4444' },
      accessNotes: 'Ring bell',
      parkingNotes: 'Street',
      specialInstructions: 'Key in lockbox 8888',
      pets: '1 dog',
      alerts: [
        { type: 'gate', text: 'Gate: 1111' },
        { type: 'access', text: 'Ring bell' },
        { type: 'special', text: 'Key in lockbox 8888' },
        { type: 'note', text: 'Spray lanai; gate code 7744 on keypad' },
        { type: 'service_pref', text: 'AWAY MODE — exterior only until 2026-12-30, nobody home' },
        { type: 'service_pref', text: 'EXTERIOR ONLY — no interior treatment' },
        { type: 'pet', text: '1 dog' },
      ],
    });
    expect(out.codes).toEqual({ neighborhoodGate: null, propertyGate: null, garage: null, lockbox: null });
    expect(out.accessNotes).toBeNull();
    expect(out.parkingNotes).toBeNull();
    expect(out.specialInstructions).toBeNull();
    expect(out.pets).toBe('1 dog');
    expect(out.alerts).toEqual([
      { type: 'note', text: expect.not.stringContaining('7744') },
      { type: 'service_pref', text: 'EXTERIOR ONLY — no interior treatment' },
      { type: 'pet', text: '1 dog' },
    ]);
  });
});

describe('visitMatchesPrimaryHomeForTechAccess & recheckTechFeedAccessRows', () => {
  test('unstamped visit with source_estimate_id for another home or unresolved estimate fails closed', async () => {
    const homes = [{ id: 'h1', is_primary: true, address_line1: '100 Main St', address_line2: null, city: 'Sarasota', zip: '34231' }];
    const estMap = new Map([
      ['est-other', { id: 'est-other', address: '999 Rental Ave, Sarasota, FL 34231' }],
      ['est-same', { id: 'est-same', address: '100 Main St, Sarasota, FL 34231' }],
      ['est-missing', null],
    ]);
    const fakeConn = () => { throw new Error('should use cache'); };
    expect(await visitMatchesPrimaryHomeForTechAccess(fakeConn, { property_id: null, source_estimate_id: 'est-other' }, homes, null, { estimateById: estMap })).toBe(false);
    expect(await visitMatchesPrimaryHomeForTechAccess(fakeConn, { property_id: null, source_estimate_id: 'est-missing' }, homes, null, { estimateById: estMap })).toBe(false);
    expect(await visitMatchesPrimaryHomeForTechAccess(fakeConn, { property_id: null, source_estimate_id: 'est-same' }, homes, null, { estimateById: estMap })).toBe(true);
    // Also works for legacy 0-home customer using customer primary address
    expect(await visitMatchesPrimaryHomeForTechAccess(fakeConn, { property_id: null, source_estimate_id: 'est-other' }, [], homes[0], { estimateById: estMap })).toBe(false);
    expect(await visitMatchesPrimaryHomeForTechAccess(fakeConn, { property_id: null, source_estimate_id: 'est-same' }, [], homes[0], { estimateById: estMap })).toBe(true);
  });

  test('recheckTechFeedAccessRows drops reassigned/dead rows and revokes visits whose premise or legacy customer address changed mid-enrichment', async () => {
    const today = etDateString();
    const req = { techRole: 'technician', technicianId: 'tech-1' };
    const vOk = { id: 'v-ok', customer_id: 'c1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: today, property_id: 'h1' };
    const vReassigned = { id: 'v-gone', customer_id: 'c2', technician_id: 'tech-1', status: 'confirmed', scheduled_date: today, property_id: 'h2' };
    const vMoved = { id: 'v-moved', customer_id: 'c3', technician_id: 'tech-1', status: 'confirmed', scheduled_date: today, property_id: 'h3' };
    const vLegacyMoved = {
      id: 'v-legacy', customer_id: 'c4', technician_id: 'tech-1', status: 'confirmed', scheduled_date: today,
      property_id: null, service_address_line1: '100 Main St', service_address_city: 'Sarasota', service_address_zip: '34231',
    };
    const fakeDb = (table) => {
      const q = {
        leftJoin: () => q, whereIn: () => q, where: () => q, whereNotIn: () => q,
        modify: (cb) => { cb(q); return q; }, select: () => q,
        then: (resolve) => {
          if (table === 'scheduled_services') {
            return Promise.resolve([
              vOk,
              { ...vMoved, property_id: 'h3-other' },
              { ...vLegacyMoved, customer_address_line1: '999 New Home Rd', customer_city: 'Sarasota', customer_zip: '34231' },
            ]).then(resolve);
          }
          if (table === 'customer_properties') {
            return Promise.resolve([{ id: 'h1', customer_id: 'c1', is_primary: true, address_line1: '100 Main St', city: 'Sarasota', zip: '34231' }]).then(resolve);
          }
          return Promise.resolve([]).then(resolve);
        },
      };
      return q;
    };
    const revoked = [];
    const droppedIds = await recheckTechFeedAccessRows(
      fakeDb,
      req,
      [
        { visit: vOk, hadWindow: true, hadPrimary: true },
        { visit: vReassigned, hadWindow: true, hadPrimary: true },
        { visit: vMoved, hadWindow: true, hadPrimary: true },
        { visit: vLegacyMoved, hadWindow: true, hadPrimary: true },
      ],
      (cand, flags) => revoked.push({ id: cand.visit.id, ...flags }),
    );
    expect([...droppedIds]).toEqual(['v-gone']);
    expect(revoked).toEqual([
      { id: 'v-gone', lostAssignment: true, lostWindow: true, lostPrimary: true },
      { id: 'v-moved', lostAssignment: false, lostWindow: true, lostPrimary: true },
      { id: 'v-legacy', lostAssignment: false, lostWindow: false, lostPrimary: true },
    ]);
  });

  test('tech-tools getMyRoute redacts access codes in notes on completed and out-of-window stops', async () => {
    jest.resetModules();
    const today = etDateString();
    const inThreeDays = etDateString(addETDays(new Date(), 3));
    const mockStops = { current: [] };
    jest.doMock('../models/db', () => {
      const db = jest.fn(() => {
        const q = {
          where: () => q, whereNotIn: () => q, leftJoin: () => q, select: () => q,
          orderByRaw: () => q,
          then: (resolve) => Promise.resolve(mockStops.current).then(resolve),
        };
        return q;
      });
      db.raw = (s) => s;
      return db;
    });
    const { executeTechTool } = require('../services/intelligence-bar/tech-tools');
    mockStops.current = [
      { id: 's-done', customer_id: 'c1', first_name: 'Pat', last_name: 'Done', status: 'completed', notes: 'Gate code 4488 behind bush' },
      { id: 's-live', customer_id: 'c2', first_name: 'Sam', last_name: 'Live', status: 'confirmed', notes: 'Gate code 9911 on keypad' },
    ];
    const todayRoute = await executeTechTool('get_my_route', { date: today }, { techId: 'tech-1', techRole: 'technician' });
    expect(todayRoute.stops[0].notes).not.toContain('4488');
    expect(todayRoute.stops[1].notes).toContain('9911');
    expect(todayRoute.next_stop.notes).toContain('9911');

    mockStops.current = [
      { id: 's-future', customer_id: 'c3', first_name: 'Lee', last_name: 'Future', status: 'confirmed', notes: 'Lockbox code 7722 by side door' },
    ];
    const futureRoute = await executeTechTool('get_my_route', { date: inThreeDays }, { techId: 'tech-1', techRole: 'technician' });
    expect(futureRoute.stops[0].notes).not.toContain('7722');
    expect(futureRoute.next_stop.notes).not.toContain('7722');
  });

  test('sameHomeForTechVisitPrefs loads customer primary address when zero active properties exist', async () => {
    jest.resetModules();
    const { sameHomeForTechVisitPrefs } = require('../services/technician-visit-scope');
    const conn = jest.fn((table) => {
      const q = {
        where: () => q,
        whereIn: () => q,
        whereNull: () => q,
        whereNotNull: () => q,
        orderBy: () => q,
        select: async () => (table === 'customer_properties' ? [] : []),
        first: async () => (table === 'customers'
          ? { address_line1: '100 Main St', address_line2: null, city: 'Tampa', zip: '33601' }
          : null),
      };
      return q;
    });
    const matchingVisit = {
      customer_id: 'cust-legacy',
      service_address_line1: '100 Main St',
      service_address_city: 'Tampa',
      service_address_zip: '33601',
    };
    const otherVisit = {
      customer_id: 'cust-legacy',
      service_address_line1: '999 Other Rd',
      service_address_city: 'Tampa',
      service_address_zip: '33602',
    };
    await expect(sameHomeForTechVisitPrefs(conn, 'tech-1', 'cust-legacy', matchingVisit)).resolves.toBe(true);
    await expect(sameHomeForTechVisitPrefs(conn, 'tech-1', 'cust-legacy', otherVisit)).resolves.toBe(false);
  });
});

describe('admin-assessment-analytics GET /tech-context/:customerId scoping', () => {
  test('rejects off-route or archived customers with 404 for technicians', async () => {
    jest.resetModules();
    const mockGetTechFieldContext = jest.fn(async () => ({ history: [] }));
    const mockServicesCustomer = jest.fn(async () => false);
    const mockCustomerRow = { current: { id: 'cust-1' } };
    jest.doMock('../models/db', () => jest.fn(() => {
      const q = { where: jest.fn(() => q), whereNull: jest.fn(() => q), first: jest.fn(async () => mockCustomerRow.current) };
      return q;
    }));
    jest.doMock('../services/assessment-analytics', () => ({ getTechFieldContext: mockGetTechFieldContext }));
    jest.doMock('../services/technician-visit-scope', () => ({ technicianServicesCustomer: mockServicesCustomer }));
    jest.doMock('../middleware/admin-auth', () => ({
      adminAuthenticate: (req, _res, next) => { req.techRole = 'technician'; req.technicianId = 'tech-1'; next(); },
      requireAdmin: (_req, res) => res.status(403).json({ error: 'Admin access required' }),
      requireTechOrAdmin: (_req, _res, next) => next(),
    }));
    const express = require('express');
    const router = require('../routes/admin-assessment-analytics');
    const app = express();
    app.use('/analytics', router);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const foreign = await fetch(`${base}/analytics/tech-context/cust-foreign`);
      expect(foreign.status).toBe(404);
      expect(mockGetTechFieldContext).not.toHaveBeenCalled();

      mockServicesCustomer.mockResolvedValue(true);
      mockCustomerRow.current = null;
      const archived = await fetch(`${base}/analytics/tech-context/cust-archived`);
      expect(archived.status).toBe(404);
      expect(mockGetTechFieldContext).not.toHaveBeenCalled();

      mockCustomerRow.current = { id: 'cust-own' };
      const own = await fetch(`${base}/analytics/tech-context/cust-own`);
      expect(own.status).toBe(200);
      expect(mockGetTechFieldContext).toHaveBeenCalledWith('cust-own');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
