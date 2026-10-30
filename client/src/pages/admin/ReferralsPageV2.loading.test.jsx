// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import ReferralsPageV2 from "./ReferralsPageV2";

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const promoter = (n) => ({
  id: n, first_name: "Example", last_name: `Promoter ${n}`, customer_phone: "+19415550199",
  referral_code: `EX${n}`, total_referrals_converted: 0, total_referrals_sent: 0,
});

let failing;
let promoterCalls;
beforeEach(() => {
  failing = new Set();
  promoterCalls = [];
  localStorage.setItem("waves_admin_token", "fixture-token");
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const u = new URL(url, "http://x");
    const key = u.pathname.replace("/api/admin/referrals/", "");
    if (failing.has(key)) return response({ error: "down" }, 503);
    if (key === "stats") return response({ activePromoters: 0, totalReferrals: 0, convertedReferrals: 0, pendingReferrals: 0, totalRewardsDollars: 0, totalPaidOutCents: 0, pendingPayouts: 0, programROI: 0 });
    if (key === "promoters") {
      promoterCalls.push(u.search);
      if (u.searchParams.get("search") === "Promoter 60") return response({ promoters: [promoter(60)], hasMore: false });
      if (u.searchParams.get("page") === "2") return response({ promoters: [promoter(51)], hasMore: false });
      return response({ promoters: [promoter(1)], hasMore: true });
    }
    if (key === "queue") return response({ referrals: [] });
    if (key === "payouts") return response({ payouts: [] });
    if (key === "inbound") return response({ enabled: false, items: [] });
    throw new Error(`Unexpected fixture request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const renderPage = () => render(<MemoryRouter><ReferralsPageV2 /></MemoryRouter>);

describe("Referrals page: failed reads are not empty lists", () => {
  it("shows an error with Retry for the queue and payouts, never the empty text", async () => {
    failing.add("queue");
    failing.add("payouts");
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Queue" }, { timeout: 15000 }));
    expect(await screen.findByText(/Could not load the referral queue/)).toBeInTheDocument();
    expect(screen.queryByText("No pending referrals")).toBeNull();
    failing.delete("queue");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("No pending referrals")).toBeInTheDocument();
  }, 30000);

  it("a failed inbound read shows an error, not a hidden inbound section", async () => {
    failing.add("inbound");
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Queue" }, { timeout: 15000 }));
    expect(await screen.findByText(/Could not load inbound referrals/)).toBeInTheDocument();
  }, 30000);
});

describe("Referrals page: promoters past the first page", () => {
  it("search asks the server, and Load more fetches the next page", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /^Queue \(/ }, { timeout: 15000 }));
    fireEvent.click(screen.getByRole("button", { name: "Promoters" }));
    expect(await screen.findByText("Example Promoter 1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Example Promoter 51")).toBeInTheDocument();
    expect(promoterCalls.at(-1)).toContain("page=2");
    fireEvent.change(screen.getByPlaceholderText("Search promoters..."), { target: { value: "Promoter 60" } });
    await waitFor(() => expect(screen.getByText("Example Promoter 60")).toBeInTheDocument(), { timeout: 3000 });
    expect(promoterCalls.at(-1)).toContain("search=Promoter+60");
  }, 30000);
});
