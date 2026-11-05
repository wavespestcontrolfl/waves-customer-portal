// @vitest-environment jsdom
// Latest communication card: a technician's thread loads from the SMS log (its own customers only), so the card
// shows the latest text like an admin's. Access notes: a technician is pointed to the visit card.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Customer360Summary from "./Customer360Summary";

afterEach(cleanup);

function renderSummary(props) {
  return render(
    <Customer360Summary
      isAdmin={false}
      customer={{ id: "customer-a", phone: "+19415550100" }}
      upcoming={[]}
      services={[]}
      comms={[]}
      commsLoading={false}
      commsError={null}
      balance={null}
      unread={0}
      preferences={{}}
      alerts={[]}
      onMessage={vi.fn()}
      onTab={vi.fn()}
      onViewServices={vi.fn()}
      discounts={[]}
      referral={null}
      {...props}
    />,
  );
}

describe("Customer360Summary latest communication", () => {
  it("shows a non-admin the latest text, as the technician thread now loads", () => {
    renderSummary({
      isAdmin: false,
      comms: [{ id: "m1", channel: "sms", direction: "inbound", body: "Gate is open", createdAt: "2026-11-03T15:00:00Z" }],
    });

    expect(screen.queryByText("Message history requires admin access.")).not.toBeInTheDocument();
    expect(screen.getByText("Gate is open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open conversation" })).toBeInTheDocument();
  });

  it("keeps the retry hint for an admin whose history failed to load", () => {
    renderSummary({ isAdmin: true, commsError: "Network error" });

    expect(
      screen.getByText("Communication history is unavailable. Open the conversation to retry."),
    ).toBeInTheDocument();
  });
});

describe("Customer360Summary access notes", () => {
  it("points a technician to the visit card instead of claiming no instructions exist", () => {
    renderSummary({ isAdmin: false });

    expect(screen.queryByText("No access instructions recorded.")).not.toBeInTheDocument();
    expect(screen.getByText(/show on the visit card on the day of service/)).toBeInTheDocument();
  });

  it("keeps the empty-state line for an admin", () => {
    renderSummary({ isAdmin: true });

    expect(screen.getByText("No access instructions recorded.")).toBeInTheDocument();
  });
});
