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
const request = (n) => ({
  id: `req-${n}`,
  title: `Agreement ${n}`,
  status: "open",
  requestStatus: "open",
  contractType: "document_template",
  customerId: `customer-${n}`,
  customer: { name: `Customer ${n}` },
  deliverySummary: {},
});
// Mirrors listDocumentRequests: 1-based pages of `limit` rows, newest first.
const pageOf = (total, path) => {
  const params = new URL(`http://x${path}`).searchParams;
  const limit = Number(params.get("limit"));
  const page = Number(params.get("page"));
  const first = (page - 1) * limit + 1;
  const last = Math.min(total, page * limit);
  const requests = [];
  for (let n = first; n <= last; n += 1) requests.push(request(n));
  return { requests, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
};
const listPaths = () => adminFetch.mock.calls.map(([path]) => path).filter((path) => path.startsWith("/admin/contracts/requests?"));
const lastParams = () => new URL(`http://x${listPaths().at(-1)}`).searchParams;
const rowTitles = () => screen.queryAllByText(/^Agreement \d+$/);

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  adminFetch.mockReset();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, "clipboard");
});

function mount() {
  return render(<MemoryRouter><DocumentRequestsPage /></MemoryRouter>);
}

function mockList(total) {
  adminFetch.mockImplementation((path) => {
    if (path === "/admin/contracts/requests/stats") return Promise.resolve(response({ stats: {} }));
    if (path.startsWith("/admin/contracts/requests?")) return Promise.resolve(response(pageOf(total, path)));
    throw new Error(`Unexpected request: ${path}`);
  });
}

it("pages through a queue longer than 100 rows", async () => {
  mockList(101);
  mount();
  await screen.findByText("Showing 1–100 of 101");
  expect(rowTitles()).toHaveLength(100);
  expect(lastParams().get("page")).toBe("1");
  expect(lastParams().get("limit")).toBe("100");
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Showing 101–101 of 101");
  expect(lastParams().get("page")).toBe("2");
  expect(rowTitles()).toHaveLength(1);
  expect(screen.getByText("Agreement 101")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByText("Showing 1–100 of 101");
  expect(lastParams().get("page")).toBe("1");
  expect(rowTitles()).toHaveLength(100);
});

it("hides the page buttons when everything fits on one page", async () => {
  mockList(3);
  mount();
  await screen.findByText("Showing 1–3 of 3");
  expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();
});

it("returns to page 1 when the search text changes or is cleared", async () => {
  mockList(101);
  mount();
  await screen.findByText("Showing 1–100 of 101");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Showing 101–101 of 101");

  fireEvent.change(screen.getByLabelText("Search requests"), { target: { value: "agreement" } });
  await waitFor(() => expect(lastParams().get("search")).toBe("agreement"));
  expect(lastParams().get("page")).toBe("1");
  await screen.findByText("Showing 1–100 of 101");

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Showing 101–101 of 101");
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() => expect(lastParams().get("search")).toBeNull());
  expect(lastParams().get("page")).toBe("1");
  await screen.findByText("Showing 1–100 of 101");
});

it("returns to page 1 when the status tab changes", async () => {
  mockList(101);
  mount();
  await screen.findByText("Showing 1–100 of 101");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Showing 101–101 of 101");

  fireEvent.click(screen.getByRole("button", { name: "Signed" }));
  await waitFor(() => expect(lastParams().get("status")).toBe("signed"));
  expect(lastParams().get("page")).toBe("1");
  await screen.findByText("Showing 1–100 of 101");
});

