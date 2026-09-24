// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DocumentRequestsPage from "./DocumentRequestsPage";

const { adminFetch } = vi.hoisted(() => ({ adminFetch: vi.fn() }));
vi.mock("../../lib/adminFetch", () => ({ adminFetch }));

const response = (data, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => data,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const request = (id, title) => ({
  id,
  title,
  status: "open",
  requestStatus: "open",
  contractType: "document_template",
  customerId: `customer-${id}`,
  customer: { name: `Customer ${id}` },
  deliverySummary: {},
});

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  adminFetch.mockReset();
});

afterEach(cleanup);

function mount() {
  return render(<MemoryRouter><DocumentRequestsPage /></MemoryRouter>);
}

it("keeps fresh request data when an older overlapping load resolves later", async () => {
  const old = deferred();
  let listCalls = 0;
  adminFetch.mockImplementation((path) => {
    if (path === "/admin/contracts/requests/stats") {
      return Promise.resolve(response({ stats: { open: 1 } }));
    }
    if (path.startsWith("/admin/contracts/requests?")) {
      listCalls += 1;
      if (listCalls === 1) return old.promise;
      return Promise.resolve(response({ requests: [request("fresh", "Fresh agreement")] }));
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  mount();
  await waitFor(() => expect(listCalls).toBe(1));
  fireEvent(window, new Event("focus"));
  await screen.findByText("Fresh agreement");
  expect(screen.queryByText("Loading document requests...")).not.toBeInTheDocument();

  await act(async () => old.resolve(response({ requests: [request("stale", "Stale agreement")] })));
  expect(screen.getByText("Fresh agreement")).toBeInTheDocument();
  expect(screen.queryByText("Stale agreement")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
});

it("offers an in-page retry after a list refresh fails", async () => {
  let listCalls = 0;
  adminFetch.mockImplementation((path) => {
    if (path === "/admin/contracts/requests/stats") return Promise.resolve(response({ stats: {} }));
    if (path.startsWith("/admin/contracts/requests?")) {
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve(response({ error: "Temporary outage" }, { ok: false, status: 503 }));
      return Promise.resolve(response({ requests: [request("retry", "Recovered agreement")] }));
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Temporary outage");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Recovered agreement");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
