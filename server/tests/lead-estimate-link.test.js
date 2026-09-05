// Pin the portal origin to the production default before any module loads a
// local .env: the iframe-deferral test posts a portal.wavespestcontrol.com
// landing_url, and CLIENT_URL=http://localhost from a dev .env would make
// attributeSelfBooking miss the portal-host match.
process.env.PUBLIC_PORTAL_URL = 'https://portal.wavespestcontrol.com';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-attribution', () => ({ markConverted: jest.fn(async () => true) }));
jest.mock('../services/lead-source-resolver', () => ({
  resolveLeadSource: jest.fn(async () => ({ leadSourceId: 'ls-fb', leadSourceName: 'Facebook', leadSourceDetail: 'Meta click (fbclid)' })),
  MAIN_SITE_NAME: 'Main Site (wavespestcontrol.com)',
  SPOKE_DOMAIN_TO_SOURCE_NAME: {},
}));
// The bridge's own SQL monotonicity is unit-tested in lead-funnel-bridge.test.js;
// here we only assert the transitions CALL it with the right stage + db handle.
jest.mock('../services/lead-funnel-bridge', () => ({
  bridgeLeadFunnelStage: jest.fn(async () => ({ updated: 1 })),
  stampLeadFunnelRow: jest.fn(async () => 'asa-stamped'),
  FUNNEL_STAGE_RANK: { lead: 0, contacted: 1, estimate_sent: 2, estimate_viewed: 3, booked: 4, completed: 5 },
}));

const db = require('../models/db');
// The qualify-on-send lane wraps its flag+audit writes in
// database.transaction (savepoint semantics on a trx); mocks run the
// callback against the same handle.
db.transaction = async (fn) => fn(db);
const leadAttribution = require('../services/lead-attribution');
const { resolveLeadSource } = require('../services/lead-source-resolver');
const { bridgeLeadFunnelStage, stampLeadFunnelRow } = require('../services/lead-funnel-bridge');
const { OPEN_LEAD_STATUSES } = require('../services/lead-statuses');
const {
  attachLeadToEstimate,
  markLinkedLeadEstimateAccepted,
  markLinkedLeadEstimateSent,
  resolveEstimateEventLeads,
  settleRepeatFunnelRow,
  markLinkedLeadEstimateViewed,
  convertLeadFromEvent,
  linkLeadEstimatesToCustomer,
  attributeSelfBooking,
} = require('../services/lead-estimate-link');

function makeDb(lead, estimate = null) {
  const updates = [];
  const activities = [];
  const database = (table) => ({
    where(clause) {
      const q = {
        // deleted_at guard on the lead lookup — fixtures are never deleted,
        // so the guard is a chain no-op here.
        whereNull: () => q,
        first: async () => {
          if (table === 'leads' && lead && clause.id === lead.id) return lead;
          if (table === 'estimates' && estimate && clause.id === estimate.id) return estimate;
          return null;
        },
        update: async (patch) => {
          updates.push({ table, clause, patch });
          return 1;
        },
      };
      return q;
    },
    insert: async (row) => {
      activities.push({ table, row });
      return [row];
    },
  });

  database.transaction = async (fn) => fn(database);
  return { database, updates, activities };
}

