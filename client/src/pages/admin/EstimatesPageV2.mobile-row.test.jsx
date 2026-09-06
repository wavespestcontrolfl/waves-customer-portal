// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileEstimateRow } from "./EstimatesPageV2";

const { openMessages } = vi.hoisted(() => ({ openMessages: vi.fn() }));
vi.mock("../../components/admin/customer360/CustomerSmsPanel", () => ({
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
    expect(screen.getByRole("button", { name: "Call via Waves" })).toBeInTheDocument();
    const message = screen.getByRole("button", { name: "SMS" });
    expect(message).toBeInTheDocument();
    fireEvent.click(message);
    await waitFor(() => expect(openMessages).toHaveBeenCalledWith({ id: "customer-1", firstName: "QA", lastName: "Current", phone: "+19415550199" }));
    expect(fetch).toHaveBeenCalledWith("/api/admin/customers/customer-1/estimates-summary", expect.any(Object));

    fireEvent.click(summary);
    expect(onOpenCustomerPanel).toHaveBeenCalledWith("customer-1");
  });

  it("renders the actions sheet above the persistent mobile navigation", () => {
    renderRow();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Ada Lovelace" }));

    // z-[120] is the modal stacking contract (see ui/Dialog.jsx) — above all
    // shell chrome (90–100) and the C360 estimates panel (110).
    expect(screen.getByRole("dialog")).toHaveClass("z-[120]");
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
