const {
  getAppointmentContacts,
  getBillingContact,
  getInvoiceEmailRecipients,
  getServiceReportEmailRecipients,
} = require('../services/customer-contact');

const customer = {
  id: 'cust-1',
  first_name: 'Lana',
  last_name: 'Owner',
  phone: '+15551110000',
  email: 'lana@example.com',
  service_contact_name: 'Terry Tenant',
  service_contact_phone: '+15552220000',
  service_contact_email: 'terry@example.com',
  // SMS fanout to service contacts requires the consent artifact (#2948).
  service_contacts_consent_at: '2026-07-22T00:00:00Z',
};

describe('customer contact recipient routing', () => {
  test('routes billing email to billing_email when configured', () => {
    const contact = getBillingContact(customer, {
      billing_contact_name: 'Accounts Payable',
      billing_email: 'ap@example.com',
    });

    expect(contact).toEqual(expect.objectContaining({
      name: 'Accounts Payable',
      email: 'ap@example.com',
      phone: '+15551110000',
      role: 'billing_contact',
    }));
    expect(getInvoiceEmailRecipients(customer, { billing_email: 'ap@example.com' }))
      .toEqual([expect.objectContaining({ email: 'ap@example.com' })]);
  });

  test('ignores stale billing contact name when billing email is cleared', () => {
    const contact = getBillingContact(customer, {
      billing_contact_name: 'Old Accounts Payable',
      billing_email: null,
    });

    expect(contact).toEqual(expect.objectContaining({
      email: 'lana@example.com',
      name: 'Lana',
      role: 'primary',
    }));
  });

  test('service reports include the account holder BY DEFAULT alongside the service contact', () => {
    // Opt-OUT semantics — see 20260725000003/4. Three real accounts were
    // receiving none of their own reports under the old opt-in default.
    expect(getServiceReportEmailRecipients(customer, {})).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
      expect.objectContaining({ email: 'lana@example.com', role: 'primary' }),
    ]);

    expect(getServiceReportEmailRecipients(customer, { service_report_notify_primary: true }))
      .toEqual([
        expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
        expect.objectContaining({ email: 'lana@example.com', role: 'primary' }),
      ]);

    // Only an EXPLICIT false opts the holder out.
    expect(getServiceReportEmailRecipients(customer, { service_report_notify_primary: false }))
      .toEqual([
        expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
      ]);
  });

  test('copies the billing recipient on service reports when enabled', () => {
    const prefs = {
      billing_contact_name: 'Christine Landlord',
      billing_email: 'christine@example.com',
      service_report_notify_billing: true,
    };

    // Account under the occupant, no service contacts: report goes to the
    // primary plus the billing recipient.
    const occupantOnly = {
      id: 'cust-3',
      first_name: 'Gideon',
      phone: '+15556660000',
      email: 'gideon@example.com',
    };
    expect(getServiceReportEmailRecipients(occupantOnly, prefs)).toEqual([
      expect.objectContaining({ email: 'gideon@example.com', role: 'primary' }),
      expect.objectContaining({
        email: 'christine@example.com',
        name: 'Christine Landlord',
        role: 'billing_contact',
      }),
    ]);

    // With a distinct service contact and owner copy explicitly OFF, the
    // billing recipient is still appended.
    expect(getServiceReportEmailRecipients(customer, { ...prefs, service_report_notify_primary: false })).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
      expect.objectContaining({ email: 'christine@example.com', role: 'billing_contact' }),
    ]);
  });

  test('billing report copy is a no-op without a billing email or when it duplicates a recipient', () => {
    // Toggle on but no billing_email set: the payer IS the primary, which the
    // notify-primary toggle already covers.
    expect(getServiceReportEmailRecipients(customer, {
      service_report_notify_billing: true,
      service_report_notify_primary: false,
    })).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
    ]);

    // Billing email matching an existing recipient is deduped.
    expect(getServiceReportEmailRecipients(customer, {
      billing_email: 'Terry@example.com',
      service_report_notify_billing: true,
      service_report_notify_primary: false,
    })).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
    ]);
  });

  test('appointment contacts include the account holder BY DEFAULT alongside the service contact', () => {
    // Opt-OUT semantics: no stored preference means the holder is included.
    // The old opt-in default silently dropped them the moment a contact was
    // named — see 20260725000001_notify_primary_default_on.
    expect(getAppointmentContacts(customer, {})).toEqual([
      expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
      expect.objectContaining({ phone: '+15551110000', role: 'primary' }),
    ]);

    expect(getAppointmentContacts(customer, { appointment_notify_primary: true }))
      .toEqual([
        expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
        expect.objectContaining({ phone: '+15551110000', role: 'primary' }),
      ]);

    // Only an EXPLICIT false opts the holder out.
    expect(getAppointmentContacts(customer, { appointment_notify_primary: false }))
      .toEqual([
        expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
      ]);
  });

  const multiContactCustomer = {
    ...customer,
    service_contact2_name: 'Sam Spouse',
    service_contact2_phone: '+15553330000',
    service_contact2_email: 'sam@example.com',
    service_contact3_name: 'Pat Manager',
    service_contact3_phone: '+15554440000',
    service_contact3_email: 'pat@example.com',
  };

  test('appointment contacts fan out across all distinct service contact slots', () => {
    expect(getAppointmentContacts(multiContactCustomer, { appointment_notify_primary: false })).toEqual([
      expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
      expect.objectContaining({ phone: '+15553330000', role: 'service_contact_2' }),
      expect.objectContaining({ phone: '+15554440000', role: 'service_contact_3' }),
    ]);

    expect(getAppointmentContacts(multiContactCustomer, { appointment_notify_primary: true }))
      .toEqual([
        expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
        expect.objectContaining({ phone: '+15553330000', role: 'service_contact_2' }),
        expect.objectContaining({ phone: '+15554440000', role: 'service_contact_3' }),
        expect.objectContaining({ phone: '+15551110000', role: 'primary' }),
      ]);
  });

  test('appointment contacts skip slots that duplicate the primary or an earlier slot', () => {
    const withDupes = {
      ...customer,
      service_contact2_name: 'Dup Of Owner',
      service_contact2_phone: '+15551110000',
      service_contact3_name: 'Dup Of Tenant',
      service_contact3_phone: '+15552220000',
    };
    expect(getAppointmentContacts(withDupes, { appointment_notify_primary: false })).toEqual([
      expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
    ]);
    // Robert Meelan's shape (2026-07-24): the holder's OWN number sitting in a
    // contact slot is de-duped away, so with the holder opted IN they appear
    // exactly once, as primary — never twice.
    expect(getAppointmentContacts(withDupes, {})).toEqual([
      expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
      expect.objectContaining({ phone: '+15551110000', role: 'primary' }),
    ]);
  });

  test('service reports fan out across all distinct service contact emails', () => {
    expect(getServiceReportEmailRecipients(multiContactCustomer, { service_report_notify_primary: false })).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
      expect.objectContaining({ email: 'sam@example.com', role: 'service_contact_2' }),
      expect.objectContaining({ email: 'pat@example.com', role: 'service_contact_3' }),
    ]);

    expect(getServiceReportEmailRecipients(multiContactCustomer, { service_report_notify_primary: true }))
      .toEqual([
        expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
        expect.objectContaining({ email: 'sam@example.com', role: 'service_contact_2' }),
        expect.objectContaining({ email: 'pat@example.com', role: 'service_contact_3' }),
        expect.objectContaining({ email: 'lana@example.com', role: 'primary' }),
      ]);
  });

  test('a slot-2 contact still routes when slot 1 is empty', () => {
    const onlySlot2 = {
      id: 'cust-2',
      first_name: 'Lana',
      phone: '+15551110000',
      email: 'lana@example.com',
      service_contact2_name: 'Sam Spouse',
      service_contact2_phone: '+15553330000',
      service_contact2_email: 'sam@example.com',
      service_contacts_consent_at: '2026-07-22T00:00:00Z',
    };
    expect(getAppointmentContacts(onlySlot2, { appointment_notify_primary: false })).toEqual([
      expect.objectContaining({ phone: '+15553330000', role: 'service_contact_2' }),
    ]);
    expect(getServiceReportEmailRecipients(onlySlot2, { service_report_notify_primary: false })).toEqual([
      expect.objectContaining({ email: 'sam@example.com', role: 'service_contact_2' }),
    ]);
  });

  test('SMS fanout skips service contacts when the consent artifact is missing (#2948 gate)', () => {
    const unstamped = { ...customer, service_contacts_consent_at: null };
    // Service-contact texting targets drop; the primary still gets texts.
    expect(getAppointmentContacts(unstamped, {})).toEqual([
      expect.objectContaining({ phone: '+15551110000', role: 'primary' }),
    ]);
    // Email routing is NOT part of the SMS consent gate. Holder explicitly
    // opted out so this asserts the gate alone — and note that BEFORE
    // 20260725000003 this ungated path dropped the holder even with no consent
    // artifact, which is why it was the more exposed of the two.
    expect(getServiceReportEmailRecipients(unstamped, { service_report_notify_primary: false })).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
    ]);
  });

  test('getServiceContactSmsRecipient resolves a COHERENT identity per consent state (#2955 P1)', () => {
    const { getServiceContact, getServiceContactSmsRecipient } = require('../services/customer-contact');
    const unstamped = { ...customer, service_contacts_consent_at: null };
    // Unstamped → the primary as a whole person (phone AND name together —
    // never the primary's phone addressed with the contact's name).
    expect(getServiceContactSmsRecipient(unstamped)).toEqual(expect.objectContaining({
      phone: '+15551110000',
      name: 'Lana',
      role: 'primary',
    }));
    // Stamped → the service contact as themselves.
    expect(getServiceContactSmsRecipient(customer)).toEqual(expect.objectContaining({
      phone: '+15552220000',
      name: 'Terry Tenant',
      role: 'service_contact',
    }));
    // getServiceContact itself stays ungated (email/display callers).
    expect(getServiceContact(unstamped)).toEqual(expect.objectContaining({
      phone: '+15552220000',
      email: 'terry@example.com',
    }));
  });

  test('an EXPLICIT opt-out wins even when there is no other recipient (codex #2992 P1)', () => {
    // The old `!contacts.length ||` safety net overrode a stored false, so
    // unchecking the toggle did nothing for an account with no distinct
    // consented contact — the UI promised an opt-out the send path ignored.
    const noContacts = {
      id: 'cust-9', first_name: 'Solo', phone: '+15551110000', email: 'solo@example.com',
    };
    expect(getAppointmentContacts(noContacts, {})).toEqual([
      expect.objectContaining({ phone: '+15551110000', role: 'primary' }),
    ]);
    expect(getAppointmentContacts(noContacts, { appointment_notify_primary: false })).toEqual([]);
    expect(getServiceReportEmailRecipients(noContacts, { service_report_notify_primary: false })).toEqual([]);

    // Consent artifact missing => service contacts drop, but an explicit
    // opt-out must still not resurrect the holder.
    const unstamped = { ...customer, service_contacts_consent_at: null };
    expect(getAppointmentContacts(unstamped, { appointment_notify_primary: false })).toEqual([]);
  });

  test('a FAILED preference lookup fails closed, not default-on (codex #2992 P1)', () => {
    const { PREFS_UNAVAILABLE } = require('../services/customer-contact');
    // A transient DB error must not be read as "no preference stored" and
    // silently override a customer's opt-out.
    expect(getAppointmentContacts(customer, PREFS_UNAVAILABLE)).toEqual([
      expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
    ]);
    expect(getServiceReportEmailRecipients(customer, PREFS_UNAVAILABLE)).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
    ]);
    // Every OTHER field still reads exactly like the `{}` callers passed before,
    // so nothing beyond the notify-primary decision changes.
    expect(PREFS_UNAVAILABLE.sms_enabled).toBeUndefined();
  });

  test('DISABLE_CONTACT_CONSENT_GATE=1 restores ungated fanout (kill switch)', () => {
    const unstamped = { ...customer, service_contacts_consent_at: null };
    process.env.DISABLE_CONTACT_CONSENT_GATE = '1';
    try {
      // Holder explicitly opted out so this asserts the CONSENT gate alone —
      // with the default (opt-in) they would also appear as primary.
      expect(getAppointmentContacts(unstamped, { appointment_notify_primary: false })).toEqual([
        expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
      ]);
    } finally {
      delete process.env.DISABLE_CONTACT_CONSENT_GATE;
    }
  });
});
