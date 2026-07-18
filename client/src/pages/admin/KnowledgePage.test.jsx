// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/admin/AdminCommandHeader", () => ({
  default: ({ sections = [], activeKey, onSectionChange, headingLevel, sticky }) => (
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

import KnowledgePage from "./KnowledgePage";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderWiki(entry) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/admin/knowledge"
          element={(
            <>
              <KnowledgePage embedded />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("KnowledgePage embedded navigation", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses wikiTab without overwriting the Knowledge area", () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    renderWiki("/admin/knowledge?source=bookmark&wikiTab=sources");

    expect(screen.getByRole("button", { name: "Sources" }))
      .toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Recent Queries" }));

    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?source=bookmark&wikiTab=queries",
    );
  });

  it("does not expose the admin-only Health area to non-admin staff", () => {
    localStorage.setItem("waves_admin_user", JSON.stringify({ role: "technician" }));
    renderWiki("/admin/knowledge?wikiTab=health");

    expect(screen.queryByRole("button", { name: "Health" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Articles" }))
      .toHaveAttribute("aria-current", "page");
  });
});
