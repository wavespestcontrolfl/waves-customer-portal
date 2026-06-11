jest.mock("twilio", () => jest.fn());
jest.mock("../config", () => ({
  twilio: {
    accountSid: "sid",
    authToken: "token",
    phoneNumber: "+15550000000",
  },
}));
jest.mock("../models/db", () => jest.fn());
jest.mock("../services/logger", () => ({
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
}));
jest.mock("../routes/admin-sms-templates", () => ({
  getTemplate: jest.fn(),
}));
jest.mock("../services/short-url", () => ({
  shortenOrPassthrough: jest.fn(),
}));
jest.mock("../services/customer-contact", () => ({
  getAppointmentContacts: jest.fn(),
  isServiceContactRole: jest.requireActual("../services/customer-contact").isServiceContactRole,
}));
jest.mock("../services/messaging/send-customer-message", () => ({
  sendCustomerMessage: jest.fn(),
}));

const db = require("../models/db");
const smsTemplates = require("../routes/admin-sms-templates");
const { shortenOrPassthrough } = require("../services/short-url");
const { getAppointmentContacts } = require("../services/customer-contact");
const {
  sendCustomerMessage,
} = require("../services/messaging/send-customer-message");
const TwilioService = require("../services/twilio");

function firstQuery(row) {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(row),
  };
}

function joinedFirstQuery(row) {
  return {
    where: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(row),
  };
}

function selectQuery(rows) {
  return {
    where: jest.fn().mockReturnThis(),
    select: jest.fn().mockResolvedValue(rows),
  };
}

describe("TwilioService.sendTechEnRoute", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PUBLIC_PORTAL_URL = "https://portal.wavespestcontrol.com";
    delete process.env.CLIENT_URL;
  });

  test("renders the editable SMS template with a branded short tracking link", async () => {
    db.mockReturnValueOnce(
      firstQuery({ id: "cust-1", first_name: "Sam", phone: "+15551112222" }),
    ).mockReturnValueOnce(
      firstQuery({ tech_en_route: true, sms_enabled: true }),
    );

    getAppointmentContacts.mockReturnValue([
      { phone: "+15551112222", name: "Sam", role: "primary" },
    ]);
    shortenOrPassthrough.mockResolvedValue(
      "https://portal.wavespestcontrol.com/l/abc23",
    );
    smsTemplates.getTemplate.mockResolvedValue(
      "Hello Sam! Bryan is on the way.\n\nTrack live: https://portal.wavespestcontrol.com/l/abc23\n\nQuestions or requests? Reply to this message. Reply STOP to opt out.",
    );
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await TwilioService.sendTechEnRoute(
      "cust-1",
      "Bryan",
      null,
      "track-token",
    );

    expect(shortenOrPassthrough).toHaveBeenCalledWith(
      "https://portal.wavespestcontrol.com/track/track-token",
      expect.objectContaining({
        kind: "tracking",
        entityType: "scheduled_services",
        customerId: "cust-1",
      }),
    );
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      "tech_en_route",
      {
        first_name: "Sam",
        tech_name: "Bryan",
        eta_line: "",
        track_clause:
          "Track live: https://portal.wavespestcontrol.com/l/abc23\n\n",
        track_url: "https://portal.wavespestcontrol.com/l/abc23",
      },
      { workflow: "tech_en_route", entity_type: "customer", entity_id: "cust-1" },
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551112222",
        body: "Hello Sam! Bryan is on the way.\n\nTrack live: https://portal.wavespestcontrol.com/l/abc23\n\nQuestions or requests? Reply to this message. Reply STOP to opt out.",
        purpose: "tech_en_route",
      }),
    );
    expect(result.success).toBe(true);
  });

  test("sendTechArrived uses arrival copy instead of en-route copy", async () => {
    db.mockReturnValueOnce(
      firstQuery({ id: "cust-1", first_name: "Sam", phone: "+15551112222" }),
    ).mockReturnValueOnce(
      firstQuery({ tech_en_route: true, sms_enabled: true }),
    );

    getAppointmentContacts.mockReturnValue([
      { phone: "+15551112222", name: "Sam", role: "primary" },
    ]);
    smsTemplates.getTemplate.mockResolvedValue(
      "Hello Sam! Bryan has arrived and is servicing your property.\n\nQuestions or requests? Reply to this message. Reply STOP to opt out.",
    );
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await TwilioService.sendTechArrived("cust-1", "Bryan");

    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      "tech_arrived",
      {
        first_name: "Sam",
        tech_name: "Bryan",
      },
      { workflow: "tech_arrived", entity_type: "customer", entity_id: "cust-1" },
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551112222",
        body: expect.stringContaining(
          "has arrived and is servicing your property",
        ),
        purpose: "tech_en_route",
        metadata: {
          original_message_type: "tech_en_route",
          appointment_progress_event: "tech_arrived",
        },
      }),
    );
    expect(sendCustomerMessage.mock.calls[0][0].body).not.toContain(
      "on the way",
    );
    expect(result.success).toBe(true);
  });
});