describe('lead-estimate link service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('links a new lead to an estimate without recording a response before send', async () => {
    const lead = {
      id: 'lead-1',
      status: 'new',
      phone: '9415550101',
      first_contact_at: new Date(Date.now() - 12 * 60000).toISOString(),
      response_time_minutes: null,
    };
    const { database, updates, activities } = makeDb(lead);

    await attachLeadToEstimate({
      database,
      leadId: lead.id,
      estimateId: 'estimate-1',
      estimate: { id: 'estimate-1', customer_phone: '+1 (941) 555-0101' },
      technician: { first_name: 'Ava', last_name: 'Tech' },
    });

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'leads',
        clause: { id: lead.id },
        patch: expect.objectContaining({ estimate_id: 'estimate-1' }),
      }),
    ]));
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).not.toHaveProperty('status');
    expect(updates[0].patch).not.toHaveProperty('response_time_minutes');
    expect(activities.map((a) => a.row.activity_type)).toEqual(['estimate_created']);
  });

  test('rejects stale lead ids that do not match the estimate contact', async () => {
    const lead = {
      id: 'lead-1',
      status: 'new',
      phone: '9415550101',
      email: 'lead@example.com',
    };
    const { database, updates, activities } = makeDb(lead);

    await expect(attachLeadToEstimate({
      database,
      leadId: lead.id,
      estimateId: 'estimate-1',
      estimate: { id: 'estimate-1', customer_phone: '9415559999', customer_email: 'other@example.com' },
    })).rejects.toMatchObject({ statusCode: 409 });

    expect(updates).toEqual([]);
    expect(activities).toEqual([]);
  });

  test('allows replacing a stale linked estimate when the caller opts in', async () => {
    const lead = {
      id: 'lead-1',
      status: 'estimate_sent',
      phone: '9415550101',
      estimate_id: 'estimate-old',
    };
    const { database, updates, activities } = makeDb(lead);

    await attachLeadToEstimate({
      database,
      leadId: lead.id,
      estimateId: 'estimate-new',
      estimate: { id: 'estimate-new', customer_phone: '+1 (941) 555-0101' },
      technician: { first_name: 'Ava', last_name: 'Tech' },
      allowReplacingEstimateId: true,
    });

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'leads',
        clause: { id: lead.id },
        patch: expect.objectContaining({ estimate_id: 'estimate-new' }),
      }),
    ]));
    expect(activities.map((a) => a.row.activity_type)).toEqual(['estimate_created']);
  });

  test('records first response after linked estimate is sent', async () => {
    const lead = {
      id: 'lead-1',
      status: 'new',
      first_contact_at: new Date(Date.now() - 12 * 60000).toISOString(),
      response_time_minutes: null,
    };
    const updates = [];
    const activities = [];
    db.mockImplementation((table) => ({
      where(clause) {
        if (table === 'leads' && clause.estimate_id === 'estimate-1' && !clause.id) {
          return Promise.resolve([lead]);
        }
        const update = async (patch) => {
          updates.push({ table, clause, patch });
          return 1;
        };
        return {
          whereIn: () => ({ update, whereRaw: () => ({ update }) }),
          whereNull: () => ({ update }),
          update,
        };
      },
      insert: async (row) => {
        activities.push({ table, row });
        return [row];
      },
    }));

    await markLinkedLeadEstimateSent({ estimateId: 'estimate-1', sendMethod: 'sms' });

    expect(updates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'leads',
        clause: { id: lead.id },
        patch: expect.objectContaining({ status: 'estimate_sent' }),
      }),
      expect.objectContaining({
        table: 'leads',
        clause: { id: lead.id },
        patch: expect.objectContaining({ response_time_minutes: expect.any(Number) }),
      }),
    ]));
    expect(activities.map((a) => a.row.activity_type)).toEqual(['qualified', 'first_response', 'estimate_sent']);
  });

  test('rejects unknown leads before creating activity rows', async () => {
    const { database, activities } = makeDb(null);

    await expect(attachLeadToEstimate({
      database,
      leadId: 'missing-lead',
      estimateId: 'estimate-1',
    })).rejects.toMatchObject({ statusCode: 404 });

    expect(activities).toEqual([]);
  });

  // Richer mock for markLinkedLeadEstimateAccepted's multi-branch resolution:
  //   leads.where({estimate_id}) -> array (FK-linked rows)
  //   leads.where({id}).first()/.update() -> single lead read + estimate_id stamp
  //   estimates.where({id}).first(), customers.where({id}).first()
  //   leads.whereNotIn(...).whereNull(...).andWhere(...) -> contact matches
  function makeAcceptDb(opts = {}) {
    const updates = [];
    const claims = []; // the identity each claimed stamp pinned (codex r17 P1)
    const lostRace = new Set();
    const stamped = new Set();
    const database = (table) => ({
      where(clause) {
        if (table === 'leads' && clause && 'estimate_id' in clause) return Promise.resolve(opts.linked || []);
        if (table === 'leads' && clause && 'id' in clause) {
          // A conditional (whereNull/whereNotIn-guarded) stamp on a row named
          // in `raceRows` loses: 0 rows, and every later read of that row
          // returns the raceRows version (the link another workflow won).
          let conditional = false;
          let identity; // the identity a claimed stamp pins (codex r17 P1)
          let not; // the exclusion a claimed write carries (codex r21 P1)
          const q = {
            whereNull: () => { conditional = true; return q; },
            whereNotIn: () => { conditional = true; return q; },
            whereIn: () => { conditional = true; return q; },
            where: (c) => { conditional = true; identity = c; return q; },
            whereNot: (c) => { conditional = true; if (typeof c === 'function') c({ where: (o) => { not = o; } }); else not = c; return q; },
            first: async () => (lostRace.has(clause.id) ? opts.raceRows[clause.id] : (stamped.has(clause.id) && opts.afterStamp && opts.afterStamp[clause.id]) || (opts.leadsById || {})[clause.id]) || null,
            update: async (patch) => {
              if (conditional && opts.raceRows && opts.raceRows[clause.id]) { lostRace.add(clause.id); return 0; }
              updates.push({ id: clause.id, patch, conditional });
              if (identity) claims.push({ id: clause.id, identity, ...(not ? { not } : {}) });
              stamped.add(clause.id);
              return 1;
            },
          };
          return q;
        }
        if (table === 'estimates') return { first: async () => opts.estimate || null };
        if (table === 'customers') return { first: async () => opts.customer || null };
        return Promise.resolve([]);
      },
      whereNotIn() {
        // Chain tolerates any number of whereNull calls (customer_id guard +
        // the deleted_at soft-delete guard).
        const chain = {
          whereNull: () => chain,
          andWhere: () => Promise.resolve(opts.contactLeads || []),
        };
        return chain;
      },
    });
    database._updates = updates;
    database._claims = claims;
    return database;
  }

  test('converts open FK-linked leads and stops (no fallback) when a linkage row exists', async () => {
    const database = makeAcceptDb({
      linked: [
        { id: 'lead-open', status: 'estimate_viewed', estimate_id: 'estimate-1' },
        { id: 'lead-lost', status: 'lost', estimate_id: 'estimate-1' },
      ],
    });

    await markLinkedLeadEstimateAccepted({
      estimateId: 'estimate-1', customerId: 'customer-1',
      monthlyValue: 125, initialServiceValue: 99, waveguardTier: 'Gold', database,
    });

    expect(leadAttribution.markConverted).toHaveBeenCalledTimes(1);
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-open', {
      customerId: 'customer-1', monthlyValue: 125, initialServiceValue: 99, waveguardTier: 'Gold', estimateId: 'estimate-1',
    });
    expect(database._updates).toHaveLength(0); // already linked → no estimate_id re-stamp
  });

  test('does NOT run the contact fallback when the only linked lead is closed', async () => {
    const database = makeAcceptDb({
      linked: [{ id: 'lead-lost', status: 'lost', estimate_id: 'estimate-1' }],
      // a contact-matching open lead exists, but must be left alone
      customer: { id: 'customer-1', phone: '+19412269100' },
      contactLeads: [{ id: 'lead-other', status: 'new', customer_id: null }],
    });

    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-1', customerId: 'customer-1', database });

    expect(leadAttribution.markConverted).not.toHaveBeenCalled();
  });

  describe('a server-filed repeat the wizard fallback stamped with this estimate but never converted resumes on retry (codex r35 P1 / pre-push r33)', () => {
    const marked = (extra = {}) => ({ id: 'lead-dup', status: 'duplicate', estimate_id: 'estimate-1', customer_id: null, phone: '9412269100', email: null, extracted_data: { duplicate_of_lead_id: 'lead-root' }, ...extra });
    const estimate = { id: 'estimate-1', customer_phone: '+1 (941) 226-9100' };

    test('resumes through the claimed conversion — no re-stamp, status pinned to duplicate, identity as read', async () => {
      const database = makeAcceptDb({ linked: [marked()], estimate });
      await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-1', customerId: 'customer-1', database });
      expect(database._updates).toHaveLength(0);
      expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup', expect.objectContaining({
        customerId: 'customer-1', estimateId: 'estimate-1', onlyIfStatusIn: ['duplicate'], onlyIfIdentity: { customer_id: null, phone: '9412269100', email: null, estimate_id: 'estimate-1' },
        // ...and only as the SOLE live row of the estimate, judged in the
        // conversion's own statement: a retry racing another retry, or a
        // link of the original to this estimate, converts 0 rows instead of
        // leaving two won rows (codex #3883 r1 P1).
        onlyIfSoleLinkedRow: 'estimate-1',
      }));
    });

    test('an acceptance that carries NO customer (a manual acceptance of an estimate without one) judges the contact and preserves the row\'s own customer link — never treats a linked row as its own, never writes customer_id NULL (codex #3883 r1 P1)', async () => {
      // linked to another customer, contact matches the estimate: resumed, link preserved
      let database = makeAcceptDb({ linked: [marked({ customer_id: 'customer-2' })], estimate });
      await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-1', customerId: null, database });
      expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup', expect.objectContaining({ customerId: undefined, onlyIfSoleLinkedRow: 'estimate-1' }));
      // linked to another customer, contact drifted from the estimate: not ours
      jest.clearAllMocks();
      database = makeAcceptDb({ linked: [marked({ customer_id: 'customer-2', phone: '9415550000' })], estimate });
      await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-1', customerId: null, database });
      expect(leadAttribution.markConverted).not.toHaveBeenCalled();
    });

    test('a duplicate staff closed by hand (no marker) stays closed', async () => {
      const database = makeAcceptDb({ linked: [marked({ extracted_data: null })], estimate });
      await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-1', customerId: 'customer-1', database });
      expect(leadAttribution.markConverted).not.toHaveBeenCalled();
    });

    test('another live row of this estimate — won, or still open — is the deal\'s lead; the duplicate is not resumed beside it', async () => {
      for (const other of [{ id: 'lead-won', status: 'won', estimate_id: 'estimate-1' }, { id: 'lead-open', status: 'contacted', estimate_id: 'estimate-1' }]) {
        jest.clearAllMocks();
        const database = makeAcceptDb({ linked: [marked(), other], estimate });
        await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-1', customerId: 'customer-1', database });
        expect(leadAttribution.markConverted.mock.calls.map((c) => c[0])).toEqual(other.status === 'won' ? [] : ['lead-open']);
      }
    });

    test('a repeat that is no longer this customer\'s (contact drifted from the estimate; linked to another customer) is left alone', async () => {
      for (const row of [marked({ phone: '9415550000' }), marked({ customer_id: 'customer-2' })]) {
        jest.clearAllMocks();
        const database = makeAcceptDb({ linked: [row], estimate });
        await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-1', customerId: 'customer-1', database });
        expect(leadAttribution.markConverted).not.toHaveBeenCalled();
      }
    });
  });

  test('rescues a quote-wizard lead via estimate_data.lead_id and stamps the estimate link', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2', estimate_data: { lead_id: 'lead-qw' } },
      leadsById: { 'lead-qw': { id: 'lead-qw', status: 'new', customer_id: 'customer-1' } },
    });

    await markLinkedLeadEstimateAccepted({
      estimateId: 'estimate-2', customerId: 'customer-1', monthlyValue: 60, database,
    });

    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-qw', expect.objectContaining({ customerId: 'customer-1' }));
    expect(database._updates).toEqual([{ id: 'lead-qw', patch: expect.objectContaining({ estimate_id: 'estimate-2' }), conditional: false }]);
  });

  test('a repeat-run duplicate lead named in estimate_data resolves to the OPEN original it duplicates and converts THAT lead', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2b', estimate_data: { lead_id: 'lead-dup' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dup': { id: 'lead-dup', status: 'duplicate', customer_id: 'customer-1', extracted_data: JSON.stringify({ duplicate_of_lead_id: 'lead-orig' }) },
        'lead-orig': { id: 'lead-orig', status: 'new', customer_id: 'customer-1', phone: '(941) 555-0142', email: 'A@example.com' },
      },
    });

    await markLinkedLeadEstimateAccepted({
      estimateId: 'estimate-2b', customerId: 'customer-1', monthlyValue: 60, database,
    });

    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-orig', expect.objectContaining({ customerId: 'customer-1' }));
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-dup', expect.anything());
    // The indirect stamp is conditional (estimate_id IS NULL + open status).
    expect(database._updates).toEqual([{ id: 'lead-orig', patch: expect.objectContaining({ estimate_id: 'estimate-2b' }), conditional: true }]);
  });

  test('a duplicate chain (B → A → O, two concurrent repeats of one open lead) resolves to the open root O and converts THAT lead', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2j', estimate_data: { lead_id: 'lead-B' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-B': { id: 'lead-B', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-A' } },
        'lead-A': { id: 'lead-A', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-O' } },
        'lead-O': { id: 'lead-O', status: 'new', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2j', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).toHaveBeenCalledTimes(1);
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-O', expect.objectContaining({ customerId: 'customer-1' }));
    expect(database._updates).toEqual([{ id: 'lead-O', patch: expect.objectContaining({ estimate_id: 'estimate-2j' }), conditional: true }]);
  });

  test('when the claim loses only because a concurrent SAME-estimate link won, the original converts directly (no fallback, no double bridge)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2o', estimate_data: { lead_id: 'lead-dupO' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dupO': { id: 'lead-dupO', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-origO' } },
        'lead-origO': { id: 'lead-origO', status: 'new', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
      raceRows: { 'lead-origO': { id: 'lead-origO', status: 'estimate_sent', estimate_id: 'estimate-2o' } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2o', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).toHaveBeenCalledTimes(1);
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-origO', expect.anything());
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('a soft-deleted named duplicate never resolves to its live original (nothing converts)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2l', estimate_data: { lead_id: 'lead-delD' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-delD': { id: 'lead-delD', status: 'duplicate', deleted_at: '2026-09-02T00:00:00Z', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-liveO' } },
        'lead-liveO': { id: 'lead-liveO', status: 'new', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2l', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalled();
    expect(database._updates).toEqual([]);
  });

  test('the conversion carries the claim: a staff closure between the stamp and the status write wins, and the duplicate records no win either', async () => {
    leadAttribution.markConverted.mockResolvedValueOnce(false);
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2m', estimate_data: { lead_id: 'lead-dupM' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dupM': { id: 'lead-dupM', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-origM' } },
        'lead-origM': { id: 'lead-origM', status: 'new', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
      // After the stamp, the office closed the original as won: the claimed
      // status write hits 0 rows and the re-read shows it.
      raceRows: {},
      afterStamp: { 'lead-origM': { id: 'lead-origM', status: 'won', estimate_id: 'estimate-2m' } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2m', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).toHaveBeenCalledTimes(1);
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-origM', expect.objectContaining({ onlyIfStatusIn: expect.arrayContaining(['new']) }));
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    // The stamp this call made is reverted so the closed original is not
    // left linked to the accepted repeat estimate (pre-push r12).
    expect(database._updates).toEqual([
      { id: 'lead-origM', patch: expect.objectContaining({ estimate_id: 'estimate-2m' }), conditional: true },
      { id: 'lead-origM', patch: expect.objectContaining({ estimate_id: null }), conditional: true },
    ]);
    // ...keyed on what the stamp wrote — never on updated_at, which the
    // closing write itself bumps (codex r21 P1) — and never on a row a
    // concurrent acceptance of this estimate already converted (r20).
    // The one won row that keeps the link is a concurrent acceptance of
    // THIS estimate: won, this customer, the contact the row was read with
    // — an admin edit that re-identified and won the row in one write loses
    // the link (codex r22 P1).
    expect(database._claims[1]).toEqual({ id: 'lead-origM', identity: { estimate_id: 'estimate-2m' }, not: { status: 'won', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com', estimate_id: 'estimate-2m' } });
    expect(database._updates[0].patch.updated_at).toBeInstanceOf(Date);
  });

  test('a lost stamp whose winner is THIS estimate on a RE-IDENTIFIED row (one admin write re-assigned and linked it) does not convert the original — the repeat takes the win (codex r25 P1)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2r', estimate_data: { lead_id: 'lead-dupR2' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dupR2': { id: 'lead-dupR2', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-origR2' } },
        'lead-origR2': { id: 'lead-origR2', status: 'new', customer_id: null, phone: '9415550142', email: 'a@example.com' },
      },
      // Between the read and the stamp an admin edit handed the original to
      // another customer AND linked it to this same estimate: the identity
      // claim on the stamp loses, and the re-read matches on estimate + open
      // status only.
      raceRows: { 'lead-origR2': { id: 'lead-origR2', status: 'new', customer_id: 'customer-OTHER', phone: '9415550199', email: 'other@example.com', estimate_id: 'estimate-2r' } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2r', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-origR2', expect.anything());
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dupR2', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: ['duplicate'] }));
  });

  test('an original relabelled a duplicate IN FLIGHT (a concurrent /calculate pointed it at an older root) is followed: the root converts, the repeat is not promoted (codex r21 P1)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2q', estimate_data: { lead_id: 'lead-dupQ' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dupQ': { id: 'lead-dupQ', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-midQ' } },
        'lead-midQ': { id: 'lead-midQ', status: 'new', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
        'lead-rootQ': { id: 'lead-rootQ', status: 'contacted', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
      // Between the read and the stamp, the middle row became a duplicate of
      // the older root: the open-status claim on it loses and the re-read
      // shows the new marker.
      raceRows: { 'lead-midQ': { id: 'lead-midQ', status: 'duplicate', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com', extracted_data: { duplicate_of_lead_id: 'lead-rootQ' } } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2q', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).toHaveBeenCalledTimes(1);
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-rootQ', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: expect.arrayContaining(['contacted']) }));
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-dupQ', expect.anything());
    expect(database._updates).toEqual([{ id: 'lead-rootQ', patch: expect.objectContaining({ estimate_id: 'estimate-2q' }), conditional: true }]);
  });

  test('a live duplicate whose original is soft-deleted resolves to the named row: no conversion of the deleted original, no funnel on it', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2n', estimate_data: { lead_id: 'lead-dupN' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dupN': { id: 'lead-dupN', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-delO' } },
        'lead-delO': { id: 'lead-delO', status: 'new', deleted_at: '2026-09-02T00:00:00Z', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2n', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-delO', expect.anything());
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dupN', expect.anything());
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('a duplicate marker cycle (A ↔ B) terminates and credits the named row', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2k', estimate_data: { lead_id: 'lead-cA' } },
      leadsById: {
        'lead-cA': { id: 'lead-cA', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-cB' } },
        'lead-cB': { id: 'lead-cB', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-cA' } },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2k', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).toHaveBeenCalledTimes(1);
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-cA', expect.anything());
  });

  test('an indirectly resolved original that loses the stamp race to a concurrent link is not converted — the named row takes the win', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2g', estimate_data: { lead_id: 'lead-dup6' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dup6': { id: 'lead-dup6', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-orig6' } },
        'lead-orig6': { id: 'lead-orig6', status: 'new', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
      // Between the eligibility read and the stamp, another workflow linked
      // the original to a different estimate: the conditional update hits 0
      // rows and the re-read shows the other link.
      raceRows: { 'lead-orig6': { id: 'lead-orig6', status: 'estimate_sent', estimate_id: 'estimate-office' } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2g', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-orig6', expect.anything());
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup6', expect.objectContaining({ customerId: 'customer-1' }));
    expect(database._updates).toEqual([{ id: 'lead-dup6', patch: expect.objectContaining({ estimate_id: 'estimate-2g' }), conditional: true }]);
    // The re-read proved the original now belongs to ANOTHER estimate, so it
    // is no longer this opportunity: its funnel is not booked (pre-push r12).
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    // ...so the named row's win gets the funnel row its own run would have
    // stamped, straight at booked (codex r14 P2).
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup6', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: ['duplicate'] }));
  });

  test('an original closed as won between the read and the atomic stamp records no second win on the duplicate row', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2h', estimate_data: { lead_id: 'lead-dup8' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dup8': { id: 'lead-dup8', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-orig8' } },
        'lead-orig8': { id: 'lead-orig8', status: 'new', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
      // The office marked the original won after the eligibility read: the
      // conditional stamp hits 0 rows and the re-read shows 'won'.
      raceRows: { 'lead-orig8': { id: 'lead-orig8', status: 'won', estimate_id: null } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2h', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalled();
    expect(database._updates).toEqual([]);
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('an indirectly resolved original that belongs to a DIFFERENT customer is never converted', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2d', estimate_data: { lead_id: 'lead-dup3' }, customer_id: 'customer-1', customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dup3': { id: 'lead-dup3', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-orig3' } },
        'lead-orig3': { id: 'lead-orig3', status: 'new', customer_id: 'customer-OTHER', phone: '9415550142', email: 'a@example.com' },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2d', customerId: 'customer-1', database });
    // The hop cannot land, so the acceptance credits the run's own row.
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-orig3', expect.anything());
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup3', expect.objectContaining({ customerId: 'customer-1' }));
    expect(database._updates).toEqual([{ id: 'lead-dup3', patch: expect.objectContaining({ estimate_id: 'estimate-2d' }), conditional: true }]);
    // The original failed validation: it is not this opportunity, so its
    // funnel row is not booked (pre-push P1 on r8).
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('a duplicate row the office closed between the read and the fallback claim is not converted (the claim is atomic on status = duplicate)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2i', estimate_data: { lead_id: 'lead-dup9' } },
      leadsById: { 'lead-dup9': { id: 'lead-dup9', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-missing' } } },
      raceRows: { 'lead-dup9': { id: 'lead-dup9', status: 'lost', estimate_id: null } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2i', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalled();
    expect(database._updates).toEqual([]);
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test.each([
    ['re-assigned to another customer', { customer_id: 'customer-OTHER', phone: '9415550142' }],
    ['re-contacted (unlinked, contact no longer matches the estimate)', { customer_id: null, phone: '9415559999', email: 'other@example.com' }],
  ])('a named repeat %s since its run is not this opportunity: the fallback converts nothing (pre-push P1 on d3edd30)', async (_label, change) => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2r', estimate_data: { lead_id: 'lead-rep' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: { 'lead-rep': { id: 'lead-rep', status: 'duplicate', estimate_id: null, extracted_data: { duplicate_of_lead_id: 'lead-missing' }, ...change } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2r', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalled();
    expect(database._updates).toEqual([]);
  });

  test('a named duplicate row with NO server marker (staff closed it by hand) is a deliberate closure: its old wizard estimate accepting reopens nothing (pre-push P1 on 67dd818)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2h', estimate_data: { lead_id: 'lead-hand' } },
      leadsById: { 'lead-hand': { id: 'lead-hand', status: 'duplicate', customer_id: 'customer-1', estimate_id: null, extracted_data: {} } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2h', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalled();
    expect(database._updates).toEqual([]);
  });

  test('an indirectly resolved original whose contact does not match the estimate is never converted', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2e', estimate_data: { lead_id: 'lead-dup4' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dup4': { id: 'lead-dup4', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-orig4' } },
        'lead-orig4': { id: 'lead-orig4', status: 'new', customer_id: null, phone: '9415559999', email: 'someone-else@example.com' },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2e', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-orig4', expect.anything());
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup4', expect.anything());
  });

  test('an indirectly resolved original already FK-linked to a DIFFERENT estimate is never converted (the win would credit the wrong offer) — the named row takes the win instead', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2f', estimate_data: { lead_id: 'lead-dup5' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dup5': { id: 'lead-dup5', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-orig5' } },
        'lead-orig5': { id: 'lead-orig5', status: 'estimate_sent', estimate_id: 'estimate-office', customer_id: null, phone: '9415550142', email: 'a@example.com' },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2f', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-orig5', expect.anything());
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup5', expect.objectContaining({ customerId: 'customer-1' }));
    expect(database._updates).toEqual([{ id: 'lead-dup5', patch: expect.objectContaining({ estimate_id: 'estimate-2f' }), conditional: true }]);
    // The other offer's funnel is not ours to book; the named row gets its own (codex r14 P2).
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup5', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: ['duplicate'], onlyIfSoleLinkedRow: 'estimate-2f' }));
  });

  test('a no-customer fallback whose status claim lost reverts its stamp on the predicate of the customer it WROTE (the row\'s own, preserved) — a concurrent no-customer retry that won keeps its link (codex #3883 r2 P1)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-16', estimate_data: { lead_id: 'lead-dup16' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: { 'lead-dup16': { id: 'lead-dup16', status: 'duplicate', customer_id: 'customer-2', phone: '9415550142', email: 'a@example.com', extracted_data: { duplicate_of_lead_id: 'lead-gone16' } } },
      raceRows: {},
      afterStamp: { 'lead-dup16': { id: 'lead-dup16', status: 'won', customer_id: 'customer-2', phone: '9415550142', email: 'a@example.com', estimate_id: 'estimate-16' } },
    });
    leadAttribution.markConverted.mockResolvedValueOnce(false);
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-16', customerId: null, database });
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup16', expect.objectContaining({ customerId: undefined, onlyIfStatusIn: ['duplicate'] }));
    expect(database._claims[1]).toEqual({ id: 'lead-dup16', identity: { estimate_id: 'estimate-16' }, not: { status: 'won', customer_id: 'customer-2', phone: '9415550142', email: 'a@example.com', estimate_id: 'estimate-16' } });
  });

  test('the named-row fallback on an acceptance with NO customer: a named row linked to another customer converts only on a matching contact, with its link preserved (codex #3883 r1 P1)', async () => {
    const leadsById = {
      'lead-dup15': { id: 'lead-dup15', status: 'duplicate', customer_id: 'customer-2', phone: '9415550142', email: 'a@example.com', extracted_data: { duplicate_of_lead_id: 'lead-gone15' } },
    };
    let database = makeAcceptDb({ linked: [], estimate: { id: 'estimate-15', estimate_data: { lead_id: 'lead-dup15' }, customer_phone: '9415550142', customer_email: 'a@example.com' }, leadsById });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-15', customerId: null, database });
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup15', expect.objectContaining({ customerId: undefined, onlyIfStatusIn: ['duplicate'], onlyIfSoleLinkedRow: 'estimate-15' }));
    jest.clearAllMocks();
    database = makeAcceptDb({ linked: [], estimate: { id: 'estimate-15', estimate_data: { lead_id: 'lead-dup15' }, customer_phone: '9415550000', customer_email: 'b@example.com' }, leadsById });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-15', customerId: null, database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalled();
  });

  test('an indirectly resolved original that is ALREADY won records no second win on the duplicate row', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2h', estimate_data: { lead_id: 'lead-dup7' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dup7': { id: 'lead-dup7', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-orig7' } },
        'lead-orig7': { id: 'lead-orig7', status: 'won', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2h', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalled();
    expect(database._updates).toEqual([]);
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });

  test('an UNLINKED original that won on a DIFFERENT estimate (its persisted won_estimate_id) is a different deal: this acceptance is credited on the named row, not suppressed as a second win (pre-push P1 on de469d9)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2m', estimate_data: { lead_id: 'lead-dup13' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dup13': { id: 'lead-dup13', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-orig13' } },
        'lead-orig13': { id: 'lead-orig13', status: 'won', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com', estimate_id: null, extracted_data: { won_estimate_id: 'estimate-office' } },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2m', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-orig13', expect.anything());
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup13', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: ['duplicate'] }));
    expect(database._updates).toEqual([{ id: 'lead-dup13', patch: expect.objectContaining({ estimate_id: 'estimate-2m' }), conditional: true }]);
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('a won original that belongs to a DIFFERENT customer (shared household contact) does not suppress the named row: this deal is credited once, on the named row, with its own funnel row', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2k', estimate_data: { lead_id: 'lead-dup9' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dup9': { id: 'lead-dup9', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-orig9' } },
        'lead-orig9': { id: 'lead-orig9', status: 'won', customer_id: 'customer-OTHER', phone: '9415550142', email: 'a@example.com' },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2k', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-orig9', expect.anything());
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup9', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: ['duplicate'] }));
    expect(database._updates).toEqual([{ id: 'lead-dup9', patch: expect.objectContaining({ estimate_id: 'estimate-2k' }), conditional: true }]);
    // The other customer's won funnel is not ours to book (codex r14 P1 + P2).
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup9', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: ['duplicate'] }));
  });

  test('a named repeat staff linked to ANOTHER estimate is not a fallback winner — this acceptance\'s customer and value hints never land on that deal\'s lead (codex r29 P1)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-29', estimate_data: { lead_id: 'lead-dup29' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        // the root vanished, so the hop cannot land and the fallback judges the named row
        'lead-dup29': { id: 'lead-dup29', status: 'duplicate', customer_id: 'customer-1', estimate_id: 'estimate-OTHER', phone: '9415550142', email: 'a@example.com', extracted_data: { duplicate_of_lead_id: 'lead-gone29' } },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-29', customerId: 'customer-1', monthlyValue: 99, database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalled();
    expect(database._updates).toHaveLength(0);
  });

  test('an indirectly resolved root that is SPAM (not answerable, not in CLOSED_LEAD_STATUSES) is never claimed and never has its funnel booked — the named repeat takes the win with its own funnel row (codex r26 P1)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2s', estimate_data: { lead_id: 'lead-dupS' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dupS': { id: 'lead-dupS', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-origS' } },
        'lead-origS': { id: 'lead-origS', status: 'spam', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2s', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-origS', expect.anything());
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dupS', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: ['duplicate'] }));
    expect(database._updates).toEqual([{ id: 'lead-dupS', patch: expect.objectContaining({ estimate_id: 'estimate-2s' }), conditional: true }]);
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('an original re-assigned to ANOTHER customer and marked won between the read and the claim is judged on its refreshed identity — the named row takes the win (codex r16 P1)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2r', estimate_data: { lead_id: 'lead-dupR' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dupR': { id: 'lead-dupR', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-origR' } },
        'lead-origR': { id: 'lead-origR', status: 'new', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
      },
      // Staff moved the original to another household and closed it as won
      // before the claim landed: the re-read carries the new identity.
      raceRows: { 'lead-origR': { id: 'lead-origR', status: 'won', estimate_id: null, customer_id: 'customer-OTHER', phone: '9415550199', email: 'other@example.com' } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2r', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).not.toHaveBeenCalledWith('lead-origR', expect.anything());
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dupR', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: ['duplicate'] }));
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dupR', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: ['duplicate'] }));
  });

  test('the indirect claim pins the identity the original was read with — customer link, phone, email — so a re-assignment after the check loses the stamp (codex r17 P1)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2p', estimate_data: { lead_id: 'lead-dupP' }, customer_phone: '9415550142', customer_email: 'a@example.com' },
      leadsById: {
        'lead-dupP': { id: 'lead-dupP', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-origP' } },
        'lead-origP': { id: 'lead-origP', status: 'new', customer_id: null, phone: '9415550142', email: 'a@example.com' },
      },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2p', customerId: 'customer-1', database });
    // ...and the estimate link: the stamp claims an unlinked row, the
    // conversion claims the row carrying THIS link (codex r22 P1).
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-origP', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: OPEN_LEAD_STATUSES, onlyIfIdentity: { customer_id: null, phone: '9415550142', email: 'a@example.com', estimate_id: 'estimate-2p' } }));
    expect(database._updates).toEqual([{ id: 'lead-origP', patch: expect.objectContaining({ estimate_id: 'estimate-2p' }), conditional: true }]);
    expect(database._claims).toEqual([{ id: 'lead-origP', identity: { customer_id: null, phone: '9415550142', email: 'a@example.com', estimate_id: null } }]);
  });

  test('a duplicate lead whose original is gone takes the win itself (no contact-fallback sweep)', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-2c', estimate_data: { lead_id: 'lead-dup2' } },
      leadsById: { 'lead-dup2': { id: 'lead-dup2', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-missing' } } },
    });
    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-2c', customerId: 'customer-1', database });
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup2', expect.anything());
    expect(database._updates).toEqual([{ id: 'lead-dup2', patch: expect.objectContaining({ estimate_id: 'estimate-2c' }), conditional: true }]);
    // No original ⇒ no surviving attribution row to advance.
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-dup2', expect.objectContaining({ customerId: 'customer-1', onlyIfStatusIn: ['duplicate'] }));
  });

  test('standalone estimate: rescues a single unlinked lead by contact and stamps the link', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-3', estimate_data: null },
      customer: { id: 'customer-1', phone: '+19412269100', email: 'taryn@example.com' },
      contactLeads: [{ id: 'lead-unlinked', status: 'new', customer_id: null }],
    });

    await markLinkedLeadEstimateAccepted({
      estimateId: 'estimate-3', customerId: 'customer-1', monthlyValue: 80, waveguardTier: 'Silver', database,
    });

    expect(leadAttribution.markConverted).toHaveBeenCalledWith('lead-unlinked', expect.objectContaining({ customerId: 'customer-1' }));
    expect(database._updates).toEqual([{ id: 'lead-unlinked', patch: expect.objectContaining({ estimate_id: 'estimate-3' }), conditional: false }]);
  });

  test('standalone estimate: skips an AMBIGUOUS contact match (2+ open leads) without converting', async () => {
    const database = makeAcceptDb({
      linked: [],
      estimate: { id: 'estimate-4', estimate_data: null },
      customer: { id: 'customer-1', phone: '+19412269100' },
      contactLeads: [
        { id: 'lead-a', status: 'new', customer_id: null },
        { id: 'lead-b', status: 'contacted', customer_id: null },
      ],
    });

    await markLinkedLeadEstimateAccepted({ estimateId: 'estimate-4', customerId: 'customer-1', database });

    expect(leadAttribution.markConverted).not.toHaveBeenCalled();
    expect(database._updates).toHaveLength(0);
  });
});

describe('convertLeadFromEvent (backfill resolver)', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  // Captures the whereNull column used by findUnconvertedLeadsByContact so a
  // test can assert the customer_id IS NULL guard is applied.
  function makeConvertDb(opts = {}) {
    const calls = { whereNull: [] };
    const db = (table) => {
      if (opts.throwOnTable === table) throw new Error('db boom');
      return {
        where(clause) {
          if (table === 'estimates') return { first: async () => opts.estimate || null };
          if (table === 'customers') return { first: async () => opts.customer || null };
          if (table === 'leads' && clause && 'estimate_id' in clause) {
            return Promise.resolve(opts.leadsByEstimate || []);
          }
          if (table === 'leads' && clause && 'id' in clause) {
            return { first: async () => (opts.leadsById || {})[clause.id] || null };
          }
          // the tier-2 duplicate-repeat lookup: .where({ customer_id, lead_type, status: 'duplicate' })
          // .whereNull('deleted_at').orderBy(...).first()
          if (table === 'leads' && clause && 'lead_type' in clause) {
            const repeatRows = () => Promise.resolve(opts.customerDuplicateLeads || (opts.customerDuplicateLead ? [opts.customerDuplicateLead] : []));
            const rep = { whereNull: () => rep, orderBy: repeatRows, orderByRaw: (sql) => { calls.orderByRaw = sql; return repeatRows(); } };
            return rep;
          }
          // customerHasWonLead: .where({ customer_id, status: 'won' })
          // .whereNull('deleted_at').first('id')
          if (table === 'leads' && clause && 'customer_id' in clause && 'status' in clause) {
            let scopedEstimate = null; // the estimate an estimate-scoped event pins the prior-win check to (codex r24 P1)
            const won = {
              whereNull: () => won,
              modify: (fn) => { fn(won); return won; },
              where: (fn) => { const q = { whereNull: () => q, orWhere: (col, val) => { scopedEstimate = val; return q; } }; fn(q); return won; },
              first: async () => {
                const w = opts.customerWonLead || null;
                return w && (!scopedEstimate || !w.estimate_id || w.estimate_id === scopedEstimate) ? w : null;
              },
            };
            return won;
          }
          // findOpenLeadsForCustomer: .where({ customer_id })
          // .whereNull('deleted_at').whereNotIn('status', [...])
          if (table === 'leads' && clause && 'customer_id' in clause) {
            const open = {
              whereNull: () => open,
              whereNotIn: () => Promise.resolve(opts.customerOpenLeads || []),
              whereIn: (col, vals) => Promise.resolve((opts.customerOpenLeads || []).filter((l) => vals.includes(l.status))),
            };
            return open;
          }
          return Promise.resolve([]);
        },
        whereNotIn() {
          // findUnconvertedLeadsByContact: .whereNotIn(...).whereNull('customer_id')
          // .whereNull('deleted_at').andWhere(...) — record every guard column.
          const chain = {
            whereNull(col) {
              calls.whereNull.push(col);
              return chain;
            },
            andWhere: () => Promise.resolve(opts.contactLeads || []),
          };
          return chain;
        },
      };
    };
    db._calls = calls;
    return db;
  }

  test('matches by estimate link and passes estimate value hints', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      estimate: { id: 'e1', customer_id: 'c1', monthly_total: 125, onetime_total: 99, waveguard_tier: 'Gold' },
      leadsByEstimate: [{ id: 'L1', status: 'estimate_sent' }],
    });

    const result = await convertLeadFromEvent({
      source: 'backfill',
      estimateId: 'e1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, count: 1, leadIds: ['L1'] });
    expect(markConverted).toHaveBeenCalledWith('L1', {
      customerId: 'c1',
      estimateId: 'e1',
      monthlyValue: 125,
      initialServiceValue: 99,
      waveguardTier: 'Gold',
      triggerSource: 'backfill',
    });
  });

  test('matches the unconverted originating lead by contact, preserves values', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', email: 'holly@example.com' },
      contactLeads: [{ id: 'L3', status: 'new', customer_id: null }],
    });

    const result = await convertLeadFromEvent({
      source: 'backfill',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, leadIds: ['L3'] });
    // Only the customer + source — no revenue fields, so markConverted preserves
    // any monthly_value/waveguard_tier already on the lead.
    expect(markConverted.mock.calls[0][1]).toEqual({ customerId: 'c1', triggerSource: 'backfill' });
    // The contact fallback must restrict to unconverted, non-deleted leads.
    expect(database._calls.whereNull).toContain('customer_id');
    expect(database._calls.whereNull).toContain('deleted_at');
  });

  test('enforceOriginating converts a contact lead first contacted before the customer signed up', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-01-01' },
      contactLeads: [{ id: 'Lold', status: 'new', customer_id: null, first_contact_at: '2025-12-15T10:00:00Z' }],
    });

    const result = await convertLeadFromEvent({
      source: 'recurring_service_booked',
      customerId: 'c1',
      enforceOriginating: true,
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, leadIds: ['Lold'] });
  });

  test('appointment_booked (one-time admin booking) converts the originating lead like the recurring trigger', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-01-01' },
      contactLeads: [{ id: 'Lold', status: 'new', customer_id: null, first_contact_at: '2025-12-15T10:00:00Z' }],
    });

    const result = await convertLeadFromEvent({
      source: 'appointment_booked',
      customerId: 'c1',
      enforceOriginating: true,
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, leadIds: ['Lold'] });
    expect(markConverted.mock.calls[0][1]).toEqual({ customerId: 'c1', triggerSource: 'appointment_booked' });
  });

  test('appointment_booked with a source estimate resolves via the estimate-link tier BEFORE the originating-timing fallback', async () => {
    // An established customer books from an accepted add-on quote: the
    // FK-linked lead was first contacted AFTER member_since, so the
    // enforceOriginating contact fallback would reject it — but the estimate
    // link is authoritative (the booking rode in on exactly this quote), so
    // tier 1 converts it, with the estimate's value hints.
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      estimate: { id: 'e9', customer_id: 'c1', monthly_total: null, onetime_total: 450, waveguard_tier: null },
      leadsByEstimate: [{ id: 'Laddon', status: 'estimate_sent', customer_id: 'c1', first_contact_at: '2026-06-20T10:00:00Z' }],
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-01-01' },
    });

    const result = await convertLeadFromEvent({
      source: 'appointment_booked',
      estimateId: 'e9',
      customerId: 'c1',
      enforceOriginating: true,
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, leadIds: ['Laddon'] });
    expect(markConverted.mock.calls[0][1]).toEqual({
      customerId: 'c1',
      estimateId: 'e9',
      triggerSource: 'appointment_booked',
      monthlyValue: null,
      initialServiceValue: 450,
      waveguardTier: null,
    });
  });

  test('enforceOriginating does NOT convert a contact lead created AFTER the customer signed up (later add-on)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-01-01' },
      contactLeads: [{ id: 'Lnew', status: 'new', customer_id: null, first_contact_at: '2026-05-01T10:00:00Z' }],
    });

    const result = await convertLeadFromEvent({
      source: 'recurring_service_booked',
      customerId: 'c1',
      enforceOriginating: true,
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'no_open_lead' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('without enforceOriginating, the live-trigger path still converts that same later contact lead', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-01-01' },
      contactLeads: [{ id: 'Lnew', status: 'new', customer_id: null, first_contact_at: '2026-05-01T10:00:00Z' }],
    });

    const result = await convertLeadFromEvent({
      source: 'recurring_service_booked',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, leadIds: ['Lnew'] });
  });

  test('skips already-closed leads and reports no_open_lead', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100' },
      contactLeads: [{ id: 'Lwon', status: 'won', customer_id: null }],
    });

    const result = await convertLeadFromEvent({
      source: 'backfill',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'no_open_lead' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('never throws — a db failure resolves to an error result', async () => {
    const markConverted = jest.fn();
    const database = makeConvertDb({ throwOnTable: 'customers' });

    const result = await convertLeadFromEvent({
      source: 'backfill',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'error' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('requireAcceptedEstimate skips when the estimate is not yet accepted', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      estimate: { id: 'e1', status: 'sent', customer_id: 'c1' },
      leadsByEstimate: [{ id: 'L1', status: 'estimate_sent' }],
    });

    const result = await convertLeadFromEvent({
      source: 'deposit_paid',
      estimateId: 'e1',
      requireAcceptedEstimate: true,
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'estimate_not_accepted' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('requireAcceptedEstimate converts once the estimate is accepted', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      estimate: { id: 'e1', status: 'accepted', customer_id: 'c1', monthly_total: 80 },
      leadsByEstimate: [{ id: 'L1', status: 'estimate_sent' }],
    });

    const result = await convertLeadFromEvent({
      source: 'deposit_paid',
      estimateId: 'e1',
      requireAcceptedEstimate: true,
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, leadIds: ['L1'] });
    expect(markConverted).toHaveBeenCalledTimes(1);
  });

  test('skips an AMBIGUOUS contact-fallback match (2+ open leads) rather than mass-converting', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100' },
      contactLeads: [
        { id: 'L1', status: 'new', customer_id: null },
        { id: 'L2', status: 'contacted', customer_id: null },
      ],
    });

    const result = await convertLeadFromEvent({
      source: 'service_completed',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'ambiguous_contact' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('converts ALL leads FK-linked to the estimate (authoritative, not ambiguous)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      estimate: { id: 'e1', customer_id: 'c1' },
      leadsByEstimate: [
        { id: 'L1', status: 'estimate_sent' },
        { id: 'L2', status: 'new' },
      ],
    });

    const result = await convertLeadFromEvent({
      source: 'backfill',
      estimateId: 'e1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, count: 2, leadIds: ['L1', 'L2'] });
    expect(markConverted).toHaveBeenCalledTimes(2);
  });

  // Tier 2 — customer-link match (the Holly case): an open lead already carrying
  // a customer_id, which the contact fallback (customer_id IS NULL) can't see.
  test('converts a customer-linked open lead on the customer FIRST close', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      // Originating, and an ET-vs-UTC boundary case: first contacted 8:30pm EDT on
      // Jun 1 (= Jun 2 00:30 UTC) — the SAME ET day the customer became one. A UTC
      // day comparison would mis-bucket it to Jun 2 and wrongly skip; ET must convert.
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-06-01' },
      customerOpenLeads: [{ id: 'L9', status: 'new', customer_id: 'c1', first_contact_at: '2026-06-02T00:30:00Z' }],
      customerWonLead: null, // no prior won lead
    });

    const result = await convertLeadFromEvent({
      source: 'service_completed',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toMatchObject({ converted: true, leadIds: ['L9'] });
    expect(markConverted).toHaveBeenCalledTimes(1);
  });

  test('does NOT convert an add-on lead created AFTER the customer became a customer', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      // Established customer (member_since long ago); the open lead is a later
      // add-on inquiry (first contacted well after) — must not be swept.
      customer: { id: 'c1', phone: '+19412269100', member_since: '2025-01-01' },
      customerOpenLeads: [{ id: 'L9', status: 'new', customer_id: 'c1', first_contact_at: '2026-06-15' }],
      customerWonLead: null, // no won lead, yet still established by tenure
    });

    const result = await convertLeadFromEvent({
      source: 'invoice_sent',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'customer_link_not_originating' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('self-booking: a repeat filed as duplicate converts its open root when the root is this customer\'s', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-rep', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'L-root' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-root': { id: 'L-root', status: 'new', customer_id: 'c1', first_contact_at: '2026-08-30T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-root'] });
    expect(markConverted).toHaveBeenCalledWith('L-root', expect.objectContaining({ customerId: 'c1' }));
    // An ancestry-resolved root converts on the open-status claim (codex r14 P1);
    // its own funnel row is bridged by markConverted, nothing is stamped.
    expect(markConverted).toHaveBeenCalledWith('L-root', expect.objectContaining({ onlyIfStatusIn: OPEN_LEAD_STATUSES }));
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });

  test('self-booking: a root staff closed between the ancestry read and the status write is not overwritten — the claim loses and this event converts nothing', async () => {
    const markConverted = jest.fn().mockResolvedValue(false);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-rep-r', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'L-root-r' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-root-r': { id: 'L-root-r', status: 'new', customer_id: 'c1', first_contact_at: '2026-08-30T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(markConverted).toHaveBeenCalledWith('L-root-r', expect.objectContaining({ onlyIfStatusIn: OPEN_LEAD_STATUSES }));
    expect(result).toEqual({ converted: false, reason: 'customer_link_claim_lost' });
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });

  test('self-booking: a repeat filed a day after its LOST original is judged originating by its ancestry — the inquiry began with the original, so the repeat converts', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-08-30' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-rep-late', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'L-root-lost' }, first_contact_at: '2026-09-02T12:00:00Z' },
      leadsById: { 'L-root-lost': { id: 'L-root-lost', status: 'lost', customer_id: 'c1', first_contact_at: '2026-08-30T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-rep-late'] });
    expect(markConverted).toHaveBeenCalledWith('L-rep-late', expect.objectContaining({ customerId: 'c1', onlyIfStatusIn: ['duplicate'] }));
    expect(markConverted).not.toHaveBeenCalledWith('L-root-lost', expect.anything());
  });

  test('self-booking: the ancestry date is never borrowed from ANOTHER customer\'s root — a repeat filed after this customer signed up is still a later add-on', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c2', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-rep-addon', status: 'duplicate', customer_id: 'c2', extracted_data: { duplicate_of_lead_id: 'L-other-old' }, first_contact_at: '2026-09-02T12:00:00Z' },
      leadsById: { 'L-other-old': { id: 'L-other-old', status: 'new', customer_id: 'c-OTHER', first_contact_at: '2026-08-01T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c2', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: false, reason: 'customer_link_not_originating' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('self-booking: a directly customer-linked open lead converts on the open-status claim too (one rule for the tier)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [{ id: 'L-direct', status: 'contacted', customer_id: 'c1', first_contact_at: '2026-08-30T12:00:00Z' }],
      customerDuplicateLeads: [],
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-direct'] });
    expect(markConverted).toHaveBeenCalledWith('L-direct', expect.objectContaining({ onlyIfStatusIn: OPEN_LEAD_STATUSES }));
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });

  test('self-booking: two repeats of one VANISHED original — the newest stands in, but the OLDER sibling that created the customer row says when the inquiry began (codex r16 P1)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLeads: [
        { id: 'R-new', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'L-gone' }, first_contact_at: '2026-09-03T12:00:00Z' },
        { id: 'R-old', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'L-gone' }, first_contact_at: '2026-09-01T12:00:00Z' },
      ],
      leadsById: {},
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['R-new'] });
    expect(markConverted).toHaveBeenCalledTimes(1);
    // The sibling's date decided origination only; the funnel row the win
    // lands on is markConverted's to settle from the row itself (r21 P2, r27).
    expect(markConverted).toHaveBeenCalledWith('R-new', expect.objectContaining({ onlyIfStatusIn: ['duplicate'] }));
  });

  test('self-booking: repeat siblings rank by their LATEST wizard submission (a rerun on an older token bumps updated_at), not by insertion (codex r31 P2)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'R-rerun', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'L-gone' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: {},
      customerWonLead: null,
      contactLeads: [],
    });
    await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(database._calls.orderByRaw).toMatch(/COALESCE\(updated_at, created_at\) DESC/);
    expect(markConverted).toHaveBeenCalledWith('R-rerun', expect.anything());
  });

  test('self-booking: two repeats of a shared parent staff closed as duplicate BY HAND (no marker) are ONE ancestry keyed on that parent — the newest stands in, nothing is ambiguous (codex r28 P1)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLeads: [
        { id: 'R2', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'P' }, first_contact_at: '2026-09-02T12:00:00Z' },
        { id: 'R1', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'P' }, first_contact_at: '2026-09-01T12:00:00Z' },
      ],
      leadsById: { P: { id: 'P', status: 'duplicate', customer_id: 'c1', extracted_data: {}, first_contact_at: '2026-08-30T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['R2'] });
    expect(markConverted).toHaveBeenCalledTimes(1);
  });

  test('self-booking: a chain B → A → O whose terminal root O vanished is ONE ancestry — the newest repeat stands in, nothing is ambiguous (codex r17 P1)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const A = { id: 'A', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'O' }, first_contact_at: '2026-09-01T12:00:00Z' };
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLeads: [
        { id: 'B', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'A' }, first_contact_at: '2026-09-02T12:00:00Z' },
        A,
      ],
      leadsById: { A },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['B'] });
    expect(markConverted).toHaveBeenCalledTimes(1);
  });

  test('self-booking: a repeat whose root is already WON as this customer\'s opportunity — unlinked, contact still matching — is an add-on: established, nothing converts (codex r17 P1)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'R-won', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'W' }, first_contact_at: '2026-09-02T12:00:00Z' },
      // The win never got a customer link, so customerHasWonLead cannot see it.
      leadsById: { W: { id: 'W', status: 'won', customer_id: null, phone: '9412269100', first_contact_at: '2026-08-20T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: false, reason: 'customer_link_established' });
    expect(markConverted).not.toHaveBeenCalled();
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });

  test('self-booking: when the original belongs to a DIFFERENT customer, the authenticated repeat row takes the win', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c2', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-rep2', status: 'duplicate', customer_id: 'c2', extracted_data: { duplicate_of_lead_id: 'L-other' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-other': { id: 'L-other', status: 'new', customer_id: 'c-OTHER', first_contact_at: '2026-08-30T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c2', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-rep2'] });
    // The repeat row is claimed on its label, so a staff transition in
    // between can never be overwritten.
    expect(markConverted).toHaveBeenCalledWith('L-rep2', expect.objectContaining({ customerId: 'c2', onlyIfStatusIn: ['duplicate'] }));
    expect(markConverted).not.toHaveBeenCalledWith('L-other', expect.anything());
    // The foreign root's funnel is not ours to book and the booking recorder
    // skips a converted lead: the repeat gets its own row at booked (codex r14 P2).
    expect(markConverted).toHaveBeenCalledWith('L-rep2', expect.objectContaining({ customerId: 'c2', onlyIfStatusIn: ['duplicate'], onlyIfIdentity: { customer_id: 'c2', phone: null, email: null, estimate_id: null } }));
  });

  test('self-booking: a repeat whose root is SPAM (not answerable, not in CLOSED_LEAD_STATUSES) stands in for it — the root is never claimed on the open statuses (codex r23 P1)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-rep-spam', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'L-root-spam' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-root-spam': { id: 'L-root-spam', status: 'spam', customer_id: 'c1', first_contact_at: '2026-08-30T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-rep-spam'] });
    expect(markConverted).not.toHaveBeenCalledWith('L-root-spam', expect.anything());
  });

  describe('settleRepeatFunnelRow — where a converted repeat\'s win lands when the bridge found no row (codex r22 P2, r24 P1, r27 P1/P2)', () => {
    const repeat = (id, extra = {}) => ({ id, lead_type: 'quote_wizard', status: 'won', customer_id: 'c1', phone: '9415550142', email: 'a@example.com', estimate_id: null, extracted_data: { duplicate_of_lead_id: 'root' }, ...extra });
    // `funnelRows`: lead id → the funnel_stage its ad_service_attribution row
    // sits at. Deletes on that table are recorded on `database._deleted`; the
    // settled-root read's lead claim (whereExists) is recorded on
    // `database._claims`, and `rootChanged` makes that claim fail (codex r30).
    // `leadsNow`: lead id → the row the settlement's LOCKED claim reads
    // (SELECT ... FOR UPDATE) sees, when it differs from the row the
    // settlement read first — a staff edit landing between the two (r35).
    const dbOf = (rows, funnelRows = {}, opts = {}) => {
      const { rootChanged = false, leadsNow = {} } = opts;
      const deleted = [];
      const claims = [];
      const updated = [];
      const locks = [];
      const database = (table) => ({
        where: (a, b) => {
          const q = {
            whereNull: (c) => { q._null = c; return q; },
            forUpdate: () => { q._lock = true; locks.push({ table, where: a, ...(q._scope === undefined ? {} : { scope: q._scope }) }); return q; },
            update: async (patch) => { updated.push({ table, where: a, whereNull: q._null, claimed: !!q._claimed, patch }); return 1; },
            first: async () => {
              if (table === 'ad_service_attribution') return a.lead_id in funnelRows && !(q._claimed && rootChanged) ? { id: `asa-${a.lead_id}`, funnel_stage: funnelRows[a.lead_id], customer_id: (opts.funnelOwners || {})[a.lead_id] || null } : null;
              const id = typeof a === 'string' ? b : a.id;
              const row = (q._lock && leadsNow[id]) || rows[id] || null;
              // An object clause beyond the id is a claim: every key must match the row AS IT IS NOW.
              if (!row || typeof a === 'string') return row;
              // The locked root read also pins the scope its win persisted (won_estimate_id, else its link).
              const scopeHolds = q._scope === undefined || ((row.extracted_data && row.extracted_data.won_estimate_id) || row.estimate_id || null) === q._scope;
              return Object.entries(a).every(([k, v]) => (row[k] ?? null) === (v ?? null)) && !(q._null === 'deleted_at' && row.deleted_at) && scopeHolds ? row : null;
            },
            whereExists: (fn) => {
              const sub = {};
              const bld = { select: () => bld, from: (t) => { sub.from = t; return bld; }, whereRaw: (r) => { sub.whereRaw = r; return bld; }, where: (c) => { sub.where = c; return bld; }, whereNull: (c) => { sub.whereNull = c; return bld; } };
              fn.call(bld); claims.push(sub); q._claimed = true; return q;
            },
            whereRaw: (sql, bindings) => { if (/won_estimate_id/.test(sql)) q._scope = bindings[0]; else q._not = sql; return q; },
            del: async () => { deleted.push({ table, where: a, not: q._not }); return opts.ownCompletesMidTx ? 0 : 1; },
          };
          return q;
        },
      });
      // The settlement's writes run in one transaction (pre-push P1 on
      // 2aa9691); the mock runs the callback on the same handle.
      database.transaction = async (fn) => fn(database);
      database._deleted = deleted;
      database._claims = claims;
      database._updated = updated;
      database._locks = locks;
      return database;
    };
    const ROOT_CLAIM = { onlyIfLead: { customer_id: 'c1', phone: '9415550142', email: null, estimate_id: null, status: 'contacted' } };
    beforeEach(() => { bridgeLeadFunnelStage.mockClear(); stampLeadFunnelRow.mockClear(); });

    test('only a quote_wizard row carrying the duplicate marker is a repeat — a call lead or a plain wizard row is never rebuilt', async () => {
      const database = dbOf({
        call: { id: 'call', lead_type: 'inbound_call', extracted_data: null },
        wiz: { id: 'wiz', lead_type: 'quote_wizard', extracted_data: {} },
      });
      await expect(settleRepeatFunnelRow(database, 'call', { customerId: 'c1' })).resolves.toBeNull();
      await expect(settleRepeatFunnelRow(database, 'wiz', { customerId: 'c1' })).resolves.toBeNull();
      await expect(settleRepeatFunnelRow(database, 'missing', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    });

    test('an open root that is still this customer\'s opportunity, read AFTER the conversion write, has ITS row advanced to booked — no second row for the deal', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead' });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      // The advance is conditioned in SQL on the root still being the row
      // validated here (identity + status + estimate link) — codex r29 P1.
      expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('root', 'won', database, ROOT_CLAIM);
      expect(database._deleted).toEqual([{ table: 'ad_service_attribution', where: { lead_id: 'rep' }, not: "funnel_stage IS DISTINCT FROM 'completed'" }]);
      // The accepting customer lands on the root's row when it has none
      // (an unlinked, contact-matched root) — never over one already there
      // (codex r32 P1).
      expect(database._updated).toEqual([{ table: 'ad_service_attribution', where: { lead_id: 'root' }, whereNull: 'customer_id', claimed: true, patch: expect.objectContaining({ customer_id: 'c1' }) }]);
      expect(database._claims).toHaveLength(1); // the stamp carries the same EXISTS lead claim as the advance (pre-push P1)
    });

    test('the root changed under the settlement (the conditioned advance updates 0 rows and its row is still below booked) — the repeat carries its own row and the root is untouched (codex r29 P1)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      bridgeLeadFunnelStage.mockResolvedValueOnce({ updated: 0 });
      const database = dbOf(rows, { root: 'lead' });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
      expect(database._deleted).toEqual([]);
      expect(database._updated).toEqual([]);
    });

    test('a lead-stage row the repeat kept (its /calculate delete failed) is dropped once the root\'s row carries the win — one row per deal (codex r29 P2)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead', rep: 'booked' });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(database._deleted).toEqual([{ table: 'ad_service_attribution', where: { lead_id: 'rep' }, not: "funnel_stage IS DISTINCT FROM 'completed'" }]);
    });

    test('a repeat row at a NULL stage is a non-completed row: it is dropped (IS DISTINCT FROM, not <>) and the settlement lands on the root, not KEEP_OWN_ROW (codex r33 P2)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead', rep: null });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('root', 'won', database, ROOT_CLAIM);
      // The predicate must be NULL-safe: a plain whereNot({ funnel_stage }) is
      // "<>", which no NULL row satisfies, so the drop would hit 0 rows and
      // the settlement would read that as a completed row and roll back.
      expect(database._deleted).toEqual([{ table: 'ad_service_attribution', where: { lead_id: 'rep' }, not: "funnel_stage IS DISTINCT FROM 'completed'" }]);
    });

    test('the settlement locks BOTH leads under their claims for the whole transaction — the repeat still won, the root as validated (codex r35 P1)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead' });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(database._locks).toEqual([
        { table: 'leads', where: { id: 'rep', status: 'won', customer_id: 'c1', phone: '9415550142', email: 'a@example.com', estimate_id: null } },
        // ...the root's lock also pins the scope its win persisted (won_estimate_id, else its link).
        { table: 'leads', where: { id: 'root', ...ROOT_CLAIM.onlyIfLead }, scope: null },
      ]);
    });

    test('a repeat that is no longer won when the settlement runs (a lost transition landed after the conversion committed) settles NOTHING — no root advance, no drop, no rebuild (codex r35 P1)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead', rep: 'lead' }, { leadsNow: { rep: { ...repeat('rep'), status: 'lost' } } });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(stampLeadFunnelRow).not.toHaveBeenCalled();
      expect(database._deleted).toEqual([]);
      expect(database._updated).toEqual([]);
    });

    test.each([
      ['re-assigned to another customer', { customer_id: 'c-OTHER' }],
      ['linked to another estimate', { estimate_id: 'e-other' }],
    ])('a repeat %s between the settlement\'s read and its lock is not the row judged: nothing is booked, dropped or rebuilt (pre-push P1 on 0731ebb)', async (_label, change) => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead' }, { leadsNow: { rep: { ...repeat('rep'), ...change } } });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(stampLeadFunnelRow).not.toHaveBeenCalled();
      expect(database._deleted).toEqual([]);
    });

    test('a repeat closed after its conversion committed is not rebuilt either — the rebuild runs inside the settlement under the won lock, never in the caller (pre-push P1 on 28489d7)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'lost', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, {}, { leadsNow: { rep: { ...repeat('rep'), status: 'lost' } } });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(stampLeadFunnelRow).not.toHaveBeenCalled();
      expect(database._locks).toEqual([{ table: 'leads', where: { id: 'rep', status: 'won', customer_id: 'c1', phone: '9415550142', email: 'a@example.com', estimate_id: null } }]);
    });

    test.each([
      ['re-assigned to another customer', { customer_id: 'c-OTHER' }],
      ['closed by staff', { status: 'lost' }],
      ['linked to another estimate', { estimate_id: 'e-other' }],
      ['soft-deleted', { deleted_at: '2026-09-05T00:00:00Z' }],
    ])('a root %s between the settlement\'s read and its locked claim is not ours: the repeat carries its own row and the root\'s funnel is untouched (codex r35 P1)', async (_label, change) => {
      const root = { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null };
      const rows = { rep: repeat('rep'), root };
      const database = dbOf(rows, { root: 'lead' }, { leadsNow: { root: { ...root, ...change } } });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(database._deleted).toEqual([]);
    });

    test('a root whose funnel row is still owned by ANOTHER customer (staff re-assigned the lead after its row was stamped) cannot carry this win: the repeat\'s own row is rebuilt and the root\'s row is untouched (codex r36 P1)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead' }, { funnelOwners: { root: 'c-A' } });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ customerId: 'c1', funnelStage: 'booked' }));
      expect(database._deleted).toEqual([]);
      expect(database._updated).toEqual([]);
    });

    test('a root row already owned by THIS customer is settled as before', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead' }, { funnelOwners: { root: 'c1' } });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('root', 'won', database, ROOT_CLAIM);
      expect(stampLeadFunnelRow).not.toHaveBeenCalled();
    });

    test('the settlement judges ownership by the repeat\'s OWN customer, not a stale argument: a repeat re-assigned to c2 does not book c1\'s root, and its rebuilt row carries c2 (pre-push P1 on d511af9)', async () => {
      const rows = { rep: repeat('rep', { customer_id: 'c2' }), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead' });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ customerId: 'c2', funnelStage: 'booked' }));
      expect(database._deleted).toEqual([]);
    });

    test('a root of this opportunity that staff marked WON after the win settled onto it: a replayed conversion of the repeat finds the root\'s row already booked and rebuilds nothing (the r33 replay residual)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'won', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'booked' }, { funnelOwners: { root: 'c1' } });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(stampLeadFunnelRow).not.toHaveBeenCalled();
      // ...judged under the lock on the root as won, with the claimed read.
      expect(database._locks[1]).toEqual({ table: 'leads', where: { id: 'root', customer_id: 'c1', phone: '9415550142', email: null, estimate_id: null, status: 'won' }, scope: null });
      expect(database._claims).toHaveLength(2); // the claimed read + the customer stamp
    });

    test('a row the repeat rebuilt while its root was LOST is dropped once staff mark that root won and its row carries the win — never two booked rows for one deal (pre-push P1 on 795fcc3)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'won', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'booked', rep: 'booked' }, { funnelOwners: { root: 'c1' } });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(stampLeadFunnelRow).not.toHaveBeenCalled();
      expect(database._deleted).toEqual([{ table: 'ad_service_attribution', where: { lead_id: 'rep' }, not: "funnel_stage IS DISTINCT FROM 'completed'" }]);
    });

    test.each([
      ['whose row is still below booked', { root: 'lead' }, {}],
      ['whose row belongs to another customer', { root: 'booked' }, { root: 'c-A' }],
      ['with no row at all', {}, {}],
    ])('a WON root of this opportunity %s does not carry the win: the repeat\'s own row is rebuilt', async (_label, funnelRows, funnelOwners) => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'won', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, funnelRows, { funnelOwners });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
    });

    test('a root row ALREADY at booked (a replayed conversion: the monotonic bridge updates 0 rows) is settled — the repeat is not rebuilt into a second row (codex r28 P1)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      bridgeLeadFunnelStage.mockResolvedValueOnce({ updated: 0 });
      const database = dbOf(rows, { root: 'booked' });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      // The settled read AND the customer stamp carry the same lead claim as the advance.
      const claim = { from: 'leads', whereRaw: 'leads.id = ad_service_attribution.lead_id', where: ROOT_CLAIM.onlyIfLead, whereNull: 'deleted_at' };
      expect(database._claims).toEqual([claim, claim]);
    });

    test('a repeat whose own row already reached completed IS the deal\'s row — nothing settles, the root is never booked beside it (pre-push P1)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead', rep: 'completed' });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(database._deleted).toEqual([]);
    });

    test('a repeat row the revenue sync completes UNDER the settlement is never deleted — the conditioned drop hits 0 rows and the root\'s advance rolls back (pre-push P0)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      const database = dbOf(rows, { root: 'lead', rep: 'booked' }, { ownCompletesMidTx: true });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(database._deleted).toEqual([{ table: 'ad_service_attribution', where: { lead_id: 'rep' }, not: "funnel_stage IS DISTINCT FROM 'completed'" }]);
    });

    test('a pre-booked root row is NOT settled once the root was re-identified since the read (the claimed read finds nothing) — the repeat carries its own row (codex r30 P1)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null } };
      bridgeLeadFunnelStage.mockResolvedValueOnce({ updated: 0 });
      const database = dbOf(rows, { root: 'booked' }, { rootChanged: true });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
      expect(database._deleted).toEqual([]);
    });

    test('an unlinked open root whose CURRENT contact matches the repeat is ours (the accept path\'s rule); a root with NO funnel row at all falls back to the repeat\'s own row', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'new', customer_id: null, phone: '(941) 555-0142', estimate_id: null } };
      bridgeLeadFunnelStage.mockResolvedValueOnce({ updated: 0 });
      const database = dbOf(rows);
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
      expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('root', 'won', expect.any(Function), expect.objectContaining({ onlyIfLead: expect.objectContaining({ customer_id: null, phone: '(941) 555-0142', status: 'new' }) }));
    });

    test.each([
      ['re-assigned to another customer', { status: 'new', customer_id: 'c-OTHER', phone: '9415550142' }],
      ['re-contacted (unlinked, contact no longer matches)', { status: 'new', customer_id: null, phone: '9415550199', email: 'other@example.com' }],
      ['closed by staff', { status: 'lost', customer_id: 'c1', phone: '9415550142' }],
      ['spam (not answerable — positive open membership)', { status: 'spam', customer_id: 'c1', phone: '9415550142' }],
      ['linked to a DIFFERENT estimate than the repeat', { status: 'estimate_sent', customer_id: 'c1', phone: '9415550142', estimate_id: 'e-other' }],
      ['soft-deleted', { status: 'new', customer_id: 'c1', phone: '9415550142', deleted_at: '2026-09-04T00:00:00Z' }],
    ])('a root %s is not ours to book: the repeat\'s own row is rebuilt and the root\'s funnel is untouched', async (_label, root) => {
      const rows = { rep: repeat('rep', { estimate_id: 'e-accepted' }), root: { id: 'root', ...root } };
      const database = dbOf(rows);
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    });

    test('an UNLINKED repeat converted by a deposit on estimate B: a root linked to estimate A is that deal\'s lead — the event\'s estimate scopes the settlement, and the repeat carries its own row (pre-push P1 on 1ea5d47)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'estimate_sent', customer_id: 'c1', phone: '9415550142', estimate_id: 'e-A' } };
      const database = dbOf(rows, { root: 'estimate_sent' });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1', estimateId: 'e-B' })).resolves.toBeNull();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(database._deleted).toEqual([]);
      // ...and the same root IS the deal when the deposit is on ITS estimate.
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1', estimateId: 'e-A' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('root', 'won', database, expect.objectContaining({ onlyIfLead: expect.objectContaining({ estimate_id: 'e-A' }) }));
    });

    test('a replayed conversion with no estimate of its own keeps the scope the winning conversion persisted (extracted_data.won_estimate_id): root A stays refused, the repeat keeps its row (codex r37 P1)', async () => {
      const rows = { rep: repeat('rep', { extracted_data: { duplicate_of_lead_id: 'root', won_estimate_id: 'e-B' } }), root: { id: 'root', status: 'estimate_sent', customer_id: 'c1', phone: '9415550142', estimate_id: 'e-A' } };
      const database = dbOf(rows, { root: 'estimate_sent' });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
      expect(database._deleted).toEqual([]);
      // The event's own estimate still comes first.
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1', estimateId: 'e-A' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('root', 'won', database, expect.objectContaining({ onlyIfLead: expect.objectContaining({ estimate_id: 'e-A' }) }));
    });

    test('an UNLINKED root that WON on estimate A (its persisted scope) is not the deal a repeat won on estimate B: nothing settles onto it, its row is never dropped beside it, the repeat carries its own (pre-push P1 on de469d9)', async () => {
      const rows = { rep: repeat('rep'), root: { id: 'root', status: 'won', customer_id: 'c1', phone: '9415550142', estimate_id: null, extracted_data: { won_estimate_id: 'e-A' } } };
      const database = dbOf(rows, { root: 'booked', rep: 'booked' }, { funnelOwners: { root: 'c1' } });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1', estimateId: 'e-B' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(database._deleted).toEqual([]);
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
      // ...and the SAME root is the deal when the repeat's win is on estimate A: judged on the root's persisted scope, pinned on its lock.
      stampLeadFunnelRow.mockClear();
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1', estimateId: 'e-A' })).resolves.toBeNull();
      expect(stampLeadFunnelRow).not.toHaveBeenCalled();
      expect(database._locks[database._locks.length - 1]).toEqual(expect.objectContaining({ table: 'leads', where: expect.objectContaining({ id: 'root', status: 'won' }), scope: 'e-A' }));
      expect(database._deleted).toEqual([{ table: 'ad_service_attribution', where: { lead_id: 'rep' }, not: "funnel_stage IS DISTINCT FROM 'completed'" }]);
    });

    test('a root whose persisted win scope changed between the read and the lock (a conversion on another estimate landed) loses the claim — the repeat carries its own row', async () => {
      const root = { id: 'root', status: 'contacted', customer_id: 'c1', phone: '9415550142', estimate_id: null };
      const rows = { rep: repeat('rep'), root };
      const database = dbOf(rows, { root: 'lead' }, { leadsNow: { root: { ...root, extracted_data: { won_estimate_id: 'e-A' } } } });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1', estimateId: 'e-B' })).resolves.toBeNull();
      expect(database._locks[1]).toEqual(expect.objectContaining({ table: 'leads', scope: null }));
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
    });

    test('a root linked to the SAME estimate as the repeat is the same deal', async () => {
      const rows = { rep: repeat('rep', { estimate_id: 'e-1' }), root: { id: 'root', status: 'estimate_viewed', customer_id: 'c1', estimate_id: 'e-1' } };
      const database = dbOf(rows, { root: 'estimate_viewed' });
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('root', 'won', database, { onlyIfLead: { customer_id: 'c1', phone: null, email: null, estimate_id: 'e-1', status: 'estimate_viewed' } });
    });

    test('a vanished root (dead marker) leaves the repeat to carry its own row', async () => {
      const rows = { rep: repeat('rep') };
      const database = dbOf(rows);
      await expect(settleRepeatFunnelRow(database, 'rep', { customerId: 'c1' })).resolves.toBeNull();
      expect(stampLeadFunnelRow).toHaveBeenCalledWith(database, rows.rep, expect.objectContaining({ funnelStage: 'booked' }));
      expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
    });
  });

  test('self-booking: a SPAM root already among the customer\'s linked rows never reaches the candidate set (positive open filter) — its repeat stands in (codex r24 P1)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const spamRoot = { id: 'L-root-spam2', status: 'spam', customer_id: 'c1', first_contact_at: '2026-08-30T12:00:00Z' };
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [spamRoot],
      customerDuplicateLead: { id: 'L-rep-spam2', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'L-root-spam2' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-root-spam2': spamRoot },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-rep-spam2'] });
    expect(markConverted).not.toHaveBeenCalledWith('L-root-spam2', expect.anything());
  });

  test('deposit_paid: a root WON through a different estimate neither stands for its repeat nor makes the customer established for THIS estimate (codex r24 P1)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const wonRoot = { id: 'L-won-e1', status: 'won', customer_id: 'c1', estimate_id: 'e1', first_contact_at: '2026-08-30T12:00:00Z' };
    const database = makeConvertDb({
      estimate: { id: 'e2', status: 'accepted', customer_id: 'c1', monthly_total: 80 },
      leadsByEstimate: [],
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-rep-e2b', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'L-won-e1' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-won-e1': wonRoot },
      customerWonLead: wonRoot,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'deposit_paid', estimateId: 'e2', customerId: 'c1', database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-rep-e2b'] });
  });

  test('send/view: a marker followed to a SPAM root does not link the estimate to it (a followed root must be open by positive membership — codex r24 P1)', async () => {
    const rows = {
      'lead-dupS': { id: 'lead-dupS', status: 'duplicate', customer_id: 'customer-1', extracted_data: { duplicate_of_lead_id: 'lead-spamS' } },
      'lead-spamS': { id: 'lead-spamS', status: 'spam', customer_id: 'customer-1', phone: '9415550142', email: 'a@example.com' },
    };
    const estimate = { id: 'estimate-S', estimate_data: { lead_id: 'lead-dupS' }, customer_phone: '9415550142', customer_email: 'a@example.com' };
    const database = (table) => ({
      where(clause) {
        if (table === 'leads' && 'estimate_id' in clause) return Promise.resolve([]);
        if (table === 'leads') return { first: async () => rows[clause.id] || null };
        if (table === 'estimates') return { first: async () => estimate };
        return Promise.resolve([]);
      },
    });
    await expect(resolveEstimateEventLeads(database, 'estimate-S')).resolves.toEqual({ leads: [], rescued: false });
  });

  test('a customer-link claim lost to a concurrent /calculate RELABEL of the root follows the new marker one hop and converts the older open root it reaches (codex r34 P1)', async () => {
    const markConverted = jest.fn()
      .mockResolvedValueOnce(false) // the open-status claim on L-root loses
      .mockResolvedValueOnce(true); // the hop's claim on L-older lands
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [{ id: 'L-root', status: 'new', customer_id: 'c1', phone: '9412269100', estimate_id: null, first_contact_at: '2026-08-30T12:00:00Z' }],
      leadsById: {
        // Re-read AFTER the claim lost: /calculate relabelled it a repeat of an older open lead.
        'L-root': { id: 'L-root', status: 'duplicate', customer_id: 'c1', phone: '9412269100', estimate_id: null, extracted_data: { duplicate_of_lead_id: 'L-older' } },
        'L-older': { id: 'L-older', status: 'contacted', customer_id: 'c1', phone: '9412269100', estimate_id: null, first_contact_at: '2026-08-20T12:00:00Z' },
      },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-older'] });
    expect(markConverted).toHaveBeenNthCalledWith(1, 'L-root', expect.objectContaining({ onlyIfStatusIn: expect.arrayContaining(['new']) }));
    expect(markConverted).toHaveBeenNthCalledWith(2, 'L-older', expect.objectContaining({ onlyIfStatusIn: expect.arrayContaining(['contacted']), onlyIfIdentity: expect.objectContaining({ customer_id: 'c1' }) }));
  });

  test.each([
    ['a genuine closure (lost)', { id: 'L-root', status: 'lost', customer_id: 'c1', phone: '9412269100', estimate_id: null }],
    ['a relabel to a root that is another customer\'s', { id: 'L-root', status: 'duplicate', customer_id: 'c1', phone: '9412269100', estimate_id: null, extracted_data: { duplicate_of_lead_id: 'L-theirs' } }],
    ['a relabel by a write that also re-identified the row', { id: 'L-root', status: 'duplicate', customer_id: 'c-OTHER', phone: '9412269100', estimate_id: null, extracted_data: { duplicate_of_lead_id: 'L-older' } }],
  ])('a customer-link claim lost to %s converts nothing (codex r34 P1)', async (_label, rereadRow) => {
    const markConverted = jest.fn().mockResolvedValue(false);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [{ id: 'L-root', status: 'new', customer_id: 'c1', phone: '9412269100', estimate_id: null, first_contact_at: '2026-08-30T12:00:00Z' }],
      leadsById: {
        'L-root': rereadRow,
        'L-older': { id: 'L-older', status: 'contacted', customer_id: 'c1', phone: '9412269100', estimate_id: null },
        'L-theirs': { id: 'L-theirs', status: 'contacted', customer_id: 'c-OTHER', phone: '9415550199', estimate_id: null },
      },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c1', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: false, reason: 'customer_link_claim_lost' });
    expect(markConverted).toHaveBeenCalledTimes(1);
  });

  test('deposit_paid: a repeat whose open root is linked to a DIFFERENT estimate stands in for it — the root is out of scope, the repeat converts (codex r22 P1)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      estimate: { id: 'e2', status: 'accepted', customer_id: 'c1', monthly_total: 80 },
      leadsByEstimate: [],
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [{ id: 'L-root-e1', status: 'estimate_sent', customer_id: 'c1', estimate_id: 'e1', first_contact_at: '2026-08-30T12:00:00Z' }],
      customerDuplicateLead: { id: 'L-rep-e2', status: 'duplicate', customer_id: 'c1', extracted_data: { duplicate_of_lead_id: 'L-root-e1' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-root-e1': { id: 'L-root-e1', status: 'estimate_sent', customer_id: 'c1', estimate_id: 'e1', first_contact_at: '2026-08-30T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'deposit_paid', estimateId: 'e2', customerId: 'c1', database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-rep-e2'] });
    expect(markConverted).not.toHaveBeenCalledWith('L-root-e1', expect.anything());
    // ...and the event's estimate rides through to the settlement, so the
    // out-of-scope root is refused as the row to book as well as the keeper
    // (pre-push P1 on 1ea5d47).
    expect(markConverted).toHaveBeenCalledWith('L-rep-e2', expect.objectContaining({ onlyIfStatusIn: ['duplicate'], estimateId: 'e2' }));
    // The stamp is markConverted's (so the backfill preview stub covers it) —
    // never a direct write from the resolver (codex r18 P1).
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });

  test('deposit_paid: when the NEWEST repeat of an ancestry is tied to a different estimate, its older unlinked sibling is the keeper — an out-of-scope sibling never silences the in-scope one (codex r27 P1)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      estimate: { id: 'e2', status: 'accepted', customer_id: 'c1', monthly_total: 80 },
      leadsByEstimate: [],
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLeads: [
        { id: 'R-e1', status: 'duplicate', customer_id: 'c1', estimate_id: 'e1', extracted_data: { duplicate_of_lead_id: 'L-gone' }, first_contact_at: '2026-09-03T12:00:00Z' },
        { id: 'R-free', status: 'duplicate', customer_id: 'c1', estimate_id: null, extracted_data: { duplicate_of_lead_id: 'L-gone' }, first_contact_at: '2026-08-30T12:00:00Z' },
      ],
      leadsById: {},
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'deposit_paid', estimateId: 'e2', customerId: 'c1', database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['R-free'] });
    expect(markConverted).toHaveBeenCalledTimes(1);
    expect(markConverted).toHaveBeenCalledWith('R-free', expect.objectContaining({ onlyIfStatusIn: ['duplicate'], onlyIfIdentity: expect.objectContaining({ estimate_id: null }) }));
  });

  test('self-booking: a repeat row whose label was changed by staff before the claim converts nothing', async () => {
    const markConverted = jest.fn().mockResolvedValue(false);
    const database = makeConvertDb({
      customer: { id: 'c2', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-rep3', status: 'duplicate', customer_id: 'c2', extracted_data: { duplicate_of_lead_id: 'L-other3' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-other3': { id: 'L-other3', status: 'new', customer_id: 'c-OTHER' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c2', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: false, reason: 'customer_link_claim_lost' });
    expect(stampLeadFunnelRow).not.toHaveBeenCalled();
  });

  test('self-booking: two repeats of the SAME foreign original are one opportunity — the newest repeat takes the win', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c4', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLeads: [
        { id: 'L-rep-new', status: 'duplicate', customer_id: 'c4', extracted_data: { duplicate_of_lead_id: 'L-foreign' }, first_contact_at: '2026-09-01T12:00:00Z' },
        { id: 'L-rep-old', status: 'duplicate', customer_id: 'c4', extracted_data: { duplicate_of_lead_id: 'L-foreign' }, first_contact_at: '2026-08-31T12:00:00Z' },
      ],
      leadsById: { 'L-foreign': { id: 'L-foreign', status: 'new', customer_id: 'c-OTHER' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c4', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-rep-new'] });
  });

  test('self-booking: an unrelated open lead plus a repeat row are two opportunities — ambiguous, nothing converts', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c5', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [{ id: 'L-unrelated', status: 'new', customer_id: 'c5', first_contact_at: '2026-08-20T12:00:00Z' }],
      customerDuplicateLead: { id: 'L-rep5', status: 'duplicate', customer_id: 'c5', extracted_data: { duplicate_of_lead_id: 'L-foreign5' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-foreign5': { id: 'L-foreign5', status: 'new', customer_id: 'c-OTHER' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c5', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: false, reason: 'ambiguous_customer_link' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('self-booking: a repeat whose root IS the customer\'s open lead collapses into that one opportunity', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c6', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [{ id: 'L-root6', status: 'new', customer_id: 'c6', first_contact_at: '2026-08-20T12:00:00Z' }],
      customerDuplicateLead: { id: 'L-rep6', status: 'duplicate', customer_id: 'c6', extracted_data: { duplicate_of_lead_id: 'L-root6' } },
      leadsById: { 'L-root6': { id: 'L-root6', status: 'new', customer_id: 'c6', first_contact_at: '2026-08-20T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c6', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-root6'] });
    // One claim rule for the tier (r15): the root converts on the open statuses.
    expect(markConverted).toHaveBeenCalledWith('L-root6', expect.objectContaining({ onlyIfStatusIn: OPEN_LEAD_STATUSES }));
  });

  test('self-booking: two repeats of one VANISHED original group by their recorded marker — one opportunity, the newest repeat wins', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c7', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLeads: [
        { id: 'L-rep7n', status: 'duplicate', customer_id: 'c7', extracted_data: { duplicate_of_lead_id: 'L-gone' }, first_contact_at: '2026-09-01T12:00:00Z' },
        { id: 'L-rep7o', status: 'duplicate', customer_id: 'c7', extracted_data: { duplicate_of_lead_id: 'L-gone' }, first_contact_at: '2026-08-31T12:00:00Z' },
      ],
      leadsById: {},
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c7', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-rep7n'] });
  });

  test('self-booking: a row staff closed as duplicate BY HAND (no ancestry marker) is never a rescue candidate', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c8', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-manual', status: 'duplicate', customer_id: 'c8', extracted_data: {}, first_contact_at: '2026-08-01T12:00:00Z' },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c8', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: false, reason: 'no_open_lead' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('self-booking: an UNLINKED root whose current contact no longer matches the customer is not ours — the repeat takes the win', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c9', phone: '+19412269100', email: 'c9@example.com', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-rep9', status: 'duplicate', customer_id: 'c9', extracted_data: { duplicate_of_lead_id: 'L-root9' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-root9': { id: 'L-root9', status: 'new', customer_id: null, phone: '9415550199', email: 'someone-else@example.com' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c9', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-rep9'] });
    expect(markConverted).not.toHaveBeenCalledWith('L-root9', expect.anything());
  });

  test('self-booking: an UNLINKED root whose current contact matches the customer converts as the opportunity', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c10', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLead: { id: 'L-rep10', status: 'duplicate', customer_id: 'c10', extracted_data: { duplicate_of_lead_id: 'L-root10' }, first_contact_at: '2026-09-01T12:00:00Z' },
      leadsById: { 'L-root10': { id: 'L-root10', status: 'new', customer_id: null, phone: '9412269100', first_contact_at: '2026-08-30T12:00:00Z' } },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c10', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: true, count: 1, leadIds: ['L-root10'] });
  });

  test('self-booking: duplicate rows behind two DIFFERENT opportunities are ambiguous — nothing converts', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c3', phone: '+19412269100', member_since: '2026-09-01' },
      customerOpenLeads: [],
      customerDuplicateLeads: [
        { id: 'L-repA', status: 'duplicate', customer_id: 'c3', extracted_data: { duplicate_of_lead_id: 'L-rootA' } },
        { id: 'L-repB', status: 'duplicate', customer_id: 'c3', extracted_data: { duplicate_of_lead_id: 'L-rootB' } },
      ],
      leadsById: {
        'L-rootA': { id: 'L-rootA', status: 'new', customer_id: 'c3' },
        'L-rootB': { id: 'L-rootB', status: 'new', customer_id: 'c3' },
      },
      customerWonLead: null,
      contactLeads: [],
    });
    const result = await convertLeadFromEvent({ source: 'self_booking_estimate', customerId: 'c3', enforceOriginating: true, database, leadAttributionService: { markConverted } });
    expect(result).toEqual({ converted: false, reason: 'ambiguous_customer_link' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('for an estimate-scoped event, does NOT convert a lead tied to a DIFFERENT estimate', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      estimate: { id: 'estA', customer_id: 'c1' }, // deposit paid on estimate A
      leadsByEstimate: [], // no lead FK-linked to estimate A
      customer: { id: 'c1', phone: '+19412269100', member_since: '2026-06-01' },
      // The customer's only open lead is linked to a DIFFERENT estimate (B).
      customerOpenLeads: [{ id: 'L9', status: 'new', customer_id: 'c1', estimate_id: 'estB', first_contact_at: '2026-05-20T12:00:00Z' }],
      customerWonLead: null,
      contactLeads: [],
    });

    const result = await convertLeadFromEvent({
      source: 'deposit_paid',
      estimateId: 'estA',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'no_open_lead' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('does NOT convert when the customer already has a won lead (established → add-on not swept)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100' },
      customerOpenLeads: [{ id: 'L9', status: 'new', customer_id: 'c1' }],
      customerWonLead: { id: 'Lold' }, // already closed a deal → L9 is an add-on
    });

    const result = await convertLeadFromEvent({
      source: 'invoice_sent',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'customer_link_established' });
    expect(markConverted).not.toHaveBeenCalled();
  });

  test('skips when the customer has 2+ open leads (ambiguous which one closed)', async () => {
    const markConverted = jest.fn().mockResolvedValue(true);
    const database = makeConvertDb({
      customer: { id: 'c1', phone: '+19412269100' },
      customerOpenLeads: [
        { id: 'L9', status: 'new', customer_id: 'c1' },
        { id: 'L10', status: 'contacted', customer_id: 'c1' },
      ],
      customerWonLead: null,
    });

    const result = await convertLeadFromEvent({
      source: 'service_completed',
      customerId: 'c1',
      database,
      leadAttributionService: { markConverted },
    });

    expect(result).toEqual({ converted: false, reason: 'ambiguous_customer_link' });
    expect(markConverted).not.toHaveBeenCalled();
  });
});

