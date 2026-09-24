// @vitest-environment jsdom
// The global Messages icon's unread badge: hidden at zero, capped at 99+, and
// the destination stays the inbox.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminLayoutV2 from "./AdminLayoutV2";
import { adminFetch } from "../utils/admin-fetch";

const unread = vi.hoisted(() => ({ value: 0 }));
const mobile = vi.hoisted(() => ({ value: false }));
vi.mock("../hooks/useUnreadConversations", () => ({ default: () => unread.value }));
vi.mock("../hooks/useIsMobile", () => ({ default: () => mobile.value }));
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

function mount() {
  return render(
    <MemoryRouter initialEntries={["/admin/dashboard"]}>
      <Routes>
        <Route path="/admin" element={<AdminLayoutV2 />}>
          <Route path="dashboard" element={<div>Dashboard body</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe("AdminLayoutV2 Messages badge", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
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
    unread.value = 0;
    mobile.value = false;
  });

  it("is hidden at zero", async () => {
    mount();
    const link = await screen.findByRole("link", { name: "Communications" });
    expect(link).toHaveAttribute("href", "/admin/communications");
    expect(link).not.toHaveTextContent(/unread/);
  });

  it("links the mobile badge to unanswered conversations", async () => {
    unread.value = 5;
    mobile.value = true;
    mount();
    const tabbar = await screen.findByRole("navigation", { name: "Primary" });
    const link = within(tabbar).getByRole("link", { name: /Messages.*5 conversations needing a reply/ });
    expect(link).toHaveAttribute("href", "/admin/communications?needsResponse=true");
    expect(link).toHaveTextContent("5");
  });

  it("caps a backlog at 99+", async () => {
    unread.value = 240;
    mount();
    const link = await screen.findByRole("link", { name: /Communications.*240 conversations needing a reply/ });
    expect(link).toHaveAttribute("href", "/admin/communications?needsResponse=true");
    expect(link).toHaveTextContent("99+");
  });
});
