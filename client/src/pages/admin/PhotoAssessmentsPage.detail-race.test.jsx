// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import PhotoAssessmentsPage from "./PhotoAssessmentsPage";
import { adminFetch } from "../../lib/adminFetch";

vi.mock("../../lib/adminFetch", () => ({ adminFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const row = (id, first) => ({
  id, type: "lawn", status: "analyzed", source: "public_funnel", claimed_at: "2026-10-29T15:00:00Z",
  headline: `${first} lawn read`, created_at: "2026-10-29T14:00:00Z",
  contact: { first_name: first, last_name: "Example", email: `${first.toLowerCase()}@example.invalid` },
});
const ok = (data) => ({ ok: true, json: async () => data });
const detail = (id, first) => ok({ assessment: { ...row(id, first), can_release: true, report_url: null }, photos: [] });

// Detail reads stay pending until the test resolves them, in any order.
function routeFetch() {
  const pending = {};
  adminFetch.mockImplementation((path) => {
    if (path.startsWith("/admin/photo-assessments/funnel")) return Promise.resolve(ok({ lawn: {}, pest: {} }));
    if (path.startsWith("/admin/photo-assessments?")) return Promise.resolve(ok({ assessments: [row(A, "Alice"), row(B, "Blair")] }));
    if (path.endsWith("/send-report")) return Promise.resolve({ ok: false, status: 409, json: async () => ({ error: "fixture stop" }) });
    return new Promise((resolve) => { pending[path] = resolve; });
  });
  return pending;
}

async function openRow(name) {
  fireEvent.click(await screen.findByText(name));
}
const sheet = () => within(screen.getByRole("dialog", { name: "Lawn Assessment details" }));

it("a late read for the closed row never pairs its email with the open row's send", async () => {
  const pending = routeFetch();
  render(<MemoryRouter><PhotoAssessmentsPage /></MemoryRouter>);
  await openRow("Alice Example");
  fireEvent.click(sheet().getByRole("button", { name: "Close" }));
  await openRow("Blair Example");
  await act(async () => pending[`/admin/photo-assessments/lawn/${B}`](detail(B, "Blair")));
  await act(async () => pending[`/admin/photo-assessments/lawn/${A}`](detail(A, "Alice")));

  expect(sheet().getByText("Lawn Assessment — Blair Example")).toBeInTheDocument();
  expect(sheet().queryByText(/Alice/)).not.toBeInTheDocument();
  fireEvent.click(sheet().getByRole("button", { name: "Send report" }));
  const send = within(screen.getByRole("dialog", { name: "Send report to customer" }));
  expect(send.getByPlaceholderText("prospect@example.com")).toHaveValue("blair@example.invalid");
  await act(async () => fireEvent.click(send.getByRole("button", { name: "Send report" })));
  expect(adminFetch).toHaveBeenCalledWith(`/admin/photo-assessments/lawn/${B}/send-report`, {
    method: "POST",
    body: { email: "blair@example.invalid" },
  });
});

it("the closed row's name and actions are gone while the next row loads", async () => {
  const pending = routeFetch();
  render(<MemoryRouter><PhotoAssessmentsPage /></MemoryRouter>);
  await openRow("Alice Example");
  await act(async () => pending[`/admin/photo-assessments/lawn/${A}`](detail(A, "Alice")));
  expect(sheet().getByText("Lawn Assessment — Alice Example")).toBeInTheDocument();
  fireEvent.click(sheet().getByRole("button", { name: "Close" }));

  await openRow("Blair Example");
  expect(sheet().getByText("Loading…")).toBeInTheDocument();
  expect(sheet().queryByText(/Alice/)).not.toBeInTheDocument();
  expect(sheet().queryByRole("button", { name: "Send report" })).not.toBeInTheDocument();
  expect(sheet().queryByRole("button", { name: "Get link" })).not.toBeInTheDocument();
});
