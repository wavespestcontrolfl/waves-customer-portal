// @vitest-environment jsdom
//
// The Celsius yearly cap in the Protocol Reference descriptions follows the program that
// renders it: the legacy lawn payload (GATE_LAWN_V13 off, no safety_rules) keeps "max 3x/year";
// the v13 payload (it carries its own safety_rules) shows "max 2x/year".
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ProtocolReferenceTabV2 from "./ProtocolReferenceTabV2";
import { PRODUCT_DESCRIPTIONS, PRODUCT_DESCRIPTIONS_V13, TRACK_SAFETY_RULES } from "./SchedulePage";

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

const lawnTrack = (extra) => ({
  name: "Synthetic lawn protocol",
  visits: [{ month: MONTH, visit: 1, notes: "Scout", primary: "Celsius WG: 0.085 oz per 1,000 sq ft", secondary: "", tiers: [] }],
  ...extra,
});

it("static lists: the legacy fallback says 3, only the v13 override says 2", () => {
  expect(PRODUCT_DESCRIPTIONS["celsius wg"]).toMatch(/max 3x\/year/);
  expect(PRODUCT_DESCRIPTIONS.celsius).toMatch(/max 3x\/year/);
  expect(PRODUCT_DESCRIPTIONS_V13["celsius wg"]).toMatch(/max 2x\/year/);
  expect(PRODUCT_DESCRIPTIONS_V13.celsius).toMatch(/max 2x\/year/);
  const celsiusRules = Object.values(TRACK_SAFETY_RULES).flat().filter((rule) => /^Celsius WG/.test(rule));
  expect(celsiusRules.length).toBeGreaterThan(0);
  for (const rule of celsiusRules) expect(rule).toBe("Celsius WG: MAX 3 apps/year/property");
});

it("gate off (the lawn payload has no safety_rules): the Celsius line reads max 3x/year", async () => {
  track = lawnTrack({});
  render(<ProtocolReferenceTabV2 />);
  await openCalendar();
  expect(await screen.findAllByText(/max 3x\/year/)).not.toHaveLength(0);
  expect(screen.queryByText(/max 2x\/year/)).not.toBeInTheDocument();
});

it("v13 (the payload carries safety_rules): the Celsius line reads max 2x/year", async () => {
  track = lawnTrack({ safety_rules: ["Celsius WG: stay under the annual cap (Celsius, Certainty and Blindside: up to 2 applications per lawn per year each)."] });
  render(<ProtocolReferenceTabV2 />);
  await openCalendar();
  expect(await screen.findAllByText(/max 2x\/year/)).not.toHaveLength(0);
  expect(screen.queryByText(/max 3x\/year/)).not.toBeInTheDocument();
});
