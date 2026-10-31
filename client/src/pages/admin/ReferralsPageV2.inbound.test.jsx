// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import ReferralsPageV2 from "./ReferralsPageV2";

const FRIEND = "00000000-0000-4000-8000-000000000021";
const REFERRER = "00000000-0000-4000-8000-000000000022";
const OTHER = "00000000-0000-4000-8000-000000000023";
const item = {
  customerId: FRIEND,
  name: "Fixture Friend",
  phone: "+19415550121",
  city: "Parrish",
  createdAt: "2026-10-09T12:00:00Z",
  plan: { tier: "Silver", monthlyRate: 119.1 },
  creditsNow: true,
  evidence: { source: "link", code: "WAVES-FIXT", spokenName: null },
  selfReferral: false,
  suggestions: [
    { customerId: REFERRER, name: "Fixture Referrer", city: "Parrish", phone: "+19415550122", onPlan: true, exact: true, viaCode: true },
  ],
};
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

let inboundBody;
let confirmResponse;
beforeEach(() => {
  inboundBody = { enabled: true, items: [item] };
  confirmResponse = () => response({ success: true, converted: true, creditsNow: true, credited: { referrerDollars: 25, refereeDollars: 25 }, error: null });
  localStorage.setItem("waves_admin_token", "fixture-token");
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === "/api/admin/referrals/stats") return response({}, 500);
    if (url === "/api/admin/referrals/promoters?status=all") return response({ promoters: [] });
    if (url === "/api/admin/referrals/queue") return response({ referrals: [] });
    if (url === "/api/admin/referrals/payouts") return response({ payouts: [] });
    if (url === "/api/admin/referrals/inbound") return response(inboundBody);
    if (url === `/api/admin/referrals/inbound/${FRIEND}/confirm`) return confirmResponse();
    // The customer list API answers camelCase names (mapCustomerListRow).
    if (url.startsWith("/api/admin/customers?search=")) {
      return response({ customers: [{ id: OTHER, firstName: "Searched", lastName: "Neighbor", phone: "+19415550123", city: "Venice" }] });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const confirms = () => fetch.mock.calls.filter(([url]) => url.endsWith("/confirm"));

const renderPage = (entry = "/admin/referrals") =>
  render(<MemoryRouter initialEntries={[entry]}><ReferralsPageV2 /></MemoryRouter>);

async function openQueue(label) {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: label }));
}

describe("Referrals queue: inbound referrals (GATE_REFERRAL_INBOUND_CONFIRM)", () => {
  it("confirms the code owner after one choice, and says the credits post now with no text", async () => {
    await openQueue(/Queue \(1\)/);
    expect(screen.getByText("Needs confirmation (1)")).toBeInTheDocument();
    expect(screen.getByText("Came in through referral link WAVES-FIXT")).toBeInTheDocument();
    expect(screen.getByText(/plan visit done/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(confirms()).toHaveLength(0);
    expect(screen.getByText(/Confirm Fixture Referrer as the referrer\. Both accounts get the \$25 credit now\. The referrer gets one thank-you email at the next 9:00 AM ET, and no text\. A referrer's 3rd, 5th or 10th referral also sends the usual milestone text\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Referral confirmed. $25 credited to both accounts.")).toBeInTheDocument();
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0][1].method).toBe("POST");
    expect(JSON.parse(confirms()[0][1].body)).toEqual({ referrerCustomerId: REFERRER });
    expect(confirms()[0][1].headers.Authorization).toBe("Bearer fixture-token");
  });

  it("with no completed plan visit, says the credits wait for the next one", async () => {
    inboundBody = { enabled: true, items: [{ ...item, creditsNow: false }] };
    await openQueue(/Queue \(1\)/);
    expect(screen.getByText(/no completed plan visit yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(screen.getByText(/Both accounts get the \$25 credit at Fixture's next completed plan visit\. The referrer then gets one thank-you email at the next 9:00 AM ET, and no text\./)).toBeInTheDocument();
  });

  it("a referrer found by search is named in the confirm line and posted by id", async () => {
    await openQueue(/Queue \(1\)/);
    fireEvent.change(screen.getByPlaceholderText("Find the referrer by name or phone"), { target: { value: "Neigh" } });
    expect(await screen.findByText("Searched Neighbor")).toBeInTheDocument();
    const chooseButtons = screen.getAllByRole("button", { name: "Choose" });
    fireEvent.click(chooseButtons[chooseButtons.length - 1]);
    expect(screen.getByText(/Confirm Searched Neighbor as the referrer\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await screen.findByText("Referral confirmed. $25 credited to both accounts.");
    expect(JSON.parse(confirms()[0][1].body)).toEqual({ referrerCustomerId: OTHER });
  });

  it("shows the server's reason when a confirm is refused", async () => {
    confirmResponse = () => response({ error: "A referral already names this customer", code: "ALREADY_REFERRED" }, 409);
    await openQueue(/Queue \(1\)/);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Error: A referral already names this customer")).toBeInTheDocument();
  });

  it("opens the Queue tab straight from ?tab=queue", async () => {
    renderPage("/admin/referrals?tab=queue");
    expect(await screen.findByText("Needs confirmation (1)")).toBeInTheDocument();
  });

  it("ignores an unknown ?tab= value and opens the Dashboard", async () => {
    renderPage("/admin/referrals?tab=constructor");
    await screen.findByRole("button", { name: /Queue \(1\)/ });
    expect(screen.queryByText("Needs confirmation (1)")).not.toBeInTheDocument();
  });

  it("gate off: no section and no count", async () => {
    inboundBody = { enabled: false, items: [] };
    await openQueue(/Queue \(0\)/);
    expect(screen.queryByText(/Needs confirmation/)).not.toBeInTheDocument();
  });
});
