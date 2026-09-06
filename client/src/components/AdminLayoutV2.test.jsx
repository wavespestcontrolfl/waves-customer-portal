// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminLayoutV2 from "./AdminLayoutV2";
import { adminFetch } from "../utils/admin-fetch";

vi.mock("../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../hooks/useFeatureFlag", () => ({
  refetchFlags: vi.fn(() => Promise.resolve()),
  useFeatureFlag: vi.fn(() => false),
}));
vi.mock("../utils/admin-fetch", async (importOriginal) => ({ ...(await importOriginal()), adminFetch: vi.fn() }));
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

function LoginProbe() {
  const location = useLocation();
  return <><div>Sign in required</div><output data-testid="return-target">{new URLSearchParams(location.search).get("next")}</output></>;
}

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

  it.each(["content-engine", "content-registry", "data-hygiene", "agent-decisions", "drafts", "health", "documents", "document-requests", "discounts"])("blocks a technician at the %s alias before mounting its child", async (path) => {
    adminFetch.mockResolvedValue({ id: 2, name: "Fixture technician", role: "technician" });
    const ForbiddenChild = vi.fn(() => <div>Forbidden child</div>);
    render(<MemoryRouter initialEntries={[`/admin/${path}?id=fixture#context`]}>
      <Routes><Route element={<AdminLayoutV2 />}>
        <Route path={`/admin/${path}`} element={<ForbiddenChild />} />
        <Route path="/admin/schedule" element={<div>Authorized schedule</div>} />
      </Route></Routes>
    </MemoryRouter>);
    expect(await screen.findByText("Authorized schedule")).toBeInTheDocument();
    expect(screen.queryByText("Forbidden child")).not.toBeInTheDocument();
    expect(ForbiddenChild).not.toHaveBeenCalled();
  });

  it("sends an unauthenticated alias to login without mounting its child", async () => {
    localStorage.clear();
    render(<MemoryRouter initialEntries={["/admin/data-hygiene?status=auto_applied#evidence"]}>
      <Routes>
        <Route element={<AdminLayoutV2 />}><Route path="/admin/data-hygiene" element={<div>Forbidden child</div>} /></Route>
        <Route path="/admin/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>);
    expect(await screen.findByText("Sign in required")).toBeInTheDocument();
    expect(screen.queryByText("Forbidden child")).not.toBeInTheDocument();
    expect(adminFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("return-target")).toHaveTextContent("/admin/data-hygiene?status=auto_applied#evidence");
  });

  it("preserves the original destination after an expired-token response", async () => {
    adminFetch.mockRejectedValue(Object.assign(new Error("Expired"), { status: 401 }));
    render(<MemoryRouter initialEntries={["/admin/documents?id=fixture-template#editor"]}>
      <Routes>
        <Route element={<AdminLayoutV2 />}><Route path="/admin/documents" element={<div>Forbidden child</div>} /></Route>
        <Route path="/admin/login" element={<LoginProbe />} />
      </Routes>
    </MemoryRouter>);
    expect(await screen.findByText("Sign in required")).toBeInTheDocument();
    expect(screen.getByTestId("return-target")).toHaveTextContent("/admin/documents?id=fixture-template#editor");
    expect(screen.queryByText("Forbidden child")).not.toBeInTheDocument();
    expect(localStorage.getItem("waves_admin_token")).toBeNull();
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
