// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerHealthSection } from "./CustomerHealthTabs";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("does not present an incomplete response as healthy and can retry", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ complete: false, fleetHealthAvg: null, atRiskCount: 0 })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ complete: true, fleetHealthAvg: 0, atRiskCount: 0, healthyCount: 0, predictedChurns: 0, gradeDistribution: [], riskBreakdown: [], atRiskCustomers: [], recentAlerts: [] }))));
  render(<CustomerHealthSection />);
  expect(await screen.findByText(/Health summary unavailable/)).toBeInTheDocument();
  expect(screen.queryByText("No at-risk customers")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry health summary" }));
  expect(await screen.findByText("0/100")).toBeInTheDocument();
  expect(screen.queryByText(/Health summary unavailable/)).not.toBeInTheDocument();
});
