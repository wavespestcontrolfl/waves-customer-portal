// Call → third-party payer (Bill-To) linkage (2026-07-10). Grounded in a live
// miss: a property-manager callback booked a $350 rodent job the owner ("Jim")
// pays for, but the paying party was filed as a service-contact and the job was
// billable to nobody. These verify the pipeline finds the billing party and
// maps it to a payer id to stamp on the booking.

// Gates are frozen at require-time from env — set BEFORE requiring the processor.
process.env.GATE_CALL_PAYER_LINKING = 'true';
process.env.GATE_CALL_SECONDARY_CONTACT = 'true';

jest.mock('../services/payer', () => ({
  findOrCreatePayerByEmail: jest.fn(async ({ apEmail }) => ({ payer: { id: 42, ap_email: apEmail } })),
}));

const proc = require('../services/call-recording-processor');
const PayerService = require('../services/payer');

describe('resolveCallBillingPayer', () => {
  afterEach(() => PayerService.findOrCreatePayerByEmail.mockClear());

  test('links a payer for the billing party that has a usable email', async () => {
    const contacts = [
      { first_name: 'Tenant', email: null, is_billing_party: false },
      { first_name: 'James', last_name: 'Brenner', email: 'jim@example.com', phone: '+19410000000', is_billing_party: true },
    ];
    const id = await proc._test.resolveCallBillingPayer(contacts);
    expect(id).toBe(42);
    expect(PayerService.findOrCreatePayerByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ apEmail: 'jim@example.com', displayName: 'James Brenner', apPhone: '+19410000000' }),
    );
  });

  test('no billing party → null, never touches the payer service', async () => {
    const contacts = [{ first_name: 'Tenant', email: 'tenant@example.com', is_billing_party: false }];
    expect(await proc._test.resolveCallBillingPayer(contacts)).toBeNull();
    expect(PayerService.findOrCreatePayerByEmail).not.toHaveBeenCalled();
  });

  test('billing party without a usable email → null (cannot invoice a payer with no AP inbox)', async () => {
    const contacts = [{ first_name: 'Jim', is_billing_party: true, email: null }];
    expect(await proc._test.resolveCallBillingPayer(contacts)).toBeNull();
    expect(PayerService.findOrCreatePayerByEmail).not.toHaveBeenCalled();
  });

  test('empty / nullish contact list → null', async () => {
    expect(await proc._test.resolveCallBillingPayer(null)).toBeNull();
    expect(await proc._test.resolveCallBillingPayer([])).toBeNull();
    expect(PayerService.findOrCreatePayerByEmail).not.toHaveBeenCalled();
  });

  test('links a payer from a PRUNED V2 billing contact absent from the merged list', async () => {
    // The merged list carries only the tenant (no billing); the owner/payer with
    // an AP email lives in the raw V2 extraction and was pruned from the merged
    // list on an identity conflict. resolveCallBillingPayer must still find it.
    const mergedList = [{ first_name: 'Tenant', email: 'tenant@example.com', is_billing_party: false }];
    const v2 = { secondary_contact: { name_full: 'James Brenner', email: 'jim@example.com', role: 'landlord', wants_notifications: true, is_billing_party: true } };
    const id = await proc._test.resolveCallBillingPayer(mergedList, v2);
    expect(id).toBe(42);
    expect(PayerService.findOrCreatePayerByEmail).toHaveBeenCalledWith(expect.objectContaining({ apEmail: 'jim@example.com' }));
  });

  test('fails closed when MULTIPLE distinct billing parties are flagged', async () => {
    const contacts = [
      { first_name: 'Owner', email: 'owner@example.com', is_billing_party: true },
      { first_name: 'Manager', email: 'mgr@example.com', is_billing_party: true },
    ];
    expect(await proc._test.resolveCallBillingPayer(contacts)).toBeNull();
    expect(PayerService.findOrCreatePayerByEmail).not.toHaveBeenCalled();
  });

  test('the same billing party in BOTH the merged list and V2 is not ambiguous (dedup by email)', async () => {
    const merged = [{ first_name: 'Jim', email: 'jim@example.com', is_billing_party: true }];
    const v2 = { secondary_contact: { name_full: 'Jim Brenner', email: 'jim@example.com', is_billing_party: true } };
    expect(await proc._test.resolveCallBillingPayer(merged, v2)).toBe(42);
  });

  test('does NOT create a payer when the billing party IS the caller (self-pay "I will pay")', async () => {
    const contacts = [{ first_name: 'Jim', email: 'jim@example.com', phone: '+19410001111', is_billing_party: true }];
    expect(await proc._test.resolveCallBillingPayer(contacts, null, { email: 'JIM@example.com' })).toBeNull();
    expect(await proc._test.resolveCallBillingPayer(contacts, null, { phone: '(941) 000-1111' })).toBeNull();
    expect(PayerService.findOrCreatePayerByEmail).not.toHaveBeenCalled();
  });
});