describe("TwilioService.sendServiceReminder", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders the standard 24-hour reminder template after legacy template deletion", async () => {
    db.mockReturnValueOnce(
      firstQuery({ id: "cust-1", first_name: "Sam", phone: "+15551112222" }),
    ).mockReturnValueOnce(
      joinedFirstQuery({
        id: "svc-1",
        service_type: "Pest Control",
        window_start: "08:00:00",
        window_end: "10:00:00",
        tech_name: "Bryan",
      }),
    ).mockReturnValueOnce(
      firstQuery({ service_reminder_24h: true, sms_enabled: true }),
    );

    smsTemplates.getTemplate.mockResolvedValue(
      "Hello Sam! Reminder: your Pest Control with Waves is tomorrow at 8:00 AM.",
    );
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await TwilioService.sendServiceReminder("cust-1", "svc-1");

    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      "reminder_24h",
      {
        first_name: "Sam",
        service_type: "Pest Control",
        time: "8:00 AM",
      },
      { workflow: "twilio_reminder_24h", entity_type: "scheduled_service", entity_id: "svc-1" },
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551112222",
        body: "Hello Sam! Reminder: your Pest Control with Waves is tomorrow at 8:00 AM.",
        channel: "sms",
        audience: "customer",
        purpose: "appointment_reminder_24h",
        customerId: "cust-1",
        identityTrustLevel: "service_contact_authorized",
        metadata: { original_message_type: "appointment_reminder" },
      }),
    );
    expect(result.sent).toBe(true);
  });
});

