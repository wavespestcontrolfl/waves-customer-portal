// @vitest-environment jsdom
// Regression: the property lookup used to take the FIRST customer whose
// street line matched the typed address and silently link them — overwriting
// name/phone/email and stamping their id on the estimate. Two adults at one
// address (spouses quoting separately) put the second person's estimate on
// the first person's profile. The match is now a suggestion the operator
// links explicitly, dismisses, or replaces via the Customer Lookup search.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EstimateToolViewV2 from "./EstimateToolViewV2";

const ADDRESS = "123 Palm Ave, Venice, FL 34285";
const WIFE = {
  id: "cust-wife", firstName: "Jane", lastName: "Doe",
  address: "123 Palm Ave, Venice, FL 34285", phone: "(941) 555-0101", tier: null, monthlyRate: 0,
};
const HUSBAND = {
  id: "cust-husband", firstName: "John", lastName: "Doe",
  address: "123 Palm Ave, Venice, FL 34285", phone: "(941) 555-0102", tier: null, monthlyRate: 0,
};
const ELSEWHERE = {
  id: "cust-other", firstName: "Pat", lastName: "Other",
  address: "9 Oak St, Venice, FL 34285", phone: "(941) 555-0199", tier: null, monthlyRate: 0,
};

function jsonResponse(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    clone() { return this; },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

let customersAtStreet;
let fetchMock;

beforeEach(() => {
  localStorage.setItem("waves_admin_token", "test-token");
  customersAtStreet = [WIFE];
  fetchMock = vi.fn((url) => {
    const path = String(url);
    if (path.includes("/estimator/property-lookup")) return jsonResponse({ enriched: {}, errors: [] });
    // The server does the (unit-aware) address matching now; the client
    // renders exactly what /customers/at-address returns.
    if (path.includes("/admin/customers/at-address")) {
      return jsonResponse({ customers: customersAtStreet });
    }
    if (path.includes("/admin/customers?")) {
      return jsonResponse({ customers: [...customersAtStreet, ELSEWHERE] });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderTool() {
  return render(
    <MemoryRouter>
      <EstimateToolViewV2 />
    </MemoryRouter>,
  );
}

async function lookUp() {
  fireEvent.change(screen.getByPlaceholderText("Start typing an address..."), {
    target: { value: ADDRESS },
  });
  fireEvent.click(screen.getByRole("button", { name: "Property Lookup" }));
  await waitFor(() =>
    expect(screen.getByText(/This address matches/)).toBeInTheDocument(),
  );
}

const chipText = () =>
  screen.getByText(/Existing customer:/).closest("div").textContent;

const spendRequests = () =>
  fetchMock.mock.calls
    .map(([u]) => String(u))
    .filter((u) => u.includes("/customer-spend/"));

describe("address match is a suggestion, never a silent link", () => {
  it("shows the matching customer but links nobody until asked", async () => {
    renderTool();
    await lookUp();

    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    // The candidate set is the server's (unit-aware) answer for the typed
    // address, not a client-side street-substring pass over a search page.
    // POST body, never the query string — a street address must not reach
    // the request log.
    const atAddress = fetchMock.mock.calls.filter(([u]) => String(u).includes("/customers/at-address"));
    expect(atAddress).toHaveLength(1);
    expect(atAddress[0][0]).toBe("/api/admin/customers/at-address");
    expect(atAddress[0][1].method).toBe("POST");
    expect(JSON.parse(atAddress[0][1].body)).toEqual({ address: ADDRESS });
    expect(screen.queryByText("Pat Other")).not.toBeInTheDocument();
    // No chip, no linked-customer spend request: customerId is still empty.
    expect(screen.queryByText(/Existing customer:/)).not.toBeInTheDocument();
    expect(spendRequests()).toEqual([]);
  });

  it("Link applies the chosen customer and keeps the looked-up address", async () => {
    renderTool();
    await lookUp();

    fireEvent.click(screen.getByRole("button", { name: "Link" }));

    await waitFor(() => expect(screen.getByText(/Existing customer:/)).toBeInTheDocument());
    expect(chipText()).toContain("Jane Doe");
    await waitFor(() =>
      expect(spendRequests().some((u) => u.includes("/customer-spend/cust-wife"))).toBe(true),
    );
    expect(screen.getByPlaceholderText("Start typing an address...").value).toBe(ADDRESS);
    expect(screen.queryByText(/This address matches/)).not.toBeInTheDocument();
  });

  it("'Not this person' dismisses the suggestion and links nobody", async () => {
    renderTool();
    await lookUp();

    fireEvent.click(screen.getByRole("button", { name: /Not this person/ }));

    expect(screen.queryByText(/This address matches/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Existing customer:/)).not.toBeInTheDocument();
    expect(spendRequests()).toEqual([]);
  });

  it("lists every household member and links the one that was clicked", async () => {
    customersAtStreet = [WIFE, HUSBAND];
    renderTool();
    await lookUp();

    expect(screen.getByText(/2 existing customers/)).toBeInTheDocument();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("John Doe")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Link" })[1]);

    await waitFor(() => expect(screen.getByText(/Existing customer:/)).toBeInTheDocument());
    expect(chipText()).toContain("John Doe");
    await waitFor(() =>
      expect(spendRequests().some((u) => u.includes("/customer-spend/cust-husband"))).toBe(true),
    );
    expect(spendRequests().some((u) => u.includes("/customer-spend/cust-wife"))).toBe(false);
  });

  it("Unlink on the chip drops the linked customer", async () => {
    renderTool();
    await lookUp();
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    await waitFor(() => expect(screen.getByText(/Existing customer:/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));

    await waitFor(() =>
      expect(screen.queryByText(/Existing customer:/)).not.toBeInTheDocument(),
    );
    // A re-lookup with nobody linked offers the suggestion again.
    await lookUp();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
  });

  it("hides the suggestion once the address is edited, so a stale Link cannot fire", async () => {
    renderTool();
    await lookUp();

    const addressInput = screen.getByPlaceholderText("Start typing an address...");
    fireEvent.change(addressInput, { target: { value: "456 Other Rd, Venice, FL 34285" } });
    expect(screen.queryByText(/This address matches/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link" })).not.toBeInTheDocument();

    // Same address again — the matches still belong to it.
    fireEvent.change(addressInput, { target: { value: ADDRESS } });
    expect(screen.getByText(/This address matches/)).toBeInTheDocument();
  });

  it("a customer-record deep link is linked, shows Unlink, and skips suggestions until unlinked", async () => {
    render(
      <MemoryRouter>
        <EstimateToolViewV2 initialCustomerId="cust-wife" />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Linked customer:/)).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Start typing an address..."), {
      target: { value: ADDRESS },
    });
    fireEvent.click(screen.getByRole("button", { name: "Property Lookup" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/estimator/property-lookup"))).toBe(true),
    );
    expect(screen.queryByText(/This address matches/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(screen.queryByText(/Linked customer:/)).not.toBeInTheDocument();

    await lookUp();
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
  });

  it("does not second-guess a customer the operator already linked", async () => {
    customersAtStreet = [WIFE, HUSBAND];
    renderTool();
    // Link the husband via the Customer Lookup search first.
    fireEvent.change(
      screen.getByPlaceholderText("Name, phone, email, or address..."),
      { target: { value: "John" } },
    );
    const row = await waitFor(() => screen.getByRole("button", { name: /John Doe/ }));
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText(/Existing customer:/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Property Lookup" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/estimator/property-lookup"))).toBe(true),
    );

    expect(screen.queryByText(/This address matches/)).not.toBeInTheDocument();
    expect(chipText()).toContain("John Doe");
  });
});