describe('attributeSelfBooking (click-id capture for cold ad self-bookings)', () => {
  // Mock surface used by attributeSelfBooking:
  //   customers.where({id}).first()                       -> the booker
  //   leads.where({customer_id}).first('id')              -> existing-lead guard
  //   leads.whereNotIn(...).whereNull(...).andWhere(...)  -> findUnconvertedLeadsByContact
  //   leads.insert(row).returning('*')                    -> minted lead
  //   lead_activities.insert(row).catch(fn)               -> audit log (best-effort)
  function makeAttrDb(opts = {}) {
    const inserted = [];
    const database = (table) => {
      if (opts.throwOnTable === table) throw new Error('db boom');
      return {
        where(clause) {
          if (table === 'customers') return { first: async () => opts.customer || null };
          if (table === 'leads' && clause && 'customer_id' in clause) {
            // existing-lead guard now excludes soft-deleted rows:
            // .where({customer_id}).whereNull('deleted_at').first('id')
            const linked = {
              whereNull: () => linked,
              first: async () => opts.linkedLead || null,
            };
            return linked;
          }
          return { first: async () => null };
        },
        whereNotIn() {
          const chain = {
            whereNull: () => chain,
            andWhere: () => Promise.resolve(opts.contactLeads || []),
          };
          return chain;
        },
        insert(row) {
          inserted.push({ table, row });
          return {
            returning: async () => [{ id: opts.mintedId || 'minted-1', ...row }],
            onConflict: () => ({ ignore: async () => 1 }),
            catch: () => Promise.resolve(),
          };
        },
      };
    };
    database._inserted = inserted;
    return database;
  }

  const FB_ATTR = {
    utm: { source: 'facebook', medium: 'paid', campaign: 'spring', term: null, content: null },
    fbclid: 'fb-click-123',
    fbc: 'fb.1.1700000000000.fb-click-123',
    fbp: 'fb.1.1700000000000.987654321',
    gclid: null, wbraid: null, gbraid: null,
    referrer: 'https://facebook.com/', landing_url: 'https://wavespestcontrol.com/book?fbclid=fb-click-123',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    resolveLeadSource.mockResolvedValue({ leadSourceId: 'ls-fb', leadSourceName: 'Facebook', leadSourceDetail: 'Meta click (fbclid)' });
  });

  test('mints a won lead + PPC funnel row when ad-tracked, customer just created, and no lead exists', async () => {
    const database = makeAttrDb({
      customer: { id: 'c1', first_name: 'Dana', last_name: 'Reyes', phone: '+19415550101', email: 'dana@example.com' },
    });

    const result = await attributeSelfBooking({
      customerId: 'c1', attribution: FB_ATTR, serviceInterest: 'General Pest Control', customerCreated: true, selfBookedAppointmentId: 'sba-paid', database,
    });

    expect(result).toMatchObject({ attributed: true, minted: true, leadId: 'minted-1' });
    const mint = database._inserted.find((i) => i.table === 'leads');
    expect(mint).toBeTruthy();
    expect(mint.row).toMatchObject({
      customer_id: 'c1',
      status: 'won',
      is_qualified: true,
      lead_type: 'self_booking',
      first_contact_channel: 'web',
      lead_source_id: 'ls-fb',
      service_interest: 'General Pest Control',
      fbclid: 'fb-click-123',
      fbc: 'fb.1.1700000000000.fb-click-123',
      fbp: 'fb.1.1700000000000.987654321',
      phone: '+19415550101',
      email: 'dana@example.com',
    });
    expect(mint.row.converted_at).toBeInstanceOf(Date);
    // null click ids are not written as keys
    expect(mint.row).not.toHaveProperty('gclid');
    // audit trail
    expect(database._inserted.some((i) => i.table === 'lead_activities')).toBe(true);
    // PPC funnel row mirrors the web-lead path, source = the click's platform
    const ppc = database._inserted.find((i) => i.table === 'ad_service_attribution');
    expect(ppc).toBeTruthy();
    expect(ppc.row).toMatchObject({
      lead_id: 'minted-1',
      customer_id: 'c1',
      lead_source: 'facebook',
      fbclid: 'fb-click-123',
      // Born at booked: the booking is committed and the won lead is a direct
      // insert (no transition ever fires the bridge for it).
      funnel_stage: 'booked',
      // booking lineage + the shared per-booking dedupe key
      self_booked_appointment_id: 'sba-paid',
    });
  });

  test('pre-existing customer on a paid Meta click: records a row-only booking row (correct paid channel), mints NO lead', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1', attribution: FB_ATTR, serviceInterest: 'General Pest Control',
      customerCreated: false, selfBookedAppointmentId: 'sba-repeat', database,
    });

    expect(result).toEqual({ attributed: true, repeatPaid: true, leadSource: 'facebook' });
    // The strongest-evidence paid conversion there is — but a repeat booker is
    // NOT a fresh acquisition: no minted lead, no activity, row only.
    expect(database._inserted.some((i) => i.table === 'leads')).toBe(false);
    expect(database._inserted.some((i) => i.table === 'lead_activities')).toBe(false);
    const row = database._inserted.find((i) => i.table === 'ad_service_attribution');
    expect(row).toBeTruthy();
    expect(row.row).toMatchObject({
      customer_id: 'c1',
      self_booked_appointment_id: 'sba-repeat', // per-booking dedupe key
      lead_source: 'facebook',
      is_paid: true, // deterministic paid click id IS the paid channel
      funnel_stage: 'booked',
      fbclid: 'fb-click-123',
      fbc: 'fb.1.1700000000000.fb-click-123',
      fbp: 'fb.1.1700000000000.987654321',
    });
    // No-lead path: the row must not claim a lead.
    expect(row.row).not.toHaveProperty('lead_id');
  });

  test('pre-existing customer on a paid Google click records lead_source google_ads (still no mint)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: { utm: { source: 'google', medium: 'cpc' }, gclid: 'g-click-9', wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null },
      customerCreated: false,
      selfBookedAppointmentId: 'sba-repeat-g',
      database,
    });

    expect(result).toEqual({ attributed: true, repeatPaid: true, leadSource: 'google_ads' });
    expect(database._inserted.some((i) => i.table === 'leads')).toBe(false);
    const row = database._inserted.find((i) => i.table === 'ad_service_attribution');
    expect(row.row).toMatchObject({ lead_source: 'google_ads', gclid: 'g-click-9', is_paid: true });
  });

  test('pre-existing customer paid click WITHOUT a booking id fails closed (no dedupe key → no row, like the organic path)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1', attribution: FB_ATTR, customerCreated: false, database,
    });

    expect(result).toEqual({ attributed: false, reason: 'no_booking_id' });
    expect(database._inserted).toEqual([]);
  });

  test('mints for a Meta booking carrying only an _fbc cookie (fbclid fell off the URL)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: { utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: 'fb.1.1700000000000.late-click', fbp: 'fb.1.x.ambient' },
      customerCreated: true,
      database,
    });

    expect(result).toMatchObject({ attributed: true, minted: true });
    const mint = database._inserted.find((i) => i.table === 'leads');
    expect(mint.row.fbc).toBe('fb.1.1700000000000.late-click');
    expect(mint.row).not.toHaveProperty('fbclid');
  });

  test('persists a Google gclid (capped to the column length) for a paid Google self-booking', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });
    const longGclid = 'g'.repeat(260);

    await attributeSelfBooking({
      customerId: 'c1',
      attribution: { utm: { source: 'google', medium: 'cpc' }, gclid: longGclid, fbclid: null, wbraid: null, gbraid: null },
      customerCreated: true,
      database,
    });

    const mint = database._inserted.find((i) => i.table === 'leads');
    expect(mint.row.gclid).toHaveLength(200); // varchar(200) cap
    expect(mint.row).not.toHaveProperty('fbclid');
    // PPC funnel row attributes it to Google Ads
    const ppc = database._inserted.find((i) => i.table === 'ad_service_attribution');
    expect(ppc.row.lead_source).toBe('google_ads');
    expect(ppc.row.gclid).toHaveLength(200);
  });

  test('does NOT mint when the touch carries no deterministic click id (a bare _fbp cookie is not a click) — organic funnel row instead', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: {
        utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null,
        fbp: 'fb.1.x.ambient',
        landing_url: 'https://wavespestcontrol.com/book', // real capture — the client always sends the landing
      },
      customerCreated: true,
      selfBookedAppointmentId: 'sba-1',
      database,
    });

    expect(result).toMatchObject({ attributed: true, organic: true });
    // No lead is EVER minted without a paid click id — only a funnel row.
    expect(database._inserted.some((i) => i.table === 'leads')).toBe(false);
    const row = database._inserted.find((i) => i.table === 'ad_service_attribution');
    expect(row).toBeTruthy();
    expect(row.row).toMatchObject({
      customer_id: 'c1',
      self_booked_appointment_id: 'sba-1',
      is_paid: false,
      funnel_stage: 'booked', // the booking already committed when this runs
      fbp: 'fb.1.x.ambient', // aux CAPI match key only — never a paid signal
    });
  });

  test('no capture, no row: attribution-less bookings (legacy page / voice agent / fbp-only) fabricate nothing', async () => {
    for (const attribution of [
      null,
      undefined,
      {},
      { utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null, referrer: null, landing_url: null },
      // ambient _fbp alone is not a capture — it carries zero classification signal
      { utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: 'fb.1.x.ambient' },
    ]) {
      const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });
      const result = await attributeSelfBooking({
        customerId: 'c1', attribution, customerCreated: true, selfBookedAppointmentId: 'sba-none', database,
      });
      expect(result).toEqual({ attributed: false, reason: 'no_attribution_capture' });
      expect(database._inserted).toEqual([]);
    }
  });

  test('recovery-link booking mints NO acquisition row (same journey completing) and is labeled as such', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: {
        utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null,
        // The abandoned-booking recovery SMS/email links to the OWNED portal URL
        // (booking-abandon-recovery BOOKING_URL) — a real capture, but not a new
        // acquisition touch.
        landing_url: 'https://portal.wavespestcontrol.com/book?source=booking_recovery',
        referrer: null,
      },
      customerCreated: true,
      selfBookedAppointmentId: 'sba-recovery',
      bookingSource: 'booking_recovery',
      database,
    });

    expect(result).toEqual({ attributed: false, reason: 'recovery_rebooking' });
    expect(database._inserted).toEqual([]);
  });

  test('recovery booking still carrying the ORIGINAL ad click id (_fbc) mints nothing — the source gate runs before the paid-click branch', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: {
        // Same journey completing: the visitor abandoned after a real Meta ad
        // click, so the browser still carries the live _fbc/fbclid. Round 3
        // only gated the organic recorder, so this used to fall through to
        // the paid-click mint and re-mint the journey as a NEW won paid lead.
        ...FB_ATTR,
        landing_url: 'https://portal.wavespestcontrol.com/book?source=booking_recovery',
      },
      customerCreated: true, // the recovery booking creates the customer
      selfBookedAppointmentId: 'sba-recovery-fbc',
      bookingSource: 'booking_recovery',
      database,
    });

    expect(result).toEqual({ attributed: false, reason: 'recovery_rebooking' });
    expect(database._inserted).toEqual([]);
  });

  test('owned estimate-originated sources skip acquisition minting with their own labeled reason (portal capture alone must not double-count the journey)', async () => {
    for (const bookingSource of ['quote-wizard', 'quote-wizard-onetime', 'estimate-accept', 'admin-manual-booking-resend']) {
      const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

      const result = await attributeSelfBooking({
        customerId: 'c1',
        attribution: {
          utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null,
          // PublicBookingPage always posts the portal landing_url — a real
          // capture, but the journey's attribution row already exists
          // (public-quote inserts it at estimate time).
          landing_url: `https://portal.wavespestcontrol.com/book?source=${bookingSource}`,
          referrer: null,
        },
        customerCreated: false,
        selfBookedAppointmentId: `sba-${bookingSource}`,
        bookingSource,
        database,
      });

      expect(result).toEqual({ attributed: false, reason: 'estimate_originated' });
      expect(database._inserted).toEqual([]);
    }
  });

  test('estimate-originated source gates the PAID path too (a lingering click id must not mint or row a second journey)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: FB_ATTR,
      customerCreated: true,
      selfBookedAppointmentId: 'sba-qw-paid',
      bookingSource: 'quote-wizard',
      database,
    });

    expect(result).toEqual({ attributed: false, reason: 'estimate_originated' });
    expect(database._inserted).toEqual([]);
  });

  test('a booking that just converted an existing lead records NO row-only attribution (the bridge advanced that lead\'s own funnel row — a second row double-counts the booking)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: {
        utm: { source: 'google', medium: 'organic', campaign: null, term: null, content: null },
        gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null,
        landing_url: 'https://wavespestcontrol.com/book',
        referrer: 'https://www.google.com/',
      },
      customerCreated: false,
      selfBookedAppointmentId: 'sba-converted-organic',
      leadConverted: true,
      database,
    });

    expect(result).toEqual({ attributed: false, reason: 'lead_converted' });
    expect(database._inserted).toEqual([]);
  });

  test('converted-lead gate runs before the PAID branch too (a live click id on a converting booking must not add a repeat-paid row)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: FB_ATTR,
      customerCreated: false,
      selfBookedAppointmentId: 'sba-converted-paid',
      leadConverted: true,
      database,
    });

    expect(result).toEqual({ attributed: false, reason: 'lead_converted' });
    expect(database._inserted).toEqual([]);
  });

  test('paid Meta UTMs with a stripped click id stay PAID (is_paid from the classifier channel, like the webhook)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: {
        utm: { source: 'facebook', medium: 'cpc', campaign: 'spring', term: null, content: null },
        gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null,
        landing_url: 'https://wavespestcontrol.com/book',
      },
      customerCreated: true,
      selfBookedAppointmentId: 'sba-fbcpc',
      database,
    });

    // Still no minted lead (no deterministic click id) — but the funnel row
    // carries the paid channel so splitFacebookByPaid keeps it under paid Meta.
    expect(result).toMatchObject({ attributed: true, organic: true, leadSource: 'facebook' });
    expect(database._inserted.some((i) => i.table === 'leads')).toBe(false);
    const row = database._inserted.find((i) => i.table === 'ad_service_attribution');
    expect(row.row).toMatchObject({ lead_source: 'facebook', is_paid: true, funnel_stage: 'booked' });
  });

  test('does NOT mint on a non-ad UTM + ambient _fbp (newsletter/organic must not become a paid won lead)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: { utm: { source: 'newsletter', medium: 'email', campaign: 'june' }, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: 'fb.1.x.ambient' },
      customerCreated: true,
      selfBookedAppointmentId: 'sba-2',
      database,
    });

    expect(result).toMatchObject({ attributed: true, organic: true });
    expect(database._inserted.some((i) => i.table === 'leads')).toBe(false);
    const row = database._inserted.find((i) => i.table === 'ad_service_attribution');
    // determineLeadSource fallback: unknown UTM source keys the bucket.
    expect(row.row).toMatchObject({
      lead_source: 'newsletter',
      utm_campaign: 'june',
      is_paid: false,
    });
  });

  test('organic booking with a GBP UTM classifies via the shared determineLeadSource (google_business)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: {
        utm: { source: 'gbp', medium: 'organic', campaign: 'gbp', term: null, content: 'unknown-profile' },
        gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null,
        referrer: 'https://www.google.com/', landing_url: 'https://wavespestcontrol.com/book',
      },
      customerCreated: true,
      selfBookedAppointmentId: 'sba-3',
      database,
    });

    expect(result).toMatchObject({ attributed: true, organic: true, leadSource: 'google_business' });
    const row = database._inserted.find((i) => i.table === 'ad_service_attribution');
    expect(row.row.lead_source).toBe('google_business');
    expect(row.row.is_paid).toBe(false);
  });

  test('organic REPEAT-customer booking still records a funnel row (per-booking capture, still no lead)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: { utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null, landing_url: 'https://wavespestcontrol.com/book' },
      customerCreated: false, // resolved existing customer
      selfBookedAppointmentId: 'sba-4',
      database,
    });

    expect(result).toMatchObject({ attributed: true, organic: true });
    expect(database._inserted.some((i) => i.table === 'leads')).toBe(false);
    const row = database._inserted.find((i) => i.table === 'ad_service_attribution');
    expect(row.row).toMatchObject({ self_booked_appointment_id: 'sba-4', is_paid: false });
  });

  test('embedded iframe booking: portal landing_url defers to the spoke-page referrer (domain_website, not the portal host)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: {
        utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null,
        // PublicBookingPage inside a spoke iframe: landing = the portal's own
        // /book URL; the real page the customer was on arrives as referrer.
        landing_url: 'https://portal.wavespestcontrol.com/book?service=lawn_care',
        referrer: 'https://www.parrishfllawncare.com/lawn-care-parrish/',
      },
      customerCreated: true,
      selfBookedAppointmentId: 'sba-iframe',
      database,
    });

    expect(result).toMatchObject({ attributed: true, organic: true, leadSource: 'domain_website' });
    const row = database._inserted.find((i) => i.table === 'ad_service_attribution');
    expect(row.row.lead_source).toBe('domain_website');
    expect(row.row.lead_source_detail).toBe('parrishfllawncare.com');
    expect(row.row.funnel_stage).toBe('booked');
  });

  test('portal landing with a signal-less referrer (google.com) keeps the landing classification — never downgrades to the generic bucket', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: {
        utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null,
        landing_url: 'https://portal.wavespestcontrol.com/book',
        referrer: 'https://www.google.com/',
      },
      customerCreated: true,
      selfBookedAppointmentId: 'sba-google-ref',
      database,
    });

    // google.com classifies to the generic 'website' fallback, so the landing's
    // waves_website classification (portal host ⊂ wavespestcontrol.com) wins.
    expect(result).toMatchObject({ attributed: true, organic: true, leadSource: 'waves_website' });
  });

  test('organic booking WITHOUT a booking id fails closed (no per-booking dedupe key → no row)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: { utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: null },
      customerCreated: true,
      database,
    });

    expect(result).toEqual({ attributed: false, reason: 'no_booking_id' });
    expect(database._inserted).toEqual([]);
  });

  test('does NOT mint a duplicate when the booker already has a lead on file', async () => {
    const database = makeAttrDb({
      customer: { id: 'c1', phone: '+19415550101' },
      linkedLead: { id: 'existing-lead' },
    });

    const result = await attributeSelfBooking({ customerId: 'c1', attribution: FB_ATTR, customerCreated: true, database });

    expect(result).toEqual({ attributed: false, reason: 'existing_customer_lead' });
    expect(database._inserted).toEqual([]);
  });

  test('does NOT mint when an unconverted lead matches the booker by contact', async () => {
    const database = makeAttrDb({
      customer: { id: 'c1', phone: '+19415550101', email: 'dana@example.com' },
      contactLeads: [{ id: 'open-contact-lead', status: 'new', customer_id: null }],
    });

    const result = await attributeSelfBooking({ customerId: 'c1', attribution: FB_ATTR, customerCreated: true, database });

    expect(result).toEqual({ attributed: false, reason: 'existing_contact_lead' });
    expect(database._inserted).toEqual([]);
  });

  test('never throws into the committed booking — a db failure resolves to an error result', async () => {
    const database = makeAttrDb({ throwOnTable: 'customers' });

    const result = await attributeSelfBooking({ customerId: 'c1', attribution: FB_ATTR, customerCreated: true, database });

    expect(result).toEqual({ attributed: false, reason: 'error' });
  });
});