describe("TwilioService legacy customer SMS helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("sendBillingReminder uses the canonical customer send wrapper", async () => {
    db.mockReturnValueOnce(
      firstQuery({
        id: "cust-1",
        first_name: "Sam",
        phone: "+15551112222",
        waveguard_tier: "Pro",
      }),
    ).mockReturnValueOnce(
      firstQuery({ billing_reminder: true, sms_enabled: true }),
    );
    smsTemplates.getTemplate.mockResolvedValue("Billing reminder body");
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await TwilioService.sendBillingReminder("cust-1", 125, "June 1");

    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      "billing_reminder",
      {
        first_name: "Sam",
        waveguard_tier: "Pro",
        amount: "125.00",
        charge_date: "June 1",
      },
      { workflow: "billing_reminder", entity_type: "customer", entity_id: "cust-1" },
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551112222",
        body: "Billing reminder body",
        channel: "sms",
        audience: "customer",
        purpose: "billing",
        customerId: "cust-1",
        identityTrustLevel: "phone_matches_customer",
        metadata: { original_message_type: "billing_reminder" },
      }),
    );
    expect(result.sent).toBe(true);
  });

  test("sendBillingReminder throws when the policy wrapper reports provider failure", async () => {
    db.mockReturnValueOnce(
      firstQuery({
        id: "cust-1",
        first_name: "Sam",
        phone: "+15551112222",
        waveguard_tier: "Pro",
      }),
    ).mockReturnValueOnce(
      firstQuery({ billing_reminder: true, sms_enabled: true }),
    );
    smsTemplates.getTemplate.mockResolvedValue("Billing reminder body");
    sendCustomerMessage.mockResolvedValue({
      sent: false,
      blocked: false,
      code: "PROVIDER_FAILURE",
      reason: "Twilio rejected the message",
    });

    await expect(
      TwilioService.sendBillingReminder("cust-1", 125, "June 1"),
    ).rejects.toThrow("Twilio rejected the message");
  });

  test("sendServiceCompletedSummary uses the canonical customer send wrapper", async () => {
    db.mockReturnValueOnce(
      firstQuery({ id: "cust-1", first_name: "Sam", phone: "+15551112222" }),
    ).mockReturnValueOnce(
      firstQuery({ service_completed: true, sms_enabled: true }),
    ).mockReturnValueOnce(
      joinedFirstQuery({ id: "record-1", service_type: "Pest Control", tech_name: "Bryan" }),
    ).mockReturnValueOnce(
      selectQuery([{ product_name: "Barrier spray" }]),
    );
    smsTemplates.getTemplate.mockResolvedValue("Service complete body");
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await TwilioService.sendServiceCompletedSummary("cust-1", "record-1");

    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      "service_complete",
      { first_name: "Sam" },
      { workflow: "service_complete", entity_type: "service_record", entity_id: "record-1" },
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551112222",
        body: "Service complete body",
        channel: "sms",
        audience: "customer",
        purpose: "service_completion",
        customerId: "cust-1",
        identityTrustLevel: "service_contact_authorized",
        metadata: {
          original_message_type: "service_complete",
          serviceRecordId: "record-1",
        },
      }),
    );
    expect(result.sent).toBe(true);
  });

  test("sendSeasonalAlert uses the canonical customer send wrapper", async () => {
    db.mockReturnValueOnce(
      firstQuery({ id: "cust-1", first_name: "Sam", phone: "+15551112222" }),
    ).mockReturnValueOnce(
      firstQuery({
        seasonal_tips: true,
        sms_enabled: true,
        updated_at: "2026-05-01T12:00:00.000Z",
      }),
    );
    smsTemplates.getTemplate.mockResolvedValue("Seasonal alert body");
    sendCustomerMessage.mockResolvedValue({ sent: true });

    const result = await TwilioService.sendSeasonalAlert("cust-1", "Mosquitoes", "Check standing water.");

    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      "seasonal_alert",
      {
        first_name: "Sam",
        tip: "Check standing water.",
      },
      { workflow: "seasonal_alert", entity_type: "customer", entity_id: "cust-1" },
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "+15551112222",
        body: "Seasonal alert body",
        channel: "sms",
        audience: "customer",
        purpose: "marketing",
        consentBasis: {
          status: "opted_in",
          source: "notification_prefs.seasonal_tips",
          capturedAt: "2026-05-01T12:00:00.000Z",
        },
        customerId: "cust-1",
        identityTrustLevel: "phone_matches_customer",
        metadata: { original_message_type: "seasonal_alert" },
      }),
    );
    expect(result.sent).toBe(true);
  });

  test("sendSeasonalAlert fails before dispatch when the seasonal opt-in is missing", async () => {
    db.mockReturnValueOnce(
      firstQuery({ id: "cust-1", first_name: "Sam", phone: "+15551112222" }),
    ).mockReturnValueOnce(
      firstQuery({ seasonal_tips: false, sms_enabled: true }),
    );

    const result = await TwilioService.sendSeasonalAlert("cust-1", "Mosquitoes", "Check standing water.");

    expect(result).toBeUndefined();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });
});
