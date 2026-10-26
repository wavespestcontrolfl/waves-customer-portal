// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ReferralsPageV2 from "./ReferralsPageV2";

const FRIEND = "00000000-0000-4000-8000-000000000021";
const REFERRER = "00000000-0000-4000-8000-000000000022";
const item = {
  customerId: FRIEND,
  name: "Fixture Friend",
  phone: "+19415550121",
  city: "Parrish",
  createdAt: "2026-10-09T12:00:00Z",
  plan: { tier: "Silver", monthlyRate: 119.1 },
  firstVisitDone: true,
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
  confirmResponse = () => response({ success: true, converted: true, firstVisitDone: true, credited: { referrerDollars: 25, refereeDollars: 25 }, error: null });
  localStorage.setItem("waves_admin_token", "fixture-token");
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === "/api/admin/referrals/stats") return response({}, 500);
    if (url === "/api/admin/referrals/promoters?status=all") return response({ promoters: [] });
    if (url === "/api/admin/referrals/queue") return response({ referrals: [] });
    if (url === "/api/admin/referrals/payouts") return response({ payouts: [] });
    if (url === "/api/admin/referrals/inbound") return response(inboundBody);
    if (url === `/api/admin/referrals/inbound/${FRIEND}/confirm`) return confirmResponse();
    throw new Error(`Unexpected fixture request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const confirms = () => fetch.mock.calls.filter(([url]) => url.endsWith("/confirm"));

async function openQueue(label) {
  render(<ReferralsPageV2 />);
  fireEvent.click(await screen.findByRole("button", { name: label }));
}

describe("Referrals queue: inbound referrals (GATE_REFERRAL_INBOUND_CONFIRM)", () => {
  it("confirms the code owner after one choice, and says the credits post now with no text", async () => {
    await openQueue(/Queue \(1\)/);
    expect(screen.getByText("Needs confirmation (1)")).toBeInTheDocument();
    expect(screen.getByText("Came in through referral link WAVES-FIXT")).toBeInTheDocument();
    expect(screen.getByText(/first plan visit done/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(confirms()).toHaveLength(0);
    expect(screen.getByText(/Confirm Fixture Referrer as the referrer\. Both accounts get the \$25 credit now\. No text or email goes out\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Referral confirmed. $25 credited to both accounts.")).toBeInTheDocument();
    expect(confirms()).toHaveLength(1);
    expect(confirms()[0][1].method).toBe("POST");
    expect(JSON.parse(confirms()[0][1].body)).toEqual({ referrerCustomerId: REFERRER });
    expect(confirms()[0][1].headers.Authorization).toBe("Bearer fixture-token");
  });

  it("before the first plan visit, says the credits wait for that visit", async () => {
    inboundBody = { enabled: true, items: [{ ...item, firstVisitDone: false }] };
    await openQueue(/Queue \(1\)/);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(screen.getByText(/Both accounts get the \$25 credit after Fixture's first plan visit\./)).toBeInTheDocument();
  });

  it("shows the server's reason when a confirm is refused", async () => {
    confirmResponse = () => response({ error: "A referral already names this customer", code: "ALREADY_REFERRED" }, 409);
    await openQueue(/Queue \(1\)/);
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Error: A referral already names this customer")).toBeInTheDocument();
  });

  it("gate off: no section and no count", async () => {
    inboundBody = { enabled: false, items: [] };
    await openQueue(/Queue \(0\)/);
    expect(screen.queryByText(/Needs confirmation/)).not.toBeInTheDocument();
  });
});
