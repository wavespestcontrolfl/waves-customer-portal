// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const AGREEMENT_KEY = "service_agreement.lawn_ornamental";
const AGREEMENT_BODY = "Customer: {{customer.name}}\nService plan: {{service.name}}\nStart date: {{agreement.start_date}}";
const agreement = (overrides = {}) => ({
  templateKey: AGREEMENT_KEY,
  name: "Lawn Agreement",
  category: "service_agreement",
  documentType: "service_agreement",
  status: "active",
  requiresSignature: true,
  variables: [],
  tags: [],
  ...overrides,
});
const agreementDetail = ({ template = {}, body = AGREEMENT_BODY } = {}) => ({
  template: {
    ...agreement(template),
    activeVersion: { versionNumber: 1, title: "Lawn and Ornamental Agreement", body },
  },
  versions: [],
});

const GUIDE_KEY = "marketing.pest_products_safety";
const guide = {
  templateKey: GUIDE_KEY,
  name: "Pest Products Guide",
  category: "marketing",
  documentType: "customer_guide",
  status: "active",
  requiresSignature: false,
  variables: [],
  tags: [],
};
const guideDetail = {
  template: { ...guide, activeVersion: { versionNumber: 1, title: "Pest Products and Safety Guide", body: "Hello {{customer.name}}" } },
  versions: [],
};
const bulkPreview = (sendable, name) => ({
  counts: { matched: sendable, sendable, duplicateSkipped: 0 },
  productGuide: { productCount: 3 },
  sampleCustomers: [{ id: `sample-${name}`, name }],
});

const CUSTOMER = { id: "customer-1", firstName: "Jordan", lastName: "Example", address: "1 Test St", phone: "(941) 555-0100" };

// Routes a request to the first matching handler; anything else fails the test.
function routes(handlers) {
  adminFetch.mockImplementation((path, options = {}) => {
    for (const [match, handler] of handlers) {
      if (match(path, options)) return Promise.resolve(handler(path, options));
    }
    throw new Error(`Unexpected request: ${options.method || "GET"} ${path}`);
  });
}
const isList = (path, options) => path.startsWith("/admin/document-templates?") && !options.method;
const is = (target, method) => (path, options) => path === target && (options.method || "GET") === method;
const calls = (target, method) => adminFetch.mock.calls.filter(([path, options = {}]) => path === target && (options.method || "GET") === method);

async function pickCustomer() {
  fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Jordan" } });
  fireEvent.click(await screen.findByRole("button", { name: /Jordan Example/ }));
}

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Element.prototype.scrollIntoView = vi.fn();
  adminFetch.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("Create link sends only the Values staff entered, and a refusal names the missing fields", async () => {
  routes([
    [isList, () => response({ templates: [agreement()] })],
    [is(`/admin/document-templates/${AGREEMENT_KEY}`, "GET"), () => response(agreementDetail())],
    [(path) => path.startsWith("/admin/customers?"), () => response({ customers: [CUSTOMER] })],
    [is(`/admin/document-templates/${AGREEMENT_KEY}/contracts`, "POST"), () => response(
      { error: "Document has unresolved merge fields.", unresolvedVariables: ["agreement.start_date"] },
      { ok: false, status: 400 },
    )],
  ]);

  render(<DocumentTemplatesPage />);
  await screen.findByDisplayValue("Lawn Agreement");
  // No sample service or dates sit in the field; the hint names what this document uses.
  expect(screen.getByLabelText("Values")).toHaveValue("");
  expect(screen.getByText("Fields this document takes from Values: agreement.start_date, service.name.")).toBeInTheDocument();

  await pickCustomer();
  fireEvent.click(screen.getByRole("button", { name: "Create link" }));

  expect(await screen.findByText("Document has unresolved merge fields. Missing: agreement.start_date.")).toBeInTheDocument();
  const [[, { body }]] = calls(`/admin/document-templates/${AGREEMENT_KEY}/contracts`, "POST");
  expect(body).toMatchObject({ customerId: "customer-1", values: {} });
  expect(JSON.stringify(body)).not.toMatch(/Quarterly Pest Control|2026-06-10/);
});

