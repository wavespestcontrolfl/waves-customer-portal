// @vitest-environment jsdom
// The Insert Link sheet's search is a plain AND-match over name, url,
// keywords, and group label; grouping keeps the fixed group order and drops
// empty groups. These are the behaviors the composer relies on.
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import InsertLinkSheet, { buildLinkGroups, linkMatchesQuery } from "./InsertLinkSheet";

const LINKS = [
  { key: "reschedule", category: "customer", name: "Reschedule link", url: "", keywords: "appointment move visit", dynamic: true },
  { key: "g-sarasota", category: "reviews", name: "Google review — Sarasota", url: "g.page/r/abc/review", keywords: "google stars" },
  { key: "quote", category: "booking", name: "Free quote (60 seconds)", url: "wavespestcontrol.com/quote/", keywords: "estimate price" },
  { key: "site-roach", category: "website", name: "Cockroach Control — Sarasota FL", url: "wavespestcontrol.com/cockroach-control-sarasota-fl/", keywords: null },
];

describe("linkMatchesQuery", () => {
  it("empty query matches everything", () => {
    for (const link of LINKS) expect(linkMatchesQuery(link, "")).toBe(true);
  });

  it("matches on name, url, keywords, and group label, case-insensitively", () => {
    expect(linkMatchesQuery(LINKS[1], "GOOGLE")).toBe(true);
    expect(linkMatchesQuery(LINKS[3], "cockroach-control")).toBe(true);
    expect(linkMatchesQuery(LINKS[0], "appointment")).toBe(true);
    expect(linkMatchesQuery(LINKS[0], "customer")).toBe(true); // group label
  });

  it("requires every term to hit (AND, not OR)", () => {
    expect(linkMatchesQuery(LINKS[1], "google sarasota")).toBe(true);
    expect(linkMatchesQuery(LINKS[1], "google venice")).toBe(false);
  });
});

describe("buildLinkGroups", () => {
  it("groups in fixed order and drops empty groups", () => {
    const groups = buildLinkGroups(LINKS, "", "all");
    expect(groups.map((g) => g.key)).toEqual(["customer", "reviews", "booking", "website"]);
  });

  it("a query narrows rows across all groups", () => {
    const groups = buildLinkGroups(LINKS, "sarasota", "all");
    expect(groups.map((g) => g.key)).toEqual(["reviews", "website"]);
    expect(groups[0].rows).toHaveLength(1);
  });

  it("a category chip narrows to that group only", () => {
    const groups = buildLinkGroups(LINKS, "", "booking");
    expect(groups).toHaveLength(1);
    expect(groups[0].rows[0].key).toBe("quote");
  });

  it("no matches yields no groups", () => {
    expect(buildLinkGroups(LINKS, "zebra", "all")).toEqual([]);
  });
});

describe("InsertLinkSheet channel chooser", () => {
  afterEach(() => cleanup());

  const rows = [
    { key: "review_request", category: "customer", name: "Review request", url: "", keywords: "rate", dynamic: true, channels: true },
    { key: "referral", category: "customer", name: "Referral link", url: "", keywords: "refer", dynamic: true },
  ];

  it("is titled Quick Links and a plain row picks immediately", () => {
    const onPick = vi.fn();
    render(<InsertLinkSheet open onClose={() => {}} links={rows} onPick={onPick} />);
    expect(screen.getByText("Quick Links")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Referral link/ }));
    expect(onPick).toHaveBeenCalledWith(rows[1]);
  });

  it("a channels row opens Text / Email / Both and passes the choice to onPick", () => {
    const onPick = vi.fn();
    render(<InsertLinkSheet open onClose={() => {}} links={rows} onPick={onPick} />);
    const row = screen.getByRole("button", { name: /Review request/ });
    expect(screen.queryByRole("group", { name: /Send Review request by/ })).not.toBeInTheDocument();
    fireEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
    expect(row).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: /^Email/ }));
    expect(onPick).toHaveBeenCalledWith(rows[0], "email");
    fireEvent.click(screen.getByRole("button", { name: /^Both/ }));
    expect(onPick).toHaveBeenLastCalledWith(rows[0], "both");
    fireEvent.click(screen.getByRole("button", { name: /^Text/ }));
    expect(onPick).toHaveBeenLastCalledWith(rows[0], "sms");
  });
});
