// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import AdminTabRedirect from "./AdminTabRedirect";

afterEach(cleanup);

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname}
      {location.search}
      {location.hash}
    </output>
  );
}

function renderRedirect({
  entry,
  source,
  to,
  tab,
  preserveTabs,
  queryKey,
  remapQuery,
}) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path={source}
          element={(
            <AdminTabRedirect
              to={to}
              tab={tab}
              preserveTabs={preserveTabs}
              queryKey={queryKey}
              remapQuery={remapQuery}
            />
          )}
        />
        <Route path={to} element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
  return screen.getByTestId("location").textContent;
}

describe("AdminTabRedirect", () => {
  it("moves a lead deep link into Pipeline without losing query or hash", () => {
    const destination = renderRedirect({
      entry: "/admin/leads?lead=lead-123&source=notification#activity",
      source: "/admin/leads",
      to: "/admin/pipeline",
      tab: "leads",
    });

    expect(destination).toBe(
      "/admin/pipeline?lead=lead-123&source=notification&tab=leads#activity",
    );
  });

  it("defaults the legacy Estimates route to the Estimates tab", () => {
    const destination = renderRedirect({
      entry: "/admin/estimates?estimateId=estimate-123",
      source: "/admin/estimates",
      to: "/admin/pipeline",
      tab: "estimates",
      preserveTabs: ["leads", "estimates", "new", "pricing"],
    });

    expect(destination).toBe(
      "/admin/pipeline?estimateId=estimate-123&tab=estimates",
    );
  });

  it("preserves an explicit valid Pipeline tab", () => {
    const destination = renderRedirect({
      entry: "/admin/estimates?tab=new&customerId=customer-123",
      source: "/admin/estimates",
      to: "/admin/pipeline",
      tab: "estimates",
      preserveTabs: ["leads", "estimates", "new", "pricing"],
    });

    expect(destination).toBe(
      "/admin/pipeline?tab=new&customerId=customer-123",
    );
  });

  it("forces the embedded Equipment calibration tab", () => {
    const destination = renderRedirect({
      entry: "/admin/equipment-calibration?equipmentId=equipment-123&tab=maintenance",
      source: "/admin/equipment-calibration",
      to: "/admin/equipment",
      tab: "calibrations",
    });

    expect(destination).toBe(
      "/admin/equipment?equipmentId=equipment-123&tab=calibrations",
    );
  });

  it("moves credential alerts into the Compliance hub", () => {
    const destination = renderRedirect({
      entry: "/admin/credentials?credentialId=credential-123#renewal",
      source: "/admin/credentials",
      to: "/admin/compliance",
      tab: "credentials",
    });

    expect(destination).toBe(
      "/admin/compliance?credentialId=credential-123&tab=credentials#renewal",
    );
  });

  it("supports non-tab hub parameters for legacy Pricing routes", () => {
    const destination = renderRedirect({
      entry: "/admin/pricing?campaign=spring#offers",
      source: "/admin/pricing",
      to: "/admin/pricing-logic",
      tab: "strategy",
      queryKey: "area",
    });

    expect(destination).toBe(
      "/admin/pricing-logic?campaign=spring&area=strategy#offers",
    );
  });

  it("moves Auto-Dispatch deep links into the Schedule workspace", () => {
    const destination = renderRedirect({
      entry: "/admin/auto-dispatch?run=run-123#audit",
      source: "/admin/auto-dispatch",
      to: "/admin/dispatch",
      tab: "automation",
    });

    expect(destination).toBe(
      "/admin/dispatch?run=run-123&tab=automation#audit",
    );
  });

  it("moves Lawn Protocol subareas into the Services hub", () => {
    const destination = renderRedirect({
      entry: "/admin/lawn-protocol?tab=readiness&alert=alert-123#blocked",
      source: "/admin/lawn-protocol",
      to: "/admin/service-library",
      tab: "protocols",
      remapQuery: {
        from: "tab",
        to: "protocolTab",
        preserveValues: ["overview", "readiness", "products"],
      },
    });

    expect(destination).toBe(
      "/admin/service-library?alert=alert-123&protocolTab=readiness&tab=protocols#blocked",
    );
  });

  it("moves Knowledge Base subareas into the Knowledge hub", () => {
    const destination = renderRedirect({
      entry: "/admin/kb?tab=audit&entry=entry-123#review",
      source: "/admin/kb",
      to: "/admin/knowledge",
      tab: "base",
      queryKey: "area",
      remapQuery: {
        from: "tab",
        to: "kbTab",
        preserveValues: ["browse", "create", "field", "audit", "tokens"],
      },
    });

    expect(destination).toBe(
      "/admin/knowledge?entry=entry-123&kbTab=audit&area=base#review",
    );
  });
});
