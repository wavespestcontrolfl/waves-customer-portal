// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useIsMobile", () => ({
  default: () => false,
}));

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

vi.mock("../../components/admin/MobileServiceLibrary", () => ({
  default: () => <div>Mobile services workspace</div>,
}));

vi.mock("./LawnProtocolCommandCenterPage", () => ({
  default: ({ embedded }) => (
    <div>{embedded ? "Embedded protocol workspace" : "Protocol page"}</div>
  ),
}));

import ServiceLibraryPage from "./ServiceLibraryPage";

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
}

function renderServices(entry = "/admin/service-library") {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route
          path="/admin/service-library"
          element={(
            <>
              <ServiceLibraryPage />
              <LocationProbe />
            </>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ServiceLibraryPage hub", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ services: [] }),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("saves only intentionally changed durations (edited: %s)", async (editDuration) => {
    const service = { id: "fixture-service", name: "Fixture Pest Service", category: "pest_control",
      is_active: true, default_duration_minutes: 30, min_duration_minutes: 30, max_duration_minutes: 40 };
    fetch.mockResolvedValue({ ok: true, json: async () => ({ services: [service] }) });
    renderServices();
    fireEvent.click(await screen.findByText(service.name));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Renamed Service" } });
    if (editDuration) fireEvent.change(screen.getByRole("spinbutton", { name: "Duration (min)" }), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    await waitFor(() => expect(fetch.mock.calls.some(([, options]) => options?.method === "PUT")).toBe(true));
    const [url, options] = fetch.mock.calls.find(([, options]) => options?.method === "PUT");
    expect(url).toBe("/api/admin/services/fixture-service");
    const payload = JSON.parse(options.body);
    expect(payload.name).toBe("Renamed Service");
    expect(payload).not.toHaveProperty("min_duration_minutes");
    expect(payload).not.toHaveProperty("max_duration_minutes");
    if (editDuration) expect(payload.default_duration_minutes).toBe(40);
    else expect(payload).not.toHaveProperty("default_duration_minutes");
  });

  it("deep-links to the embedded Treatment Plans workspace", async () => {
    renderServices(
      "/admin/service-library?alert=alert-123&tab=protocols&protocolTab=readiness",
    );

    expect(await screen.findByText("Embedded protocol workspace"))
      .toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Treatment Plans" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("switches areas without dropping unrelated query context", async () => {
    renderServices("/admin/service-library?source=settings");

    fireEvent.click(
      screen.getByRole("button", { name: "Treatment Plans" }),
    );

    expect(await screen.findByText("Embedded protocol workspace"))
      .toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("location-search")).toHaveTextContent(
        "?source=settings&tab=protocols",
      );
    });
  });

  it("keeps the exact empty-detail instruction copy", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1440,
    });
    renderServices();

    expect(screen.getByText("+ Add Service").parentElement).toHaveTextContent(
      "Or click + Add Serviceto create one.",
    );
  });

  it("keeps saved views and search copy in the stacked catalog", () => {
    renderServices();

    expect(
      screen.getByRole("searchbox", { name: "Search services" }),
    ).toHaveAttribute("placeholder", "Search services...");
    expect(
      screen.getByRole("button", { name: /Recurring/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /One-Time/ }),
    ).toBeInTheDocument();
  });

  it("keeps unsaved detail fields mounted during a catalog refresh", async () => {
    const service = {
      id: "fixture-service",
      name: "Fixture Pest Service",
      category: "pest_control",
      billing_type: "recurring",
      is_active: true,
    };
    let catalogRequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options) => {
        if (options?.method === "PUT") {
          return Promise.resolve({ ok: true, json: async () => ({}) });
        }
        if (String(url).includes("/admin/services")) {
          catalogRequests += 1;
          if (catalogRequests > 1) return new Promise(() => {});
          return Promise.resolve({
            ok: true,
            json: async () => ({ services: [service] }),
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    renderServices();
    fireEvent.click(await screen.findByText(service.name));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "Unsaved service name" },
    });

    fireEvent.click(screen.getByRole("button", { name: /Active/ }));
    await waitFor(() => expect(catalogRequests).toBe(2));

    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Unsaved service name",
    );
  });

  it("keeps the existing catalog retry label and request", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    renderServices();

    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
    fireEvent.click(retry);

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("keeps the existing service saving label", async () => {
    const service = {
      id: "fixture-service",
      name: "Fixture Pest Service",
      category: "pest_control",
      is_active: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((url, options) => {
        if (options?.method === "PUT") return new Promise(() => {});
        return Promise.resolve({
          ok: true,
          json: async () => ({ services: [service] }),
        });
      }),
    );
    renderServices();
    fireEvent.click(await screen.findByText(service.name));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(
      await screen.findByRole("button", { name: "Saving..." }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "● Active" })).toBeInTheDocument();
  });
});
