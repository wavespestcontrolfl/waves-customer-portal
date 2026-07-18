// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/admin/AdminCommandHeader", () => ({
  default: ({ sections, activeKey, onSectionChange, ariaLabel }) => (
    <nav aria-label={ariaLabel}>
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
    </nav>
  ),
}));

vi.mock("./KnowledgePage", () => ({
  default: ({ embedded }) => (
    <div>{embedded ? "Embedded Wiki workspace" : "Wiki page"}</div>
  ),
}));

vi.mock("./KnowledgeBasePage", () => ({
  default: ({ embedded }) => (
    <div>{embedded ? "Embedded Knowledge Base workspace" : "Knowledge Base page"}</div>
  ),
}));

import KnowledgeHubPage from "./KnowledgeHubPage";

afterEach(cleanup);

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderHub(entry = "/admin/knowledge") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/admin/knowledge"
          element={(
            <>
              <KnowledgeHubPage />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("KnowledgeHubPage", () => {
  it("defaults to the embedded Wiki workspace", async () => {
    renderHub();

    expect(await screen.findByText("Embedded Wiki workspace"))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Wiki" }))
      .toHaveAttribute("aria-current", "page");
  });

  it("deep-links and switches areas without dropping query context", async () => {
    renderHub("/admin/knowledge?source=alert&area=base&kbTab=audit");

    expect(await screen.findByText("Embedded Knowledge Base workspace"))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Wiki" }));

    expect(await screen.findByText("Embedded Wiki workspace"))
      .toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent(
        "?source=alert",
      );
    });
  });
});
