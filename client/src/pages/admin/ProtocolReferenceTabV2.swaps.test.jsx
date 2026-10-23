// @vitest-environment jsdom
//
// The v13 December visit can carry a conditional swap of its whole-lawn bag (GATE_LAWN_DEC_LARGE_PATCH_K): the programs API sends the
// visit's `swaps` block only while the gate is live. The Protocol Reference calendar shows it as a labeled IF line under the visit's
// secondary applications, and shows nothing for a payload without the block (the gate off is the old calendar exactly).
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProtocolReferenceTabV2 from "./ProtocolReferenceTabV2";

const MONTH = new Date().toLocaleString("en-US", { month: "short" });
const catalog = { lawn: { tracks: [{ key: "st_augustine", name: "Synthetic Lawn", visits: 0 }] }, programs: [] };
const ok = (data) => ({ ok: true, json: async () => data });
let track;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === "/api/admin/protocols/programs") return ok(catalog);
    if (url.includes("/programs?")) return ok({ track, viewerRole: "admin" });
    return ok({ calibrations: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openCalendar() {
  fireEvent.click(await screen.findByRole("button", { name: "View full calendar" }));
  await screen.findByText("Primary Applications");
}

const SWAP = {
  largePatchPotassium: {
    gate: "GATE_LAWN_DEC_LARGE_PATCH_K",
    primary: "Synthetic Potash 0-0-24 — 4.1 lb per 1,000 sq ft (0 lb N, 0.99 lb K2O), spreader, active patch mapped",
    summary: "Active large patch mapped (GATE_LAWN_DEC_LARGE_PATCH_K): Synthetic Potash 0-0-24 in place of the Synthetic 10-0-22.",
  },
};
const lawnTrack = (visit) => ({
  name: "Synthetic lawn protocol",
  safety_rules: ["Synthetic rule."],
  visits: [{ month: MONTH, visit: 12, notes: "Spreader visit.", primary: "Synthetic 10-0-22 — 4.5 lb per 1,000 sq ft (0.45 lb N, 0.99 lb K2O), spreader", secondary: "Synthetic Celsius — weed spots", tiers: [], ...visit }],
});

it("a visit with a swaps block shows the conditional bag as an IF line with the recipe's own words, beside the normal bag", async () => {
  track = lawnTrack({ swaps: SWAP });
  render(<ProtocolReferenceTabV2 />);
  await openCalendar();
  const line = await screen.findByTestId("protocol-swap-line");
  expect(line).toHaveTextContent("Synthetic Potash 0-0-24");
  expect(line).toHaveTextContent("IF");
  expect(line).toHaveTextContent("Active large patch mapped (GATE_LAWN_DEC_LARGE_PATCH_K)");
  expect(line).toHaveTextContent("in place of the Synthetic 10-0-22");
  // The normal bag and the secondary applications are still listed.
  expect(screen.getAllByText(/Synthetic 10-0-22/).length).toBeGreaterThan(0);
  expect(screen.getByText(/Synthetic Celsius/)).toBeInTheDocument();
});

it("a visit without the block (the gate off) shows no swap line, and a visit with no secondary still shows its dash", async () => {
  track = lawnTrack({});
  render(<ProtocolReferenceTabV2 />);
  await openCalendar();
  expect(screen.queryByTestId("protocol-swap-line")).not.toBeInTheDocument();
  expect(screen.queryByText(/Synthetic Potash/)).not.toBeInTheDocument();
  cleanup();
  track = lawnTrack({ secondary: "" });
  render(<ProtocolReferenceTabV2 />);
  await openCalendar();
  expect(screen.getAllByText("—").length).toBeGreaterThan(0);
});

it("a visit with a swap and no secondary shows the swap and no dash in that cell", async () => {
  track = lawnTrack({ secondary: "", swaps: SWAP });
  render(<ProtocolReferenceTabV2 />);
  await openCalendar();
  const line = await screen.findByTestId("protocol-swap-line");
  expect(line.parentElement).not.toHaveTextContent(/^—$/);
  expect(line.parentElement.textContent).not.toContain("— —");
});
