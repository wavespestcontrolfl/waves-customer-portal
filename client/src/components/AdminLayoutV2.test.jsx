// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminLayoutV2 from "./AdminLayoutV2";
import { adminFetch } from "../utils/admin-fetch";

vi.mock("../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../hooks/useFeatureFlag", () => ({ refetchFlags: vi.fn(() => Promise.resolve()) }));
vi.mock("../utils/admin-fetch", () => ({ adminFetch: vi.fn() }));
vi.mock("./NotificationBell", () => ({ default: () => null }));
vi.mock("./admin/GlobalCommandPalette", async () => {
  const ReactModule = await import("react");
  return {
    default: ReactModule.forwardRef(function PaletteMock(_props, ref) {
      ReactModule.useImperativeHandle(ref, () => ({ open: vi.fn() }));
      return null;
    }),
  };
});

describe("AdminLayoutV2 Safari bookmark metadata", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    document.head.innerHTML = `
      <link rel="manifest" href="/manifest.json">
      <meta name="apple-mobile-web-app-title" content="Waves">
      <meta name="description" content="Customer portal">
    `;
    document.title = "Waves Customer Portal";
    const store = new Map([["waves_admin_token", "test-token"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
      clear: () => store.clear(),
    });
    adminFetch.mockResolvedValue({ id: 1, name: "Admin", role: "admin" });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("activates the admin manifest and restores the customer defaults on unmount", async () => {
    const view = render(
      <MemoryRouter initialEntries={["/admin/dashboard"]}>
        <Routes>
          <Route element={<AdminLayoutV2 />}>
            <Route path="/admin/dashboard" element={<div>Admin child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Admin child");
    expect(document.documentElement).toHaveClass("admin-app");
    expect(document.querySelector('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/admin-manifest.json",
    );
    expect(
      document.querySelector('meta[name="apple-mobile-web-app-title"]'),
    ).toHaveAttribute("content", "Waves Admin");
    expect(document.title).toBe("Waves Admin");

    view.unmount();
    expect(document.documentElement).not.toHaveClass("admin-app");
    expect(document.querySelector('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.json",
    );
    expect(document.title).toBe("Waves Customer Portal");
  });
});
