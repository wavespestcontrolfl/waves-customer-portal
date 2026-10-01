// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerGeocodeReviewPanel, { confirmDiscardDraft } from "./CustomerGeocodeReviewPanel";

vi.mock("@react-google-maps/api", () => ({
  useJsApiLoader: () => ({ isLoaded: true, loadError: null }),
  GoogleMap: ({ children }) => <div>{children}</div>,
  Marker: () => null,
}));

function response(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    statusText: status >= 400 ? "Request failed" : "OK",
    headers: { "Content-Type": "application/json" },
  }));
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
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
    vi.restoreAllMocks();
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

  it("shows an actionable queue without exposing raw review reasons", async () => {
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, records: [record()], total: 1 })));
    render(<CustomerGeocodeReviewPanel onSelectCustomer={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    expect(screen.getByRole("button", { name: "Synthetic Customer" })).toBeInTheDocument();
    expect(screen.getByText("Choose the exact primary service location on the map.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review location" })).toBeInTheDocument();
    expect(screen.queryByText("internal_zero_results")).not.toBeInTheDocument();
  });

  it("opens the linked customer directly when no draft is open", async () => {
    const onSelectCustomer = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, records: [record()], total: 1 })));
    render(<CustomerGeocodeReviewPanel onSelectCustomer={onSelectCustomer} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Synthetic Customer" }));
    expect(onSelectCustomer).toHaveBeenCalledWith("customer-1");
  });

  it("confirms before discarding an active draft to open the linked customer", async () => {
    const onSelectCustomer = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, records: [record()], total: 1 })));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CustomerGeocodeReviewPanel onSelectCustomer={onSelectCustomer} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Do not lose this draft." } });

    fireEvent.click(screen.getByRole("button", { name: "Synthetic Customer" }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(onSelectCustomer).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Evidence")).toHaveValue("Do not lose this draft.");

    window.confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Synthetic Customer" }));
    expect(onSelectCustomer).toHaveBeenCalledWith("customer-1");
  });

  it.each([
    ["provider_unavailable", "Retry saved address", "retry"],
    ["verified", "Revoke verification", "revoke"],
  ])("posts revision-only %s actions", async (status, buttonName, action) => {
    const detail = record({
      customer: {
        ...record().customer,
        ...(status === "provider_unavailable" ? { latitude: null, longitude: null } : {}),
      },
      review: {
        status,
        reason: "opaque_internal_reason",
        ...(status === "verified" ? { latitude: 27.49, longitude: -82.57 } : {}),
      },
    });
    const calls = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      calls.push([String(url), options]);
      return response({ enabled: true, ...detail });
    }));
    render(<CustomerGeocodeReviewPanel customerId="customer-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    if (action === "revoke") expect(window.confirm).toHaveBeenCalledOnce();
    await waitFor(() => expect(calls.some(([, options]) => options.method === "POST")).toBe(true));
    const post = calls.find(([, options]) => options.method === "POST");
    expect(JSON.parse(post[1].body)).toEqual({ revision: "revision-1", action });
  });

  it("does not revoke a pin when the confirmation is declined", async () => {
    const detail = record({
      customer: { ...record().customer, latitude: 27.49, longitude: -82.57 },
      review: { status: "verified", reason: "opaque_internal_reason", latitude: 27.49, longitude: -82.57 },
    });
    const calls = [];
    vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      calls.push([String(url), options]);
      return response({ enabled: true, ...detail });
    }));
    render(<CustomerGeocodeReviewPanel customerId="customer-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke verification" }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(calls.some(([, options]) => options.method === "POST")).toBe(false);
    expect(screen.getByRole("button", { name: "Revoke verification" })).toBeInTheDocument();
  });

  it("keeps the current-page draft and disables pagination until it is closed", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "This page-one draft is intentionally left behind." } });
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByLabelText("Evidence")).toHaveValue("This page-one draft is intentionally left behind.");
    expect(urls.some((url) => url.includes("limit=25&offset=25"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("button", { name: "Page two Customer" })).toBeInTheDocument();
    expect(urls.some((url) => url.includes("limit=25&offset=25"))).toBe(true);
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  it("preserves an open draft while the panel is collapsed and reopened", async () => {
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, records: [record()], total: 1 })));
    render(<CustomerGeocodeReviewPanel />);
    const panelButton = await screen.findByRole("button", { name: /Address review queue/ });
    fireEvent.click(panelButton);
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Preserve this collapsed draft." } });

    fireEvent.click(panelButton);
    expect(screen.getByLabelText("Evidence")).not.toBeVisible();
    fireEvent.click(panelButton);
    expect(screen.getByLabelText("Evidence")).toHaveValue("Preserve this collapsed draft.");
  });

  it("does not present the previous page under a failed offset and retries that offset", async () => {
    const first = record();
    const second = record({ customer: { ...record().customer, id: "customer-26", first_name: "Page two" } });
    let pageTwoAttempts = 0;
    const onResolved = vi.fn();
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

    render(<CustomerGeocodeReviewPanel onSelectCustomer={vi.fn()} onResolved={onResolved} />);
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
    expect(onResolved).not.toHaveBeenCalled();
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

  it("shows a changed saved pin while preserving the old draft until acknowledgment", async () => {
    const original = record();
    const latest = record({
      revision: "revision-2",
      customer: { ...record().customer, latitude: 27.55, longitude: -82.65 },
    });
    const pendingRefresh = deferred();
    const bodies = [];
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") {
        bodies.push(JSON.parse(options.body));
        return response({ enabled: true, ...latest, review: { status: "verified" } });
      }
      reads += 1;
      if (reads === 1) return response({ enabled: true, ...original });
      if (reads === 2) return pendingRefresh.promise;
      return response({ enabled: true, ...latest });
    }));

    const view = render(<CustomerGeocodeReviewPanel customerId="customer-1" refreshToken={1} />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Preserve this customer confirmation." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));

    view.rerender(<CustomerGeocodeReviewPanel customerId="customer-1" refreshToken={2} />);
    expect(await screen.findByText("Loading address review…")).toBeInTheDocument();
    expect(screen.getByLabelText("Evidence")).toHaveValue("Preserve this customer confirmation.");
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();

    pendingRefresh.resolve(await response({ error: "Synthetic refresh failure" }, 503));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic refresh failure");
    expect(screen.getByLabelText("Evidence")).toHaveValue("Preserve this customer confirmation.");
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Latest saved pin: 27.55, -82.65")).toBeInTheDocument();
    expect(screen.getByLabelText("Address")).toHaveValue("100 Test Ave");
    expect(screen.getByLabelText("Latitude")).toHaveValue("27.49");
    expect(screen.getByLabelText("Longitude")).toHaveValue("-82.57");
    expect(screen.getByLabelText("Evidence")).toHaveValue("Preserve this customer confirmation.");
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "I reviewed the latest record" }));
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0].revision).toBe("revision-2");
    expect(bodies[0].evidence).toBe("Preserve this customer confirmation.");
  });

  it("keeps row actions isolated while another row has a draft or pending save", async () => {
    const first = record({
      customer: { ...record().customer, latitude: null, longitude: null },
      review: { status: "provider_unavailable" },
    });
    const second = record({
      customer: {
        ...record().customer,
        id: "customer-2",
        first_name: "Other",
        last_name: "Queue",
        latitude: null,
        longitude: null,
      },
      review: { status: "provider_unavailable" },
      revision: "revision-2",
    });
    const pendingSave = deferred();
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") {
        posts += 1;
        return pendingSave.promise;
      }
      return response({ enabled: true, records: [first, second], total: 2 });
    }));

    render(<CustomerGeocodeReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Retry saved address" })[0]);

    expect(screen.getAllByRole("button", { name: "Review location" })[1]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Retry saved address" })[1]).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "Retry saved address" })[1]);
    expect(posts).toBe(1);

    await act(async () => pendingSave.resolve(await response({ enabled: true, ...first })));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Review location" })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole("button", { name: "Review location" })[0]);
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Keep this row's draft." } });

    expect(screen.getByText("Latest saved pin: No saved pin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review location" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Retry saved address" }).at(-1)).toBeDisabled();
    expect(screen.getByLabelText("Evidence")).toHaveValue("Keep this row's draft.");
  });

  it("preserves a directory draft while external refresh blocks stale rows and pagination", async () => {
    const original = record();
    const other = record({
      customer: { ...record().customer, id: "customer-2", first_name: "Other", last_name: "Queue" },
    });
    const latest = record({
      revision: "revision-2",
      customer: { ...record().customer, address_line1: "200 Directory Refresh Ave" },
    });
    const pendingRefresh = deferred();
    const bodies = [];
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") {
        bodies.push(JSON.parse(options.body));
        return response({ enabled: true, ...latest, review: { status: "verified" } });
      }
      reads += 1;
      if (reads === 1) return response({ enabled: true, records: [original, other], total: 26 });
      if (reads === 2) return pendingRefresh.promise;
      if (reads === 3) return response({ enabled: true, records: [other], total: 25 });
      return response({ enabled: true, records: [latest, other], total: 26 });
    }));

    const onSelectCustomer = vi.fn();
    const view = render(<CustomerGeocodeReviewPanel refreshToken={1} onSelectCustomer={onSelectCustomer} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Review location" })[0]);
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Preserve this directory site note." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    expect(screen.getByText("Showing 1–2 of 26")).toBeInTheDocument();

    view.rerender(<CustomerGeocodeReviewPanel refreshToken={2} onSelectCustomer={onSelectCustomer} />);
    expect(await screen.findByText("Loading address review…")).toBeInTheDocument();
    expect(screen.getByLabelText("Evidence")).toHaveValue("Preserve this directory site note.");
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Other Queue" })).not.toBeInTheDocument();
    expect(screen.queryByText("Showing 1–2 of 26")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();

    pendingRefresh.resolve(await response({ error: "Synthetic directory refresh failure" }, 503));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic directory refresh failure");
    expect(screen.getByLabelText("Evidence")).toHaveValue("Preserve this directory site note.");
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Other Queue" })).not.toBeInTheDocument();
    expect(screen.queryByText("Showing 1–2 of 26")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("current saved review is unavailable");
    expect(screen.getByLabelText("Evidence")).toHaveValue("Preserve this directory site note.");
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "I reviewed the latest record" })).not.toBeInTheDocument();
    expect(screen.queryByText("Showing 1–2 of 26")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("200 Directory Refresh Ave, Bradenton, FL, 34205")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I reviewed the latest record" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Other Queue" })).toBeInTheDocument();
    expect(screen.getByText("Showing 1–2 of 26")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "200 Directory Refresh Ave" } });
    fireEvent.click(screen.getByRole("button", { name: "I reviewed the latest record" }));
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      revision: "revision-2",
      evidence: "Preserve this directory site note.",
    });
    expect(bodies[0].address).toBeUndefined();
  });

  it("returns to the preceding page when resolving the last row", async () => {
    const first = record();
    const last = record({
      customer: { ...record().customer, id: "customer-26", first_name: "Last", latitude: null, longitude: null },
      review: { status: "provider_unavailable" },
    });
    let removed = false;
    const urls = [];
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      urls.push(String(url));
      if (options.method === "POST") {
        removed = true;
        return response({ enabled: true, ...last });
      }
      if (String(url).includes("offset=25")) {
        return response({ enabled: true, records: removed ? [] : [last], total: removed ? 25 : 26 });
      }
      return response({ enabled: true, records: [first], total: removed ? 25 : 26 });
    }));
    render(<CustomerGeocodeReviewPanel onSelectCustomer={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByRole("button", { name: "Last Customer" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry saved address" }));
    expect(await screen.findByRole("button", { name: "Synthetic Customer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Address review queue/ })).toHaveTextContent("25");
    expect(screen.queryByRole("button", { name: "Previous" })).not.toBeInTheDocument();
    expect(urls.filter((url) => url.includes("offset=0")).length).toBeGreaterThan(1);
  });

  it("shows an empty queue after verifying the last open review", async () => {
    let resolved = false;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") {
        resolved = true;
        return response({ enabled: true, ...record(), review: { status: "verified" } });
      }
      return response({ enabled: true, records: resolved ? [] : [record()], total: resolved ? 0 : 1 });
    }));

    function LastRowHarness() {
      const [, setParentRefresh] = React.useState(0);
      return <CustomerGeocodeReviewPanel onResolved={() => setParentRefresh((value) => value + 1)} />;
    }
    render(<LastRowHarness />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Confirmed at the front entry." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));

    expect(await screen.findByText("No addresses need review.")).toBeInTheDocument();
    expect(screen.queryByText(/current saved review is unavailable/i)).not.toBeInTheDocument();
  });

  it("distinguishes reviewed statuses and only revokes a recorded matching pin", async () => {
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
    expect(screen.getByRole("button", { name: "Revoke verification" })).toBeInTheDocument();

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

  it("withholds 409 acknowledgment when the current review fails to reload", async () => {
    const original = record();
    const latest = record({
      revision: "revision-2",
      customer: { ...record().customer, address_line1: "200 Recovered Ave" },
    });
    const bodies = [];
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") {
        bodies.push(JSON.parse(options.body));
        return bodies.length === 1
          ? response({ error: "That address already exists as another property on this customer.", code: "address_matches_existing_property" }, 409)
          : response({ enabled: true, ...latest, review: { status: "verified" } });
      }
      reads += 1;
      if (reads === 1) return response({ enabled: true, records: [original], total: 1 });
      if (reads === 2) return response({ error: "Synthetic 409 refresh failure" }, 503);
      return response({ enabled: true, records: [latest], total: 1 });
    }));

    render(<CustomerGeocodeReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Keep this note until the saved review loads." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));

    expect(await screen.findByText("Synthetic 409 refresh failure")).toBeInTheDocument();
    expect(screen.getByText(/That address already exists as another property on this customer\./)).toBeInTheDocument();
    expect(screen.getByLabelText("Evidence")).toHaveValue("Keep this note until the saved review loads.");
    expect(screen.getByLabelText("Address")).toHaveValue("100 Test Ave");
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "I reviewed the latest record" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("200 Recovered Ave, Bradenton, FL, 34205")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I reviewed the latest record" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "I reviewed the latest record" }));
    expect(screen.getByRole("button", { name: "Verify pin" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));
    await waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies[1].revision).toBe("revision-2");
  });

  it("opens the latest record and requires acknowledgment after a direct action conflicts", async () => {
    const original = record({
      customer: { ...record().customer, latitude: null, longitude: null },
      review: { status: "provider_unavailable" },
    });
    const latest = record({
      ...original,
      revision: "revision-2",
      customer: { ...original.customer, address_line1: "200 Latest Ave" },
    });
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") return response({ error: "This review changed elsewhere." }, 409);
      reads += 1;
      return response({ enabled: true, records: [reads === 1 ? original : latest], total: 1 });
    }));

    render(<CustomerGeocodeReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Retry saved address" }));

    expect(await screen.findByText("200 Latest Ave, Bradenton, FL, 34205")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "I reviewed the latest record" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry saved address" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "I reviewed the latest record" }));
    expect(screen.getByRole("button", { name: "Retry saved address" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("lets an unavailable conflicted draft return to the refreshed queue", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") return response({ error: "This review changed elsewhere." }, 409);
      reads += 1;
      return reads === 1
        ? response({ enabled: true, records: [record()], total: 1 })
        : response({ enabled: true, records: [], total: 0 });
    }));

    render(<CustomerGeocodeReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Discard after the other admin resolves it." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));

    expect(await screen.findByText(/current saved review is unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("No addresses need review.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Evidence")).not.toBeInTheDocument();
    expect(screen.queryByText(/current saved review is unavailable/i)).not.toBeInTheDocument();
  });

  it("ignores a stale refresh conflict for a draft that was already canceled", async () => {
    const original = record();
    const changedElsewhere = record({
      revision: "revision-2",
      customer: { ...record().customer, latitude: 27.55, longitude: -82.65 },
    });
    const pendingRefresh = deferred();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      reads += 1;
      if (reads === 1) return response({ enabled: true, records: [original], total: 1 });
      if (reads === 2) return pendingRefresh.promise;
      return response({ enabled: true, records: [changedElsewhere], total: 1 });
    }));

    const view = render(<CustomerGeocodeReviewPanel refreshToken={1} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Will be canceled before the refresh lands." } });

    view.rerender(<CustomerGeocodeReviewPanel refreshToken={2} />);
    await screen.findByText("Loading address review…");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Evidence")).not.toBeInTheDocument();

    await act(async () => pendingRefresh.resolve(await response({ enabled: true, records: [changedElsewhere], total: 1 })));

    // The canceled draft must not reopen as an orphaned, stuck conflict —
    // there is no form left to show "I reviewed the latest record" on, and
    // the row's normal actions must still work.
    expect(screen.queryByRole("button", { name: "I reviewed the latest record" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review location" })).toBeEnabled();
  });

  it("keeps the queue enabled and drops only the vanished record on a customer_not_found 404", async () => {
    const target = record({
      customer: { ...record().customer, latitude: null, longitude: null },
      review: { status: "provider_unavailable" },
    });
    const remaining = record({
      customer: { ...record().customer, id: "customer-2", first_name: "Still", last_name: "Queued" },
    });
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") return response({ error: "Customer not found", code: "customer_not_found" }, 404);
      reads += 1;
      return reads === 1
        ? response({ enabled: true, records: [target], total: 1 })
        : response({ enabled: true, records: [remaining], total: 1 });
    }));

    render(<CustomerGeocodeReviewPanel onSelectCustomer={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Retry saved address" }));

    // A missing single customer must not be treated like the whole route or
    // gate going away — the queue stays live and simply reloads.
    expect(await screen.findByRole("button", { name: "Still Queued" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Address review queue/ })).toBeInTheDocument();
  });

  it("guards every customer link while any row's draft is active, not just its own", async () => {
    const onSelectCustomer = vi.fn();
    const first = record();
    const second = record({
      customer: { ...record().customer, id: "customer-2", first_name: "Other", last_name: "Queue" },
    });
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, records: [first, second], total: 2 })));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<CustomerGeocodeReviewPanel onSelectCustomer={onSelectCustomer} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));

    fireEvent.click(screen.getAllByRole("button", { name: "Review location" })[0]);
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Keep this row's draft open." } });

    // customer-2's own row has no draft open, but customer-1's does — the
    // guard must fire on EVERY link while any draft is active, not only the
    // link belonging to the row that opened it.
    fireEvent.click(screen.getByRole("button", { name: "Other Queue" }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(onSelectCustomer).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Evidence")).toHaveValue("Keep this row's draft open.");

    window.confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Other Queue" }));
    expect(onSelectCustomer).toHaveBeenCalledWith("customer-2");
  });

  it("clears a conflict from a direct action once its target leaves the refreshed queue", async () => {
    const first = record({
      customer: { ...record().customer, latitude: null, longitude: null },
      review: { status: "provider_unavailable" },
    });
    const second = record({
      customer: {
        ...record().customer,
        id: "customer-2",
        first_name: "Other",
        last_name: "Queue",
        latitude: null,
        longitude: null,
      },
      review: { status: "provider_unavailable" },
      revision: "revision-2",
    });
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") return response({ error: "This review changed elsewhere." }, 409);
      reads += 1;
      // After the conflicting retry, the refreshed queue reflects that
      // another admin already resolved (and removed) the first row.
      return reads === 1
        ? response({ enabled: true, records: [first, second], total: 2 })
        : response({ enabled: true, records: [second], total: 1 });
    }));

    render(<CustomerGeocodeReviewPanel onSelectCustomer={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getAllByRole("button", { name: "Retry saved address" })[0]);

    // The vanished row's conflict must not linger: no orphaned acknowledgment
    // form, no panel-wide error, and the remaining row's own actions stay
    // usable instead of disabled behind a conflict nobody can dismiss.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Synthetic Customer" })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "I reviewed the latest record" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Other Queue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry saved address" })).toBeEnabled();
  });

  it("retries the failed profile refresh from the recovery action instead of clearing it via the queue reload", async () => {
    let getCalls = 0;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") return response({ enabled: true, ...record(), review: { status: "verified" } });
      getCalls += 1;
      return response({ enabled: true, ...record() });
    }));
    const onResolved = vi.fn()
      .mockRejectedValueOnce(new Error("profile reload failed"))
      .mockResolvedValueOnce(undefined);

    render(<CustomerGeocodeReviewPanel customerId="customer-1" onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Confirmed at the gate." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("the customer profile could not refresh");
    expect(onResolved).toHaveBeenCalledOnce();
    const getsAfterSave = getCalls;

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // Recovery must retry the profile reload itself, not another
    // geocode-review queue fetch — the one that would have cleared the
    // warning for free without the profile ever actually refreshing.
    expect(getCalls).toBe(getsAfterSave);
  });

  it("keeps the warning while a retried profile refresh fails again", async () => {
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") return response({ enabled: true, ...record(), review: { status: "verified" } });
      return response({ enabled: true, ...record() });
    }));
    const onResolved = vi.fn().mockRejectedValue(new Error("still down"));

    render(<CustomerGeocodeReviewPanel customerId="customer-1" onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Confirmed at the gate." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the customer profile could not refresh");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("alert")).toHaveTextContent("the customer profile could not refresh");
  });

  it("serializes a double-clicked Refresh retry instead of starting a second reload", async () => {
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") return response({ enabled: true, ...record(), review: { status: "verified" } });
      return response({ enabled: true, ...record() });
    }));
    const pendingRetry = deferred();
    const onResolved = vi.fn()
      .mockRejectedValueOnce(new Error("profile reload failed"))
      .mockImplementationOnce(() => pendingRetry.promise);

    render(<CustomerGeocodeReviewPanel customerId="customer-1" onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Confirmed at the gate." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the customer profile could not refresh");

    const refreshButton = screen.getByRole("button", { name: "Refresh" });
    fireEvent.click(refreshButton);
    // The retry is now in flight — a second click must not start another
    // reload (previously, the profile's stale-response guard would abort
    // that second reload and resolve it as null, letting THIS click's own
    // success handler clear profileRefreshPending before the real retry
    // had actually finished).
    expect(refreshButton).toBeDisabled();
    fireEvent.click(refreshButton);
    expect(onResolved).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent("the customer profile could not refresh");

    await act(async () => pendingRetry.resolve());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("disables the draft's editable fields while its save is pending", async () => {
    const pendingSave = deferred();
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") return pendingSave.promise;
      return response({ enabled: true, records: [record()], total: 1 });
    }));
    render(<CustomerGeocodeReviewPanel onSelectCustomer={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Confirmed on site." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));

    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));
    expect(screen.getByLabelText("Address")).toBeDisabled();
    expect(screen.getByLabelText("Address line 2")).toBeDisabled();
    expect(screen.getByLabelText("City")).toBeDisabled();
    expect(screen.getByLabelText("State")).toBeDisabled();
    expect(screen.getByLabelText("ZIP")).toBeDisabled();
    expect(screen.getByLabelText("Latitude")).toBeDisabled();
    expect(screen.getByLabelText("Longitude")).toBeDisabled();
    expect(screen.getByLabelText("Confirmation source")).toBeDisabled();
    expect(screen.getByLabelText("Evidence")).toBeDisabled();
    expect(screen.getByLabelText("I confirmed this is the primary service location")).toBeDisabled();

    await act(async () => pendingSave.resolve(await response({ enabled: true, ...record(), review: { status: "verified" } })));
  });

  it("reports no open draft once the panel unmounts with a draft open", async () => {
    const onDraftActiveChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, records: [record()], total: 1 })));

    const view = render(<CustomerGeocodeReviewPanel onDraftActiveChange={onDraftActiveChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    expect(onDraftActiveChange).toHaveBeenLastCalledWith(true);

    // The page-level navigation guards rely on this to stop asking once the
    // panel that owned the draft is gone.
    view.unmount();
    expect(onDraftActiveChange).toHaveBeenLastCalledWith(false);
  });

  it.each([
    ["reports the queue disabled", () => response({ enabled: false })],
    ["answers 404 because the route went away", () => response({ error: "Not found" }, 404)],
  ])("clears the active draft and its disabled-warning signal when a refresh %s", async (_label, disabledResponse) => {
    const onDraftActiveChange = vi.fn();
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      reads += 1;
      return reads === 1
        ? response({ enabled: true, records: [record()], total: 1 })
        : disabledResponse();
    }));

    const view = render(<CustomerGeocodeReviewPanel refreshToken={1} onDraftActiveChange={onDraftActiveChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Should not survive a disabled refresh." } });
    expect(onDraftActiveChange).toHaveBeenLastCalledWith(true);

    // A refresh that reports the gate disabled while a draft is open must
    // not leave activeId set — an invisible panel (it renders nothing once
    // disabled) can never keep reporting a draft as active or keep the
    // beforeunload warning armed for a form nobody can see.
    view.rerender(<CustomerGeocodeReviewPanel refreshToken={2} onDraftActiveChange={onDraftActiveChange} />);
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
    expect(onDraftActiveChange).toHaveBeenLastCalledWith(false);
  });

  it("clears the active draft when a resolve 404 means the whole review route or gate went away", async () => {
    const onDraftActiveChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") return response({ error: "Not found" }, 404);
      return response({ enabled: true, records: [record()], total: 1 });
    }));

    render(<CustomerGeocodeReviewPanel onDraftActiveChange={onDraftActiveChange} />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Should not survive a vanished route." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    expect(onDraftActiveChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));

    // A resolve 404 with no customer_not_found code means the whole route or
    // gate disappeared, not just this one record — the same disabled
    // transition as the refresh path above, and it must clear the draft the
    // same way.
    await waitFor(() => expect(onDraftActiveChange).toHaveBeenLastCalledWith(false));
  });

  it("reloads the authoritative record and softens the wording after a non-409, non-404 resolve failure", async () => {
    const original = record();
    const latest = record({
      revision: "revision-2",
      customer: { ...record().customer, address_line1: "300 Recovered After Timeout Ave" },
    });
    const bodies = [];
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") {
        bodies.push(JSON.parse(options.body));
        return response({ error: "Synthetic gateway timeout" }, 502);
      }
      reads += 1;
      return response({ enabled: true, records: [reads === 1 ? original : latest], total: 1 });
    }));

    render(<CustomerGeocodeReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));
    fireEvent.change(screen.getByLabelText("Evidence"), { target: { value: "Confirmed while the gateway is flaky." } });
    fireEvent.click(screen.getByLabelText("I confirmed this is the primary service location"));
    fireEvent.click(screen.getByRole("button", { name: "Verify pin" }));

    // A non-409, non-404 failure can still arrive after the server actually
    // committed (retry commits before ensureCustomerGeocoded, and every
    // action does a final getReviewDetail after commit) — the panel must
    // reload the authoritative record rather than assert the save
    // definitely failed, and keep the draft open to compare against it.
    expect(await screen.findByText("300 Recovered After Timeout Ave, Bradenton, FL, 34205")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Address review may not have saved. The latest record is loaded; check it before trying again.",
    );
    expect(screen.getByLabelText("Evidence")).toHaveValue("Confirmed while the gateway is flaky.");
    expect(screen.getByLabelText("Address")).toHaveValue("100 Test Ave");
    expect(bodies).toHaveLength(1);
  });

  it("does not let an old customer save refresh or replace the next customer", async () => {
    const oldSave = deferred();
    const onResolved = vi.fn();
    const first = record({
      customer: { ...record().customer, latitude: null, longitude: null },
      review: { status: "provider_unavailable" },
    });
    const second = record({
      customer: { ...record().customer, id: "customer-2", first_name: "Current", address_line1: "200 Current Ave" },
      revision: "revision-2",
    });
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      if (options.method === "POST") return oldSave.promise;
      return String(url).includes("customer-2")
        ? response({ enabled: true, ...second })
        : response({ enabled: true, ...first });
    }));
    const view = render(<CustomerGeocodeReviewPanel key="customer-1" customerId="customer-1" onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    fireEvent.click(screen.getByRole("button", { name: "Retry saved address" }));
    view.rerender(<CustomerGeocodeReviewPanel key="customer-2" customerId="customer-2" onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    expect(await screen.findByText("200 Current Ave, Bradenton, FL, 34205")).toBeInTheDocument();
    await act(async () => oldSave.resolve(await response({ enabled: true, ...first })));
    expect(onResolved).not.toHaveBeenCalled();
    expect(screen.getByText("200 Current Ave, Bradenton, FL, 34205")).toBeInTheDocument();
  });

  function dispatchBeforeUnload() {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it("warns on the native beforeunload while a draft is open with no approved discard", async () => {
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, records: [record()], total: 1 })));
    render(<CustomerGeocodeReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));

    const event = dispatchBeforeUnload();
    expect(event.defaultPrevented).toBe(true);
  });

  // A same-tab plain <a href> whose capture-phase click guard (CustomersPageV2's
  // guardLink, Customer360ProfileV2's guardNavigateAway) already confirmed the
  // discard through this exported function, then lets the click become a real
  // document navigation, which fires this native prompt a moment later — one
  // confirm is enough for that one navigation.
  it("does not re-prompt the native beforeunload right after confirmDiscardDraft approves a navigation, but re-arms once that tick passes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.stubGlobal("fetch", vi.fn(() => response({ enabled: true, records: [record()], total: 1 })));
    render(<CustomerGeocodeReviewPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /Address review queue/ }));
    fireEvent.click(screen.getByRole("button", { name: "Review location" }));

    expect(confirmDiscardDraft()).toBe(true);
    const approvedEvent = dispatchBeforeUnload();
    expect(approvedEvent.defaultPrevented).toBe(false);

    // The approval covers that one navigation only — once its tick passes
    // (the confirmed click did not actually leave the page, e.g. a
    // guardHistory revert or a same-page link), the guard re-arms so a
    // later real navigation is never silently unguarded.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const laterEvent = dispatchBeforeUnload();
    expect(laterEvent.defaultPrevented).toBe(true);
  });
});
