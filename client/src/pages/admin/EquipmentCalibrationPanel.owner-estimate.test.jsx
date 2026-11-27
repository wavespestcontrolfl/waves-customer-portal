// @vitest-environment jsdom
// Owner 2026-11-27 ("we will use the best guess"): a sprayer number with no expiry reads "Owner estimate", shows no expiry line
// and no "Verify Calibration" prompt. A row with an expiry keeps both.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import EquipmentCalibrationPanel from "./EquipmentCalibrationPanel";

vi.mock("../../hooks/useVisiblePageRefresh", () => ({ default: () => {} }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubApi(calibration) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const path = String(url);
    let body = {};
    if (path.endsWith("/admin/equipment-systems")) body = { systems: [{ id: "sys-1", name: "FlowZone Typhoon 3.0 #1", system_type: "backpack" }] };
    else if (path.endsWith("/admin/equipment-systems/sys-1")) body = { calibration };
    else if (path.endsWith("/reconciliation")) body = { systems: [] };
    return { ok: true, json: async () => body };
  }));
}

async function openSystem() {
  render(<EquipmentCalibrationPanel />);
  const select = await screen.findByLabelText("Equipment system");
  await screen.findByRole("option", { name: /FlowZone Typhoon 3\.0 #1/ });
  fireEvent.change(select, { target: { value: "sys-1" } });
}

it("an owner estimate with no expiry: the status label, no expiry and no verify prompt", async () => {
  stubApi({ id: "cal-1", calibration_status: "owner_estimate", carrier_gal_per_1000: "2.000", expires_at: null, calibrated_at: "2026-11-27T15:00:00Z" });
  await openSystem();
  expect(await screen.findByText("Owner estimate")).toBeInTheDocument();
  expect(screen.queryByText("expires:")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Verify Calibration" })).not.toBeInTheDocument();
});

it("an estimate with an expiry keeps the expiry line and the verify prompt", async () => {
  stubApi({ id: "cal-1", calibration_status: "estimated", carrier_gal_per_1000: "1.330", expires_at: "2026-12-07T14:00:00Z", calibrated_at: "2026-11-07T14:00:00Z" });
  await openSystem();
  expect(await screen.findByText("expires:")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Verify Calibration" })).toBeInTheDocument();
});
