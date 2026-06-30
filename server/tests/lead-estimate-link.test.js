jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-attribution', () => ({ markConverted: jest.fn() }));
jest.mock('../services/lead-source-resolver', () => ({
  resolveLeadSource: jest.fn(async () => ({ leadSourceId: 'ls-fb', leadSourceName: 'Facebook', leadSourceDetail: 'Meta click (fbclid)' })),
  MAIN_SITE_NAME: 'Main Site (wavespestcontrol.com)',
  SPOKE_DOMAIN_TO_SOURCE_NAME: {},
}));

const db = require('../models/db');
const leadAttribution = require('../services/lead-attribution');
const { resolveLeadSource } = require('../services/lead-source-resolver');
const {
  attachLeadToEstimate,
  markLinkedLeadEstimateAccepted,
  markLinkedLeadEstimateSent,
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
      return {
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
    },
    insert: async (row) => {
      activities.push({ table, row });
      return [row];
    },
  });

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
        if (table === 'leads' && clause.estimate_id === 'estimate-1') {
          return Promise.resolve([lead]);
        }
        const update = async (patch) => {
          updates.push({ table, clause, patch });
          return 1;
        };
        return {
          whereIn: () => ({ update }),
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
    expect(activities.map((a) => a.row.activity_type)).toEqual(['first_response', 'estimate_sent']);
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
    const database = (table) => ({
      where(clause) {
        if (table === 'leads' && clause && 'estimate_id' in clause) return Promise.resolve(opts.linked || []);
        if (table === 'leads' && clause && 'id' in clause) {
          return {
            first: async () => (opts.leadsById || {})[clause.id] || null,
            update: async (patch) => { updates.push({ id: clause.id, patch }); return 1; },
          };
        }
        if (table === 'estimates') return { first: async () => opts.estimate || null };
        if (table === 'customers') return { first: async () => opts.customer || null };
        return Promise.resolve([]);
      },
      whereNotIn() {
        return { whereNull: () => ({ andWhere: () => Promise.resolve(opts.contactLeads || []) }) };
      },
    });
    database._updates = updates;
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
      customerId: 'customer-1', monthlyValue: 125, initialServiceValue: 99, waveguardTier: 'Gold',
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
    expect(database._updates).toEqual([{ id: 'lead-qw', patch: expect.objectContaining({ estimate_id: 'estimate-2' }) }]);
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
    expect(database._updates).toEqual([{ id: 'lead-unlinked', patch: expect.objectContaining({ estimate_id: 'estimate-3' }) }]);
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
          // customerHasWonLead: .where({ customer_id, status: 'won' }).first('id')
          if (table === 'leads' && clause && 'customer_id' in clause && 'status' in clause) {
            return { first: async () => opts.customerWonLead || null };
          }
          // findOpenLeadsForCustomer: .where({ customer_id }).whereNotIn('status', [...])
          if (table === 'leads' && clause && 'customer_id' in clause) {
            return { whereNotIn: () => Promise.resolve(opts.customerOpenLeads || []) };
          }
          return Promise.resolve([]);
        },
        whereNotIn() {
          // findUnconvertedLeadsByContact: .whereNotIn(...).whereNull('customer_id').andWhere(...)
          return {
            whereNull(col) {
              calls.whereNull.push(col);
              return { andWhere: () => Promise.resolve(opts.contactLeads || []) };
            },
          };
        },
      };
    };
    db._calls = calls;
    return db;
  }

  test('matches by estimate link and passes estimate value hints', async () => {
    const markConverted = jest.fn().mockResolvedValue();
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
      monthlyValue: 125,
      initialServiceValue: 99,
      waveguardTier: 'Gold',
      triggerSource: 'backfill',
    });
  });

  test('matches the unconverted originating lead by contact, preserves values', async () => {
    const markConverted = jest.fn().mockResolvedValue();
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
    // The contact fallback must restrict to unconverted leads.
    expect(database._calls.whereNull).toContain('customer_id');
  });

  test('enforceOriginating converts a contact lead first contacted before the customer signed up', async () => {
    const markConverted = jest.fn().mockResolvedValue();
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

  test('enforceOriginating does NOT convert a contact lead created AFTER the customer signed up (later add-on)', async () => {
    const markConverted = jest.fn().mockResolvedValue();
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
    const markConverted = jest.fn().mockResolvedValue();
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
    const markConverted = jest.fn().mockResolvedValue();
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
    const markConverted = jest.fn().mockResolvedValue();
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
    const markConverted = jest.fn().mockResolvedValue();
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
    const markConverted = jest.fn().mockResolvedValue();
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
    const markConverted = jest.fn().mockResolvedValue();
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
    const markConverted = jest.fn().mockResolvedValue();
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
    const markConverted = jest.fn().mockResolvedValue();
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

  test('for an estimate-scoped event, does NOT convert a lead tied to a DIFFERENT estimate', async () => {
    const markConverted = jest.fn().mockResolvedValue();
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
    const markConverted = jest.fn().mockResolvedValue();
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
    const markConverted = jest.fn().mockResolvedValue();
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
            return { first: async () => opts.linkedLead || null };
          }
          return { first: async () => null };
        },
        whereNotIn() {
          return { whereNull: () => ({ andWhere: () => Promise.resolve(opts.contactLeads || []) }) };
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
      customerId: 'c1', attribution: FB_ATTR, serviceInterest: 'General Pest Control', customerCreated: true, database,
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
      funnel_stage: 'lead',
    });
  });

  test('does NOT mint for a pre-existing customer (repeat booker, not a fresh paid lead)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1', attribution: FB_ATTR, customerCreated: false, database,
    });

    expect(result).toEqual({ attributed: false, reason: 'existing_customer' });
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

  test('does NOT mint when the touch carries no deterministic click id (a bare _fbp cookie is not a click)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: { utm: null, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: 'fb.1.x.ambient' },
      customerCreated: true,
      database,
    });

    expect(result).toEqual({ attributed: false, reason: 'no_paid_click_id' });
    expect(database._inserted).toEqual([]);
  });

  test('does NOT mint on a non-ad UTM + ambient _fbp (newsletter/organic must not become a paid won lead)', async () => {
    const database = makeAttrDb({ customer: { id: 'c1', phone: '+19415550101' } });

    const result = await attributeSelfBooking({
      customerId: 'c1',
      attribution: { utm: { source: 'newsletter', medium: 'email', campaign: 'june' }, gclid: null, wbraid: null, gbraid: null, fbclid: null, fbc: null, fbp: 'fb.1.x.ambient' },
      customerCreated: true,
      database,
    });

    expect(result).toEqual({ attributed: false, reason: 'no_paid_click_id' });
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
        if (table === 'leads' && clause && 'estimate_id' in clause) {
          return Promise.resolve(opts.linked || []);
        }
        if (table === 'estimates') return { first: async () => opts.estimate || null };
        if (table === 'leads' && clause && 'id' in clause) {
          return {
            first: async () => leadsById[clause.id] || null,
            whereNull: (col) => ({
              update: async (patch) => {
                updates.push({ id: clause.id, whereNull: col, patch });
                return opts.linkRows == null ? 1 : opts.linkRows;
              },
            }),
            whereIn: (col, vals) => ({
              update: async (patch) => {
                updates.push({ id: clause.id, whereIn: vals, patch });
                return 1;
              },
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
        return { whereNull: () => ({ andWhere: () => Promise.resolve(opts.contactLeads || []) }) };
      },
      insert: async (row) => {
        activities.push({ table, row });
        return [row];
      },
    });
    database._updates = updates;
    database._activities = activities;
    return database;
  }

  const types = (db) => db._activities.map((a) => a.row.activity_type);

  test('FK-linked send is unchanged — flips status, no contact-match link activity', async () => {
    const database = makeEventDb({
      linked: [{ id: 'L1', status: 'new', estimate_id: 'e-1' }],
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-1', sendMethod: 'sms', database });

    expect(database._updates).toEqual([
      { id: 'L1', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
    ]);
    expect(types(database)).toEqual(['estimate_sent']);
  });

  test('standalone estimate: rescues a single contact-matched open lead — links it then flips to estimate_sent', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-3', estimate_data: null, customer_phone: '+19417452085', customer_email: 'ljwilhelm1@verizon.net' },
      contactLeads: [{ id: 'L-unlinked', status: 'new', customer_id: null }],
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-3', sendMethod: 'both', database });

    expect(database._updates).toEqual([
      { id: 'L-unlinked', whereNull: 'estimate_id', patch: expect.objectContaining({ estimate_id: 'e-3' }) },
      { id: 'L-unlinked', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
    ]);
    expect(types(database)).toEqual(['estimate_created', 'estimate_sent']);
  });

  test('standalone estimate: AMBIGUOUS contact match (2+ open leads) advances nothing', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-4', estimate_data: null, customer_phone: '+19417452085' },
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
      estimate: { id: 'e-5', estimate_data: null, customer_phone: '+19417452085' },
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
      { id: 'L-qw', whereNull: 'estimate_id', patch: expect.objectContaining({ estimate_id: 'e-6' }) },
      { id: 'L-qw', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
    ]);
    expect(types(database)).toEqual(['estimate_created', 'estimate_sent']);
  });

  test('viewed: rescues a contact-matched lead — links it then flips to estimate_viewed (no first-response)', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-7', estimate_data: null, customer_phone: '+19417452085' },
      contactLeads: [{ id: 'L-view', status: 'estimate_sent', customer_id: null }],
    });

    await markLinkedLeadEstimateViewed({ estimateId: 'e-7', database });

    expect(database._updates).toEqual([
      { id: 'L-view', whereNull: 'estimate_id', patch: expect.objectContaining({ estimate_id: 'e-7' }) },
      { id: 'L-view', whereIn: ['new', 'contacted', 'estimate_sent'], patch: expect.objectContaining({ status: 'estimate_viewed' }) },
    ]);
    expect(types(database)).toEqual(['estimate_created', 'estimate_viewed']);
  });

  test('rescue stamp loses to a DIFFERENT estimate (0 rows) → does not advance or log for this estimate', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-9', estimate_data: null, customer_phone: '+19417452085' },
      contactLeads: [{ id: 'L-race', status: 'new', customer_id: null }],
      linkRows: 0, // another estimate claimed the lead between resolution and the stamp
      leadsById: { 'L-race': { id: 'L-race', estimate_id: 'e-OTHER' } }, // re-read: now a different estimate
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-9', sendMethod: 'sms', database });

    // Only the (lost) stamp attempt ran — no status flip, no estimate_created, no estimate_sent.
    expect(database._updates).toEqual([
      { id: 'L-race', whereNull: 'estimate_id', patch: expect.objectContaining({ estimate_id: 'e-9' }) },
    ]);
    expect(database._activities).toEqual([]);
  });

  test('rescue stamp loses to a concurrent SAME-estimate event (0 rows) → still records this event’s side effect', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-10', estimate_data: null, customer_phone: '+19417452085' },
      contactLeads: [{ id: 'L-same', status: 'new', customer_id: null }],
      linkRows: 0, // a simultaneous send + first view linked it first…
      leadsById: { 'L-same': { id: 'L-same', estimate_id: 'e-10' } }, // …to THIS same estimate
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-10', sendMethod: 'sms', database });

    // Link already won by the concurrent event (no estimate_created re-log), but
    // this send's status flip + estimate_sent activity must NOT be dropped.
    expect(database._updates).toEqual([
      { id: 'L-same', whereNull: 'estimate_id', patch: expect.objectContaining({ estimate_id: 'e-10' }) },
      { id: 'L-same', whereIn: ['new', 'contacted'], patch: expect.objectContaining({ status: 'estimate_sent' }) },
    ]);
    expect(types(database)).toEqual(['estimate_sent']);
  });

  test('no FK link and no contact match → advances nothing', async () => {
    const database = makeEventDb({
      linked: [],
      estimate: { id: 'e-8', estimate_data: null, customer_phone: '+19417452085' },
      contactLeads: [],
    });

    await markLinkedLeadEstimateSent({ estimateId: 'e-8', sendMethod: 'sms', database });

    expect(database._updates).toEqual([]);
    expect(database._activities).toEqual([]);
  });
});
