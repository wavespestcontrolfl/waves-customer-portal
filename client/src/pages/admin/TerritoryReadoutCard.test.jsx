// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TerritoryReadoutCard from "./TerritoryReadoutCard";

// Territories read-out (GATE_TERRITORY_READOUT, build 3): rows grouped per technician with a
// total, per-week numbers over the server's weeks, and a plain failure line.
describe("TerritoryReadoutCard", () => {
  beforeEach(() => { vi.stubGlobal("fetch", vi.fn()); });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("shows stops a week per technician and area, with a total per technician", async () => {
    fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        weeks: 4,
        rows: [
          { technicianId: "t1", technicianName: "Adam", area: "north_river", areaLabel: "North of the river", booked: 48, done: 36 },
          { technicianId: "t1", technicianName: "Adam", area: null, areaLabel: null, booked: 2, done: 0 },
          { technicianId: null, technicianName: null, area: "venice", areaLabel: "Venice", booked: 4, done: 0 },
        ],
      }),
    });
    render(<TerritoryReadoutCard />);
    expect(await screen.findByText("North of the river")).toBeTruthy();
    expect(screen.getByText("12.0")).toBeTruthy();
    expect(screen.getByText("No area (ZIP outside the map)")).toBeTruthy();
    // Adam's total: (48 + 2) / 4 booked a week.
    expect(screen.getByText("12.5")).toBeTruthy();
    expect(screen.getAllByText("No technician").length).toBe(2);
  });

  it("says when the read-out could not be loaded", async () => {
    fetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<TerritoryReadoutCard />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