describe('linkLeadEstimatesToCustomer', () => {
  // Records each estimates() query chain so we can assert the guard + patch
  // without a real db. update() resolves to a row count like knex/pg; select()
  // resolves to the configured tagged rows (the estimate_data.lead_id prefilter).
  function makeBackfillDb({ rowsUpdated = 1, throwOnUpdate = false, taggedRows = [] } = {}) {
    const ops = [];
    function chain(table) {
      const ctx = { table, wheres: [], patch: null, selected: false };
      ops.push(ctx);
      const c = {
        where: (a) => { ctx.wheres.push(['where', a]); return c; },
        whereNull: (col) => { ctx.wheres.push(['whereNull', col]); return c; },
        whereIn: (col, vals) => { ctx.wheres.push(['whereIn', col, vals]); return c; },
        whereRaw: (sql, b) => { ctx.wheres.push(['whereRaw', sql, b]); return c; },
        select: async () => { ctx.selected = true; return taggedRows; },
        update: async (patch) => {
          if (throwOnUpdate) throw new Error('boom');
          ctx.patch = patch;
          return rowsUpdated;
        },
      };
      return c;
    }
    const database = (table) => chain(table);
    return { database, ops };
  }

  test('attaches the FK-linked estimate, guarded to unowned, and returns the count', async () => {
    const { database, ops } = makeBackfillDb({ rowsUpdated: 1 });
    const n = await linkLeadEstimatesToCustomer({
      database,
      lead: { id: 'lead-1', estimate_id: 'est-1', phone: '9415550101', email: 'jake@example.com' },
      customerId: 'cust-9',
    });
    expect(n).toBe(1);
    expect(ops).toHaveLength(1);
    expect(ops[0].table).toBe('estimates');
    // Targets the FK estimate and never re-homes an already-owned one.
    expect(ops[0].wheres).toContainEqual(['where', { id: 'est-1' }]);
    expect(ops[0].wheres).toContainEqual(['whereNull', 'customer_id']);
    expect(ops[0].patch.customer_id).toBe('cust-9');
  });

  test('falls back to the estimate_data.lead_id mirror (exact id, not contact) when there is no FK link', async () => {
    const taggedRows = [
      { id: 'est-a', estimate_data: JSON.stringify({ lead_id: 'lead-2' }) },
      { id: 'est-b', estimate_data: JSON.stringify({ lead_id: 'someone-else' }) },
    ];
    const { database, ops } = makeBackfillDb({ rowsUpdated: 1, taggedRows });
    const n = await linkLeadEstimatesToCustomer({
      database,
      // Shares a phone with est-b's lead, but only est-a is tagged with lead-2.
      lead: { id: 'lead-2', estimate_id: null, phone: '9415550102', email: 'pat@example.com' },
      customerId: 'cust-7',
    });
    expect(n).toBe(1);
    const update = ops.find((o) => o.patch);
    // Only the estimate whose estimate_data.lead_id === lead.id is attached.
    expect(update.wheres).toContainEqual(['whereIn', 'id', ['est-a']]);
    expect(update.wheres).toContainEqual(['whereNull', 'customer_id']);
    expect(update.patch.customer_id).toBe('cust-7');
  });

  test('returns 0 when no FK link and nothing is tagged with the lead id (no contact sweep)', async () => {
    const taggedRows = [{ id: 'est-x', estimate_data: JSON.stringify({ lead_id: 'unrelated' }) }];
    const { database, ops } = makeBackfillDb({ taggedRows });
    const n = await linkLeadEstimatesToCustomer({
      database,
      lead: { id: 'lead-3', estimate_id: null, phone: '9415550102', email: 'pat@example.com' },
      customerId: 'cust-1',
    });
    expect(n).toBe(0);
    // Prefilter ran, but no update (no exact lead-id match).
    expect(ops.some((o) => o.selected)).toBe(true);
    expect(ops.some((o) => o.patch)).toBe(false);
  });

  test('no-ops without a customerId or lead', async () => {
    const { database, ops } = makeBackfillDb();
    expect(await linkLeadEstimatesToCustomer({ database, lead: { id: 'l', estimate_id: 'e' }, customerId: null })).toBe(0);
    expect(await linkLeadEstimatesToCustomer({ database, lead: null, customerId: 'c' })).toBe(0);
    expect(ops).toHaveLength(0);
  });

  test('swallows db errors (never breaks the conversion) and returns 0', async () => {
    const { database } = makeBackfillDb({ throwOnUpdate: true });
    const n = await linkLeadEstimatesToCustomer({
      database,
      lead: { id: 'lead-5', estimate_id: 'est-5' },
      customerId: 'cust-5',
    });
    expect(n).toBe(0);
  });
});

