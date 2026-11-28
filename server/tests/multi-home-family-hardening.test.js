/**
 * Regression suite for PR 5 (Customers & Customer 360 audit — Same-Family links):
 *   - Decision 3: restrict Same-Family eligibility to live customer stages
 *     ('active_customer', 'won', 'at_risk'), exclude internal test accounts, and
 *     block same-address links across both service and IB link tool.
 *   - Decision 2: raise an office review alert via raiseAdminAlert('billing', ...)
 *     when unlink, archive, or full cancellation drops a surviving family member
 *     below 2 active homes while they still carry an active Multi-Home discount
 *     on upcoming visits (never auto-changes prices or messages customers).
 *   - RBAC: link_customer_family & unlink_customer_family listed in ADMIN_ONLY_TOOL_NAMES.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockRaiseAdminAlert = jest.fn(async () => ({ id: 'alert-1' }));
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return {
    ...actual,
    raiseAdminAlert: (...args) => {
      // Always validate alert copy against the real composeAdminAlert rules!
      actual.composeAdminAlert(args[1]);
      return mockRaiseAdminAlert(...args);
    },
  };
});

const fs = require('node:fs');
const path = require('node:path');
const Family = require('../services/multi-home-family');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Decision 3: Same-Family eligibility, internal test exclusion, and same-address guard', () => {
  test('isEligibleFamilyCustomer admits only live customer stages and excludes leads, lost, churned, inactive, deleted, and internal test accounts', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      first_name: 'Robin',
      last_name: 'Sample',
      email: 'robin@example.com',
      phone: '+19415551111',
      address_line1: '100 Main St',
      zip: '34231',
      active: true,
      deleted_at: null,
      pipeline_stage: 'active_customer',
    };
    expect(Family.isEligibleFamilyCustomer(base)).toBe(true);
    expect(Family.isEligibleFamilyCustomer({ ...base, address_line1: '' })).toBe(false);
    expect(Family.isEligibleFamilyCustomer({ ...base, address_line1: null })).toBe(false);
    expect(Family.isEligibleFamilyCustomer({ ...base, pipeline_stage: 'won' })).toBe(true);
    expect(Family.isEligibleFamilyCustomer({ ...base, pipeline_stage: 'at_risk' })).toBe(true);
    for (const stage of ['new_lead', 'contacted', 'estimate_sent', 'lost', 'churned', null, '']) {
      expect(Family.isEligibleFamilyCustomer({ ...base, pipeline_stage: stage })).toBe(false);
    }
    expect(Family.isEligibleFamilyCustomer({ ...base, active: false })).toBe(false);
    expect(Family.isEligibleFamilyCustomer({ ...base, deleted_at: new Date() })).toBe(false);
    // Internal test customer name / App Review demo email
    expect(Family.isEligibleFamilyCustomer({ ...base, first_name: 'Adam', last_name: 'Martinez' })).toBe(false);
    expect(Family.isEligibleFamilyCustomer({ ...base, first_name: 'Shakedown', last_name: 'Test One' })).toBe(false);
    expect(Family.isEligibleFamilyCustomer({ ...base, email: 'appreview+demo@wavespestcontrol.com' })).toBe(false);
  });

  test('sameHomeAddress blocks linking two profiles at the same normalized street/unit/zip while allowing distinct homes', () => {
    const homeA = { address_line1: '100 Main St', address_line2: null, city: 'Sarasota', zip: '34231' };
    const homeASpelling = { address_line1: '100 Main Street', address_line2: '', city: 'Sarasota', zip: '34231-1234' };
    const homeB = { address_line1: '200 Oak Ave', address_line2: null, city: 'Sarasota', zip: '34231' };
    const unit2 = { address_line1: '100 Main St', address_line2: 'Apt 2', city: 'Sarasota', zip: '34231' };
    expect(Family.sameHomeAddress(homeA, homeASpelling)).toBe(true);
    expect(Family.sameHomeAddress(homeA, homeB)).toBe(false);
    expect(Family.sameHomeAddress(homeA, unit2)).toBe(false);
    // Missing address on either profile is not treated as a same-address match.
    expect(Family.sameHomeAddress({ address_line1: '' }, homeA)).toBe(false);
  });

  test('linkFamily rejects non-live stage, internal test account, and same service address with 409', async () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const makeConn = (rowsById) => {
      const conn = (table) => {
        let whereObj = {};
        const q = {
          where(w) { whereObj = { ...whereObj, ...w }; return q; },
          whereIn() { return q; },
          orderBy() { return q; },
          forUpdate() { return q; },
          select: async () => [],
          first: async () => (table === 'customers' ? rowsById[whereObj.id] : null),
        };
        return q;
      };
      conn.raw = async () => ({});
      conn.transaction = async (cb) => cb(conn);
      return conn;
    };
    const liveA = {
      id: A, first_name: 'Robin', last_name: 'Sample', email: 'r@example.com', phone: '+19415551111',
      address_line1: '100 Main St', city: 'Sarasota', zip: '34231', active: true, deleted_at: null, pipeline_stage: 'active_customer',
    };
    await expect(Family.linkFamily(makeConn({
      [A]: liveA,
      [B]: { ...liveA, id: B, address_line1: '200 Oak Ave', pipeline_stage: 'new_lead' },
    }), { customerId: A, otherCustomerId: B })).rejects.toMatchObject({ statusCode: 409, message: /not an active customer/i });

    await expect(Family.linkFamily(makeConn({
      [A]: liveA,
      [B]: { ...liveA, id: B, first_name: 'Adam', last_name: 'Martinez', address_line1: '200 Oak Ave' },
    }), { customerId: A, otherCustomerId: B })).rejects.toMatchObject({ statusCode: 409, message: /internal test account/i });

    await expect(Family.linkFamily(makeConn({
      [A]: liveA,
      [B]: { ...liveA, id: B, first_name: 'Casey', address_line1: '100 Main Street', zip: '34231' },
    }), { customerId: A, otherCustomerId: B })).rejects.toMatchObject({ statusCode: 409, message: /same service address/i });
  });

  test('linkFamily rejects joining an existing family when another member shares the address, and liveFamilySize counts distinct qualifying homes including self', async () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const C = '66666666-6666-4666-8666-666666666666';
    const makeJoinConn = () => {
      const conn = (table) => {
        let whereObj = {};
        let joined = false;
        const q = {
          join() { joined = true; return q; },
          where(w) { whereObj = { ...whereObj, ...w }; return q; },
          whereIn() { return q; },
          whereNull() { return q; },
          orderBy() { return q; },
          forUpdate() { return q; },
          select: async () => {
            if (table === 'multi_home_family_members' && joined) {
              return [
                { id: A, address_line1: '100 Main St', city: 'Sarasota', zip: '34231' },
                { id: C, address_line1: '300 Pine St', city: 'Sarasota', zip: '34231' },
              ];
            }
            if (table === 'multi_home_family_members') return [{ customer_id: A, family_id: 'fam-1' }];
            return [];
          },
          first: async () => {
            if (table !== 'customers') return null;
            if (whereObj.id === A) return { id: A, first_name: 'Robin', last_name: 'Sample', address_line1: '100 Main St', city: 'Sarasota', zip: '34231', active: true, deleted_at: null, pipeline_stage: 'active_customer' };
            return { id: B, first_name: 'Alex', last_name: 'Sample', address_line1: '300 Pine Street', city: 'Sarasota', zip: '34231', active: true, deleted_at: null, pipeline_stage: 'active_customer' };
          },
        };
        return q;
      };
      conn.raw = async () => ({});
      conn.transaction = async (cb) => cb(conn);
      return conn;
    };
    await expect(Family.linkFamily(makeJoinConn(), { customerId: A, otherCustomerId: B }))
      .rejects.toMatchObject({ statusCode: 409, message: /already in that family/i });

    // liveFamilySize requires self in qualifying set and distinct addresses
    const makeSizeConn = (rows) => (table) => {
      const q = {
        join() { return q; },
        where() { return q; },
        whereIn() { return q; },
        whereNull() { return q; },
        select: async () => rows,
        first: async () => (table === 'multi_home_family_members' ? { family_id: 'fam-1' } : null),
      };
      return q;
    };
    // Self is a lead even though 2 other members qualify -> ineligible (< 2)
    expect(await Family.familyMultiHomeEligible(makeSizeConn([
      { id: A, first_name: 'Robin', last_name: 'One', address_line1: '100 Main St', city: 'Sarasota', zip: '34231', active: true, pipeline_stage: 'active_customer', deleted_at: null },
      { id: C, first_name: 'Sam', last_name: 'Two', address_line1: '300 Pine St', city: 'Sarasota', zip: '34231', active: true, pipeline_stage: 'active_customer', deleted_at: null },
    ]), B)).toBe(false);
    // Two qualifying members at the exact same address -> only 1 distinct home -> false
    expect(await Family.familyMultiHomeEligible(makeSizeConn([
      { id: A, first_name: 'Robin', last_name: 'One', address_line1: '100 Main St', city: 'Sarasota', zip: '34231', active: true, pipeline_stage: 'active_customer', deleted_at: null },
      { id: B, first_name: 'Alex', last_name: 'Two', address_line1: '100 Main Street', city: 'Sarasota', zip: '34231', active: true, pipeline_stage: 'active_customer', deleted_at: null },
    ]), A)).toBe(false);
  });
});

describe('Decision 2: office review alert when Same-Family drops below 2 active homes', () => {
  const SURVIVOR = '33333333-3333-4333-8333-333333333333';
  const DEPARTED = '44444444-4444-4444-8444-444444444444';

  function makeAlertConn({ member, familyMembersRows = [], upcomingDiscountedCount = 2 }) {
    const conn = (table) => {
      const q = {
        join() { return q; },
        where(arg) { if (typeof arg === 'function') arg(q); return q; },
        orWhere() { return q; },
        orWhereExists() { return q; },
        whereIn() { return q; },
        whereNotIn() { return q; },
        whereNull() { return q; },
        count() { return q; },
        select: async () => (table === 'multi_home_family_members' ? familyMembersRows : []),
        first: async () => {
          if (table === 'customers') return member;
          if (table === 'multi_home_family_members') return familyMembersRows.length ? { family_id: 'fam-1' } : null;
          if (table === 'discounts') return { id: 'disc-mh' };
          if (table === 'scheduled_services') return { cnt: String(upcomingDiscountedCount) };
          return null;
        },
      };
      return q;
    };
    return conn;
  }

  test('raises valid composed Billing alert when survivor drops below 2 homes with upcoming Multi-Home discounted visits', async () => {
    const conn = makeAlertConn({
      member: {
        id: SURVIVOR, first_name: 'Robin', last_name: 'Sample', company_name: null,
        active: true, has_multi_home: false, pipeline_stage: 'active_customer',
      },
      familyMembersRows: [],
      upcomingDiscountedCount: 2,
    });
    const alerted = await Family.alertFamilyDropBelowTwo(conn, {
      formerMemberIds: [SURVIVOR],
      departedCustomerId: DEPARTED,
      reason: 'unlinked',
    });
    expect(alerted).toBe(1);
    expect(mockRaiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(mockRaiseAdminAlert).toHaveBeenCalledWith(
      'billing',
      expect.objectContaining({
        area: 'Billing',
        severity: 'needs-you',
        who: 'person',
        subject: { type: 'customer', id: SURVIVOR },
        doneWhen: 'multi_home_discount_reviewed',
        link: `/admin/customers/${SURVIVOR}`,
      }),
      expect.objectContaining({
        dedupeKey: `family-drop-below-two:${SURVIVOR}:${DEPARTED}`,
        dedupeOpenOnly: true,
      }),
    );
  });

  test('skips alert when survivor still has has_multi_home=true, still has >=2 live family homes, or has 0 upcoming discounted visits', async () => {
    const baseMember = {
      id: SURVIVOR, first_name: 'Robin', last_name: 'Sample', company_name: null,
      active: true, has_multi_home: false, pipeline_stage: 'active_customer',
    };
    // Own multi-home flag -> still qualifies on its own
    expect(await Family.alertFamilyDropBelowTwo(
      makeAlertConn({ member: { ...baseMember, has_multi_home: true }, upcomingDiscountedCount: 2 }),
      { formerMemberIds: [SURVIVOR], departedCustomerId: DEPARTED, reason: 'archived' },
    )).toBe(0);

    // Still 2 active qualifying members in family -> no drop below 2
    expect(await Family.alertFamilyDropBelowTwo(
      makeAlertConn({
        member: baseMember,
        familyMembersRows: [
          { id: SURVIVOR, first_name: 'Robin', last_name: 'Sample', address_line1: '100 Main St', zip: '34231', active: true, pipeline_stage: 'active_customer', deleted_at: null },
          { id: '55555555-5555-4555-8555-555555555555', first_name: 'Sam', last_name: 'Sample', address_line1: '200 Oak Ave', zip: '34231', active: true, pipeline_stage: 'active_customer', deleted_at: null },
        ],
        upcomingDiscountedCount: 2,
      }),
      { formerMemberIds: [SURVIVOR], departedCustomerId: DEPARTED, reason: 'cancelled' },
    )).toBe(0);

    // Zero upcoming discounted visits -> no alert needed
    expect(await Family.alertFamilyDropBelowTwo(
      makeAlertConn({ member: baseMember, upcomingDiscountedCount: 0 }),
      { formerMemberIds: [SURVIVOR], departedCustomerId: DEPARTED, reason: 'unlinked' },
    )).toBe(0);

    expect(mockRaiseAdminAlert).not.toHaveBeenCalled();
  });
});

describe('IB tool RBAC guard for family-link tools', () => {
  test('admin-intelligence-bar.js lists link_customer_family and unlink_customer_family in ADMIN_ONLY_TOOL_NAMES', () => {
    const src = fs.readFileSync(path.join(__dirname, '../routes/admin-intelligence-bar.js'), 'utf8');
    expect(src).toMatch(/'link_customer_family'/);
    expect(src).toMatch(/'unlink_customer_family'/);
  });
});
