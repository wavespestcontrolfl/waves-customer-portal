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
function AdminShellStub({ role = "admin" }) {
  return <Outlet context={{ user: { role } }} />;
}

function renderKnowledgeBase(entry, role = "admin") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<AdminShellStub role={role} />}>
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

    expect(screen.getByRole("button", { name: "Audit" }))
      .toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));

    expect(screen.getByTestId("location-search")).toHaveTextContent(
      "?area=base&source=digest&kbTab=tokens",
    );
  });

  it("keeps owner-only sections hidden and resolves their deep links to Browse", () => {
    renderKnowledgeBase("/admin/knowledge?area=base&kbTab=tokens", "technician");

    expect(screen.queryByRole("button", { name: "Tokens" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Audit" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browse" }))
      .toHaveAttribute("aria-current", "page");
    expect(screen.getByTestId("location-search"))
      .toHaveTextContent("?area=base&kbTab=tokens");
  });
});

// The knowledge base is READ-ONLY for a technician (owner 2026-10-02): the
// Create tab and the entry edit / verify / flag / delete controls call
// admin-only routes, so a technician must not be offered them.
describe("technician knowledge base is read-only", () => {
  const ENTRY = {
    id: "kb-1",
    title: "Synthetic protocol entry",
    category: "protocols",
    confidence: "medium",
    status: "active",
    source: "manual",
    content: "Entry content",
    tags: [],
    updated_at: "2026-09-01T12:00:00Z",
  };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (url) => ({
      ok: true,
      json: async () => (String(url).includes("/admin/kb?") ? { entries: [ENTRY], total: 1 } : {}),
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

  it("hides the Create tab from a technician, resolves its deep link to Browse, and keeps it for an admin", () => {
    renderKnowledgeBase("/admin/knowledge?area=base&kbTab=create", "technician");
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browse" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Field" })).toBeInTheDocument();
    cleanup();
    renderKnowledgeBase("/admin/knowledge?area=base&kbTab=create", "admin");
    expect(screen.getByRole("button", { name: "Create" })).toHaveAttribute("aria-current", "page");
  });

  async function openEntry(role) {
    renderKnowledgeBase("/admin/knowledge?area=base", role);
    fireEvent.click(await screen.findByRole("button", { name: /Synthetic protocol entry/ }));
    await screen.findByLabelText("Close entry details");
  }

  it("shows a technician the entry without Edit, Verify, Flag or Delete", async () => {
    await openEntry("technician");
    expect(screen.getByText("Entry content")).toBeInTheDocument();
    for (const name of ["Edit", "Verify", "Flag", "Delete"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("shows an admin Edit, Verify, Flag and Delete", async () => {
    await openEntry("admin");
    for (const name of ["Edit", "Verify", "Flag", "Delete"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
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
