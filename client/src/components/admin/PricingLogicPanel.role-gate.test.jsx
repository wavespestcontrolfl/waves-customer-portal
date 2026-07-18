// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pricing writes are admin-only server-side (requireAdmin on the three
// mutating pricing-config routes); the panel mirrors that role so a
// technician gets read-only values instead of optimistic edits that
// silently 403.
const mockGetAdminUser = vi.fn();
vi.mock("../../lib/adminAuth", () => ({
  getAdminUser: (...args) => mockGetAdminUser(...args),
}));

import PricingLogicPanel from "./PricingLogicPanel";

const CONFIGS = [
  {
    config_key: "global_labor_rate",
    name: "Loaded Labor Rate",
    category: "global",
    data: { value: 35 },
    description: "test",
  },
];

beforeEach(() => {
  mockGetAdminUser.mockReset();
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ configs: CONFIGS }),
  }));
});

afterEach(cleanup);

async function renderPanel() {
  render(<PricingLogicPanel />);
  await waitFor(() => expect(screen.getByText("Loaded Labor Rate")).toBeInTheDocument());
}

describe("PricingLogicPanel role gate", () => {
  it("technician sees read-only values: no edit affordance, no Raw JSON toggle", async () => {
    mockGetAdminUser.mockReturnValue({ role: "technician" });
    await renderPanel();

    fireEvent.click(screen.getByText("Loaded Labor Rate"));

    const cell = screen.getByTitle("Read-only — pricing edits are admin-only");
    fireEvent.click(cell);
    // No input appears — the cell never enters edit mode for a technician.
    expect(document.querySelector("input[type='number']")).toBeNull();
    expect(screen.queryByText("Raw JSON")).toBeNull();
  });

  it("admin keeps the full editing surface", async () => {
    mockGetAdminUser.mockReturnValue({ role: "admin" });
    await renderPanel();

    fireEvent.click(screen.getByText("Loaded Labor Rate"));
    expect(screen.getByText("Raw JSON")).toBeInTheDocument();

    const cell = screen.getByTitle("Click to edit");
    fireEvent.click(cell);
    expect(document.querySelector("input[type='number']")).not.toBeNull();
  });
});
