// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/admin/AdminCommandHeader", () => ({
  default: ({
    sections,
    activeKey,
    onSectionChange,
    headingLevel,
    sticky,
  }) => (
    <div data-heading-level={headingLevel} data-sticky={String(sticky)}>
      {sections.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          aria-current={activeKey === key ? "page" : undefined}
          onClick={() => onSectionChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  ),
}));

import LawnProtocolCommandCenterPage from "./LawnProtocolCommandCenterPage";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderProtocol(entry) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/admin/service-library"
          element={(
            <>
              <LawnProtocolCommandCenterPage embedded />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("LawnProtocolCommandCenterPage embedded navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses the nested protocol query without overwriting the Services area", () => {
    renderProtocol(
      "/admin/service-library?tab=protocols&protocolTab=readiness&alert=alert-123",
    );

    expect(screen.getByRole("button", { name: "Readiness" }))
      .toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "Products" }));

    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?tab=protocols&protocolTab=products&alert=alert-123",
    );
    expect(screen.getByRole("button", { name: "Products" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("renders embedded navigation as a non-sticky second-level heading", () => {
    renderProtocol("/admin/service-library?tab=protocols");

    const header = screen.getByRole("button", { name: "Overview" }).parentElement;
    expect(header).toHaveAttribute("data-heading-level", "2");
    expect(header).toHaveAttribute("data-sticky", "false");
  });
});
