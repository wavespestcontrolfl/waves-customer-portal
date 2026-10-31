// @vitest-environment jsdom
// Latest communication card (tech portal gaps audit, fix 2): a non-admin never
// loads message history, so the card says it is admin-only instead of the
// retry hint, which cannot help.
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
  it("tells a non-admin the history is admin-only, with no retry hint", () => {
    renderSummary({ isAdmin: false, commsError: "Message history requires admin access" });

    expect(screen.getByText("Message history requires admin access.")).toBeInTheDocument();
    expect(screen.queryByText(/Communication history is unavailable/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open conversation" })).toBeInTheDocument();
  });

  it("keeps the retry hint for an admin whose history failed to load", () => {
    renderSummary({ isAdmin: true, commsError: "Network error" });

    expect(
      screen.getByText("Communication history is unavailable. Open the conversation to retry."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Message history requires admin access.")).not.toBeInTheDocument();
  });
});
