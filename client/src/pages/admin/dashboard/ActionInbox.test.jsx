// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import ActionInbox from "./ActionInbox";

const ALERTS = [
  {
    id: "ar_overdue",
    kind: "alert",
    severity: "warn",
    count: 5,
    label: "5 invoices overdue",
    href: "/admin/invoices",
    amount: 2410,
  },
  {
    id: "estimates_expiring",
    kind: "action",
    severity: "warn",
    count: 2,
    label: "2 open estimates expiring within 3 days",
    href: "/admin/estimates",
    amount: 3120,
  },
  {
    id: "leads_awaiting_contact",
    kind: "action",
    severity: "critical",
    count: 3,
    label: "3 leads waiting over 30m for first contact",
    href: "/admin/leads",
  },
];

describe("ActionInbox", () => {
  afterEach(cleanup);

  it("ranks critical before warn, and actions before alerts within a severity", () => {
    render(<ActionInbox alerts={ALERTS} />);
    const labels = screen
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(labels[0]).toContain("3 leads waiting over 30m");
    expect(labels[1]).toContain("2 open estimates expiring");
    expect(labels[2]).toContain("5 invoices overdue");
  });

  it("deep-links each item and shows the at-stake amount", () => {
    render(<ActionInbox alerts={ALERTS} />);
    const links = screen.getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/admin/leads",
      "/admin/estimates",
      "/admin/invoices",
    ]);
    // fmtMoneyCompact renders $3.1k for the expiring-estimates value.
    expect(screen.getByText("$3.1k")).toBeInTheDocument();
    expect(screen.getByText("1 critical")).toBeInTheDocument();
  });

  it("still renders alerts that predate the kind field (treated as watch-state)", () => {
    render(
      <ActionInbox
        alerts={[
          { id: "legacy", severity: "warn", label: "Legacy alert", href: "/x" },
          ALERTS[2],
        ]}
      />,
    );
    const labels = screen.getAllByRole("link").map((a) => a.textContent);
    // The critical action outranks the kind-less legacy row.
    expect(labels[0]).toContain("3 leads waiting");
    expect(labels[1]).toContain("Legacy alert");
  });

  it("shows the all-clear state on a clean day", () => {
    render(<ActionInbox alerts={[]} />);
    expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
    expect(screen.getByText(/All clear/)).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("never claims all-clear when alerts failed to load (null)", () => {
    render(<ActionInbox alerts={null} />);
    expect(
      screen.getByText(/Alerts couldn't be loaded/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/All clear/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Nothing needs you right now."),
    ).not.toBeInTheDocument();
  });

  it("never claims all-clear when the latest refresh failed and the kept value is empty", () => {
    render(<ActionInbox alerts={[]} stale />);
    expect(
      screen.getByText(/Alerts couldn't be refreshed/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/All clear/)).not.toBeInTheDocument();
    expect(
      screen.queryByText("Nothing needs you right now."),
    ).not.toBeInTheDocument();
  });

  it("keeps showing last-loaded items on a failed refresh, labeled stale", () => {
    render(
      <ActionInbox
        stale
        alerts={[
          { id: "a", kind: "action", severity: "warn", count: 1, label: "1 estimate expiring", href: "/admin/estimates" },
        ]}
      />,
    );
    expect(screen.getByRole("link")).toHaveTextContent("1 estimate expiring");
    expect(screen.getByText(/refresh failed, showing last loaded/)).toBeInTheDocument();
    expect(screen.queryByText(/All clear/)).not.toBeInTheDocument();
  });
});
