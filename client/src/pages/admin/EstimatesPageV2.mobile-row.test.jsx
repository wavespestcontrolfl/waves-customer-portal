// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcceptanceRecordDialog, MobileEstimateRow } from "./EstimatesPageV2";

const { openMessages } = vi.hoisted(() => ({ openMessages: vi.fn() }));
vi.mock("../../components/admin/customer360/CustomerSmsPanel", async (importOriginal) => ({
  ...await importOriginal(),
  useCustomerSms: () => openMessages,
  CustomerSmsProvider: ({ children }) => children,
}));

const ESTIMATE = {
  id: "estimate-1",
  token: "customer-link-token",
  status: "sent",
  customerId: "customer-1",
  customerName: "Ada Lovelace",
  customerPhone: "+19415550100",
  monthlyTotal: 189,
  createdAt: "2026-07-16T12:00:00.000Z",
  serviceLines: [],
};

function renderRow(props = {}) {
  return render(
    <MemoryRouter>
      <MobileEstimateRow estimate={ESTIMATE} {...props} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  openMessages.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ customer: { id: "customer-1", first_name: "QA", last_name: "Current", phone: "+19415550199" } }) })));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("MobileEstimateRow accessibility", () => {
  it("keeps the customer summary separate from the row action controls", async () => {
    const onOpenCustomerPanel = vi.fn();
    const { container } = renderRow({ onOpenCustomerPanel });
    const row = container.querySelector('[data-estimate-id="estimate-1"]');
    const summary = screen.getByRole("button", {
      name: "Open Ada Lovelace customer estimate history",
    });

    expect(row).not.toHaveAttribute("role");
    expect(row).not.toHaveAttribute("tabindex");
    expect(summary.querySelector("button, a")).toBeNull();
    const call = screen.getByRole("button", { name: "Call via Waves" });
    expect(call).toHaveClass("ui-icon-action");
    const message = screen.getByRole("button", { name: "SMS" });
    expect(message).toHaveClass("ui-icon-action");
    fireEvent.click(message);
    await waitFor(() => expect(openMessages).toHaveBeenCalledWith({ id: "customer-1", firstName: "QA", lastName: "Current", phone: "+19415550199" }));
    expect(fetch).toHaveBeenCalledWith("/api/admin/customers/customer-1/estimates-summary", expect.any(Object));

    fireEvent.click(summary);
    expect(onOpenCustomerPanel).toHaveBeenCalledWith("customer-1");
  });

  it("renders the actions sheet above the persistent mobile navigation", () => {
    renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Ada Lovelace" }));

    // The shared Dialog owns the layer as an inline value so callers cannot
    // accidentally let shell chrome (90–110) cover the action surface.
    expect(screen.getByRole("dialog")).toHaveStyle({ zIndex: "120" });
  });
  it("does not open the stale snapshot when live contact lookup fails", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    fetch.mockRejectedValue(new Error("Contact lookup unavailable"));
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "SMS" }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Contact lookup unavailable"));
    expect(openMessages).not.toHaveBeenCalled();
  });

});

describe("MobileEstimateRow per-application price and view actions", () => {
  const openActions = () =>
    fireEvent.click(screen.getByRole("button", { name: "Actions for Ada Lovelace" }));

  it("leads with the per-application price and keeps the monthly average secondary", () => {
    renderRow({
      estimate: { ...ESTIMATE, monthlyTotal: 31.33, perApplication: [{ label: "Pest Control", amount: 94, visitsPerYear: 4 }] },
    });
    expect(screen.getByText("$94 per application · 4 a year · $31/mo avg")).toBeInTheDocument();
  });

  it("keeps cents on a non-whole per-application price", () => {
    renderRow({
      estimate: { ...ESTIMATE, monthlyTotal: 42.3, perApplication: [{ label: "Lawn Care", amount: 56.4, visitsPerYear: 9 }] },
    });
    expect(screen.getByText(/^\$56\.40 per application/)).toBeInTheDocument();
  });

  it("lists each service for a multi-service plan beside the plan figure", () => {
    renderRow({
      estimate: {
        ...ESTIMATE,
        monthlyTotal: 72.3,
        perApplication: [
          { label: "Lawn Care", amount: 56.4, visitsPerYear: 9 },
          { label: "Pest Control", amount: 90, visitsPerYear: 4 },
        ],
      },
    });
    expect(
      screen.getByText("$72/mo · Lawn Care $56.40 per application · Pest Control $90 per application"),
    ).toBeInTheDocument();
  });

  it("falls back to today's display with no per-application lines", () => {
    renderRow();
    expect(screen.getByText("$189/mo")).toBeInTheDocument();
    expect(screen.queryByText(/per application/)).toBeNull();
  });

  it("offers View estimate on an unaccepted row and opens the staff preview link", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderRow();
    openActions();
    fireEvent.click(screen.getByRole("button", { name: /View estimate/ }));
    expect(open).toHaveBeenCalledWith("/estimate/customer-link-token?adminPreview=1", "_blank", "noopener,noreferrer");
    expect(screen.queryByText("Preview customer view")).toBeNull();
  });

  it("offers the accepted PDF and the acceptance record on an accepted row", () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const onViewAcceptance = vi.fn();
    const estimate = { ...ESTIMATE, status: "accepted", hasAcceptanceRecord: true };
    renderRow({ estimate, onViewAcceptance });
    openActions();
    expect(screen.queryByRole("button", { name: /^View estimate/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /View accepted estimate/ }));
    expect(open).toHaveBeenCalledWith("/api/estimates/customer-link-token/pdf", "_blank", "noopener,noreferrer");
    openActions();
    fireEvent.click(screen.getByRole("button", { name: /View acceptance record/ }));
    expect(onViewAcceptance).toHaveBeenCalledWith(estimate);
  });

  it("hides the acceptance record action when none is recorded (Mark won)", () => {
    renderRow({ estimate: { ...ESTIMATE, status: "accepted", hasAcceptanceRecord: false }, onViewAcceptance: vi.fn() });
    openActions();
    expect(screen.getByRole("button", { name: /View accepted estimate/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /View acceptance record/ })).toBeNull();
  });
});

describe("AcceptanceRecordDialog", () => {
  it("shows the recorded time, terms version, terms text and device", async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        acceptance: {
          recordId: "ACC-ABCDEF12", termsVersion: "v1", termsText: "Sample terms text.",
          acceptedAt: "2026-10-02T15:00:00.000Z", ipMasked: "203.0.x.x", device: "iPhone · Safari",
        },
      }),
    });
    render(<AcceptanceRecordDialog estimate={{ id: "estimate-1" }} onClose={() => {}} />);
    expect(await screen.findByText("Sample terms text.")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("iPhone · Safari")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("/api/admin/estimates/estimate-1/acceptance", expect.any(Object));
  });

  it("says so when the record cannot be loaded", async () => {
    fetch.mockResolvedValue({ ok: false, status: 404, clone: () => ({ json: async () => ({ error: "No acceptance record for this estimate" }) }), json: async () => ({}) });
    render(<AcceptanceRecordDialog estimate={{ id: "estimate-1" }} onClose={() => {}} />);
    expect(await screen.findByText("No acceptance record for this estimate")).toBeInTheDocument();
  });
});
