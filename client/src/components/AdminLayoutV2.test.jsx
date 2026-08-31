// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminLayoutV2 from "./AdminLayoutV2";
import { adminFetch } from "../utils/admin-fetch";

vi.mock("../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../hooks/useFeatureFlag", () => ({
  refetchFlags: vi.fn(() => Promise.resolve()),
  useFeatureFlag: vi.fn(() => false),
}));
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

describe("AdminLayoutV2", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    document.documentElement.className = "";
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
    document.documentElement.className = "";
  });

  it("renders the authenticated child route", async () => {
    render(
      <MemoryRouter initialEntries={["/admin/dashboard"]}>
        <Routes>
          <Route element={<AdminLayoutV2 />}>
            <Route path="/admin/dashboard" element={<div>Admin child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Admin child")).toBeInTheDocument();
  });

  it("no longer owns the Safari bookmark identity (moved to AdminSafariShell in App)", async () => {
    // Regression pin: the manifest/title swap lives in useAdminBookmarkMeta,
    // mounted app-wide so /admin/login (outside this layout) is covered. A
    // duplicate effect here would fight the app-level one on unmount.
    render(
      <MemoryRouter initialEntries={["/admin/dashboard"]}>
        <Routes>
          <Route element={<AdminLayoutV2 />}>
            <Route path="/admin/dashboard" element={<div>Admin child</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText("Admin child");
    expect(document.documentElement).not.toHaveClass("admin-app");
    expect(document.querySelector('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.json",
    );
    expect(document.title).toBe("Waves Customer Portal");
  });
});
