// @vitest-environment jsdom
// B10: charge-card goes past a collections dispute hold, so the sheet shows
// the hold (or a failed check) beside its Charge buttons.

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import MobileCardOnFileSheet from "./MobileCardOnFileSheet";
import { UiSurface } from "../ui";

const cards = [{ id: "pm-1", method_type: "card", brand: "visa", last_four: "1111" }];
const json = (body, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

function install(holdsReply) {
  const fetchMock = vi.fn((url) => {
    const u = String(url);
    if (u.endsWith("/admin/customers/cust-1/cards")) return json({ cards });
    if (u.endsWith("/admin/customers/cust-1/collection-holds")) return holdsReply();
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe.each(["legacy", "admin"])("MobileCardOnFileSheet collections hold (%s)", (presentation) => {
  const renderSheet = () =>
    render(
      <UiSurface density={presentation === "admin" ? "comfortable" : "legacy"}>
        <MobileCardOnFileSheet presentation={presentation} desktopVisible invoiceId="inv-1" customerId="cust-1" customerName="Test Customer" />
      </UiSurface>,
    );

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("waves_admin_token", "test-token");
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("warns beside the Charge buttons when the customer has a dispute hold", async () => {
    install(() => json({ holds: [{ id: "hold-1", stops_charges: true, reason: "dispute: synthetic" }] }));
    renderSheet();
    await screen.findByText("Visa 1111");
    expect(await screen.findByText(/A charge you make here goes past the hold/i)).toBeInTheDocument();
  });

  it("says the hold could not be checked when the read fails", async () => {
    install(() => json({ error: "boom" }, 500));
    renderSheet();
    await screen.findByText("Visa 1111");
    expect(await screen.findByText(/Couldn't check for a billing hold — reload before charging/i)).toBeInTheDocument();
  });

  it("shows nothing for a customer with no hold, and never reads holds for a non-admin", async () => {
    const fetchMock = install(() => json({ holds: [] }));
    const { unmount } = renderSheet();
    await screen.findByText("Visa 1111");
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/collection-holds"))).toBe(true));
    expect(screen.queryByText(/goes past the hold/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn't check/i)).not.toBeInTheDocument();
    unmount();

    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "technician" }));
    const techFetch = install(() => json({ holds: [{ id: "h", stops_charges: true }] }));
    renderSheet();
    await screen.findByText("Visa 1111");
    expect(techFetch.mock.calls.some(([u]) => String(u).endsWith("/collection-holds"))).toBe(false);
  });
});