it("goes to the last page when a reload returns a page past the end", async () => {
  adminFetch.mockImplementation((path) => {
    if (path === "/admin/contracts/requests/stats") return Promise.resolve(response({ stats: {} }));
    if (path.startsWith("/admin/contracts/requests?")) {
      const params = new URL(`http://x${path}`).searchParams;
      // The queue shrank to 100 rows while the user was moving to page 2.
      if (params.get("page") === "2") return Promise.resolve(response({ ...pageOf(100, path), requests: [] }));
      return Promise.resolve(response(pageOf(listPaths().length === 1 ? 101 : 100, path)));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  mount();
  await screen.findByText("Showing 1–100 of 101");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(listPaths().map((path) => new URL(`http://x${path}`).searchParams.get("page"))).toEqual(["1", "2", "1"]));
  await screen.findByText("Showing 1–100 of 100");
  expect(rowTitles()).toHaveLength(100);
  expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
});

it("keeps page 2 when a late page-1 response lands after the user moved on", async () => {
  const late = deferred();
  let listCalls = 0;
  adminFetch.mockImplementation((path) => {
    if (path === "/admin/contracts/requests/stats") return Promise.resolve(response({ stats: {} }));
    if (path.startsWith("/admin/contracts/requests?")) {
      listCalls += 1;
      if (listCalls === 2) return late.promise;
      return Promise.resolve(response(pageOf(101, path)));
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  mount();
  await screen.findByText("Showing 1–100 of 101");
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(listCalls).toBe(2));

  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Showing 101–101 of 101");
  expect(lastParams().get("page")).toBe("2");

  await act(async () => late.resolve(response(pageOf(101, "/admin/contracts/requests?status=open&limit=100&page=1"))));
  expect(screen.getByText("Showing 101–101 of 101")).toBeInTheDocument();
  expect(rowTitles()).toHaveLength(1);
  expect(screen.getByText("Agreement 101")).toBeInTheDocument();
});

it("keeps the current page after a row action reloads the list", async () => {
  adminFetch.mockImplementation((path, options) => {
    if (path === "/admin/contracts/requests/stats") return Promise.resolve(response({ stats: {} }));
    if (path === "/admin/contracts/req-101/share-link" && options?.method === "POST") {
      return Promise.resolve(response({ signingUrl: "https://example.test/sign/abc" }));
    }
    if (path.startsWith("/admin/contracts/requests?")) return Promise.resolve(response(pageOf(101, path)));
    throw new Error(`Unexpected request: ${path}`);
  });
  mount();
  await screen.findByText("Showing 1–100 of 101");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Showing 101–101 of 101");
  fireEvent.click(screen.getByRole("button", { name: "Link", exact: true }));
  await screen.findByText("Fresh link ready");
  await waitFor(() => expect(listPaths()).toHaveLength(3));
  expect(lastParams().get("page")).toBe("2");
  expect(screen.getByText("Showing 101–101 of 101")).toBeInTheDocument();
});

it("a row action that finishes after the user changed page reloads the current page, not the old one (Codex #7093 r1)", async () => {
  const link = deferred();
  adminFetch.mockImplementation((path, options) => {
    if (path === "/admin/contracts/requests/stats") return Promise.resolve(response({ stats: {} }));
    if (path === "/admin/contracts/req-101/share-link" && options?.method === "POST") return link.promise;
    if (path.startsWith("/admin/contracts/requests?")) return Promise.resolve(response(pageOf(101, path)));
    throw new Error(`Unexpected request: ${path}`);
  });
  mount();
  await screen.findByText("Showing 1–100 of 101");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Showing 101–101 of 101");
  fireEvent.click(screen.getByRole("button", { name: "Link", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Previous" }));
  await screen.findByText("Showing 1–100 of 101");

  await act(async () => {
    link.resolve(response({ signingUrl: "https://example.test/sign/abc" }));
    await link.promise;
  });
  await screen.findByText("Fresh link ready");
  await waitFor(() => expect(listPaths()).toHaveLength(4));
  // The action's reload asked for page 1, the page on screen; page 2 never comes back.
  expect(lastParams().get("page")).toBe("1");
  expect(screen.getByText("Showing 1–100 of 101")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
});

async function freshLink() {
  adminFetch.mockImplementation((path, options) => {
    if (path === "/admin/contracts/requests/stats") return Promise.resolve(response({ stats: {} }));
    if (path === "/admin/contracts/req-1/share-link" && options?.method === "POST") {
      return Promise.resolve(response({ signingUrl: "https://example.test/sign/abc" }));
    }
    if (path.startsWith("/admin/contracts/requests?")) return Promise.resolve(response(pageOf(1, path)));
    throw new Error(`Unexpected request: ${path}`);
  });
  mount();
  await screen.findByText("Agreement 1");
  fireEvent.click(screen.getByRole("button", { name: "Link", exact: true }));
  await screen.findByText("Fresh link ready");
  await screen.findByText("https://example.test/sign/abc");
}

it("shows a copy error, not the success toast, when the clipboard rejects", async () => {
  const writeText = vi.fn().mockRejectedValue(new Error("denied"));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await freshLink();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy the link. Select the link above and copy it.");
  expect(writeText).toHaveBeenCalledWith("https://example.test/sign/abc");
  expect(screen.queryByText("Signing link copied")).not.toBeInTheDocument();
  expect(screen.getByText("https://example.test/sign/abc")).toBeInTheDocument();
});

it("shows a copy error when the clipboard API is missing", async () => {
  await freshLink();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy the link.");
  expect(screen.queryByText("Signing link copied")).not.toBeInTheDocument();
});

it("shows the success toast once the clipboard write resolves", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await freshLink();
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByText("Signing link copied")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
