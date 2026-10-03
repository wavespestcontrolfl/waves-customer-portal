// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReviewDraftsPanel from "./ReviewDraftsPanel";

const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Tech-voice review texts panel", () => {
  it("shows each draft with the record lines behind it, held repeats, fallbacks and payment holds", async () => {
    const fetch = vi.fn(async () => response({
      days: 14,
      truncated: true,
      drafts: [
        {
          id: 1, customerName: "Marta R", step: 0, channel: "sms", outcome: "drafted", reason: null,
          body: "It's Adam. I flagged moisture under the sink. A Google review helps: {review_url}",
          sentences: [
            { sentence: "I flagged moisture under the sink.", quotes: ["Moisture under the sink"], ask_only: false, greeting_only: false },
            { sentence: "A Google review helps: {review_url}", quotes: [], ask_only: true, greeting_only: false },
          ],
          repeat: null, technicianName: "Adam", serviceType: "Pest Control", serviceDate: "2026-10-01",
          createdAt: "2026-10-02T15:00:00Z", sentAt: "2026-10-02T15:05:00Z",
        },
        {
          id: 2, customerName: "Lee K", step: 1, channel: "sms", outcome: "held", reason: "repeat", body: "How are the ants?",
          sentences: [], repeat: { sentence: "How are the ants?", earlierQuote: "How are the ants doing", earlierStep: 0 },
          createdAt: "2026-10-02T16:00:00Z", sentAt: null,
        },
        { id: 4, customerName: "Drop D", step: 2, channel: "email", outcome: "held", reason: "payment_hold_dropped", body: null, sentences: [], repeat: null, hold: { hold: "overdue_invoice", heldSince: "2026-10-01T14:00:00Z" }, createdAt: "2026-10-04T14:00:00Z", sentAt: null },
        { id: 3, customerName: "Ana P", step: 1, channel: "sms", outcome: "fallback", reason: "fact_check_unavailable", body: null, sentences: [], repeat: null, createdAt: "2026-10-02T17:00:00Z" },
      ],
      paymentHolds: [
        { sequenceId: "s-8", customerName: "Email Hold", step: 2, channel: "email", reason: "payment_hold", nextEvalAt: "2026-10-03T14:00:00Z", detail: { hold: "payment_reminder_recent" } },
        { sequenceId: "s-9", customerName: "Rosa M", step: 1, channel: "sms", reason: "payment_hold", nextEvalAt: "2026-10-03T14:00:00Z", detail: { hold: "overdue_invoice", heldSince: "2026-10-02T14:00:00Z" } },
      ],
    }));
    vi.stubGlobal("fetch", fetch);
    render(<ReviewDraftsPanel />);
    expect(await screen.findByText("Marta R")).toBeInTheDocument();
    expect(fetch.mock.calls[0][0]).toContain("/admin/review-requests/tech-voice-drafts?days=14");
    expect(screen.getByText(/I flagged moisture under the sink\. A Google review helps: \[review link\]/)).toBeInTheDocument();
    expect(screen.getByText(/from the record: "Moisture under the sink"/)).toBeInTheDocument();
    expect(screen.getByText(/the review request/)).toBeInTheDocument();
    expect(screen.getByText(/repeats text 1: .How are the ants doing./)).toBeInTheDocument();
    expect(screen.getByText(/this step uses the fixed text: the fact check could not be reached\./)).toBeInTheDocument();
    expect(screen.getByText(/Drafted .* · sent /)).toBeInTheDocument();
    expect(screen.getAllByText(/not sent yet/)).toHaveLength(1);
    expect(screen.getByText("Held for payment")).toBeInTheDocument();
    expect(screen.getByText(/overdue bill since/)).toBeInTheDocument();
    expect(screen.getByText(/· email 3 ·/)).toBeInTheDocument();
    expect(screen.getByText(/· text 2 ·/)).toBeInTheDocument();
    // a dropped payment hold stays listed with what it saw
    expect(screen.getByText("Dropped: payment hold")).toBeInTheDocument();
    expect(screen.getByText(/the payment hold \(overdue bill\) outlasted its 3-day window/)).toBeInTheDocument();
    // more texts than are listed is said so
    expect(screen.getByText(/Showing the newest 4 in this window/)).toBeInTheDocument();
  });

  it("says when nothing has been drafted yet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ days: 14, drafts: [], paymentHolds: [] })));
    render(<ReviewDraftsPanel />);
    expect(await screen.findByText(/once the technician's-voice switch/)).toBeInTheDocument();
  });
});
