// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Customer360ProfileV2 from "./Customer360ProfileV2";

vi.mock("./StickyActionBar", () => ({ CustomerActionBar: () => null }));
vi.mock("./AuthenticatedCallAudio", () => ({ default: () => null }));
vi.mock("./CustomerRequestsPanel", () => ({ default: () => null }));
vi.mock("./CallBridgeLink", () => ({
  default: ({ children }) => <span>{children}</span>,
  callViaBridge: vi.fn(),
}));
vi.mock("../../pages/admin/SchedulePage", () => ({
  ZoneMarkingStep: () => null,
  StationMarkingStep: () => null,
}));
vi.mock("../../hooks/useFeatureFlag", () => ({
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function response(body, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function customerDetail(id, notificationPrefs = {}) {
  return {
    customer: {
      id,
      firstName: id === "customer-a" ? "Avery" : "Blair",
      lastName: "Customer",
      email: `${id}@example.invalid`,
      address: {
        line1: `${id} Main St`,
        line2: null,
        city: "Naples",
        state: "FL",
        zip: "34102",
      },
      active: true,
    },
    notificationPrefs,
    preferences: {},
    healthScore: {},
    invoices: [],
    cards: [],
    paymentMethodConsents: [],
    contracts: [],
    photos: [],
    customerDiscounts: [],
    complianceRecords: [],
    nutrientLedger: {},
    services: [],
    payments: [],
    scheduled: [],
    upcomingScheduled: [],
    accountProperties: [],
    annualPrepayTerms: [],
  };
}

const appointmentLabel = /Also send appointment SMS to the account owner/i;
const billingReportLabel = /Also email service reports to the billing recipient/i;

describe("Customer360ProfileV2 recipient preference recovery", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("waves_admin_token", "test-token");
    localStorage.setItem(
      "waves_admin_user",
      JSON.stringify({ role: "admin" }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("allows only one notification preference write at a time", async () => {
    const save = deferred();
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const path = String(url);
        if (path.endsWith("/notification-prefs") && options.method === "PUT") {
          return save.promise;
        }
        if (path.endsWith("/customer-a")) {
          return response(customerDetail("customer-a"));
        }
        return response({});
      }),
    );

    render(
      <Customer360ProfileV2
        customerId="customer-a"
        onClose={vi.fn()}
        initialTab="comms"
      />,
    );

    const appointment = await screen.findByRole("checkbox", {
      name: appointmentLabel,
    });
    const billingReport = screen.getByRole("checkbox", {
      name: billingReportLabel,
    });
    fireEvent.click(appointment);

    expect(appointment).toBeDisabled();
    expect(billingReport).toBeDisabled();
    fireEvent.click(billingReport);
    expect(
      fetch.mock.calls.filter(([url]) =>
        String(url).endsWith("/notification-prefs"),
      ),
    ).toHaveLength(1);

    await act(async () => {
      save.resolve(
        await response({
          notificationPrefs: { appointment_notify_primary: false },
        }),
      );
    });
    await waitFor(() => expect(appointment).toBeEnabled());
    expect(appointment).not.toBeChecked();
    expect(billingReport).not.toBeChecked();
  });

  it("freezes a billing recipient snapshot while saving and retains it after failure", async () => {
    const firstSave = deferred();
    const secondSave = deferred();
    let saveCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const path = String(url);
        if (path.endsWith("/notification-prefs") && options.method === "PUT") {
          saveCount += 1;
          return saveCount === 1 ? firstSave.promise : secondSave.promise;
        }
        if (path.endsWith("/customer-a")) {
          return response(
            customerDetail("customer-a", {
              billing_contact_name: "Old accounts",
              billing_email: "old@example.invalid",
            }),
          );
        }
        return response({});
      }),
    );

    render(
      <Customer360ProfileV2
        customerId="customer-a"
        onClose={vi.fn()}
        initialTab="comms"
      />,
    );

    const name = await screen.findByLabelText("Billing contact name");
    const email = screen.getByLabelText("Billing recipient email");
    fireEvent.change(name, { target: { value: "New accounts" } });
    fireEvent.change(email, { target: { value: "new@example.invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Save recipients" }));

    expect(name).toBeDisabled();
    expect(email).toBeDisabled();
    expect(
      JSON.parse(
        fetch.mock.calls.find(
          ([url]) => String(url).endsWith("/notification-prefs"),
        )[1].body,
      ),
    ).toEqual({
      billingContactName: "New accounts",
      billingEmail: "new@example.invalid",
    });

    await act(async () => {
      firstSave.resolve(
        await response({ error: "Synthetic recipient save failure" }, 503),
      );
    });
    expect(
      await screen.findByText("Synthetic recipient save failure"),
    ).toBeInTheDocument();
    expect(name).toBeEnabled();
    expect(email).toBeEnabled();
    expect(name).toHaveValue("New accounts");
    expect(email).toHaveValue("new@example.invalid");

    fireEvent.click(screen.getByRole("button", { name: "Save recipients" }));
    await act(async () => {
      secondSave.resolve(
        await response({
          notificationPrefs: {
            billing_contact_name: "New accounts",
            billing_email: "new@example.invalid",
          },
        }),
      );
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Recipients saved" }),
      ).toBeDisabled(),
    );
    expect(name).toHaveValue("New accounts");
    expect(email).toHaveValue("new@example.invalid");
  });

  it.each([false, true])("ignores an older customer's response while a new customer's save is pending (failed: %s)", async (failed) => {
    const saves = { "customer-a": deferred(), "customer-b": deferred() };
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const path = String(url);
        if (path.endsWith("/notification-prefs") && options.method === "PUT") {
          const id = path.includes("customer-a") ? "customer-a" : "customer-b";
          return saves[id].promise;
        }
        if (path.endsWith("/customer-a")) {
          return response(customerDetail("customer-a"));
        }
        if (path.endsWith("/customer-b")) {
          return response(
            customerDetail("customer-b", {
              service_report_notify_billing: true,
            }),
          );
        }
        return response({});
      }),
    );

    const view = render(
      <Customer360ProfileV2
        customerId="customer-a"
        onClose={vi.fn()}
        initialTab="comms"
      />,
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: appointmentLabel }),
    );

    view.rerender(
      <Customer360ProfileV2
        customerId="customer-b"
        onClose={vi.fn()}
        initialTab="comms"
      />,
    );
    await screen.findAllByText("Blair Customer");
    const billingReport = screen.getByRole("checkbox", {
      name: billingReportLabel,
    });
    expect(billingReport).toBeChecked();
    expect(billingReport).toBeEnabled();
    fireEvent.click(billingReport);
    expect(billingReport).toBeDisabled();

    await act(async () => {
      saves["customer-a"].resolve(
        await response(failed ? { error: "Old customer save failed" } : {
          notificationPrefs: {
            appointment_notify_primary: false,
            service_report_notify_billing: true,
          },
        }, failed ? 503 : 200),
      );
    });
    expect(billingReport).not.toBeChecked();
    expect(billingReport).toBeDisabled();
    expect(screen.queryByText("Old customer save failed")).not.toBeInTheDocument();

    await act(async () => {
      saves["customer-b"].resolve(
        await response({
          notificationPrefs: {
            appointment_notify_primary: true,
            service_report_notify_billing: false,
          },
        }),
      );
    });
    await waitFor(() => expect(billingReport).toBeEnabled());
    expect(billingReport).not.toBeChecked();
  });
});
