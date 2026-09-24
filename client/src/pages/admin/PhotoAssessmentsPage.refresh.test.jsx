// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import PhotoAssessmentsPage from "./PhotoAssessmentsPage";
import { adminFetch } from "../../lib/adminFetch";

vi.mock("../../lib/adminFetch", () => ({ adminFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("finishes the initial read even if Add Assessment opens while it is pending", async () => {
  let finishList;
  adminFetch.mockImplementation((path) => path.includes("/funnel")
    ? Promise.resolve({ ok: true, json: async () => ({ lawn: {}, pest: {} }) })
    : new Promise((resolve) => { finishList = resolve; }));
  render(<MemoryRouter><PhotoAssessmentsPage /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "New assessment" }));
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await act(async () => finishList({ ok: true, json: async () => ({ assessments: [] }) }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  expect(screen.getByText(/No assessments yet/)).toBeInTheDocument();
  adminFetch.mockClear();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(adminFetch).toHaveBeenCalledTimes(2);
});

// Keep Retry and focus in one React batch to exercise the window before
// loading=true removes the automatic-refresh listener.
it.each([false, true])("clears Retry loading when a focus refresh wins (failure=%s)", async (fails) => {
  adminFetch.mockImplementation((path) => Promise.resolve(path.includes("/funnel")
    ? { ok: true, json: async () => ({ lawn: {}, pest: {} }) }
    : { ok: false, status: 503 }));
  render(<MemoryRouter><PhotoAssessmentsPage /></MemoryRouter>);
  const retry = await screen.findByRole("button", { name: "Retry" });
  const pending = [];
  adminFetch.mockImplementation((path) => path.includes("/funnel")
    ? Promise.resolve({ ok: true, json: async () => ({ lawn: {}, pest: {} }) })
    : new Promise((resolve) => pending.push(resolve)));
  act(() => {
    retry.click();
    window.dispatchEvent(new Event("focus"));
  });
  expect(pending).toHaveLength(2);
  await act(async () => pending[0]({ ok: true, json: async () => ({ assessments: [] }) }));
  expect(screen.getByText("Loading…")).toBeInTheDocument();
  await act(async () => pending[1](fails
    ? { ok: false, status: 502 }
    : { ok: true, json: async () => ({ assessments: [] }) }));
  expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
  if (fails) expect(screen.getByText(/List failed \(502\)/)).toBeInTheDocument();
  else expect(screen.getByText(/No assessments yet/)).toBeInTheDocument();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(pending).toHaveLength(3);
  await act(async () => pending[2]({ ok: true, json: async () => ({ assessments: [] }) }));
});
