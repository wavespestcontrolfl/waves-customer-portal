// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../components/admin/AdminCommandHeader", () => ({
  default: ({ sections, activeKey, onSectionChange, headingLevel, sticky }) => (
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

import KnowledgeBasePage from "./KnowledgeBasePage";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

// The real page reads the shell's Outlet context for the server-verified
// role (audit/tokens tabs are owner-only) — mirror it with an admin stub.
function AdminShellStub() {
  return <Outlet context={{ user: { role: "admin" } }} />;
}

function renderKnowledgeBase(entry) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<AdminShellStub />}>
          <Route
            path="/admin/knowledge"
            element={(
              <>
                <KnowledgeBasePage embedded />
                <LocationProbe />
              </>
            )}
          />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("KnowledgeBasePage embedded navigation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })));
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses kbTab without overwriting the Knowledge Base area", () => {
    renderKnowledgeBase(
      "/admin/knowledge?area=base&source=digest&kbTab=audit",
    );

    expect(screen.getByRole("button", { name: "AI Audit" }))
      .toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Token Health" }));

    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?area=base&source=digest&kbTab=tokens",
    );
  });
});

// Regeneration is admin-only server-side (requireAdmin on /admin/wiki/update
// burns a DEEP-model call per hit) — the Field Intelligence detail panel must
// not render a Regenerate control that can only 403 for technicians.
describe("Field Intelligence regenerate control", () => {
  const WIKI_PAGE = {
    id: "w1",
    slug: "product/celsius-wg",
    title: "Product: Celsius WG",
    review_tier: "red",
    review_status: "pending_review",
    data_point_count: 4,
    confidence: "low",
    content: "page body",
    risk_flags: [],
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url) => ({
      ok: true,
      json: async () => {
        const u = String(url);
        if (u.includes("/admin/wiki/review/queue")) {
          return { pending: [WIKI_PAGE], blocked: [], recentYellow: [] };
        }
        if (u.includes("/admin/wiki?")) return { pages: [] };
        if (u.includes(`/admin/wiki/${WIKI_PAGE.slug}`)) return { page: WIKI_PAGE };
        return {};
      },
    })));
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.removeItem("waves_admin_user");
  });

  async function openDetail() {
    renderKnowledgeBase("/admin/knowledge?area=base&kbTab=field");
    const [queueRow] = await screen.findAllByText(WIKI_PAGE.title);
    fireEvent.click(queueRow);
    await screen.findByRole("button", { name: "Close" });
  }

  it("hides Regenerate from technicians", async () => {
    window.localStorage.setItem("waves_admin_user", JSON.stringify({ role: "technician" }));
    await openDetail();

    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });

  it("shows Regenerate to admins", async () => {
    window.localStorage.setItem("waves_admin_user", JSON.stringify({ role: "admin" }));
    await openDetail();

    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
  });
});