describe('is_billing_party flows through the extraction mapping', () => {
  test('V2 secondary contact maps is_billing_party into the flat shape', () => {
    const { mapSecondaryContactToLegacy } = require('../utils/extraction-compat');
    const mapped = mapSecondaryContactToLegacy({
      name_full: 'Jim Brenner', email: 'jim@example.com', role: 'landlord',
      wants_notifications: true, is_billing_party: true,
    });
    expect(mapped.is_billing_party).toBe(true);
  });

  test('a contact without the flag maps to is_billing_party:false', () => {
    const { mapSecondaryContactToLegacy } = require('../utils/extraction-compat');
    const mapped = mapSecondaryContactToLegacy({ name_full: 'Tenant', phone: '+19410000001', role: 'tenant' });
    expect(mapped.is_billing_party).toBe(false);
  });

  test('V2 gap-fills the billing flag for the SAME contact (V1 had the email, no flag)', () => {
    // Same person: V1 carries the AP email but didn't set is_billing_party; V2
    // (same name, no competing email) heard "the owner pays". The merged contact
    // must keep the flag so the payer links for that email.
    const merged = proc._test.resolveCallSecondaryContact(
      { secondary_contact: { first_name: 'Jim', last_name: 'Brenner', email: 'jim@example.com' } },
      { secondary_contact: { first_name: 'Jim', last_name: 'Brenner', role: 'landlord', wants_notifications: true, is_billing_party: true } },
    );
    expect(merged.email).toBe('jim@example.com');
    expect(merged.is_billing_party).toBe(true);
  });

  test('does NOT inherit the V2 billing flag without a positive shared identifier', () => {
    // V1 = email-only contact, V2 = name-only billing party. Nothing conflicts
    // (no overlapping field to compare), but no shared identifier proves they're
    // the same person — so the owner flag must NOT ride onto V1's email.
    const merged = proc._test.resolveCallSecondaryContact(
      { secondary_contact: { email: 'someone@example.com' } },
      { secondary_contact: { first_name: 'Owner', last_name: 'Guy', role: 'landlord', wants_notifications: true, is_billing_party: true } },
    );
    expect(merged.email).toBe('someone@example.com');
    expect(merged.is_billing_party).toBe(false);
  });

  test('a DIFFERENT billing party never bills the wrong contact (conflict → V1 unmerged, no flag)', () => {
    // V1 = tenant (has email, not payer); V2 = owner with a DIFFERENT name+email
    // flagged billing. The identity-conflict check returns V1 unmerged, so the
    // owner flag never attaches to the tenant's email.
    const merged = proc._test.resolveCallSecondaryContact(
      { secondary_contact: { first_name: 'Ann', last_name: 'Tenant', email: 'tenant@example.com', is_billing_party: false } },
      { secondary_contact: { first_name: 'Bob', last_name: 'Owner', email: 'owner@example.com', role: 'landlord', wants_notifications: true, is_billing_party: true } },
    );
    expect(merged.email).toBe('tenant@example.com');
    expect(merged.is_billing_party).toBe(false);
  });
});

describe('extraction schema version', () => {
  test('SCHEMA_VERSION bumped to 1.6.0 for the additive is_billing_party field', () => {
    const { SCHEMA_VERSION } = require('../schemas/validate-extraction');
    expect(SCHEMA_VERSION).toBe('1.6.0');
  });
});
