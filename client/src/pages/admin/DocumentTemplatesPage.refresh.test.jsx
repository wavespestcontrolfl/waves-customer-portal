// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DocumentTemplatesPage from "./DocumentTemplatesPage";

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
const template = (name) => ({
  templateKey: "agreement.standard",
  name,
  category: "service_agreement",
  documentType: "service_agreement",
  status: "active",
  requiresSignature: true,
  variables: [],
  tags: [],
});
const detail = (name) => ({
  template: {
    ...template(name),
    activeVersion: { versionNumber: 1, title: "Standard agreement", body: "Original body" },
  },
  versions: [],
});

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Element.prototype.scrollIntoView = vi.fn();
  adminFetch.mockReset();
});

afterEach(cleanup);

it("refreshes the template list in the background without blanking it or overwriting a dirty draft", async () => {
  const background = deferred();
  let listCalls = 0;
  adminFetch.mockImplementation((path) => {
    if (path === "/admin/document-templates/agreement.standard") {
      return Promise.resolve(response(detail("Original template")));
    }
    if (path.startsWith("/admin/document-templates?")) {
      listCalls += 1;
      if (listCalls === 1) return Promise.resolve(response({ templates: [template("Original template")] }));
      return background.promise;
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(<DocumentTemplatesPage />);
  await screen.findByDisplayValue("Original template");
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved local name" } });

  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(listCalls).toBe(2));
  expect(screen.getByText("Original template")).toBeInTheDocument();
  expect(screen.queryByText("Loading templates…")).not.toBeInTheDocument();

  background.resolve(response({ templates: [template("Server renamed template")] }));
  await screen.findByText("Server renamed template");
  expect(screen.getByLabelText("Name")).toHaveValue("Unsaved local name");
  expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
});

it("ignores a late detail response after the user selects another template", async () => {
  const firstDetail = deferred();
  const other = { ...template("Other template"), templateKey: "agreement.other" };
  adminFetch.mockImplementation((path) => {
    if (path.startsWith("/admin/document-templates?")) {
      return Promise.resolve(response({ templates: [template("First template"), other] }));
    }
    if (path === "/admin/document-templates/agreement.standard") return firstDetail.promise;
    if (path === "/admin/document-templates/agreement.other") {
      return Promise.resolve(response({
        template: { ...other, activeVersion: { versionNumber: 2, title: "Current title", body: "Current body" } },
        versions: [],
      }));
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(<DocumentTemplatesPage />);
  fireEvent.click(await screen.findByRole("button", { name: /Other template/ }));
  await screen.findByDisplayValue("Current title");

  firstDetail.resolve(response(detail("Stale first template")));
  await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Other template"));
  expect(screen.getByLabelText("Document title")).toHaveValue("Current title");
});

it("retries the failed detail read without reloading the list", async () => {
  let listCalls = 0;
  let detailCalls = 0;
  adminFetch.mockImplementation((path) => {
    if (path.startsWith("/admin/document-templates?")) {
      listCalls += 1;
      return Promise.resolve(response({ templates: [template("Retry template")] }));
    }
    if (path === "/admin/document-templates/agreement.standard") {
      detailCalls += 1;
      if (detailCalls === 1) return Promise.resolve(response({ error: "Detail unavailable" }, { ok: false, status: 503 }));
      return Promise.resolve(response(detail("Recovered template")));
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(<DocumentTemplatesPage />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Detail unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByDisplayValue("Recovered template");
  expect(listCalls).toBe(1);
  expect(detailCalls).toBe(2);
});

it("does not let a successful background list refresh erase an operation error", async () => {
  let listCalls = 0;
  adminFetch.mockImplementation((path, options = {}) => {
    if (path.startsWith("/admin/document-templates?") && !options.method) {
      listCalls += 1;
      return Promise.resolve(response({ templates: [template("Operation template")] }));
    }
    if (path === "/admin/document-templates/agreement.standard" && options.method === "PUT") {
      return Promise.resolve(response({ error: "Save rejected" }, { ok: false, status: 409 }));
    }
    if (path === "/admin/document-templates/agreement.standard") {
      return Promise.resolve(response(detail("Operation template")));
    }
    throw new Error(`Unexpected request: ${path}`);
  });

  render(<DocumentTemplatesPage />);
  await screen.findByDisplayValue("Operation template");
  fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Save rejected");

  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(listCalls).toBe(2));
  expect(screen.getByRole("alert")).toHaveTextContent("Save rejected");
  expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
});
