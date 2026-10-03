// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import NamedSearchesTable, { describeChange, scannedText } from "./NamedSearchesTable";

function search(overrides = {}) {
  return {
    officeId: "sarasota",
    city: "Sarasota",
    keyword: "pest control",
    label: "Pest control in Sarasota",
    tracked: true,
    current: { scanDate: "2026-10-04", gridSize: 5, pins: 25, found: 25, position: 3.2, top3Pct: 60 },
    baseline: { scanDate: "2026-09-06", gridSize: 5, pins: 25, found: 25, position: 5.5, top3Pct: 40 },
    positionChange: 2.3,
    top3Change: 20,
    ...overrides,
  };
}

describe("NamedSearchesTable", () => {
  afterEach(cleanup);

  it("renders nothing until the scoreboard has loaded", () => {
    const { container } = render(<NamedSearchesTable data={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows position, top-3 share and the change since last month", () => {
    render(<NamedSearchesTable data={{ searches: [search()], weeklyScanBlockedBy: [] }} />);
    expect(screen.getByText("Pest control in Sarasota")).toBeInTheDocument();
    expect(screen.getByText("3.2")).toBeInTheDocument();
    expect(screen.getByText("60% of 25 points")).toBeInTheDocument();
    expect(screen.getByText("Up 2.3 since 9/6 (was 5.5)")).toBeInTheDocument();
    expect(screen.getByText("10/4")).toBeInTheDocument();
    expect(screen.queryByText(/weekly scan is off/)).not.toBeInTheDocument();
  });

  it("says the scan is off when nothing has been scanned and the gate is off", () => {
    render(
      <NamedSearchesTable
        data={{ searches: [search({ current: null, baseline: null, positionChange: null })], weeklyScanBlockedBy: ["GATE_GEO_GRID"] }}
      />,
    );
    expect(screen.getByText(/weekly scan is off \(it needs GATE_GEO_GRID\), so there is nothing to show yet/)).toBeInTheDocument();
    expect(screen.getByText("Not scanned yet")).toBeInTheDocument();
  });

  it("tells the office how to track a keyword the scan does not cover", () => {
    render(
      <NamedSearchesTable
        data={{
          searches: [search({ keyword: "lawn care", tracked: false, current: null, baseline: null, positionChange: null })],
          weeklyScanBlockedBy: [],
        }}
      />,
    );
    expect(screen.getByText('Not tracked: add "lawn care" under Edit keywords')).toBeInTheDocument();
  });
});

describe("describeChange", () => {
  it("covers every before and after state", () => {
    const none = { scanDate: "2026-09-06", position: null };
    const now = (position) => ({ scanDate: "2026-10-04", position });
    expect(describeChange(search({ baseline: null, positionChange: null })).text).toBe("No scan a month back yet");
    expect(describeChange(search({ positionChange: -1.5 })).text).toBe("Down 1.5 since 9/6 (was 5.5)");
    expect(describeChange(search({ positionChange: 0 })).text).toBe("No change since 9/6 (was 5.5)");
    expect(describeChange(search({ baseline: none, positionChange: null })).text).toBe("New in the pack since 9/6");
    expect(describeChange(search({ current: now(null), positionChange: null })).text).toBe("Dropped out of the pack since 9/6");
    expect(describeChange(search({ current: now(null), baseline: none, positionChange: null })).text).toBe("Still not in the pack since 9/6");
  });
});

describe("stale rows", () => {
  afterEach(cleanup);

  it("each row shows its own scan date, not one date for the table", () => {
    const older = search({
      officeId: "venice",
      label: "Pest control in Venice",
      current: { scanDate: "2026-09-20", gridSize: 5, pins: 25, found: 25, position: 6, top3Pct: 8 },
    });
    render(<NamedSearchesTable data={{ searches: [search(), older], weeklyScanBlockedBy: [] }} />);
    expect(screen.getByText("10/4")).toBeInTheDocument();
    expect(screen.getByText("9/20")).toBeInTheDocument();
  });

  it("a keyword removed from the scan keeps its numbers and says they will not update", () => {
    const row = search({ keyword: "lawn care", tracked: false });
    expect(scannedText(row)).toBe('10/4, no longer tracked: add "lawn care" under Edit keywords');
    render(<NamedSearchesTable data={{ searches: [row], weeklyScanBlockedBy: [] }} />);
    expect(screen.getByText("3.2")).toBeInTheDocument();
    expect(screen.getByText(/no longer tracked/)).toBeInTheDocument();
  });

  it("says the scan is off even when earlier scans are on the page", () => {
    render(
      <NamedSearchesTable
        data={{ searches: [search()], weeklyScanBlockedBy: ["GATE_SEO_INTELLIGENCE", "GATE_CRON_JOBS"] }}
      />,
    );
    expect(
      screen.getByText(/weekly scan is off \(it needs GATE_SEO_INTELLIGENCE and GATE_CRON_JOBS\), so these numbers will not update/),
    ).toBeInTheDocument();
  });
});
