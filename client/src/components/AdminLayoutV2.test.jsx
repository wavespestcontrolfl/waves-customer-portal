// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminLayoutV2 from "./AdminLayoutV2";
import { adminFetch } from "../utils/admin-fetch";
import { loadEmailDrafts, updateEmailDrafts } from "../lib/emailDrafts";
import { registerLeaveGuard } from "../lib/navigation-guard";
import TechNavigationLock, { useTechNavigationLock } from "./tech/TechNavigationLock";

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock("../hooks/useIsMobile", () => ({ default: () => viewport.mobile }));
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
    viewport.mobile = false;
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

  it.each(["content-engine", "content-registry", "data-hygiene", "agent-decisions", "drafts", "health", "documents", "document-requests", "discounts", "email"])("blocks a technician at the %s alias before mounting its child", async (path) => {
    adminFetch.mockResolvedValue({ id: 2, name: "Fixture technician", role: "technician" });
    const ForbiddenChild = vi.fn(() => <div>Forbidden child</div>);
    render(<MemoryRouter initialEntries={[`/admin/${path}?id=fixture#context`]}>
      <Routes><Route element={<AdminLayoutV2 />}>
        <Route path={`/admin/${path}`} element={<ForbiddenChild />} />
        <Route path="/admin/today" element={<div>Authorized schedule</div>} />
      </Route></Routes>
    </MemoryRouter>);
    expect(await screen.findByText("Authorized schedule")).toBeInTheDocument();
    expect(screen.queryByText("Forbidden child")).not.toBeInTheDocument();
    expect(ForbiddenChild).not.toHaveBeenCalled();
  });

  it.each(["payers", "billing-recovery", "invoices", "banking", "tax"].flatMap((path) => ["csr", "technician"].map((role) => ({ path, role }))))(
    "blocks $role at the migrated $path route before mounting its content",
    async ({ path, role }) => {
      adminFetch.mockResolvedValue({ id: 2, name: "Fixture staff", role });
      const ForbiddenChild = vi.fn(() => <div>Restricted billing content</div>);
      render(<MemoryRouter initialEntries={[`/admin/${path}?source=fixture`]}>
        <Routes><Route element={<AdminLayoutV2 />}>
          <Route path={`/admin/${path}`} element={<ForbiddenChild />} />
          <Route path="/admin/today" element={<div>Authorized schedule</div>} />
        </Route></Routes></MemoryRouter>);
      expect(await screen.findByText("Authorized schedule")).toBeInTheDocument();
      expect(ForbiddenChild).not.toHaveBeenCalled();
    },
  );

  it("lands a technician deep link to an owner-only page on /admin/today", async () => {
    adminFetch.mockResolvedValue({ id: 2, name: "Fixture technician", role: "technician" });
    render(<MemoryRouter initialEntries={["/admin/dashboard"]}><Routes><Route element={<AdminLayoutV2 />}>
      <Route path="/admin/dashboard" element={<div>Owner dashboard</div>} />
      <Route path="/admin/today" element={<div>Field workspace</div>} />
    </Route></Routes></MemoryRouter>);
    expect(await screen.findByText("Field workspace")).toBeInTheDocument();
    expect(screen.queryByText("Owner dashboard")).not.toBeInTheDocument();
  });

  it.each([
    ["/admin/today", false],
    ["/admin/today/tools", false],
    ["/admin/schedule", true],
  ])("on mobile at %s the admin top bar and tab bar are present: %s", async (path, chrome) => {
    viewport.mobile = true;
    adminFetch.mockResolvedValue({ id: 2, name: "Fixture technician", role: "technician" });
    render(<MemoryRouter initialEntries={[path]}><Routes><Route element={<AdminLayoutV2 />}>
      <Route path="/admin/today/*" element={<div>Today content</div>} />
      <Route path="/admin/schedule" element={<div>Schedule content</div>} />
    </Route></Routes></MemoryRouter>);
    await screen.findByText(chrome ? "Schedule content" : "Today content");
    expect(Boolean(screen.queryByRole("button", { name: "Open menu" }))).toBe(chrome);
    expect(Boolean(screen.queryByRole("navigation", { name: "Primary" }))).toBe(chrome);
    if (chrome) {
      const tabs = within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("link").map((link) => link.textContent);
      expect(tabs).toEqual(["Today", "Schedule", "Customers", "Messages", "Settings"]);
    }
    const padding = document.getElementById("admin-main").style;
    if (chrome) expect(padding.paddingTop).not.toBe("0px");
    else expect([padding.paddingTop, padding.paddingBottom, padding.paddingLeft, padding.paddingRight]).toEqual(["0px", "0px", "0px", "0px"]);
  });

  it("keeps Dashboard (not Today) in the mobile tab bar for an admin", async () => {
    viewport.mobile = true;
    render(<MemoryRouter initialEntries={["/admin/schedule"]}><Routes><Route element={<AdminLayoutV2 />}>
      <Route path="/admin/schedule" element={<div>Schedule content</div>} />
    </Route></Routes></MemoryRouter>);
    await screen.findByText("Schedule content");
    const tabs = within(screen.getByRole("navigation", { name: "Primary" })).getAllByRole("link").map((link) => link.textContent);
    expect(tabs).toEqual(["Dashboard", "Schedule", "Customers", "Messages", "Settings"]);
  });

  it("explicit sign-out clears local Email recovery and invalidates pending callbacks", async () => {
    const session = loadEmailDrafts(1);
    updateEmailDrafts(session, (drafts) => ({ ...drafts, replies: { fixture: "Private unsent edit" } }));
    render(<MemoryRouter initialEntries={["/admin/dashboard"]}><Routes>
      <Route element={<AdminLayoutV2 />}><Route path="/admin/dashboard" element={<div>Admin child</div>} /></Route>
      <Route path="/admin/login" element={<div>Signed out</div>} />
    </Routes></MemoryRouter>);
    await screen.findByText("Admin child");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await screen.findByText("Signed out");
    expect(loadEmailDrafts(1).drafts.replies).toEqual({});
    expect(updateEmailDrafts(session, () => ({ replies: { fixture: "Late result" } }))).toBeNull();
  });

  // Sign-out calls navigate() from a plain button — no popstate, no <a
  // href> click — so a page's own in-app draft guard (CustomersPageV2's
  // guardLink/guardHistory) never sees it. It must go through the shared
  // registry instead (client/src/lib/navigation-guard.js), the same one a
  // draft-bearing page like CustomersPageV2 registers itself with.
  it("asks the shared navigation guard before sign-out, and honors a decline", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    function DraftChild() {
      const [open, setOpen] = React.useState(false);
      React.useEffect(() => {
        if (!open) return undefined;
        return registerLeaveGuard(() => window.confirm("Discard the open draft?"));
      }, [open]);
      return <button onClick={() => setOpen(true)}>Open draft</button>;
    }
    render(<MemoryRouter initialEntries={["/admin/dashboard"]}><Routes>
      <Route element={<AdminLayoutV2 />}><Route path="/admin/dashboard" element={<DraftChild />} /></Route>
      <Route path="/admin/login" element={<div>Signed out</div>} />
    </Routes></MemoryRouter>);
    await screen.findByRole("button", { name: "Open draft" });
    fireEvent.click(screen.getByRole("button", { name: "Open draft" }));

    // Declined: sign-out is blocked, credentials and the page are untouched.
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(screen.queryByText("Signed out")).not.toBeInTheDocument();
    expect(localStorage.getItem("waves_admin_token")).toBe("test-token");

    // Confirmed: the same click now signs out.
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    await screen.findByText("Signed out");
    expect(localStorage.getItem("waves_admin_token")).toBeNull();
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

  it("holds the sidebar, sign-out and palette while a field action is in flight (TechNavigationLock)", async () => {
    function BusyChild() {
      const { setNavigationBusy } = useTechNavigationLock();
      const location = useLocation();
      return <>
        <button type="button" onClick={() => setNavigationBusy(true)}>Start contact</button>
        <output data-testid="where">{location.pathname}</output>
      </>;
    }
    render(
      <TechNavigationLock>
        <MemoryRouter initialEntries={["/admin/today"]}>
          <Routes>
            <Route element={<AdminLayoutV2 />}>
              <Route path="/admin/today" element={<BusyChild />} />
              <Route path="/admin/customers" element={<div>Customers page</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TechNavigationLock>,
    );
    await screen.findByRole("button", { name: "Start contact" });
    fireEvent.click(screen.getByRole("button", { name: "Start contact" }));
    const sidebar = document.getElementById("admin-sidebar");
    expect(sidebar).toHaveAttribute("aria-busy", "true");
    const customersLink = within(sidebar).getAllByRole("link", { name: /Customers/ })[0];
    fireEvent.click(customersLink);
    expect(screen.getByTestId("where")).toHaveTextContent("/admin/today");
    expect(screen.queryByText("Customers page")).not.toBeInTheDocument();
  });
});