describe('estimate sent/viewed — standalone-estimate contact rescue', () => {
  // Every send flow attempts the qualify-on-send write right after the
  // status flip (sending an estimate IS qualification); the fixture-backed
  // mock applies it only when the lead exists in leadsById, is open, and is
  // not yet qualified — otherwise it records the attempt and touches 0 rows.
  const QUALIFY_ATTEMPT = (id) => ({
    id,
    whereIn: ['new', 'contacted', 'estimate_sent', 'estimate_viewed'],
    whereRaw: 'is_qualified IS DISTINCT FROM TRUE AND deleted_at IS NULL',
    patch: expect.objectContaining({ is_qualified: true }),
  });
  // Mock supporting both branches of resolveEstimateEventLeads:
  //   leads.where({estimate_id})            -> FK-linked rows (array)
  //   estimates.where({id}).first()         -> the estimate
  //   leads.where({id}).first()             -> mirror lead lookup
  //   leads.where({id}).whereNull('estimate_id').update() -> rescue link stamp
  //   leads.where({id}).update()            -> status flip / first-response
  //   leads.whereNotIn(...).whereNull(...).andWhere(...)  -> contact matches
  //   lead_activities.insert()              -> activity rows
  function makeEventDb(opts = {}) {
    const updates = [];
    const activities = [];
    const leadsById = opts.leadsById || {};
    const database = (table) => ({
      where(clause) {
        if (table === 'leads' && clause && 'estimate_id' in clause && !('id' in clause)) {
          return Promise.resolve(opts.linked || []);
        }
        if (table === 'estimates') return { first: async () => opts.estimate || null };
        if (table === 'customers') return { first: async () => opts.customer || null };
        // customerHasWonLead: .where({ customer_id, status: 'won' })
        // .whereNull('deleted_at').first('id')
        if (table === 'leads' && clause && 'customer_id' in clause && 'status' in clause) {
          const won = {
            whereNull: () => won,
            modify: (fn) => { fn(won); return won; },
            first: async () => opts.customerWonLead || null,
          };
          return won;
        }
        if (table === 'leads' && clause && 'id' in clause) {
          return {
            first: async () => leadsById[clause.id] || null,
            whereNull: (col) => ({
              // linkRescuedLead: .whereNull('estimate_id').whereIn('status', OPEN)
              // .where(identity as read).update(...) (codex r27 P1, r31 P1)
              whereIn: (statusCol, vals) => ({
                where: (identity) => ({
                  update: async (patch) => {
                    updates.push({ id: clause.id, whereNull: col, whereIn: vals, identity, patch });
                    return opts.linkRows == null ? 1 : opts.linkRows;
                  },
                }),
              }),
              // recordFirstResponseIfNeeded's atomic claim:
              // .where({id}).whereNull('response_time_minutes').update(patch)
              update: async (patch) => {
                updates.push({ id: clause.id, whereNull: col, patch });
                return 1;
              },
            }),
            whereIn: (col, vals) => ({
              update: async (patch) => {
                updates.push({ id: clause.id, whereIn: vals, patch });
                // statusRows=0 simulates a replayed event on a lead whose
                // status is already outside the whitelist (won/lost/…).
                return opts.statusRows == null ? 1 : opts.statusRows;
              },
              // The estimate-send qualification write:
              // .whereIn('status', OPEN).whereRaw('is_qualified IS DISTINCT
              // FROM TRUE').update(...). Applies the real predicate against
              // the fixture so tests exercise the qualify-once semantics.
              whereRaw: (sql) => ({
                update: async (patch) => {
                  updates.push({ id: clause.id, whereIn: vals, whereRaw: sql, patch });
                  const row = leadsById[clause.id];
                  if (!row) return 0;
                  const statusOk = vals.includes(row.status);
                  const notAlready = row.is_qualified !== true;
                  const notDeleted = !row.deleted_at;
                  const linkOk = !('estimate_id' in clause) || row.estimate_id === undefined
                    || row.estimate_id === clause.estimate_id;
                  if (statusOk && notAlready && notDeleted && linkOk) {
                    row.is_qualified = true;
                    return 1;
                  }
                  return 0;
                },
              }),
            }),
            update: async (patch) => {
              updates.push({ id: clause.id, patch });
              return 1;
            },
          };
        }
        return Promise.resolve([]);
      },
      whereNotIn() {
        // First guard picks the resolver branch (whereNull('customer_id') =
        // unconverted; whereNotNull('customer_id') = customer-linked); each
        // branch then chains the deleted_at soft-delete guard.
        const unconverted = {
          whereNull: () => unconverted,
          andWhere: () => Promise.resolve(opts.contactLeads || []),
        };
        const customerLinked = {
          whereNull: () => customerLinked,
          andWhere: () => Promise.resolve(opts.customerLinkedLeads || []),
        };
        return {
          whereNull: () => unconverted,
          whereNotNull: () => customerLinked,
        };
      },
      insert: async (row) => {
        activities.push({ table, row });
        return [row];
      },
    });
    database.transaction = async (fn) => fn(database);
    database._updates = updates;
    database._activities = activities;
    return database;
  }

  const types = (db) => db._activities.map((a) => a.row.activity_type);
  // The open-status guard the rescue stamp applies (CLOSED_LEAD_STATUSES order).

  // The bridge call log must not leak across tests (the replay cases assert
  // not.toHaveBeenCalled).
  beforeEach(() => { bridgeLeadFunnelStage.mockClear(); });

  test('FK-linked send is unchanged — flips status, no contact-match link activity', async () => {
    const database = makeEventDb({
      linked: [{ id: 'L1', status: 'new', estimate_id: 'e-1' }],
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-1', sendMethod: 'sms', database });

    expect(database._updates).toEqual([
      { id: 'L1', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
      QUALIFY_ATTEMPT('L1'),
    ]);
    expect(types(database)).toEqual(['estimate_sent']);
    // Funnel-row mirror fires with the caller's database handle.
    expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('L1', 'estimate_sent', database);
  });

  test('replayed send on a closed lead (status update touches 0 rows) does NOT bridge the funnel row', async () => {
    const database = makeEventDb({
      // FK-linked lead whose stale loaded status passes the loop, but the
      // guarded UPDATE finds it already won/lost → 0 rows.
      linked: [{ id: 'L-won', status: 'new', estimate_id: 'e-replay' }],
      statusRows: 0,
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-replay', sendMethod: 'sms', database });

    // The status update was attempted (and applied nothing)…
    expect(database._updates).toEqual([
      { id: 'L-won', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
      QUALIFY_ATTEMPT('L-won'),
    ]);
    // …so the funnel row must NOT be advanced for a deal that never transitioned.
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('qualify-on-send never re-qualifies or re-logs an already-qualified lead', async () => {
    const database = makeEventDb({
      linked: [{ id: 'L-q', status: 'new', estimate_id: 'e-q' }],
      leadsById: { 'L-q': { id: 'L-q', status: 'new', is_qualified: true } },
    });
    await markLinkedLeadEstimateSent({ estimateId: 'e-q', sendMethod: 'sms', database });
    // The attempt runs (guard lives in SQL), applies 0 rows, logs nothing.
    expect(types(database)).toEqual(['estimate_sent']);
  });

  test('qualify-on-send treats a never-judged (NULL) lead as qualifiable', async () => {
    const database = makeEventDb({
      linked: [{ id: 'L-null', status: 'new', estimate_id: 'e-n' }],
      leadsById: { 'L-null': { id: 'L-null', status: 'new', is_qualified: null } },
    });
    await markLinkedLeadEstimateSent({ estimateId: 'e-n', sendMethod: 'sms', database });
    expect(types(database)).toEqual(['qualified', 'estimate_sent']);
  });

  test('a fully suppressed send (sentChannels: []) does not qualify', async () => {
    const database = makeEventDb({
      linked: [{ id: 'L-supp', status: 'new', estimate_id: 'e-supp' }],
      leadsById: { 'L-supp': { id: 'L-supp', status: 'new', is_qualified: null, estimate_id: 'e-supp' } },
    });
    await markLinkedLeadEstimateSent({ estimateId: 'e-supp', sendMethod: 'sms', sentChannels: [], database });
    // Status bookkeeping still runs; qualification does not.
    expect(types(database)).toEqual(['estimate_sent']);
    expect(database._updates.some((u) => u.patch && u.patch.is_qualified === true)).toBe(false);
  });

  test('qualify-on-send cannot touch a lead soft-deleted between resolve and write', async () => {
    const database = makeEventDb({
      linked: [{ id: 'L-del', status: 'new', estimate_id: 'e-del' }],
      statusRows: 0,
      // Re-read state: an admin deleted the lead after the resolve read.
      leadsById: { 'L-del': { id: 'L-del', status: 'new', is_qualified: null, deleted_at: '2026-08-31T12:00:00Z', estimate_id: 'e-del' } },
    });
    await markLinkedLeadEstimateSent({ estimateId: 'e-del', sendMethod: 'sms', database });
    expect(types(database)).toEqual(['estimate_sent']);
  });

  test('qualify-on-send cannot touch a lead whose estimate link moved', async () => {
    const database = makeEventDb({
      linked: [{ id: 'L-moved', status: 'new', estimate_id: 'e-old' }],
      statusRows: 0,
      leadsById: { 'L-moved': { id: 'L-moved', status: 'new', is_qualified: null, estimate_id: 'e-OTHER' } },
    });
    await markLinkedLeadEstimateSent({ estimateId: 'e-old', sendMethod: 'sms', database });
    expect(types(database)).toEqual(['estimate_sent']);
  });

  test('qualify-on-send cannot touch a lead a human closed or disqualified', async () => {
    const database = makeEventDb({
      linked: [{ id: 'L-dq', status: 'new', estimate_id: 'e-dq' }],
      // Re-read row shows the lead was disqualified between load and write.
      leadsById: { 'L-dq': { id: 'L-dq', status: 'disqualified', is_qualified: false } },
    });
    await markLinkedLeadEstimateSent({ estimateId: 'e-dq', sendMethod: 'sms', database });
    expect(types(database)).toEqual(['estimate_sent']);
  });

  test('replayed view on a closed lead does NOT bridge the funnel row', async () => {
    const database = makeEventDb({
      linked: [{ id: 'L-lost', status: 'new', estimate_id: 'e-replay-2' }],
      statusRows: 0,
    });

    await markLinkedLeadEstimateViewed({ estimateId: 'e-replay-2', database });

    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });

  test('standalone estimate: rescues a single contact-matched open lead — links it then flips to estimate_sent', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-3', estimate_data: null, customer_phone: '+19415550142', customer_email: 'rescue@example.com' },
      contactLeads: [{ id: 'L-unlinked', status: 'new', customer_id: null }],
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-3', sendMethod: 'both', database });

    expect(database._updates).toEqual([
      { id: 'L-unlinked', whereNull: 'estimate_id', whereIn: OPEN_LEAD_STATUSES, identity: expect.any(Object), patch: expect.objectContaining({ estimate_id: 'e-3' }) },
      { id: 'L-unlinked', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
      QUALIFY_ATTEMPT('L-unlinked'),
    ]);
    expect(types(database)).toEqual(['estimate_created', 'estimate_sent']);
  });

  test('standalone estimate: AMBIGUOUS contact match (2+ open leads) advances nothing', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-4', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [
        { id: 'L-a', status: 'new', customer_id: null },
        { id: 'L-b', status: 'contacted', customer_id: null },
      ],
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-4', sendMethod: 'sms', database });

    expect(database._updates).toEqual([]);
    expect(database._activities).toEqual([]);
  });

  test('never steals a lead already linked to ANOTHER estimate', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-5', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [{ id: 'L-other', status: 'new', customer_id: null, estimate_id: 'e-OTHER' }],
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-5', sendMethod: 'sms', database });

    expect(database._updates).toEqual([]);
    expect(database._activities).toEqual([]);
  });

  test('public-quote mirror: rescues the estimate_data.lead_id lead by customer match', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-6', estimate_data: { lead_id: 'L-qw' }, customer_id: 'c1' },
      leadsById: { 'L-qw': { id: 'L-qw', status: 'new', customer_id: 'c1' } },
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-6', sendMethod: 'email', database });

    expect(database._updates).toEqual([
      { id: 'L-qw', whereNull: 'estimate_id', whereIn: OPEN_LEAD_STATUSES, identity: expect.any(Object), patch: expect.objectContaining({ estimate_id: 'e-6' }) },
      { id: 'L-qw', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
      QUALIFY_ATTEMPT('L-qw'),
    ]);
    // The fixture lead is open and unqualified, so the qualify-on-send
    // write applies and records its activity.
    expect(types(database)).toEqual(['estimate_created', 'qualified', 'estimate_sent']);
  });

  test('viewed: rescues a contact-matched lead — links it then flips to estimate_viewed (no first-response)', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-7', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [{ id: 'L-view', status: 'estimate_sent', customer_id: null }],
    });

    await markLinkedLeadEstimateViewed({ estimateId: 'e-7', database });

    expect(database._updates).toEqual([
      { id: 'L-view', whereNull: 'estimate_id', whereIn: OPEN_LEAD_STATUSES, identity: expect.any(Object), patch: expect.objectContaining({ estimate_id: 'e-7' }) },
      { id: 'L-view', whereIn: ['new', 'contacted', 'estimate_sent'], patch: expect.objectContaining({ status: 'estimate_viewed' }) },
    ]);
    expect(types(database)).toEqual(['estimate_created', 'estimate_viewed']);
    expect(bridgeLeadFunnelStage).toHaveBeenCalledWith('L-view', 'estimate_viewed', database);
  });

  test('rescue stamp loses to a DIFFERENT estimate (0 rows) → does not advance or log for this estimate', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-9', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [{ id: 'L-race', status: 'new', customer_id: null }],
      linkRows: 0, // another estimate claimed the lead between resolution and the stamp
      leadsById: { 'L-race': { id: 'L-race', estimate_id: 'e-OTHER' } }, // re-read: now a different estimate
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-9', sendMethod: 'sms', database });

    // Only the (lost) stamp attempt ran — no status flip, no estimate_created, no estimate_sent.
    expect(database._updates).toEqual([
      { id: 'L-race', whereNull: 'estimate_id', whereIn: OPEN_LEAD_STATUSES, identity: expect.any(Object), patch: expect.objectContaining({ estimate_id: 'e-9' }) },
    ]);
    expect(database._activities).toEqual([]);
  });

  test('rescue stamp loses to a concurrent SAME-estimate event (0 rows) → still records this event’s side effect', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-10', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [{ id: 'L-same', status: 'new', customer_id: null }],
      linkRows: 0, // a simultaneous send + first view linked it first…
      leadsById: { 'L-same': { id: 'L-same', estimate_id: 'e-10' } }, // …to THIS same estimate
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-10', sendMethod: 'sms', database });

    // Link already won by the concurrent event (no estimate_created re-log), but
    // this send's status flip + estimate_sent activity must NOT be dropped.
    expect(database._updates).toEqual([
      { id: 'L-same', whereNull: 'estimate_id', whereIn: OPEN_LEAD_STATUSES, identity: expect.any(Object), patch: expect.objectContaining({ estimate_id: 'e-10' }) },
      { id: 'L-same', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
      QUALIFY_ATTEMPT('L-same'),
    ]);
    expect(types(database)).toEqual(['estimate_sent']);
  });

  test('the rescue stamp pins the identity the followed root was read with — a root re-assigned or re-contacted between the read and the stamp loses it, and nothing advances (codex r27 P1)', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-27', estimate_data: { lead_id: 'L-rep27' }, customer_phone: '+19415550142' },
      leadsById: {
        'L-rep27': { id: 'L-rep27', status: 'duplicate', extracted_data: { duplicate_of_lead_id: 'L-root27' } },
        'L-root27': { id: 'L-root27', status: 'new', customer_id: null, phone: '9415550142', email: 'a@example.com', estimate_id: null },
      },
      linkRows: 0, // the identity-scoped stamp hit 0 rows: an admin edit re-identified the root in between
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-27', sendMethod: 'sms', database });

    expect(database._updates).toEqual([
      { id: 'L-root27', whereNull: 'estimate_id', whereIn: OPEN_LEAD_STATUSES, identity: { customer_id: null, phone: '9415550142', email: 'a@example.com', estimate_id: null }, patch: expect.objectContaining({ estimate_id: 'e-27' }) },
    ]);
    expect(database._activities).toEqual([]);
  });

  test('a same-estimate link that won the race counts as ours only on the identity the lead was read with (codex r27 P1)', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-28', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [{ id: 'L-swap', status: 'new', customer_id: null, phone: '9415550142' }],
      linkRows: 0,
      // re-read: linked to THIS estimate, but by a write that also re-contacted the row
      leadsById: { 'L-swap': { id: 'L-swap', status: 'new', customer_id: null, phone: '9415550199', estimate_id: 'e-28' } },
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-28', sendMethod: 'sms', database });

    expect(database._updates).toHaveLength(1); // the lost stamp only — no status flip
    expect(database._activities).toEqual([]);
  });

  test('contact-matched lead CONVERTED between read and stamp (now closed) → does not link or advance', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-11', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [{ id: 'L-conv', status: 'new', customer_id: null }],
      linkRows: 0, // open-status guard makes the stamp no-op: the lead was just converted (status→won)
      leadsById: { 'L-conv': { id: 'L-conv', estimate_id: null, status: 'won' } }, // re-read: won, still unlinked
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-11', sendMethod: 'sms', database });

    // Only the guarded (no-op) stamp attempt ran — no link, no status flip, no activity.
    expect(database._updates).toEqual([
      { id: 'L-conv', whereNull: 'estimate_id', whereIn: OPEN_LEAD_STATUSES, identity: expect.any(Object), patch: expect.objectContaining({ estimate_id: 'e-11' }) },
    ]);
    expect(database._activities).toEqual([]);
  });

  test('no FK link and no contact match → advances nothing', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-8', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [],
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-8', sendMethod: 'sms', database });

    expect(database._updates).toEqual([]);
    expect(database._activities).toEqual([]);
  });

  // originatingNotAfter — backfill safety: the fuzzy contact match must not grab a
  // lead created AFTER the estimate went out (a newer same-contact inquiry).
  test('originatingNotAfter excludes a contact match first contacted AFTER the cutoff (newer inquiry)', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-12', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [{ id: 'L-newer', status: 'new', customer_id: null, first_contact_at: '2026-06-30T12:00:00Z' }],
    });

    await markLinkedLeadEstimateSent({
      estimateId: 'e-12', sendMethod: 'sms', database,
      originatingNotAfter: new Date('2026-01-01T00:00:00Z'), // estimate went out months before this lead existed
    });

    expect(database._updates).toEqual([]);
    expect(database._activities).toEqual([]);
  });

  test('originatingNotAfter keeps a contact match first contacted ON/BEFORE the cutoff', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-13', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [{ id: 'L-older', status: 'new', customer_id: null, first_contact_at: '2025-12-15T10:00:00Z', response_time_minutes: 5 }],
    });

    await markLinkedLeadEstimateSent({
      estimateId: 'e-13', sendMethod: 'sms', database,
      originatingNotAfter: new Date('2026-01-01T00:00:00Z'),
    });

    expect(database._updates).toEqual([
      { id: 'L-older', whereNull: 'estimate_id', whereIn: OPEN_LEAD_STATUSES, identity: expect.any(Object), patch: expect.objectContaining({ estimate_id: 'e-13' }) },
      { id: 'L-older', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
      QUALIFY_ATTEMPT('L-older'),
    ]);
    expect(types(database)).toEqual(['estimate_created', 'estimate_sent']);
  });

  test('originatingNotAfter does NOT gate the public-quote mirror (authoritative lead-id link)', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-14', estimate_data: { lead_id: 'L-mirror' }, customer_id: 'c1' },
      leadsById: { 'L-mirror': { id: 'L-mirror', status: 'new', customer_id: 'c1', first_contact_at: '2026-06-30T12:00:00Z', response_time_minutes: 5 } },
    });

    await markLinkedLeadEstimateSent({
      estimateId: 'e-14', sendMethod: 'sms', database,
      originatingNotAfter: new Date('2026-01-01T00:00:00Z'), // newer than the lead, but mirror is precise → still advances
    });

    expect(database._updates).toEqual([
      { id: 'L-mirror', whereNull: 'estimate_id', whereIn: OPEN_LEAD_STATUSES, identity: expect.any(Object), patch: expect.objectContaining({ estimate_id: 'e-14' }) },
      { id: 'L-mirror', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
      QUALIFY_ATTEMPT('L-mirror'),
    ]);
    // The fixture lead is open and unqualified, so the qualify-on-send
    // write applies and records its activity.
    expect(types(database)).toEqual(['estimate_created', 'qualified', 'estimate_sent']);
  });

  test('respondedAt times first response from the historical send, not "now" (backfill KPI safety)', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-15', estimate_data: null, customer_phone: '+19415550142' },
      // un-responded lead (response_time_minutes null) so recordFirstResponseIfNeeded fires
      contactLeads: [{ id: 'L-hist', status: 'new', customer_id: null, first_contact_at: '2026-01-01T00:00:00Z', response_time_minutes: null }],
    });

    await markLinkedLeadEstimateSent({
      estimateId: 'e-15', sendMethod: 'backfill', database,
      originatingNotAfter: new Date('2026-01-01T00:30:00Z'),
      respondedAt: new Date('2026-01-01T00:30:00Z'), // 30 min after first contact — NOT months (today)
    });

    // Response time reflects sent-minus-first-contact (30), not Date.now()-first-contact.
    const responseUpdate = database._updates.find((u) => u.patch && 'response_time_minutes' in u.patch);
    expect(responseUpdate.patch.response_time_minutes).toBe(30);
    expect(types(database)).toEqual(['estimate_created', 'first_response', 'estimate_sent']);
  });

  // Tier 3 — customer-linked contact rescue: an open lead that matches the
  // estimate's contact but already carries a customer_id (excluded from tier 2).
  test('customer-linked lead: rescues the customer’s ORIGINATING open lead (Lawrence case)', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-16', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [], // tier 2 (customer_id IS NULL) finds nothing
      customerLinkedLeads: [{ id: 'L-cust', status: 'new', customer_id: 'cust-1', phone: '9415550142', first_contact_at: '2026-06-30T16:49:49Z', response_time_minutes: 5 }],
      customerWonLead: null, // customer has no prior won lead → not established
      customer: { id: 'cust-1', member_since: '2026-06-30', created_at: '2026-06-30T16:49:48Z' }, // lead first-contacted same ET day → originating
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-16', sendMethod: 'sms', database });

    expect(database._updates).toEqual([
      { id: 'L-cust', whereNull: 'estimate_id', whereIn: OPEN_LEAD_STATUSES, identity: expect.any(Object), patch: expect.objectContaining({ estimate_id: 'e-16' }) },
      { id: 'L-cust', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
      QUALIFY_ATTEMPT('L-cust'),
    ]);
    expect(types(database)).toEqual(['estimate_created', 'estimate_sent']);
  });

  test('customer-linked lead: does NOT advance an ESTABLISHED customer’s add-on (customer has a won lead)', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-17', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [],
      customerLinkedLeads: [{ id: 'L-addon', status: 'new', customer_id: 'cust-2', phone: '9415550142', first_contact_at: '2026-06-30T16:49:49Z' }],
      customerWonLead: { id: 'won-1' }, // established → skip
      customer: { id: 'cust-2', member_since: '2026-06-30' },
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-17', sendMethod: 'sms', database });

    expect(database._updates).toEqual([]);
    expect(database._activities).toEqual([]);
  });

  test('customer-linked lead: does NOT advance a lead first contacted AFTER they became a customer (not originating)', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-18', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [],
      customerLinkedLeads: [{ id: 'L-late', status: 'new', customer_id: 'cust-3', phone: '9415550142', first_contact_at: '2026-05-01T10:00:00Z' }],
      customerWonLead: null,
      customer: { id: 'cust-3', member_since: '2026-01-01' }, // lead (May) post-dates member_since (Jan) → not originating
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-18', sendMethod: 'sms', database });

    expect(database._updates).toEqual([]);
    expect(database._activities).toEqual([]);
  });

  test('customer-linked lead: AMBIGUOUS (2+ open customer-linked matches) advances nothing', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-19', estimate_data: null, customer_phone: '+19415550142' },
      contactLeads: [],
      customerLinkedLeads: [
        { id: 'L-a', status: 'new', customer_id: 'cust-4', phone: '9415550142' },
        { id: 'L-b', status: 'contacted', customer_id: 'cust-4', phone: '9415550142' },
      ],
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-19', sendMethod: 'sms', database });

    expect(database._updates).toEqual([]);
    expect(database._activities).toEqual([]);
  });

  test('customer-linked lead: never crosses customer boundaries (estimate customer ≠ lead customer, shared phone)', async () => {
    const database = makeEventDb({
      linked: [],
      // estimate belongs to customer X; a DIFFERENT customer Y shares the phone
      estimate: { id: 'e-20', estimate_data: null, customer_phone: '+19415550142', customer_id: 'cust-X' },
      contactLeads: [],
      customerLinkedLeads: [{ id: 'L-otherCust', status: 'new', customer_id: 'cust-Y', phone: '9415550142', first_contact_at: '2026-06-30T16:49:49Z' }],
      customerWonLead: null,
      customer: { id: 'cust-Y', member_since: '2026-06-30' },
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-20', sendMethod: 'sms', database });

    // leadMatchesEstimateContact rejects the mismatched customer_id → not advanced.
    expect(database._updates).toEqual([]);
    expect(database._activities).toEqual([]);
  });
});

