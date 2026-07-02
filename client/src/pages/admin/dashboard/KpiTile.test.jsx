// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KpiTile } from "./KpiTile";

afterEach(cleanup);

const HISTORY = {
  gross_margin: [
    { date: "2026-06-30", value: 38 },
    { date: "2026-07-01", value: 41 },
    { date: "2026-07-02", value: 42 },
  ],
};

describe("KpiTile target-store integration", () => {
  it("resolves the tone from the store row (red beyond the amber band)", () => {
    const { container } = render(
      <KpiTile
        label="Gross Margin"
        metricKey="gross_margin"
        targets={{ gross_margin: { target: 60, lowerIsBetter: false, amberBandPct: 5 } }}
        value="40%"
        chart={{ kind: "gauge", value: 40, max: 100 }}
      />,
    );
    // 40 vs target 60 (band 3) → bad → the ring strokes alert red.
    expect(container.innerHTML).toContain("#C8312F");
  });

  it("falls back to the built-in default target while the store is unfetched", () => {
    const { container } = render(
      <KpiTile
        label="Gross Margin"
        metricKey="gross_margin"
        targets={null}
        value="45%"
        chart={{ kind: "gauge", value: 45, max: 100 }}
      />,
    );
    // 45 ≥ default target 40 → good → emerald ring, no alert red.
    expect(container.innerHTML).toContain("#10B981");
    expect(container.innerHTML).not.toContain("#C8312F");
  });

  it("renders a sparkline from the metric's history series", () => {
    const { container } = render(
      <KpiTile
        label="Gross Margin"
        metricKey="gross_margin"
        targets={null}
        history={HISTORY}
        value="42%"
        chart={{ kind: "gauge", value: 42, max: 100 }}
      />,
    );
    expect(container.querySelector("polyline")).toBeTruthy();
  });

  it("small samples fade the tile, note the n, and never paint a verdict tone", () => {
    const { container } = render(
      <KpiTile
        label="Collection Rate"
        metricKey="collection_rate"
        targets={null}
        n={2}
        value="40%"
        sub="2 issued"
        chart={{ kind: "gauge", value: 40, max: 100 }}
      />,
    );
    // 40 < target 70 would be red — but n=2 is noise, not a verdict.
    expect(container.innerHTML).not.toContain("#C8312F");
    expect(container.firstChild.className).toContain("opacity-70");
    expect(screen.getByText(/n=2 — low sample/)).toBeInTheDocument();
  });

  it("keeps the caller-passed alert for tiles without a resolvable target", () => {
    render(
      <KpiTile
        label="Net MRR"
        metricKey="net_mrr"
        targets={null}
        value="−$120"
        alert
        chart={{ kind: "diverging", positive: 100, negative: 220 }}
      />,
    );
    expect(screen.getByText("−$120").className).toContain("text-alert-fg");
  });
});
