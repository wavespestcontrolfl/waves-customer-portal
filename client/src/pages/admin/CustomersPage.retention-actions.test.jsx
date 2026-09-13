// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CustomerIntelligenceTab } from "./CustomersPage";

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  }));
}

function summary(overrides = {}) {
  return {
    totalCustomers: 2,
    pendingOutreach: [
      { id: "sms-outreach", first_name: "Avery", last_name: "Customer", outreach_type: "sms", outreach_strategy: "service_check_in", message_content: "Synthetic SMS draft" },
      { id: "call-outreach", first_name: "Blair", last_name: "Customer", outreach_type: "call", outreach_strategy: "personal_call", message_content: "Synthetic call notes" },
    ],
    upsells: [
      { id: "upsell-one", first_name: "Casey", last_name: "Customer", waveguard_tier: "Silver", recommended_service: "mosquito_control", estimated_monthly_value: 20, confidence: 0.9 },
    ],
    upsellTotalMonthly: 20,
    ...overrides,
  };
}

function writesFor(pathPart) {
  return fetch.mock.calls.filter(
    ([url, options = {}]) =>
      String(url).includes(pathPart) && options.method && options.method !== "GET",
  );
}

async function openTab() {
  render(<CustomerIntelligenceTab />);
  return screen.findByRole("button", { name: "Run Scan Now" });
}

describe("CustomerIntelligenceTab retention actions", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("waves_admin_token", "test-token");
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("single-flights scan, approve, skip, and upsell submissions", async () => {
    const pending = {
      scan: deferred(),
      approve: deferred(),
      skip: deferred(),
      upsell: deferred(),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const path = String(url);
        if (!options.method) return response(summary());
        if (path.endsWith("/scan")) return pending.scan.promise;
        if (path.endsWith("/sms-outreach/approve")) return pending.approve.promise;
        if (path.endsWith("/call-outreach/skip")) return pending.skip.promise;
        if (path.endsWith("/upsell-one")) return pending.upsell.promise;
        return response({});
      }),
    );
    const scan = await openTab();
    const approve = screen.getByRole("button", { name: "Yes Approve & Send" });
    const skip = screen.getAllByRole("button", { name: "Skip" })[1];
    const pitch = screen.getByRole("button", { name: "Pitch" });
    [scan, approve, skip, pitch].forEach((button) => {
      fireEvent.click(button);
      fireEvent.click(button);
      expect(button).toBeDisabled();
    });

    expect(writesFor("/scan")).toHaveLength(1);
    expect(writesFor("/sms-outreach/approve")).toHaveLength(1);
    expect(writesFor("/call-outreach/skip")).toHaveLength(1);
    expect(writesFor("/upsell-one")).toHaveLength(1);
  });

  it.each([
    ["sms", "sent", "Yes Approve & Send", "Retention SMS sent."],
    ["sms", "blocked", "Yes Approve & Send", "Retention SMS was blocked and was not sent."],
    ["sms", "approved", "Yes Approve & Send", "Retention SMS approval is recorded; delivery is not confirmed."],
    ["call", "approved", "Yes Approve & Call", "Call outreach approved for manual follow-up."],
  ])("reports a %s approval result of %s accurately", async (type, status, buttonName, message) => {
    let summaryReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const path = String(url);
        if (path.endsWith(`/${type}-outreach/approve`) && options.method === "PUT") {
          return response({ outreach: { id: `${type}-outreach`, outreach_type: type, status } });
        }
        if (!options.method) {
          summaryReads += 1;
          return response(
            summaryReads === 1
              ? summary()
              : summary({ pendingOutreach: [] }),
          );
        }
        return response({});
      }),
    );
    await openTab();
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    expect(await screen.findByText(message)).toHaveAttribute("role", "status");
    expect(screen.queryByText(/Retention SMS sent\./)).toBe(
      status === "sent" ? screen.getByText(message) : null,
    );
  });

  it.each(["approve", "scan"])("retries only the summary GET after a successful %s whose refresh fails", async (action) => {
    let summaryReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const path = String(url);
        if (path.endsWith("/sms-outreach/approve") && options.method === "PUT") {
          return response({ outreach: { id: "sms-outreach", outreach_type: "sms", status: "sent" } });
        }
        if (path.endsWith("/scan") && options.method === "POST") return response({ scanned: true });
        if (!options.method) {
          summaryReads += 1;
          if (summaryReads === 1) return response(summary());
          if (summaryReads === 2) {
            return response({ error: "Refresh unavailable" }, 503);
          }
          return response(summary({ pendingOutreach: [] }));
        }
        return response({});
      }),
    );
    await openTab();
    fireEvent.click(screen.getByRole("button", {
      name: action === "approve" ? "Yes Approve & Send" : "Run Scan Now",
    }));

    expect(
      await screen.findByText(/Latest results could not be refreshed/i),
    ).toHaveAttribute("role", "status");
    if (action === "approve") {
      expect(screen.queryByText("Synthetic SMS draft")).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", {
      name: action === "approve" ? "Retry results" : "Retry scan results",
    }));
    await waitFor(() => expect(summaryReads).toBe(3));
    expect(writesFor(action === "approve" ? "/sms-outreach/approve" : "/scan")).toHaveLength(1);
  });

  it("checks current status before allowing an ambiguous approval retry", async () => {
    let summaryReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) => {
        const path = String(url);
        if (path.endsWith("/sms-outreach/approve") && options.method === "PUT") {
          return response({ error: "Approval response unavailable" }, 503);
        }
        if (!options.method) {
          summaryReads += 1;
          return response(summary());
        }
        return response({});
      }),
    );
    await openTab();
    fireEvent.click(screen.getByRole("button", { name: "Yes Approve & Send" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/refresh current status before trying again/i);
    const smsRow = screen.getByText(/Synthetic SMS draft/).parentElement;
    expect(within(smsRow).getByRole("button", { name: "Skip" })).toBeDisabled();
    fireEvent.click(within(smsRow).getByRole("button", { name: "Check status" }));
    await waitFor(() =>
      expect(
        within(smsRow).getByRole("button", { name: "Yes Approve & Send" }),
      ).toBeEnabled(),
    );
    expect(summaryReads).toBe(2);
    expect(writesFor("/sms-outreach/approve")).toHaveLength(1);
  });

  it.each([
    ["scan", "/scan", "Customer intelligence scan failed. Try again."],
    ["skip", "/sms-outreach/skip", "Retention outreach could not be skipped. Try again."],
    ["upsell", "/upsell-one", "Upsell status could not be updated. Try again."],
  ])("re-enables the %s control after a definite failure", async (kind, pathPart, message) => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options = {}) =>
        options.method
          ? response({ error: "Synthetic failure" }, 503)
          : response(summary()),
      ),
    );
    await openTab();
    const button =
      kind === "scan"
        ? screen.getByRole("button", { name: "Run Scan Now" })
        : kind === "skip"
          ? screen.getAllByRole("button", { name: "Skip" })[0]
          : screen.getByRole("button", { name: "Pitch" });
    fireEvent.click(button);
    expect(await screen.findByText(message)).toHaveAttribute("role", "alert");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(writesFor(pathPart)).toHaveLength(2));
  });

  it("keeps approve and skip unavailable to technicians", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "technician" }));
    vi.stubGlobal("fetch", vi.fn(() => response(summary())));
    await openTab();
    expect(
      screen.getByRole("button", { name: "Yes Approve & Send" }),
    ).toBeDisabled();
    screen.getAllByRole("button", { name: "Skip" }).forEach((button) =>
      expect(button).toBeDisabled(),
    );
  });
});
