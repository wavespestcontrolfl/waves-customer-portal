/**
 * sendTechArrived label override (GATE_ONE_TEXT_PER_CUSTOMER_DAY): the one arrived text may name
 * every service it covers. No override = today's label from the reminder path's builder.
 */
jest.mock("twilio", () => jest.fn());
jest.mock("../config", () => ({
  twilio: { accountSid: "sid", authToken: "token", phoneNumber: "+15550000000" },
}));
jest.mock("../models/db", () => jest.fn());
jest.mock("../services/logger", () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock("../routes/admin-sms-templates", () => ({ getTemplate: jest.fn() }));
jest.mock("../services/short-url", () => ({ shortenOrPassthrough: jest.fn() }));
jest.mock("../services/customer-contact", () => ({
  getAppointmentContacts: jest.fn(),
  getPrimaryContact: jest.requireActual("../services/customer-contact").getPrimaryContact,
  isServiceContactRole: jest.requireActual("../services/customer-contact").isServiceContactRole,
  firstNameFrom: jest.requireActual("../services/customer-contact").firstNameFrom,
  prefsUnavailable: jest.requireActual("../services/customer-contact").prefsUnavailable,
}));
jest.mock("../services/recipient-optin", () => ({ filterRecipientsByOptin: jest.fn(async (contacts) => contacts) }));
jest.mock("../services/messaging/send-customer-message", () => ({ sendCustomerMessage: jest.fn() }));
jest.mock("../services/appointment-email", () => ({
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
  sendTechArrivedEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock("../services/appointment-reminders", () => ({
  alertNoReachableChannel: jest.fn(async () => ({})),
  resolveChannelPrefsRow: jest.fn(async (customerId, prefs) => prefs),
  buildServiceLabel: jest.fn(async (scheduledServiceId, parentName) => parentName || "service"),
  apptChannel: (value) => (value === "email" || value === "both" ? value : "sms"),
}));

const db = require("../models/db");
const smsTemplates = require("../routes/admin-sms-templates");
const { getAppointmentContacts } = require("../services/customer-contact");
const { sendCustomerMessage } = require("../services/messaging/send-customer-message");
const TwilioService = require("../services/twilio");

const customer = { id: "cust-1", first_name: "Pat", phone: "+15550001111" };
const prefs = { customer_id: "cust-1", tech_arrived: true, sms_enabled: true };
const firstQuery = (row) => ({ where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(row) });

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation((table) => {
    if (table === "customers") return firstQuery(customer);
    if (table === "notification_prefs") return firstQuery(prefs);
    if (table === "scheduled_services") return firstQuery({ service_type: "Quarterly Pest Control" });
    return firstQuery(null);
  });
  smsTemplates.getTemplate.mockResolvedValue("Your technician has arrived.");
  getAppointmentContacts.mockReturnValue([{ phone: customer.phone, name: "Pat Q", role: "primary" }]);
  sendCustomerMessage.mockResolvedValue({ sent: true, deliveryOutcome: "accepted" });
});

const serviceTypeUsed = () => smsTemplates.getTemplate.mock.calls.find((c) => c[0] === "tech_arrived")[1].service_type;

test("no override: the label is the visit's own, as today", async () => {
  await TwilioService.sendTechArrived("cust-1", "Adam", { scheduledServiceId: "svc-1" });
  expect(serviceTypeUsed()).toBe("Quarterly Pest Control");
});

test("an override label replaces the visit's own in the same template", async () => {
  await TwilioService.sendTechArrived("cust-1", "Adam", { scheduledServiceId: "svc-1", serviceLabel: "Pest Control & Lawn Care" });
  expect(serviceTypeUsed()).toBe("Pest Control & Lawn Care");
});
