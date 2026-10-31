// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobCardGoverned, JobCardTab } from "./SchedulePage";

afterEach(cleanup);

const D = { text: "#000", muted: "#666", heading: "#000" };
const base = { area: "Treated square feet.", limit: "Repeat no sooner than 8 weeks.", safety: "The applicator must carry the 2(ee) sheet." };

// What the technician reads on an area add-on's product card (Codex r6): what was sold, the
// grass the estimate priced, the label rate (or why it is withheld), the area basis, the
// yearly limit and the safety line.
describe("area add-on label text on the job card", () => {
  it("shows what was sold, the grass on the estimate and the rate", () => {
    render(<JobCardGoverned D={D} governed={{ ...base, sold: "Sold: up to 2,000 sq ft of treated lawn", grass: "Grass on the estimate: St. Augustine", rate: "0.147 oz per 1,000 sq ft", rateNote: null }} />);
    expect(screen.getByText("Sold: up to 2,000 sq ft of treated lawn")).toBeInTheDocument();
    expect(screen.getByText("Grass on the estimate: St. Augustine")).toBeInTheDocument();
    expect(screen.getByText("Rate: 0.147 oz per 1,000 sq ft")).toBeInTheDocument();
    expect(screen.getByText("Area: Treated square feet.")).toBeInTheDocument();
    expect(screen.getByText("Limit: Repeat no sooner than 8 weeks.")).toBeInTheDocument();
    expect(screen.getByText("Safety: The applicator must carry the 2(ee) sheet.")).toBeInTheDocument();
  });

  it("with no grass evidence the rate is replaced by the reason; area, limit and safety stay", () => {
    render(<JobCardGoverned D={D} governed={{ ...base, sold: "Sold: up to 1,000 sq ft of treated lawn", grass: null, rate: null, rateNote: "Grass on the estimate is not on this visit (the rate is St. Augustine only) — rate withheld" }} />);
    expect(screen.getByText(/Grass on the estimate is not on this visit/)).toBeInTheDocument();
    expect(screen.queryByText(/^Rate:/)).toBeNull();
    expect(screen.queryByText(/Grass on the estimate: /)).toBeNull();
    expect(screen.getByText("Area: Treated square feet.")).toBeInTheDocument();
    expect(screen.getByText(/Safety:/)).toBeInTheDocument();
  });

  it("renders nothing for an ordinary product", () => {
    const { container } = render(<JobCardGoverned D={D} governed={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// Codex round 12 on #6135: a host's Snapshot and the Bed Pre-Emergent add-on's Snapshot are two applications, so two cards
// of one product. They need distinct React keys, DOM ids and titles, and each keeps its own open or closed state.
describe("two cards of one product (a host and a sold add-on)", () => {
  const theme = { ...D, card: "#fff", border: "#ddd", input: "#fff", inputBorder: "#ccc", white: "#fff" };
  const strip = { name: "Synthetic Customer", program: "Tree & Shrub" };
  const common = { id: "prod-snap", name: "Snapshot 2.5TG", role: "base", conditional: false, verdict: "ok", verdictReason: null, planned: null, short: false, onHand: null, lowStock: false };
  const host = { ...common, rowId: "prod-snap", source: null, addOnKey: null, line: "Snapshot 2.5TG: beds, only when due", governed: undefined };
  const addOn = { ...common, rowId: "prod-snap::area_addon_bed_pre_emergent", source: "Bed Pre-Emergent Treatment", addOnKey: "area_addon_bed_pre_emergent", line: "Bed Pre-Emergent Treatment: granular on the beds", governed: { sold: "Sold: up to 2,000 sq ft of bed", rate: "3.45 lb per 1,000 sq ft", rateNote: null, area: "Bed square feet treated.", limit: "Once.", use: "Application 1 of 4 in 12 months." } };
  const card = { serviceId: "visit-1", strip, tank: { calibrated: true, rigs: [] }, sprayCheck: { window: "today", forecast: null }, products: [host, addOn], addons: [{ name: "Bed Pre-Emergent Treatment", visit: null }] };

  it("render as two cards with distinct DOM ids and titles, without a duplicate-key warning", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<JobCardTab card={card} D={theme} />);
    const ids = [...container.querySelectorAll("[id^='job-card-product-']")].map((el) => el.id);
    expect(ids).toEqual(["job-card-product-prod-snap", "job-card-product-prod-snap::area_addon_bed_pre_emergent"]);
    // The add-on's card opens with its governed text; the host's stays closed and carries none.
    expect(screen.getByText("Sold: up to 2,000 sq ft of bed")).toBeInTheDocument();
    expect(screen.getByText("Application 1 of 4 in 12 months.")).toBeInTheDocument();
    expect(screen.getAllByText("Snapshot 2.5TG · Bed Pre-Emergent Treatment")).toHaveLength(2); // its title and its spray check row
    expect(screen.getAllByText("Snapshot 2.5TG").length).toBeGreaterThanOrEqual(2);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/same key|unique "key"/);
    warn.mockRestore();
  });

  it("each card keeps its own open state", () => {
    render(<JobCardTab card={card} D={theme} />);
    const hostToggle = document.getElementById("job-card-product-prod-snap");
    const addOnToggle = document.getElementById("job-card-product-prod-snap::area_addon_bed_pre_emergent");
    expect(hostToggle).toHaveAttribute("aria-expanded", "false");
    expect(addOnToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(hostToggle);
    expect(hostToggle).toHaveAttribute("aria-expanded", "true");
    expect(addOnToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(addOnToggle);
    expect(hostToggle).toHaveAttribute("aria-expanded", "true");
    expect(addOnToggle).toHaveAttribute("aria-expanded", "false");
  });
});

// Owner 2026-10-29 ("i just want to warn techs", step 2): rain very likely is a Warning that keeps the
// dose and says what to do. The chip is dark, never the red Hold.
describe("a weather warning on the job card", () => {
  const theme = { ...D, card: "#fff", border: "#ddd", input: "#fff", inputBorder: "#ccc", white: "#fff" };
  const product = {
    id: "cel", rowId: "cel", name: "Celsius WG", role: "base", conditional: false, verdict: "caution", verdictLevel: "warning",
    verdictReason: "rain 85% inside 3 h", verdictAction: "Skip it today and note why, or plan a re-treat.",
    planned: { amount: 0.5, unit: "oz" }, short: false, onHand: null, lowStock: false, line: "Celsius WG + NIS broadleaf", governed: undefined,
  };
  const card = {
    serviceId: "visit-1", strip: { name: "Synthetic Customer", program: "Lawn" }, tank: { calibrated: true, rigs: [] },
    sprayCheck: { window: "today", windowHours: 4, hold: false, forecast: { tempF: [80, 84], windMph: 6, rainPct: 85, shortForecast: "Showers" } },
    products: [product], addons: [],
  };

  it("shows the Warning chip, the reason and the action, and no Hold", () => {
    render(<JobCardTab card={card} D={theme} />);
    // The spray check header, its product row and the product card's own chip.
    expect(screen.getAllByText("Warning")).toHaveLength(3);
    expect(screen.queryByText("Hold")).toBeNull();
    expect(screen.getByText("rain 85% inside 3 h")).toBeInTheDocument();
    fireEvent.click(document.getElementById("job-card-product-cel"));
    expect(screen.getByText("Spray check: rain 85% inside 3 h")).toBeInTheDocument();
    expect(screen.getByText("Skip it today and note why, or plan a re-treat.")).toBeInTheDocument();
  });
});

// Owner 2026-10-31: a heat index line for the tech, beside the weather line. It is not a verdict, a chip or a hold.
describe("the heat safety line on the job card", () => {
  const theme = { ...D, card: "#fff", border: "#ddd", input: "#fff", inputBorder: "#ccc", white: "#fff" };
  const base = { window: "today", windowHours: 4, hold: false, forecast: { tempF: [95, 98], windMph: 6, rainPct: 10, shortForecast: "Sunny" } };
  const cardWith = (heatSafety) => ({
    serviceId: "visit-1", strip: { name: "Synthetic Customer", program: "Pest" }, tank: { calibrated: true, rigs: [] },
    sprayCheck: { ...base, ...(heatSafety ? { heatSafety } : {}) }, products: [], addons: [],
  });

  it("shows the server's text as its own line and adds no chip", () => {
    const text = "Heat index 106°F at 2 pm. Drink water every 15 minutes. Rest in the shade.";
    render(<JobCardTab card={cardWith({ heatIndexF: 106, at: "2 pm", level: "high", text })} D={theme} />);
    expect(screen.getByTestId("job-card-heat-safety")).toHaveTextContent(text);
    expect(screen.getByText(/Next 4 h:/)).toBeInTheDocument();
    expect(screen.queryByText("Hold")).toBeNull();
    expect(screen.queryByText("Warning")).toBeNull();
  });

  it("shows no line when the server sends none", () => {
    render(<JobCardTab card={cardWith(null)} D={theme} />);
    expect(screen.queryByTestId("job-card-heat-safety")).toBeNull();
  });
});
