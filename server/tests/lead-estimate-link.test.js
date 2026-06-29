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
  convertLeadFromEvent,
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
        return {
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
