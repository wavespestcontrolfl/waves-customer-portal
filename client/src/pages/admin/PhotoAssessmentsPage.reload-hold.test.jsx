// @vitest-environment jsdom
// Run analysis resizes the photos before its request starts, so no save is
// open yet. Staff who send and then go Back in an out-of-date tab keep the
// send: the move opens the page with no reload, the Reload bar names the
// send, and the first move after it settles loads the live code.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../native/platform", () => ({ isWavesAdminApp: () => false }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch: vi.fn() }));

import PhotoAssessmentsPage from "./PhotoAssessmentsPage";
import { adminFetch } from "../../lib/adminFetch";
import { noteServerAnswer, resetPortalVersionForTests } from "../../lib/portalVersion";
import { reloadHoldNames } from "../../lib/reloadHolds";
import { PortalUpdateBar, PortalUpdateGate } from "../../components/PortalUpdate";

// Moves the way the browser's Back and Forward buttons do: with no event on
// the page.
let browserMove;
function BrowserMoves() {
  browserMove = useNavigate();
  return null;
}

let reload;
beforeEach(() => {
  resetPortalVersionForTests();
  document.head.insertAdjacentHTML("beforeend", '<meta name="portal-build" content="aaa111aaa111">');
  sessionStorage.clear();
  reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  document.head.querySelectorAll('meta[name="portal-build"]').forEach((el) => el.remove());
});

it("an out-of-date tab keeps a photo assessment that is still resizing when staff go Back; the first move after it settles loads the live code", async () => {
  const images = [];
  vi.stubGlobal("Image", class { set src(_url) { images.push(this); } });
  adminFetch.mockImplementation((path) => Promise.resolve(path.includes("/funnel")
    ? { ok: true, json: async () => ({ lawn: {}, pest: {} }) }
    : { ok: true, json: async () => ({ assessments: [] }) }));
  render(
    <MemoryRouter initialEntries={["/admin/pipeline", "/admin/lawn-assessments"]} initialIndex={1}>
      <BrowserMoves />
      <PortalUpdateBar />
      <PortalUpdateGate fallback={<p>Loading the new version...</p>}>
        <Routes>
          <Route path="/admin/lawn-assessments" element={<PhotoAssessmentsPage />} />
          <Route path="/admin/pipeline" element={<h1>Pipeline</h1>} />
        </Routes>
      </PortalUpdateGate>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "New assessment" }));
  fireEvent.change(document.querySelector('input[type="file"]'), {
    target: { files: [new File(["x"], "lawn.jpg", { type: "image/jpeg" })] },
  });
  act(() => { noteServerAnswer(new Headers({ "X-Portal-Build": "bbb222bbb222", "X-Portal-Boot": "2000" })); });
  expect(reloadHoldNames()).not.toContain("photo-assessment");
  fireEvent.click(screen.getByRole("button", { name: "Run analysis" }));
  await waitFor(() => expect(images).toHaveLength(1));

  act(() => browserMove(-1));
  expect(screen.getByRole("heading", { name: "Pipeline" })).toBeInTheDocument();
  await act(async () => {});
  expect(reload).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(screen.getByText("A photo assessment is still being sent.")).toBeInTheDocument();
  expect(reload).not.toHaveBeenCalled();

  await act(async () => images[0].onerror());
  expect(reloadHoldNames()).not.toContain("photo-assessment");
  act(() => browserMove(1));
  expect(screen.getByText("Loading the new version...")).toBeInTheDocument();
  await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
});
