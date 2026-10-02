// @vitest-environment jsdom
// Cold reopen in a dead zone, with the REAL feature-flag hook: the staff check
// and the flag read both hang. Both are bounded, so the field workspace still
// opens from this token's offline pass and the route content renders.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("../hooks/useIsMobile", () => ({ default: () => false }));
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
import { FLAGS_FETCH_TIMEOUT_MS } from "../hooks/useFeatureFlag";

function staffJwt(exp = Math.floor(Date.now() / 1000) + 3600) {
  const part = (value) => btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${part({ alg: "HS256" })}.${part({ exp })}.fixture-signature`;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("opens the saved route when the staff check and the flag read both hang", async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.setItem("waves_admin_token", staffJwt());
  localStorage.setItem("waves_tech_offline_pass", JSON.stringify({
    binding: "fixture-signature",
    profile: { id: "tech-1", name: "River Tech", role: "technician" },
  }));
  // Every request hangs until its own abort fires.
  vi.stubGlobal("fetch", vi.fn((_url, options = {}) => new Promise((_, reject) => {
    options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })));

  render(
    <TechNavigationLock><MemoryRouter initialEntries={["/admin/today"]}>
      <Routes>
        <Route element={<AdminLayoutV2 />}>
          <Route path="/admin/today" element={<div>Saved route content</div>} />
        </Route>
      </Routes>
    </MemoryRouter></TechNavigationLock>,
  );

  await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_CHECK_TIMEOUT_MS + 100); });
  await act(async () => { await vi.advanceTimersByTimeAsync(FLAGS_FETCH_TIMEOUT_MS + 100); });

  expect(await screen.findByText("Saved route content")).toBeInTheDocument();
});
