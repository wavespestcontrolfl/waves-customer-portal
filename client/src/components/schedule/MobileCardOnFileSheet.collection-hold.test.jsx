// @vitest-environment jsdom
// B10: charge-card goes past a collections dispute hold, so the sheet shows
// the hold (or a failed check) beside its Charge buttons.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  const chargeButton = () => screen.getByRole("button", { name: presentation === "admin" ? /Charge Visa 1111/i : /^Charge$/ });
  const chargeCalls = (fetchMock) =>
    fetchMock.mock.calls.filter(([u]) => /charge-card/.test(String(u)));

  it("keeps Charge disabled while the hold read is loading, then enables it", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetchMock = install(() => gate.then(() => json({ holds: [] })));
    renderSheet();
    await screen.findByText("Visa 1111");
    expect(chargeButton()).toBeDisabled();
    fireEvent.click(chargeButton());
    expect(chargeCalls(fetchMock)).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(chargeButton()).not.toBeDisabled());
  });

  it("keeps Charge disabled when the hold read fails, and Retry re-reads and enables it", async () => {
    let attempt = 0;
    const fetchMock = install(() => (++attempt === 1 ? json({ error: "boom" }, 500) : json({ holds: [] })));
    renderSheet();
    await screen.findByText("Visa 1111");
    await screen.findByText(/Couldn't check for a billing hold/i);
    expect(chargeButton()).toBeDisabled();
    fireEvent.click(chargeButton());
    expect(chargeCalls(fetchMock)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));
    await vi.waitFor(() => expect(chargeButton()).not.toBeDisabled());
    expect(screen.queryByText(/Couldn't check for a billing hold/i)).not.toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("charges in one tap once a hold is known (warning shown, no confirm step)", async () => {
    const fetchMock = install(() => json({ holds: [{ id: "hold-1", stops_charges: true }] }));
    renderSheet();
    await screen.findByText(/A charge you make here goes past the hold/i);
    await vi.waitFor(() => expect(chargeButton()).not.toBeDisabled());
    fireEvent.click(chargeButton());
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u]) => /charge-card-quote/.test(String(u)))).toBe(true));
  });

  it("does not lock a non-admin out: no hold read, Charge stays enabled", async () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "technician" }));
    install(() => json({ holds: [] }));
    renderSheet();
    await screen.findByText("Visa 1111");
    expect(chargeButton()).not.toBeDisabled();
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
