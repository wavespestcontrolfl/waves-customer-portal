// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KpiGrid, KpiTile } from "./KpiTile";

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
    // 40 < target 70 would be red — but n=2 is noise, not a verdict. The
    // ring must stay neutral too: the target is withheld from it, so a few
    // favorable samples can't paint a green "meets target" either.
    expect(container.innerHTML).not.toContain("#C8312F");
    expect(container.innerHTML).not.toContain("#10B981");
    expect(container.firstChild.className).toContain("opacity-70");
    expect(screen.getByText(/n=2 — low sample/)).toBeInTheDocument();
  });

  it("a MET target shows green on the number for tiles with no ring/bar to carry it", () => {
    render(
      <KpiTile
        label="Revenue / Job"
        metricKey="revenue_per_job"
        metricValue={130}
        targets={{ revenue_per_job: { target: 100, lowerIsBetter: false, amberBandPct: 10 } }}
        value="$130.00"
      />,
    );
    expect(screen.getByText("$130.00").className).toContain("text-emerald-600");
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

  it("metricValue lets diverging/no-chart tiles honor an owner-set target", () => {
    // Diverging charts carry only positive/negative — without metricValue an
    // owner target for net_mrr would silently never tone the tile.
    render(
      <KpiTile
        label="Net MRR"
        metricKey="net_mrr"
        metricValue={-120}
        targets={{ net_mrr: { target: 500, lowerIsBetter: false, amberBandPct: 10 } }}
        value="−$120"
        chart={{ kind: "diverging", positive: 100, negative: 220 }}
      />,
    );
    expect(screen.getByText("−$120").className).toContain("text-alert-fg");
  });

  it("a near-miss shows amber on the number for tiles with no ring/bar to carry it", () => {
    render(
      <KpiTile
        label="Revenue / Job"
        metricKey="revenue_per_job"
        metricValue={96}
        targets={{ revenue_per_job: { target: 100, lowerIsBetter: false, amberBandPct: 10 } }}
        value="$96.00"
      />,
    );
    const num = screen.getByText("$96.00");
    expect(num.className).toContain("text-amber-600");
    expect(num.className).not.toContain("text-alert-fg");
  });
});

// jsdom has no layout, so these pin the classes that carry the narrow-pane
// fix (audit D01); the browser geometry check is the audit's reproduce runner.
describe("KpiTile layout on narrow panes", () => {
  it("keeps the default strip at two columns until lg and stretches an odd last tile", () => {
    const { container } = render(<KpiGrid><div /><div /><div /></KpiGrid>);
    const grid = container.firstChild;
    // From md the fixed sidebar leaves ~500px: four columns waited for lg.
    expect(grid).toHaveClass("grid-cols-2", "lg:grid-cols-4", "max-lg:[&>:last-child:nth-child(odd)]:col-span-2");
    expect(grid).not.toHaveClass("md:grid-cols-4");
  });

  it("wraps a gauge caption under the ring instead of squeezing it beside", () => {
    render(
      <KpiTile
        label="Autopay Coverage"
        value="40%"
        sub="70 of 173 customers"
        chart={{ kind: "gauge", value: 40, max: 100 }}
      />,
    );
    const caption = screen.getByText("70 of 173 customers");
    expect(caption.parentElement).toHaveClass("flex-wrap");
    expect(caption).toHaveClass("min-w-0", "grow", "basis-24");
  });
});
