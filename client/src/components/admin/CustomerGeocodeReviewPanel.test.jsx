// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CustomerGeocodeReviewPanel from "./CustomerGeocodeReviewPanel";

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
    vi.stubGlobal("fetch", vi.fn((url, options = {}) => {
      calls.push([String(url), options]);
      return response({ enabled: true, ...detail });
    }));
    render(<CustomerGeocodeReviewPanel customerId="customer-1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Primary service location review/ }));
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await waitFor(() => expect(calls.some(([, options]) => options.method === "POST")).toBe(true));
    const post = calls.find(([, options]) => options.method === "POST");
    expect(JSON.parse(post[1].body)).toEqual({ revision: "revision-1", action });
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

    render(<CustomerGeocodeReviewPanel />);
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
});
