// @vitest-environment jsdom
// Field workspace (/admin/today) opens with no signal from the offline pass a
// verified /admin/auth/me left for the same token (ported from the #5590
// TechLayout tests). Any other admin path, and any server answer, keeps the
// plain verification behavior.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import AdminLayoutV2, { AUTH_CHECK_TIMEOUT_MS } from "./AdminLayoutV2";
import TechNavigationLock from "./tech/TechNavigationLock";

function LoginProbe() {
  const location = useLocation();
  return <div>{`Staff login ${location.pathname}${location.search}`}</div>;
}

function renderAt(initialPath = "/admin/today?visit=row%3Atwo") {
  return render(
    <TechNavigationLock>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<AdminLayoutV2 />}>
            <Route path="/admin/today" element={<div>Saved route content</div>} />
            <Route path="/admin/dashboard" element={<div>Admin dashboard content</div>} />
          </Route>
          <Route path="/admin/login" element={<LoginProbe />} />
        </Routes>
      </MemoryRouter>
    </TechNavigationLock>,
  );
}

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), clone() { return this; }, json: vi.fn(async () => body), text: vi.fn(async () => "") };
}

function staffJwt(exp = Math.floor(Date.now() / 1000) + 3600, sig = "fixture-signature") {
  const part = (value) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "HS256" })}.${part({ exp })}.${sig}`;
}
const LIVE_TOKEN = staffJwt();
const TECH = { id: "tech-1", name: "River Tech", role: "technician" };
function seedOfflinePass(token, profile = TECH) {
  localStorage.setItem("waves_tech_offline_pass", JSON.stringify({ binding: token.split(".")[2], profile }));
}
const offline = () => vi.fn(async () => { throw new TypeError("Failed to fetch"); });

describe("AdminLayoutV2 field workspace offline fallback", () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("opens the saved route from this token's pass when /admin/auth/me gets no answer", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seedOfflinePass(LIVE_TOKEN);
    vi.stubGlobal("fetch", offline());
    renderAt();
    expect(await screen.findByText("Saved route content")).toBeInTheDocument();
    expect(localStorage.getItem("waves_admin_token")).toBe(LIVE_TOKEN);
  });

  it("opens from the pass when the verification request hangs past the bound", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seedOfflinePass(LIVE_TOKEN);
    vi.stubGlobal("fetch", vi.fn((_url, options = {}) => new Promise((_, reject) => {
      options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })));
    renderAt();
    expect(screen.getByRole("status")).toHaveTextContent("Verifying staff access");
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_CHECK_TIMEOUT_MS + 100); });
    expect(await screen.findByText("Saved route content")).toBeInTheDocument();
  });

  it("an uppercase /ADMIN/TODAY bookmark gets the same offline fallback (pre-push P1)", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seedOfflinePass(LIVE_TOKEN);
    vi.stubGlobal("fetch", offline());
    render(
      <TechNavigationLock>
        <MemoryRouter initialEntries={["/ADMIN/TODAY"]}>
          <Routes>
            <Route element={<AdminLayoutV2 />}>
              <Route path="/admin/today" element={<div>Saved route content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TechNavigationLock>,
    );
    expect(await screen.findByText("Saved route content")).toBeInTheDocument();
  });

  it("an account switch in another tab while on another admin page reaches Today as the new login (pre-push P1)", async () => {
    const NEW_TOKEN = staffJwt(undefined, "newer-signature");
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    vi.stubGlobal("fetch", vi.fn(async (_url, options = {}) => {
      const auth = options.headers?.Authorization || "";
      return response(200, auth.endsWith(NEW_TOKEN)
        ? { id: "tech-2", name: "Newer Tech", role: "technician" }
        : { id: "tech-1", name: "River Tech", role: "technician" });
    }));
    function Dashboard() { const go = useNavigate(); return <button type="button" onClick={() => go("/admin/today")}>to today</button>; }
    function Today() { const { user } = useOutletContext() || {}; return <div>{`Today as ${user?.name}`}</div>; }
    render(
      <TechNavigationLock>
        <MemoryRouter initialEntries={["/admin/schedule"]}>
          <Routes>
            <Route element={<AdminLayoutV2 />}>
              <Route path="/admin/schedule" element={<Dashboard />} />
              <Route path="/admin/today" element={<Today />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TechNavigationLock>,
    );
    await screen.findByRole("button", { name: "to today" });
    localStorage.setItem("waves_admin_token", NEW_TOKEN);
    await act(async () => { window.dispatchEvent(new StorageEvent("storage", { key: "waves_admin_token" })); });
    await screen.findByRole("button", { name: "to today" });
    await act(async () => { screen.getByRole("button", { name: "to today" }).click(); });
    expect(await screen.findByText("Today as Newer Tech")).toBeInTheDocument();
  });

  it("leaving Today after an offline open re-runs the online check before another admin page mounts (Codex #5573 r8)", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seedOfflinePass(LIVE_TOKEN);
    const fetchMock = offline();
    vi.stubGlobal("fetch", fetchMock);
    function Today() { const go = useNavigate(); return <button type="button" onClick={() => go("/admin/schedule")}>to schedule</button>; }
    render(
      <TechNavigationLock>
        <MemoryRouter initialEntries={["/admin/today"]}>
          <Routes>
            <Route element={<AdminLayoutV2 />}>
              <Route path="/admin/today" element={<Today />} />
              <Route path="/admin/schedule" element={<div>Schedule content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TechNavigationLock>,
    );
    await screen.findByRole("button", { name: "to schedule" });
    const before = fetchMock.mock.calls.length;
    let scheduleEverMounted = false;
    const observer = new MutationObserver(() => { if (document.body.textContent.includes("Schedule content")) scheduleEverMounted = true; });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    await act(async () => { screen.getByRole("button", { name: "to schedule" }).click(); });
    observer.disconnect();
    expect(scheduleEverMounted).toBe(false);
    await act(async () => {});
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    expect(screen.queryByText("Schedule content")).not.toBeInTheDocument();
  });

  it("entering Today after a failed check on another page re-runs it and opens from the pass (Codex #5573 r9)", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seedOfflinePass(LIVE_TOKEN);
    vi.stubGlobal("fetch", offline());
    function Go() { const go = useNavigate(); return <button type="button" onClick={() => go("/admin/today")}>to today</button>; }
    render(
      <TechNavigationLock>
        <MemoryRouter initialEntries={["/admin/schedule"]}>
          <Go />
          <Routes>
            <Route element={<AdminLayoutV2 />}>
              <Route path="/admin/schedule" element={<div>Schedule content</div>} />
              <Route path="/admin/today" element={<div>Saved route content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TechNavigationLock>,
    );
    await screen.findByText(/Unable to verify staff access/i);
    await act(async () => { screen.getByRole("button", { name: "to today" }).click(); });
    expect(await screen.findByText("Saved route content")).toBeInTheDocument();
  });

  it("entering Today while another page's check still hangs restarts it as the bounded field check (pre-push P1)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seedOfflinePass(LIVE_TOKEN);
    vi.stubGlobal("fetch", vi.fn((_url, options = {}) => new Promise((_, reject) => {
      options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })));
    function Go() { const go = useNavigate(); return <button type="button" onClick={() => go("/admin/today")}>to today</button>; }
    render(
      <TechNavigationLock>
        <MemoryRouter initialEntries={["/admin/schedule"]}>
          <Go />
          <Routes>
            <Route element={<AdminLayoutV2 />}>
              <Route path="/admin/schedule" element={<div>Schedule content</div>} />
              <Route path="/admin/today" element={<div>Saved route content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TechNavigationLock>,
    );
    await act(async () => { screen.getByRole("button", { name: "to today" }).click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_CHECK_TIMEOUT_MS + 100); });
    expect(await screen.findByText("Saved route content")).toBeInTheDocument();
  });

  it("a direct /admin/today load makes one staff check, not two (Codex #5573 r10)", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    const fetchMock = vi.fn(async () => response(200, TECH));
    vi.stubGlobal("fetch", fetchMock);
    renderAt();
    expect(await screen.findByText("Saved route content")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/admin/auth/me"))).toHaveLength(1);
  });

  it("a technician who must rotate their password goes to the signed-in change page from Today (Codex #5573 r11)", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    vi.stubGlobal("fetch", vi.fn(async () => response(200, { ...TECH, mustChangePassword: true, email: "tech@example.com" })));
    render(
      <TechNavigationLock>
        <MemoryRouter initialEntries={["/admin/today"]}>
          <Routes>
            <Route element={<AdminLayoutV2 />}>
              <Route path="/admin/today" element={<div>Saved route content</div>} />
            </Route>
            <Route path="/admin/change-password" element={<div>Change password page</div>} />
            <Route path="/admin/forgot-password" element={<div>Forgot password page</div>} />
          </Routes>
        </MemoryRouter>
      </TechNavigationLock>,
    );
    expect(await screen.findByText("Change password page")).toBeInTheDocument();
    expect(localStorage.getItem("waves_admin_token")).toBe(LIVE_TOKEN);
  });

  it("leaving Today while its bounded check is pending restarts it unbounded, so a slow answer still verifies (Codex #5573 r12)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    const pending = [];
    vi.stubGlobal("fetch", vi.fn((_url, options = {}) => new Promise((resolve, reject) => {
      pending.push({ resolve, signal: options.signal });
      options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })));
    function Today() { const go = useNavigate(); return <button type="button" onClick={() => go("/admin/schedule")}>to schedule</button>; }
    function Go() { const go = useNavigate(); return <button type="button" onClick={() => go("/admin/schedule")}>leave</button>; }
    render(
      <TechNavigationLock>
        <MemoryRouter initialEntries={["/admin/today"]}>
          <Go />
          <Routes>
            <Route element={<AdminLayoutV2 />}>
              <Route path="/admin/today" element={<Today />} />
              <Route path="/admin/schedule" element={<div>Schedule content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </TechNavigationLock>,
    );
    await act(async () => { screen.getByRole("button", { name: "leave" }).click(); });
    const unbounded = pending[pending.length - 1];
    expect(unbounded.signal).toBeUndefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_CHECK_TIMEOUT_MS + 100); });
    await act(async () => { unbounded.resolve(response(200, TECH)); });
    expect(await screen.findByText("Schedule content")).toBeInTheDocument();
  });

  it("treats a 2xx whose body cannot be read as weak signal", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seedOfflinePass(LIVE_TOKEN);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ...response(200, null), json: () => Promise.reject(new TypeError("network error")) })));
    renderAt();
    expect(await screen.findByText("Saved route content")).toBeInTheDocument();
    expect(localStorage.getItem("waves_admin_token")).toBe(LIVE_TOKEN);
  });

  it.each([
    ["a pass written for another token", () => seedOfflinePass(staffJwt(undefined, "previous-login"))],
    ["an expired token", () => {
      const expired = staffJwt(Math.floor(Date.now() / 1000) - 60);
      localStorage.setItem("waves_admin_token", expired);
      seedOfflinePass(expired);
    }],
    ["only a stored profile and no pass", () => localStorage.setItem("waves_admin_user", JSON.stringify(TECH))],
    ["no stored data at all", () => {}],
  ])("never opens offline with %s", async (_label, seed) => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seed();
    vi.stubGlobal("fetch", offline());
    renderAt();
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to verify staff access");
    expect(screen.queryByText("Saved route content")).not.toBeInTheDocument();
  });

  it("keeps the verification error on a server error even with a valid pass", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seedOfflinePass(LIVE_TOKEN);
    vi.stubGlobal("fetch", vi.fn(async () => response(503, { error: "Unavailable" })));
    renderAt();
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to verify staff access");
    expect(screen.queryByText("Saved route content")).not.toBeInTheDocument();
    expect(localStorage.getItem("waves_admin_token")).toBe(LIVE_TOKEN);
  });

  it("does not open a non-field admin path from the pass", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seedOfflinePass(LIVE_TOKEN, { id: "admin-1", name: "Owner", role: "admin" });
    vi.stubGlobal("fetch", offline());
    renderAt("/admin/dashboard");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to verify staff access");
    expect(screen.queryByText("Admin dashboard content")).not.toBeInTheDocument();
  });

  it.each([
    ["/admin/today", TECH, "Saved route content"],
    ["/admin/dashboard", { id: "admin-1", name: "Owner", role: "admin" }, "Admin dashboard content"],
  ])("writes the offline pass and profile copy for the token it verified at %s", async (path, profile, content) => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    vi.stubGlobal("fetch", vi.fn(async () => response(200, profile)));
    renderAt(path);
    expect(await screen.findByText(content)).toBeInTheDocument();
    const pass = JSON.parse(localStorage.getItem("waves_tech_offline_pass"));
    expect(pass).toMatchObject({ binding: "fixture-signature", profile: { id: profile.id } });
    expect(JSON.parse(localStorage.getItem("waves_admin_user"))).toMatchObject({ id: profile.id });
  });

  it("clears the session, saved route and pass on a 401 and sends the field path to login", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    localStorage.setItem("adminToken", "legacy-token");
    localStorage.setItem("waves_admin_user", JSON.stringify(TECH));
    localStorage.setItem("waves_tech_route_snapshot", JSON.stringify({ techId: "tech-1" }));
    seedOfflinePass(LIVE_TOKEN);
    vi.stubGlobal("fetch", vi.fn(async () => response(401, { error: "Session has been revoked" })));
    renderAt();
    expect(await screen.findByText(
      `Staff login /admin/login?next=${encodeURIComponent("/admin/today?visit=row%3Atwo")}`,
    )).toBeInTheDocument();
    expect(localStorage.getItem("waves_admin_token")).toBeNull();
    expect(localStorage.getItem("waves_admin_user")).toBeNull();
    expect(localStorage.getItem("waves_tech_route_snapshot")).toBeNull();
    expect(localStorage.getItem("waves_tech_offline_pass")).toBeNull();
    expect(screen.queryByText("Saved route content")).not.toBeInTheDocument();
  });

  it("an old login's late 401 neither redirects nor clears a newer login (pre-push P1)", async () => {
    const NEW_TOKEN = staffJwt(undefined, "newer-signature");
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    let answerOld;
    const calls = [];
    vi.stubGlobal("fetch", vi.fn((_url, options = {}) => {
      const auth = options.headers?.Authorization || "";
      calls.push(auth);
      if (auth.endsWith(LIVE_TOKEN)) return new Promise((resolve) => { answerOld = () => resolve(response(401, { error: "revoked" })); });
      return Promise.resolve(response(200, { ...TECH, id: "tech-2", name: "Newer Tech" }));
    }));
    const hrefBefore = window.location.href;
    renderAt();
    await act(async () => {});
    localStorage.setItem("waves_admin_token", NEW_TOKEN);
    await act(async () => { answerOld(); });
    expect(window.location.href).toBe(hrefBefore);
    expect(localStorage.getItem("waves_admin_token")).toBe(NEW_TOKEN);
    expect(await screen.findByText("Saved route content")).toBeInTheDocument();
    expect(calls.some((a) => a.endsWith(NEW_TOKEN))).toBe(true);
  });

  it("ends the session when any staff API call is answered 401 for the current token", async () => {
    localStorage.setItem("waves_admin_token", LIVE_TOKEN);
    seedOfflinePass(LIVE_TOKEN);
    localStorage.setItem("waves_tech_route_snapshot", JSON.stringify({ techId: "tech-1" }));
    vi.stubGlobal("fetch", vi.fn(async (url) => (String(url).endsWith("/admin/auth/me")
      ? response(200, TECH)
      : response(401, { error: "Session expired" }))));
    renderAt();
    expect(await screen.findByText("Saved route content")).toBeInTheDocument();
    await act(async () => {
      await fetch("/api/admin/schedule/route", { headers: { Authorization: `Bearer ${LIVE_TOKEN}` } });
    });
    expect(await screen.findByText(/Staff login \/admin\/login\?next=/)).toBeInTheDocument();
    expect(localStorage.getItem("waves_admin_token")).toBeNull();
    expect(localStorage.getItem("waves_tech_route_snapshot")).toBeNull();
    expect(localStorage.getItem("waves_tech_offline_pass")).toBeNull();
  });
});