it("a preview that lands after the audience changed is ignored, and Send batch sends the reviewed request with its count", async () => {
  const late = deferred();
  const previews = [];
  routes([
    [isList, () => response({ templates: [guide] })],
    [is(`/admin/document-templates/${GUIDE_KEY}`, "GET"), () => response(guideDetail)],
    [is(`/admin/document-templates/${GUIDE_KEY}/bulk-preview`, "POST"), (_path, options) => {
      previews.push(options.body.audience);
      return previews.length === 1 ? late.promise : response(bulkPreview(5, "Everyone sample"));
    }],
    [is(`/admin/document-templates/${GUIDE_KEY}/bulk-send`, "POST"), () => response({ summary: { sentSms: 5 } }, { status: 202 })],
  ]);

  render(<DocumentTemplatesPage />);
  await screen.findByDisplayValue("Pest Products Guide");
  const [, bulkPreviewButton] = screen.getAllByRole("button", { name: "Preview" });
  fireEvent.click(bulkPreviewButton);
  fireEvent.change(screen.getByLabelText("Audience"), { target: { value: "all" } });
  await act(async () => {
    late.resolve(response(bulkPreview(2, "Pest-only sample")));
    await late.promise;
  });

  // The pest-only counts never appear beside "All customers", and nothing can be sent from them.
  expect(screen.queryByText("Pest-only sample")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send batch" })).toBeDisabled();

  fireEvent.click(bulkPreviewButton);
  await screen.findByText("Everyone sample");
  fireEvent.click(screen.getByRole("button", { name: "Send batch" }));
  expect(screen.getByText("Send Pest Products Guide to 5 customers?")).toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Send batch" }).at(-1));

  await waitFor(() => expect(calls(`/admin/document-templates/${GUIDE_KEY}/bulk-send`, "POST")).toHaveLength(1));
  const [[, { body }]] = calls(`/admin/document-templates/${GUIDE_KEY}/bulk-send`, "POST");
  expect(body).toMatchObject({ audience: "all", expectedSendable: 5 });
  expect(previews).toEqual(["active_pest", "all", "all"]);
});

it("Send batch refuses when the request changed after the preview, and asks for a fresh preview", async () => {
  routes([
    [isList, () => response({ templates: [guide] })],
    [is(`/admin/document-templates/${GUIDE_KEY}`, "GET"), () => response(guideDetail)],
    [is(`/admin/document-templates/${GUIDE_KEY}/bulk-preview`, "POST"), () => response(bulkPreview(2, "Pest sample"))],
  ]);

  render(<DocumentTemplatesPage />);
  await screen.findByDisplayValue("Pest Products Guide");
  fireEvent.click(screen.getAllByRole("button", { name: "Preview" })[1]);
  await screen.findByText("Pest sample");
  // Values feed every guide in the batch, but sit in another card: editing them does not clear the preview.
  fireEvent.change(screen.getByLabelText("Values"), { target: { value: '{"service": {"name": "Changed"}}' } });
  fireEvent.click(screen.getByRole("button", { name: "Send batch" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Send batch" }).at(-1));

  expect(await screen.findByText("The bulk send settings or Values changed after the preview. Run Preview again before sending.")).toBeInTheDocument();
  expect(calls(`/admin/document-templates/${GUIDE_KEY}/bulk-send`, "POST")).toHaveLength(0);
  expect(screen.queryByText("Pest sample")).not.toBeInTheDocument();
});

it("saving one part of a template keeps the unsaved edits in the other part", async () => {
  let server = agreementDetail({ body: "Original body" });
  routes([
    [isList, () => response({ templates: [agreement({ name: server.template.name })] })],
    [is(`/admin/document-templates/${AGREEMENT_KEY}`, "GET"), () => response(server)],
    [is(`/admin/document-templates/${AGREEMENT_KEY}`, "PUT"), (_path, options) => {
      server = { ...server, template: { ...server.template, name: options.body.name } };
      return response({ template: server.template });
    }],
    [is(`/admin/document-templates/${AGREEMENT_KEY}/versions`, "POST"), (_path, options) => {
      server = { ...server, template: { ...server.template, status: "active", activeVersion: { versionNumber: 2, title: options.body.title, body: options.body.body } } };
      return response({ template: server.template });
    }],
  ]);

  render(<DocumentTemplatesPage />);
  await screen.findByDisplayValue("Original body");

  // Save metadata: the name saves, the unpublished body stays in the editor.
  fireEvent.change(screen.getByLabelText("Body"), { target: { value: "Unpublished body" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Saved name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save metadata" }));
  await screen.findByText("Template saved");
  await waitFor(() => expect(calls(`/admin/document-templates/${AGREEMENT_KEY}`, "GET")).toHaveLength(2));
  expect(screen.getByLabelText("Name")).toHaveValue("Saved name");
  expect(screen.getByLabelText("Body")).toHaveValue("Unpublished body");

  // Publish version: the body publishes, the unsaved name stays; untouched fields take the saved values.
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved name" } });
  fireEvent.click(screen.getByRole("button", { name: "Publish version" }));
  await screen.findByText("Version published");
  await waitFor(() => expect(calls(`/admin/document-templates/${AGREEMENT_KEY}`, "GET")).toHaveLength(3));
  expect(screen.getByLabelText("Name")).toHaveValue("Unsaved name");
  expect(screen.getByLabelText("Body")).toHaveValue("Unpublished body");
  expect(screen.getByText("Version 2")).toBeInTheDocument();
  const [[, { body: published }]] = calls(`/admin/document-templates/${AGREEMENT_KEY}/versions`, "POST");
  expect(published.body).toBe("Unpublished body");
});

it("Preview renders the text in the editor, not the saved version", async () => {
  routes([
    [isList, () => response({ templates: [agreement()] })],
    [is(`/admin/document-templates/${AGREEMENT_KEY}`, "GET"), () => response(agreementDetail())],
    [is(`/admin/document-templates/${AGREEMENT_KEY}/preview`, "POST"), (_path, options) => response({
      rendered: { title: options.body.draft.title, body: `Rendered: ${options.body.draft.body}`, unresolvedVariables: [] },
    })],
  ]);

  render(<DocumentTemplatesPage />);
  await screen.findByDisplayValue("Lawn Agreement");
  fireEvent.change(screen.getByLabelText("Body"), { target: { value: "New clause, not yet published" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Preview" })[0]);

  expect(await screen.findByText("Rendered: New clause, not yet published")).toBeInTheDocument();
  const [[, { body }]] = calls(`/admin/document-templates/${AGREEMENT_KEY}/preview`, "POST");
  expect(body.draft).toEqual({ title: "Lawn and Ornamental Agreement", body: "New clause, not yet published" });
});

it("a failed customer search says so instead of 'no matching customers', and Try again searches again", async () => {
  let searches = 0;
  routes([
    [isList, () => response({ templates: [agreement()] })],
    [is(`/admin/document-templates/${AGREEMENT_KEY}`, "GET"), () => response(agreementDetail())],
    [(path) => path.startsWith("/admin/customers?"), () => {
      searches += 1;
      return searches === 1
        ? response({ error: "Service unavailable" }, { ok: false, status: 503 })
        : response({ customers: [CUSTOMER] });
    }],
  ]);

  render(<DocumentTemplatesPage />);
  await screen.findByDisplayValue("Lawn Agreement");
  fireEvent.change(screen.getByLabelText("Customer"), { target: { value: "Jordan" } });

  expect(await screen.findByText("Customer search failed.")).toBeInTheDocument();
  expect(screen.queryByText("No matching customers found.")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Customer")).toHaveValue("Jordan");

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: /Jordan Example/ })).toBeInTheDocument();
  expect(screen.queryByText("Customer search failed.")).not.toBeInTheDocument();
  expect(searches).toBe(2);
});

it("Copy reports success only when the clipboard accepts the link", async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  routes([
    [isList, () => response({ templates: [agreement()] })],
    [is(`/admin/document-templates/${AGREEMENT_KEY}`, "GET"), () => response(agreementDetail())],
    [(path) => path.startsWith("/admin/customers?"), () => response({ customers: [CUSTOMER] })],
    [is(`/admin/document-templates/${AGREEMENT_KEY}/contracts`, "POST"), () => response({ signingUrl: "https://portal.example/contract/fresh-token", rendered: null })],
  ]);

  render(<DocumentTemplatesPage />);
  await screen.findByDisplayValue("Lawn Agreement");
  await pickCustomer();
  fireEvent.change(screen.getByLabelText("Values"), { target: { value: '{"agreement": {"start_date": "2026-11-03"}}' } });
  fireEvent.click(screen.getByRole("button", { name: "Create link" }));
  await screen.findByText("https://portal.example/contract/fresh-token");

  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByText("Could not copy the link. Select the link above and copy it.")).toBeInTheDocument();
  expect(screen.queryByText("Document link copied")).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByText("Document link copied")).toBeInTheDocument();
  expect(screen.queryByText("Could not copy the link. Select the link above and copy it.")).not.toBeInTheDocument();
  expect(writeText).toHaveBeenCalledWith("https://portal.example/contract/fresh-token");
});
