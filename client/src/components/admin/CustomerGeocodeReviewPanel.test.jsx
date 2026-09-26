// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerGeocodeReviewPanel from "./CustomerGeocodeReviewPanel";

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    statusText: status >= 400 ? "Request failed" : "OK",
    headers: { "Content-Type": "application/json" },
  }));
}

function record(overrides = {}) {
  return {
    customer: {
      id: "customer-1",
      first_name: "Synthetic",
      last_name: "Customer",
      address_line1: "100 Test Ave",
      address_line2: "",
      city: "Bradenton",
      state: "FL",
      zip: "34205",
      latitude: 27.49,
      longitude: -82.57,
    },
    review: { status: "needs_pin", reason: "internal_zero_results", source: "automatic" },
    revision: "revision-1",
    next_visit_date: "2026-10-01",
    ...overrides,
  };
}

describe("CustomerGeocodeReviewPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("waves_admin_token", "test-token");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hides the whole feature when the server gate is off", async () => {
    const fetchMock = vi.fn(() => response({ enabled: false }));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<CustomerGeocodeReviewPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(container).toBeEmptyDOMElement();
  });

  it("hides when the sibling backend route is not deployed yet", async () => {
    const fetchMock = vi.fn(() => response({ error: "Not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<CustomerGeocodeReviewPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a load failure without reporting an empty queue", async () => {
    vi.stubGlobal("fetch", vi.fn(() => response({ error: "Synthetic load failure" }, 503)));
    render(<CustomerGeocodeReviewPanel onSelectCustomer={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Synthetic load failure");
    expect(screen.queryByText("No addresses need review.")).not.toBeInTheDocument();
  });

  it.each([
    ["partial_match", "Lookup matched only part of the address."],
    ["coarse_result:locality", "Lookup found only a general area."],
    ["address_changed", "The address changed after review."],
  ])("explains %s in plain language", async (reason, message) => {
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, records: [record({ review: { status: "needs_pin", reason } })], total: 1 })));
    render(<CustomerGeocodeReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    expect(screen.getByText((text) => text.startsWith(message))).toBeInTheDocument();
  });

  it("shows a read-only queue without exposing raw review reasons", async () => {
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, records: [record()], total: 1 })));
    render(<CustomerGeocodeReviewPanel onSelectCustomer={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    expect(screen.getByRole("button", { name: "Synthetic Customer" })).toBeInTheDocument();
    expect(screen.getByText("Choose the exact primary service location on the map.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review location" })).not.toBeInTheDocument();
    expect(screen.queryByText("internal_zero_results")).not.toBeInTheDocument();
  });

  it("paginates the full queue with the server offset", async () => {
    const first = record();
    const second = record({ customer: { ...record().customer, id: "customer-26", first_name: "Page two" } });
    const urls = [];
    vi.stubGlobal("fetch", vi.fn((url) => {
      urls.push(String(url));
      return String(url).includes("offset=25")
        ? response({ enabled: true, records: [second], total: 26 })
        : response({ enabled: true, records: [first], total: 26 });
    }));
    render(<CustomerGeocodeReviewPanel onSelectCustomer={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    expect(screen.getByText("Showing 1–1 of 26")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("button", { name: "Page two Customer" })).toBeInTheDocument();
    expect(urls.some((url) => url.includes("limit=25&offset=25"))).toBe(true);
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  it("does not present the previous page under a failed offset and retries that offset", async () => {
    const first = record();
    const second = record({ customer: { ...record().customer, id: "customer-26", first_name: "Page two" } });
    let pageTwoAttempts = 0;
    const urls = [];
    vi.stubGlobal("fetch", vi.fn((url) => {
      urls.push(String(url));
      if (!String(url).includes("offset=25")) {
        return response({ enabled: true, records: [first], total: 26 });
      }
      pageTwoAttempts += 1;
      return pageTwoAttempts === 1
        ? response({ error: "Synthetic page failure" }, 503)
        : response({ enabled: true, records: [second], total: 26 });
    }));

    render(<CustomerGeocodeReviewPanel onSelectCustomer={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    expect(screen.getByText("Showing 1–1 of 26")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic page failure");
    expect(screen.queryByRole("button", { name: "Synthetic Customer" })).not.toBeInTheDocument();
    expect(screen.queryByText("Showing 26–26 of 26")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("button", { name: "Page two Customer" })).toBeInTheDocument();
    expect(screen.getByText("Showing 26–26 of 26")).toBeInTheDocument();
    expect(urls.filter((url) => url.includes("offset=25"))).toHaveLength(2);
  });

  it("reloads the same customer when its profile refresh token changes", async () => {
    const verified = record({
      customer: { ...record().customer, address_line1: "100 Old Address" },
      review: { status: "verified", source: "site_visit", reviewed_at: "2026-09-24T15:30:00.000Z" },
    });
    const changed = record({
      customer: { ...record().customer, address_line1: "200 Current Address" },
      review: { status: "needs_pin", reason: "address_changed", source: "automatic" },
      revision: "revision-2",
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => response({ enabled: true, ...verified }))
      .mockImplementationOnce(() => response({ enabled: true, ...changed }));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<CustomerGeocodeReviewPanel customerId="customer-1" refreshToken={1} />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    expect(await screen.findByText("100 Old Address, Bradenton, FL, 34205")).toBeInTheDocument();
    expect(screen.getByText("Verified")).toBeInTheDocument();

    view.rerender(<CustomerGeocodeReviewPanel customerId="customer-1" refreshToken={2} />);
    expect(await screen.findByText("200 Current Address, Bradenton, FL, 34205")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Pin needs review")).toBeInTheDocument();
    expect(screen.queryByText("100 Old Address, Bradenton, FL, 34205")).not.toBeInTheDocument();
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
  });

  it("suppresses stale detail while a profile-triggered refresh is pending or fails", async () => {
    const verified = record({
      customer: { ...record().customer, address_line1: "100 Old Address" },
      review: { status: "verified", source: "site_visit", reviewed_at: "2026-09-24T15:30:00.000Z" },
    });
    let finishRefresh;
    const pendingRefresh = new Promise((resolve) => { finishRefresh = resolve; });
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => response({ enabled: true, ...verified }))
      .mockImplementationOnce(() => pendingRefresh));

    const view = render(<CustomerGeocodeReviewPanel customerId="customer-1" refreshToken={1} />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    expect(await screen.findByText("Verified")).toBeInTheDocument();

    view.rerender(<CustomerGeocodeReviewPanel customerId="customer-1" refreshToken={2} />);
    expect(await screen.findByText("Loading address review…")).toBeInTheDocument();
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
    expect(screen.queryByText("100 Old Address, Bradenton, FL, 34205")).not.toBeInTheDocument();

    finishRefresh(await response({ error: "Synthetic refresh failure" }, 503));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic refresh failure");
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
    expect(screen.queryByText("100 Old Address, Bradenton, FL, 34205")).not.toBeInTheDocument();
    expect(screen.queryByText("No addresses need review.")).not.toBeInTheDocument();
  });

  it("distinguishes reviewed statuses and keeps the read slice free of pin actions", async () => {
    const verified = record({
      review: {
        status: "verified",
        source: "site_visit",
        evidence: "Gate entrance checked in person.",
        reviewed_at: "2026-09-24T15:30:00.000Z",
        latitude: 27.49,
        longitude: -82.57,
      },
    });
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, ...verified })));
    const view = render(<CustomerGeocodeReviewPanel customerId="customer-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    expect(screen.getByText(/Verified by Site visit on/)).toBeInTheDocument();
    expect(screen.getByText("Gate entrance checked in person.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke verification" })).not.toBeInTheDocument();

    const automatic = record({ review: { status: "geocoded", source: "google" } });
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, ...automatic })));
    view.rerender(<CustomerGeocodeReviewPanel key="automatic" customerId="customer-2" />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    expect(await screen.findByText("Automatically located")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke verification" })).not.toBeInTheDocument();

    const outside = record({ review: { status: "outside_area", reviewed_at: "2026-09-24T15:30:00.000Z" } });
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, ...outside })));
    view.rerender(<CustomerGeocodeReviewPanel key="outside" customerId="customer-3" />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    expect(await screen.findByText("Confirmed outside service area")).toBeInTheDocument();
  });
});
