// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { Link, MemoryRouter } from "react-router-dom";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import EstimatesPageV2 from "./EstimatesPageV2";

vi.mock("../../components/admin/customer360/CustomerSmsPanel", () => ({
  useCustomerSms: () => vi.fn(),
  CustomerSmsProvider: ({ children }) => children,
  openEstimateMessages: vi.fn(),
}));
vi.mock("../../hooks/useFeatureFlag", () => ({
  useFeatureFlag: () => false,
}));
vi.mock("../../components/schedule/CreateAppointmentModal", () => ({
  default: () => null,
}));
vi.mock("./PipelineAnalytics", () => ({
  default: () => <div>Pipeline summary</div>,
  isFollowUpOverdueEstimate: () => false,
  isGoingColdEstimate: () => false,
  isCallTodayEstimate: () => false,
  isPickReasonEstimate: () => false,
  lastEngagementMs: () => null,
}));
vi.mock("./WinLossSlicesCard", () => ({ default: () => null }));
vi.mock("./SourcePerformanceCard", () => ({ default: () => null }));

const ESTIMATES = Array.from({ length: 26 }, (_, index) => {
  const sequence = index + 1;
  const day = sequence === 26 ? 25 : 26;
  return {
    id: `estimate-${String(sequence).padStart(3, "0")}`,
    token: `token-${sequence}`,
    status: "sent",
    customerId: `customer-${sequence}`,
    customerName: `Estimate ${String(sequence).padStart(3, "0")}`,
    customerEmail: `fixture-${sequence}@example.test`,
    customerPhone: `+1941555${String(sequence).padStart(4, "0")}`,
    address: `${sequence} Fixture Avenue`,
    monthlyTotal: 27 - sequence,
    createdAt: new Date(Date.UTC(2026, 9, day, 12, 0, -index)).toISOString(),
    serviceLines: [],
  };
});

function response(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    clone() {
      return this;
    },
  };
}

function renderPage(path, width = 1440) {
  window.innerWidth = width;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <EstimatesPageV2 />
      <Link to="/admin/pipeline?tab=estimates">Exit preview</Link>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const parsed = new URL(String(url), "http://fixture.invalid");
      if (parsed.pathname === "/api/admin/estimates") {
        if (parsed.searchParams.get("sentOnly") === "1") {
          return response({ estimates: ESTIMATES, truncated: true });
        }
        return response({ estimates: [], truncated: false });
      }
      return response({ resolved: 0, drafted: 0, sources: [] });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  "/admin/pipeline?tab=estimates",
  "/admin/pipeline?tab=estimates&tableControls=0",
])("keeps the existing controls when the preview is off: %s", async (path) => {
  renderPage(path);
  await screen.findByText("Estimate 001");
  expect(
    screen.getByRole("searchbox", { name: "Search estimates" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("searchbox", { name: "Estimates search" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("navigation", { name: "Estimates pagination" }),
  ).not.toBeInTheDocument();
});

it("pages, sorts, searches, and resets the desktop loaded batch", async () => {
  const { container } = renderPage(
    "/admin/pipeline?tab=estimates&tableControls=1",
  );
  await screen.findByText("Estimate 001");
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
  expect(screen.getByText("1–25 of 26 loaded estimates")).toBeInTheDocument();
  expect(container.querySelectorAll("[data-estimate-id]")).toHaveLength(25);

  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByText("Estimate 026")).toBeInTheDocument();
  expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();

  fireEvent.change(
    screen.getByRole("searchbox", { name: "Estimates search" }),
    { target: { value: "Estimate 001" } },
  );
  expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  expect(container.querySelectorAll("[data-estimate-id]")).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Reset filters" }));
  fireEvent.change(screen.getByLabelText("Estimates sort"), {
    target: { value: "amount-asc" },
  });
  expect(await screen.findByText("Estimate 026")).toBeInTheDocument();
  expect(container.querySelector("[data-estimate-id]")).toHaveAttribute(
    "data-estimate-id",
    "estimate-026",
  );

  fireEvent.change(screen.getByLabelText("Estimates rows per page"), {
    target: { value: "500" },
  });
  expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
  expect(container.querySelectorAll("[data-estimate-id]")).toHaveLength(26);

  fireEvent.click(screen.getByRole("link", { name: "Exit preview" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Estimates sort")).not.toBeInTheDocument(),
  );
  expect(container.querySelector("[data-estimate-id]")).toHaveAttribute(
    "data-estimate-id",
    "estimate-001",
  );
});

it("opens the preview page containing an estimate notification target", async () => {
  const { container } = renderPage(
    "/admin/pipeline?tab=estimates&tableControls=1&estimateId=estimate-026",
  );
  await waitFor(() =>
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument(),
  );
  const target = container.querySelector('[data-estimate-id="estimate-026"]');
  expect(target).toBeInTheDocument();
  await waitFor(() => expect(target).toHaveClass("ring-2"));
  expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
});

it("globally sorts named mobile cards before paging and searching", async () => {
  const { container } = renderPage(
    "/admin/pipeline?tab=estimates&tableControls=1",
    390,
  );
  await screen.findByText("Estimate 001");
  expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
  expect(container.querySelectorAll("[data-estimate-id]")).toHaveLength(25);
  expect(screen.getByText(/loaded list hit its size cap/i)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText("Estimates sort"), {
    target: { value: "amount-asc" },
  });
  expect(await screen.findByText("Estimate 026")).toBeInTheDocument();
  expect(container.querySelector("[data-estimate-id]")).toHaveAttribute(
    "data-estimate-id",
    "estimate-026",
  );
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(await screen.findByText("Estimate 001")).toBeInTheDocument();

  fireEvent.change(
    screen.getByRole("searchbox", { name: "Estimates search" }),
    { target: { value: "26 Fixture Avenue" } },
  );
  expect(await screen.findByText("Estimate 026")).toBeInTheDocument();
  expect(screen.getByText("1 result")).toBeInTheDocument();
  expect(
    screen.getByRole("button", {
      name: "Open Estimate 026 customer estimate history",
    }),
  ).toBeInTheDocument();
  expect(screen.getByText("Page 1 of 1")).toBeInTheDocument();
});
