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