// ── stampFirstResponseByContact (loose SLA stamp, 2026-07-30) ──────────────
// Chain-aware harness: the contact query is a thenable knex chain
// (whereNull/whereNotNull/whereNotIn/where), unlike makeDb's lookup shapes.
const { stampFirstResponseByContact } = require('../services/lead-estimate-link');

function makeContactDb({ leads = [], estimate = null } = {}) {
  const updates = [];
  const activities = [];
  const database = (table) => {
    let lastWhere = null;
    const q = {
      whereNull: () => q,
      whereNotNull: () => q,
      whereNotIn: () => q,
      whereIn: () => q,
      where: (clause) => {
        if (clause && typeof clause === 'object') lastWhere = clause;
        return q;
      },
      first: async () => (table === 'estimates' ? estimate : null),
      update: async (patch) => { updates.push({ table, clause: lastWhere, patch }); return 1; },
      insert: async (row) => { activities.push({ table, row }); return [row]; },
      then: (resolve, reject) => Promise.resolve(table === 'leads' ? leads : []).then(resolve, reject),
    };
    return q;
  };
  database.transaction = async (fn) => fn(database);
  return { database, updates, activities };
}

describe('stampFirstResponseByContact', () => {
  test('stamps EVERY open matching lead, even when the contact is ambiguous', async () => {
    const twelveMinAgo = new Date(Date.now() - 12 * 60000).toISOString();
    const leads = [
      { id: 'lead-a', status: 'new', phone: '9415550101', first_contact_at: twelveMinAgo, response_time_minutes: null },
      { id: 'lead-b', status: 'new', phone: '9415550101', first_contact_at: twelveMinAgo, response_time_minutes: null },
    ];
    const { database, updates, activities } = makeContactDb({ leads });

    const stamped = await stampFirstResponseByContact({
      database,
      phone: '+1 (941) 555-0101',
      performedBy: 'admin:tech-1',
    });

    expect(stamped).toBe(2);
    const leadUpdates = updates.filter((u) => u.table === 'leads');
    expect(leadUpdates).toHaveLength(2);
    for (const u of leadUpdates) {
      expect(u.patch).toHaveProperty('response_time_minutes');
      expect(u.patch).not.toHaveProperty('status');
      expect(u.patch).not.toHaveProperty('estimate_id');
    }
    expect(activities.filter((a) => a.table === 'lead_activities')).toHaveLength(2);
  });

  test('no-op without a phone or email, and skips already-stamped leads', async () => {
    const { database, updates } = makeContactDb({ leads: [] });
    expect(await stampFirstResponseByContact({ database })).toBe(0);
    expect(updates).toHaveLength(0);

    const stampedLead = {
      id: 'lead-c', status: 'new', phone: '9415550102',
      first_contact_at: new Date().toISOString(), response_time_minutes: 5,
    };
    const harness = makeContactDb({ leads: [stampedLead] });
    // recordFirstResponseIfNeeded refuses an already-stamped lead.
    await stampFirstResponseByContact({ database: harness.database, phone: '9415550102' });
    expect(harness.updates.filter((u) => u.table === 'leads')).toHaveLength(0);
  });

  test('respondedAt backfills historical minutes instead of stamping from now', async () => {
    const firstContact = new Date('2026-07-10T12:00:00Z');
    const lead = { id: 'lead-d', status: 'new', phone: '9415550103', first_contact_at: firstContact.toISOString(), response_time_minutes: null };
    const { database, updates } = makeContactDb({ leads: [lead] });

    await stampFirstResponseByContact({
      database,
      phone: '9415550103',
      respondedAt: new Date('2026-07-10T12:45:00Z'),
    });

    const [u] = updates.filter((x) => x.table === 'leads');
    expect(u.patch.response_time_minutes).toBe(45);
  });

  test('respondedAt/originatingNotAfter constrain the query so newer inquiries keep their clock (backfill safety)', async () => {
    // The chain records every where() clause — assert the first_contact_at
    // cutoffs are applied when the historical replay provides them.
    const whereCalls = [];
    const database = (table) => {
      const q = {
        whereNull: () => q,
        whereNotNull: () => q,
        whereNotIn: () => q,
        whereIn: () => q,
        where: (...args) => { whereCalls.push(args); return q; },
        then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
      };
      return q;
    };

    const responded = new Date('2026-07-10T12:45:00Z');
    const cutoff = new Date('2026-07-09T00:00:00Z');
    await stampFirstResponseByContact({
      database,
      phone: '9415550103',
      respondedAt: responded,
      originatingNotAfter: cutoff,
    });

    const cutoffCalls = whereCalls.filter((args) => args[0] === 'first_contact_at' && args[1] === '<=');
    expect(cutoffCalls.map((args) => args[2].toISOString())).toEqual([
      responded.toISOString(),
      cutoff.toISOString(),
    ]);
  });

  test('international callers match by FULL digit string, never last-10', async () => {
    const raws = [];
    const database = (table) => {
      const q = {
        whereNull: () => q,
        whereNotNull: () => q,
        whereNotIn: () => q,
        whereIn: () => q,
        where: (fn) => { if (typeof fn === 'function') fn.call({ orWhereRaw: (sql, binds) => { raws.push({ sql, binds }); } }); return q; },
        then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
      };
      return q;
    };

    await stampFirstResponseByContact({ database, phone: '+442079460958' });
    expect(raws).toHaveLength(1);
    expect(raws[0].sql).not.toContain('RIGHT(');
    expect(raws[0].binds).toEqual(['442079460958']);
  });
});
