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

  test('the V1/V2 merge ORs is_billing_party from either extractor', () => {
    const merged = proc._test.resolveCallSecondaryContact(
      { secondary_contact: { first_name: 'Jim', email: 'jim@example.com', is_billing_party: false } },
      { secondary_contact: { first_name: 'Jim', email: 'jim@example.com', role: 'landlord', wants_notifications: true, is_billing_party: true } },
    );
    expect(merged.is_billing_party).toBe(true);
  });
});

describe('extraction schema version', () => {
  test('SCHEMA_VERSION bumped to 1.6.0 for the additive is_billing_party field', () => {
    const { SCHEMA_VERSION } = require('../schemas/validate-extraction');
    expect(SCHEMA_VERSION).toBe('1.6.0');
  });
});
