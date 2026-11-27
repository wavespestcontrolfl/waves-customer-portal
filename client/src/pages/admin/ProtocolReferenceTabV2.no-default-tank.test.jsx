// @vitest-environment jsdom
// Owner 2026-11-27: the big tanks are on different numbers (2.0 and 4.0), so the tank sheet picks no sprayer for the technician:
// the lawn mix request carries no equipmentSystemId until one is chosen, and the sheet then shows each tank's amount.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ProtocolReferenceTabV2 from "./ProtocolReferenceTabV2";

const ok = (data) => ({ ok: true, json: async () => data });
const TANKS = [
  { id: "cal-1", equipment_system_id: "tank1", system_name: "110-Gallon Spray Tank #1", tank_capacity_gal: 110, carrier_gal_per_1000: "2.000", calibration_status: "field_verified", expires_at: null },
  { id: "cal-2", equipment_system_id: "tank2", system_name: "Udor tank #2", tank_capacity_gal: 110, carrier_gal_per_1000: "4.000", calibration_status: "owner_estimate", expires_at: null },
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("opens with no sprayer picked: the lawn mix request names none, even after the calibrations load", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (url === "/api/admin/protocols/programs") return ok({ lawn: { tracks: [{ key: "st_augustine", name: "Synthetic Lawn", visits: 0 }] }, programs: [] });
    if (url.includes("/programs?")) return ok({ track: { name: "Synthetic protocol", visits: [] } });
    if (url.includes("/equipment-systems/calibrations")) return ok({ calibrations: TANKS });
    if (url.includes("/lawn-mix?")) return ok({ items: [], warnings: [], blocks: [], mixingOrder: [] });
    return ok({});
  }));
  render(<ProtocolReferenceTabV2 />);
  await screen.findByRole("option", { name: "Lawn, 0 visits" });
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes("/lawn-mix?"))).toBe(true));
  await waitFor(() => expect(fetch.mock.calls.some(([url]) => url.includes("/equipment-systems/calibrations"))).toBe(true));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const mixCalls = fetch.mock.calls.map(([url]) => url).filter((url) => url.includes("/lawn-mix?"));
  expect(mixCalls.every((url) => !url.includes("equipmentSystemId"))).toBe(true);
});
