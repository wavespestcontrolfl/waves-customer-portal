/**
 * sendTechArrived × the 8AM-8PM send window (codex r13 P2, PR #3259).
 *
 * "Has arrived" is only true at arrival time. A QUIET_HOURS_HOLD from the
 * canonical send path is retryable+deferred for most messages, but for the
 * arrival notice a released guard means the next morning's GPS/geofence
 * re-fire of a still-on_property row texts "has arrived" hours late
 * (markOnProperty deliberately retries stamped-but-unsent rows on every
 * later signal). Contract pinned here:
 *
 *  - a window-held leg → { suppressed: true, reason: 'send_window_hold' }:
 *    the arrival is HANDLED, the caller keeps its claim, the text drops;
 *  - the hold is sticky across the contact loop — a retryable provider
 *    failure on another contact must not flip the outcome back to retry;
 *  - a plain transient provider failure (no hold) stays a retryable miss.
 */
jest.mock("twilio", () => jest.fn());
jest.mock("../config", () => ({
  twilio: { accountSid: "sid", authToken: "token", phoneNumber: "+15550000000" },
}));
jest.mock("../models/db", () => jest.fn());
jest.mock("../services/logger", () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock("../routes/admin-sms-templates", () => ({
  getTemplate: jest.fn(),
}));
jest.mock("../services/short-url", () => ({
  shortenOrPassthrough: jest.fn(),
}));
jest.mock("../services/customer-contact", () => ({
  getAppointmentContacts: jest.fn(),
  getPrimaryContact: jest.requireActual("../services/customer-contact").getPrimaryContact,
  isServiceContactRole: jest.requireActual("../services/customer-contact").isServiceContactRole,
  firstNameFrom: jest.requireActual("../services/customer-contact").firstNameFrom,
  prefsUnavailable: jest.requireActual("../services/customer-contact").prefsUnavailable,
}));
jest.mock("../services/recipient-optin", () => ({
  filterRecipientsByOptin: jest.fn(async (contacts) => contacts),
}));
jest.mock("../services/messaging/send-customer-message", () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock("../services/appointment-email", () => ({
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
  sendTechArrivedEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock("../services/appointment-reminders", () => ({
  alertNoReachableChannel: jest.fn(async () => ({})),
  resolveChannelPrefsRow: jest.fn(async (customerId, prefs) => prefs),
  apptChannel: (value) => (value === "email" || value === "both" ? value : "sms"),
}));

const db = require("../models/db");
const smsTemplates = require("../routes/admin-sms-templates");
const { getAppointmentContacts } = require("../services/customer-contact");
const { sendCustomerMessage } = require("../services/messaging/send-customer-message");
const TwilioService = require("../services/twilio");

const customer = { id: "cust-1", first_name: "Pat", phone: "+15550001111" };
const prefs = { customer_id: "cust-1", tech_arrived: true, sms_enabled: true };

function firstQuery(row) {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(row),
  };
}

const HOLD = {
  sent: false,
  blocked: true,
  code: "QUIET_HOURS_HOLD",
  retryable: true,
  deferred: true,
  nextAllowedAt: "2026-08-08T12:00:00.000Z",
};
const TRANSIENT = { sent: false, blocked: true, code: "PROVIDER_ERROR", retryable: true };

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation((table) => {
    if (table === "customers") return firstQuery(customer);
    if (table === "notification_prefs") return firstQuery(prefs);
    return firstQuery(null);
  });
  smsTemplates.getTemplate.mockResolvedValue("Your technician has arrived.");
});

test("window-held arrival SMS is HANDLED (suppressed), not a retryable miss", async () => {
  getAppointmentContacts.mockReturnValue([{ phone: customer.phone, name: "Pat Q", role: "primary" }]);
  sendCustomerMessage.mockResolvedValue(HOLD);

  const res = await TwilioService.sendTechArrived("cust-1", "Adam");
  expect(res.success).toBe(false);
  expect(res.suppressed).toBe(true);
  expect(res.reason).toBe("send_window_hold");
});

test("hold is sticky across the contact fanout — a retryable leg cannot flip it back to retry", async () => {
  getAppointmentContacts.mockReturnValue([
    { phone: "+15550001111", name: "Pat Q", role: "primary" },
    { phone: "+15550002222", name: "Sam Q", role: "spouse" },
  ]);
  sendCustomerMessage
    .mockResolvedValueOnce(HOLD)
    .mockResolvedValueOnce(TRANSIENT);

  const res = await TwilioService.sendTechArrived("cust-1", "Adam");
  expect(res.suppressed).toBe(true);
  expect(res.reason).toBe("send_window_hold");
});

test("plain transient provider failure stays a retryable miss (guard released)", async () => {
  getAppointmentContacts.mockReturnValue([{ phone: customer.phone, name: "Pat Q", role: "primary" }]);
  sendCustomerMessage.mockResolvedValue(TRANSIENT);

  const res = await TwilioService.sendTechArrived("cust-1", "Adam");
  expect(res.success).toBe(false);
  expect(res.suppressed).toBeUndefined();
});
