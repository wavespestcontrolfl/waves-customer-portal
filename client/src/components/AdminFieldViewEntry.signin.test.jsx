// @vitest-environment jsdom
// Field view in front of the real admin shell: a sign-in the shell asks for
// after a Field view landing returns to /admin, so the login that signs in
// next lands by its own switch (pre-push P1). Today opened by hand still
// returns to Today.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

vi.mock("../hooks/useIsMobile", () => ({ default: () => false }));
vi.mock("../hooks/useFeatureFlag", () => ({
  refetchFlags: vi.fn(() => Promise.resolve()),
  useFeatureFlag: vi.fn(() => false),
  useFeatureFlagReady: () => ({ enabled: false, ready: true }),
}));
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

import AdminLayoutV2 from "./AdminLayoutV2";
import AdminFieldViewEntry from "./AdminFieldViewEntry";
import AdminIndexRedirect from "./AdminIndexRedirect";
import TechNavigationLock from "./tech/TechNavigationLock";
import { saveStaffOfflinePass } from "../lib/adminAuth";

const ADMIN = { id: "acct-1", name: "Fixture Admin", role: "admin" };
// The full shell signs out in a few steps, and a fresh sign-in mounts it
// twice; a loaded runner can pass vitest's 5 s default for one test.
const SIGN_IN_WAIT = { timeout: 15000 };
const SHELL_TEST_TIMEOUT = 20000;

function LoginProbe() {
  const location = useLocation();
  return <div>{`Staff login ${location.pathname}${location.search}`}</div>;
}

function TodayChild() {
  React.useEffect(() => {
    fetch("/api/fixture/today-data", { headers: { Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}` } });
  }, []);
  return <div>Today content</div>;
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), clone() { return this; }, json: vi.fn(async () => body), text: vi.fn(async () => "") };
}

function staffJwt(exp = Math.floor(Date.now() / 1000) + 3600) {
  const part = (value) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "HS256" })}.${part({ exp })}.fixture-signature`;
}

// A phone a verified check left signed in, with Field view on. A fresh
// sign-in has no offline pass yet (the first verified check writes it).
function signedIn(token = staffJwt(), { pass = true } = {}) {
  localStorage.setItem("waves_admin_token", token);
  if (pass) saveStaffOfflinePass(token, ADMIN);
  localStorage.setItem(`waves_admin_navigation:${ADMIN.id}`, JSON.stringify({ version: 2, fieldView: true }));
}

function openAt(pathname) {
  return render(
    <TechNavigationLock>
      <MemoryRouter initialEntries={[pathname]}>
        <Routes>
          <Route path="/admin" element={<AdminFieldViewEntry><AdminLayoutV2 /></AdminFieldViewEntry>}>
            <Route index element={<AdminIndexRedirect />} />
            <Route path="today" element={<TodayChild />} />
          </Route>
          <Route path="/admin/login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>
    </TechNavigationLock>,
  );
}

// jsdom has no element scrollTo; the shell scrolls its main area on a page change.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("a 401 from the login check after a Field view landing returns the sign-in to /admin", async () => {
  signedIn();
  vi.stubGlobal("fetch", vi.fn(async () => response(401, { error: "revoked" })));
  openAt("/admin");
  expect(await screen.findByText("Staff login /admin/login?next=%2Fadmin", undefined, SIGN_IN_WAIT)).toBeInTheDocument();
}, SHELL_TEST_TIMEOUT);

it("a 401 from a Today request after a Field view landing returns the sign-in to /admin (session guard)", async () => {
  signedIn();
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).includes("/admin/auth/me")) return response(200, ADMIN);
    if (String(url).includes("/fixture/today-data")) return response(401, { error: "revoked" });
    return response(200, {});
  }));
  openAt("/admin");
  expect(await screen.findByText("Staff login /admin/login?next=%2Fadmin", undefined, SIGN_IN_WAIT)).toBeInTheDocument();
}, SHELL_TEST_TIMEOUT);

it("another tab signing out after a Field view landing returns this tab's sign-in to /admin", async () => {
  signedIn();
  vi.stubGlobal("fetch", vi.fn(async (url) => (String(url).includes("/admin/auth/me") ? response(200, ADMIN) : response(200, {}))));
  openAt("/admin");
  await screen.findByText("Today content", undefined, SIGN_IN_WAIT);
  localStorage.removeItem("waves_admin_token");
  await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: "waves_admin_token" })); });
  expect(await screen.findByText("Staff login /admin/login?next=%2Fadmin", undefined, SIGN_IN_WAIT)).toBeInTheDocument();
}, SHELL_TEST_TIMEOUT);

// Pre-push P1 (round 2): no pass yet, so the shell checks at /admin and its
// own index rule lands on Today; that landing is marked too.
it("after a fresh sign-in (no offline pass yet) the shell's own Today landing returns a later sign-in to /admin", async () => {
  signedIn(staffJwt(), { pass: false });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url).includes("/admin/auth/me")) return response(200, ADMIN);
    if (String(url).includes("/fixture/today-data")) return response(401, { error: "revoked" });
    return response(200, {});
  }));
  openAt("/admin");
  expect(await screen.findByText("Staff login /admin/login?next=%2Fadmin", undefined, SIGN_IN_WAIT)).toBeInTheDocument();
}, SHELL_TEST_TIMEOUT);

it("Today opened by hand still returns the sign-in to Today", async () => {
  signedIn();
  vi.stubGlobal("fetch", vi.fn(async () => response(401, { error: "revoked" })));
  openAt("/admin/today");
  expect(await screen.findByText("Staff login /admin/login?next=%2Fadmin%2Ftoday", undefined, SIGN_IN_WAIT)).toBeInTheDocument();
}, SHELL_TEST_TIMEOUT);

it("an expired token is checked at /admin, so its sign-in returns there", async () => {
  signedIn(staffJwt(Math.floor(Date.now() / 1000) - 60));
  vi.stubGlobal("fetch", vi.fn(async () => response(401, { error: "expired" })));
  openAt("/admin");
  expect(await screen.findByText("Staff login /admin/login?next=%2Fadmin", undefined, SIGN_IN_WAIT)).toBeInTheDocument();
}, SHELL_TEST_TIMEOUT);
