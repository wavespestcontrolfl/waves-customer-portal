// @vitest-environment jsdom
// Misting system records panel (Customer 360, GATE_MOSQUITO_MISTING): a 404 renders nothing, the current
// calibration and refills show, the over-label preview turns red, and server error text is shown as returned.
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();
vi.mock("../../utils/admin-fetch", () => ({ adminFetch: (...args) => mockFetch(...args) }));

import MistingRecordsPanel from "./MistingRecordsPanel";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const CAL_ID = "22222222-2222-4222-8222-222222222222";

const calibration = (over = {}) => ({
  id: CAL_ID,
  customerId: CUSTOMER,
  propertyId: "p1",
  installedOn: "2026-03-01",
  vendor: "Pynamite",
  model: "Test 55",
  serialNumber: "SN-1",
  tankGallons: 55,
  zoneCount: 2,
  nozzleCount: 40,
  riserCount: 4,
  nozzleFlowFlOzPerMin: 1,
  cycleSeconds: 45,
  mistTimes: ["06:30", "19:30", "22:30"],
  productName: "Sector Misting Concentrate",
  epaRegNo: "1021-1834",
  concentrateFlOzPerTank: 64,
  mixFlOzPerGal: 1.164,
  labelMaxFlOzPer1000CuFtDay: 9.5,
  treatedAreaSqFt: 6000,
  treatedHeightFt: 8,
  treatedVolumeCuFt: 48000,
  outputFlOzPerCycle: 33,
  dailyOutputFlOz: 99,
  labelDailyCapFlOz: 456,
  cabinetLocked: true,
  labelPosted: true,
  scheduleAvoidsPeople: true,
  notes: null,
  source: "staff",
  recordedBy: { id: "t1", name: "Test Tech" },
  createdAt: "2026-03-01T15:00:00.000Z",
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  isCurrent: true,
  ...over,
});

const refill = (over = {}) => ({
  id: "33333333-3333-4333-8333-333333333333",
  customerId: CUSTOMER,
  calibrationId: CAL_ID,
  propertyId: "p1",
  refilledOn: "2026-04-01",
  productName: "Sector Misting Concentrate",
  epaRegNo: "1021-1834",
  concentrateFlOzAdded: 64,
  waterGallonsAdded: 55,
  levelBeforePct: 20,
  counterReset: true,
  notes: null,
  source: "staff",
  recordedBy: { id: "t1", name: "Test Tech" },
  createdAt: "2026-04-01T15:00:00.000Z",
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  ...over,
});

const records = (over = {}) => ({
  properties: [{ id: "p1", label: "Home", address: "1 Test Lane", isPrimary: true }],
  calibrations: [],
  refills: [],
  ...over,
});

const httpError = (status, message) => Object.assign(new Error(message), { status });

beforeEach(() => mockFetch.mockReset());
afterEach(cleanup);

async function openPanel(payload) {
  mockFetch.mockResolvedValueOnce(payload);
  const view = render(<MistingRecordsPanel customerId={CUSTOMER} />);
  fireEvent.click(await screen.findByRole("button", { name: "Show" }));
  return view;
}

describe("MistingRecordsPanel", () => {
  it("renders nothing at all when the records answer 404 (gate off)", async () => {
    mockFetch.mockRejectedValueOnce(httpError(404, "Not enabled"));
    const { container } = render(<MistingRecordsPanel customerId={CUSTOMER} />);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(`/admin/misting-records/customers/${CUSTOMER}/records`));
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });

  it("starts collapsed, and with no calibration says so and offers to record one", async () => {
    mockFetch.mockResolvedValueOnce(records());
    render(<MistingRecordsPanel customerId={CUSTOMER} />);
    expect(await screen.findByText("Misting system")).toBeInTheDocument();
    expect(screen.queryByText("No misting system on file.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(screen.getByText("No misting system on file.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Record install calibration" })).toBeInTheDocument();
  });

  it("shows the current calibration with its daily limit, and the refills with voided rows struck through", async () => {
    await openPanel(records({
      calibrations: [calibration(), calibration({ id: "old", isCurrent: false, nozzleCount: 30 })],
      refills: [
        refill(),
        refill({ id: "r2", refilledOn: "2026-03-15", voidedAt: "2026-03-16T12:00:00.000Z", voidReason: "Wrong tank", levelBeforePct: null, counterReset: false }),
      ],
    }));
    expect(screen.getByText(/Pynamite Test 55, 55 gal tank, 2 zones, serial SN-1/)).toBeInTheDocument();
    expect(screen.getByText(/40 nozzles, 4 risers/)).toBeInTheDocument();
    expect(screen.getByText(/Sector Misting Concentrate \(EPA Reg\. No\. 1021-1834\)/)).toBeInTheDocument();
    expect(screen.getByText(/6:30 AM, 7:30 PM, 10:30 PM, 45 seconds each/)).toBeInTheDocument();
    expect(screen.getByText("Puts out 99 fl oz a day. The label allows 456.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log refill" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New calibration" })).toBeInTheDocument();
    expect(screen.getByText(/level before 20%, counter reset, by Test Tech/)).toBeInTheDocument();
    const voided = screen.getByText(/Mar 15, 2026: Sector Misting Concentrate/);
    expect(voided.className).toMatch(/line-through/);
    expect(screen.getByText(/Voided .*: Wrong tank/)).toBeInTheDocument();
    expect(screen.queryByText(/30 nozzles/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Earlier calibrations \(1\)/ }));
    expect(screen.getByText(/30 nozzles, 4 risers/)).toBeInTheDocument();
  });

  it("groups by real property: the primary has no special NULL reading, and rows with no property list under Removed property", async () => {
    await openPanel(records({
      properties: [
        { id: "p1", label: "Home", address: "1 Test Lane", isPrimary: false },
        { id: "p2", label: "Lake house", address: "2 Test Lane", isPrimary: true },
      ],
      calibrations: [
        calibration({ id: "c-lake", propertyId: "p2", model: "Lake model" }),
        calibration({ id: "c-gone", propertyId: null, isCurrent: false, model: "Gone model" }),
      ],
      refills: [refill({ id: "r-gone", propertyId: null, calibrationId: "c-gone" })],
    }));
    // The current system sits under its own home's label, not under the primary by default.
    expect(screen.getByText("Lake house")).toBeInTheDocument();
    expect(screen.getByText(/Pynamite Lake model/)).toBeInTheDocument();
    // The other home has no system, so it can be offered one; a NULL row never counts as a system.
    expect(screen.getByRole("button", { name: "Record install calibration at another property" })).toBeInTheDocument();
    expect(screen.getByText(/level before 20%, counter reset, Removed property, by Test Tech/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Earlier calibrations \(1\)/ }));
    expect(screen.getByText(/Gone model.*Removed property\./)).toBeInTheDocument();
  });

  it("lists a retired property's records under Removed property with no new work, but still lets staff void a mistake", async () => {
    await openPanel(records({
      calibrations: [calibration({ id: "c-old", propertyId: "retired-1", isCurrent: false, model: "Retired model" })],
      refills: [refill({ id: "r-old", propertyId: "retired-1", calibrationId: "c-old" })],
    }));
    expect(screen.getByText("No misting system on file.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log refill" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New calibration" })).not.toBeInTheDocument();
    expect(screen.getByText(/counter reset, Removed property, by Test Tech/)).toBeInTheDocument();
    // The refill's Void; the server allows voiding a record at a removed property.
    expect(screen.getAllByRole("button", { name: "Void" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Earlier calibrations \(1\)/ }));
    expect(screen.getByText(/Retired model.*Removed property\./)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Void" })).toHaveLength(2);
  });

  it("voids an earlier (superseded) calibration with an inline reason", async () => {
    await openPanel(records({
      calibrations: [calibration(), calibration({ id: "c-earlier", isCurrent: false, model: "Earlier model", createdAt: "2026-02-01T15:00:00.000Z" })],
    }));
    fireEvent.click(screen.getByRole("button", { name: /Earlier calibrations \(1\)/ }));
    const item = screen.getByText(/Earlier model/).closest("li");
    fireEvent.click(within(item).getByRole("button", { name: "Void" }));
    fireEvent.change(within(item).getByLabelText("Why void this record?"), { target: { value: "Typed the wrong flow" } });
    mockFetch.mockResolvedValueOnce({ calibration: calibration({ id: "c-earlier", isCurrent: false, voidedAt: "2026-03-02T00:00:00.000Z" }) });
    mockFetch.mockResolvedValueOnce(records({ calibrations: [calibration()] }));
    fireEvent.click(within(item).getByRole("button", { name: "Void record" }));
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith("/admin/misting-records/calibrations/c-earlier/void", {
      method: "POST",
      body: JSON.stringify({ reason: "Typed the wrong flow" }),
    }));
  });

  it("voids with an inline reason, never a browser prompt", async () => {
    const prompt = vi.spyOn(window, "prompt");
    await openPanel(records({ calibrations: [calibration()] }));
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    const confirm = screen.getByRole("button", { name: "Void record" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Why void this record?"), { target: { value: "Wrong nozzle count" } });
    mockFetch.mockResolvedValueOnce({ calibration: calibration({ voidedAt: "2026-03-02T00:00:00.000Z" }) });
    mockFetch.mockResolvedValueOnce(records());
    fireEvent.click(confirm);
    await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(`/admin/misting-records/calibrations/${CAL_ID}/void`, {
      method: "POST",
      body: JSON.stringify({ reason: "Wrong nozzle count" }),
    }));
    expect(prompt).not.toHaveBeenCalled();
    expect(await screen.findByText("No misting system on file.")).toBeInTheDocument();
  });

  it("shows the server's void refusal as returned", async () => {
    await openPanel(records({ calibrations: [calibration()] }));
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    fireEvent.change(screen.getByLabelText("Why void this record?"), { target: { value: "Entered wrong" } });
    mockFetch.mockRejectedValueOnce(httpError(409, "Void its refills first, or record a new calibration instead."));
    fireEvent.click(screen.getByRole("button", { name: "Void record" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Void its refills first, or record a new calibration instead.");
  });

  describe("calibration form", () => {
    const fill = (label, value) => fireEvent.change(screen.getByLabelText(new RegExp(`^${label}`)), { target: { value } });

    async function openForm() {
      await openPanel(records());
      fireEvent.click(screen.getByRole("button", { name: "Record install calibration" }));
    }

    it("pre-fills Pynamite, a 55 gal tank, 45 seconds, three mist times and the Sector product", async () => {
      await openForm();
      expect(screen.getByLabelText(/^Vendor/)).toHaveValue("Pynamite");
      expect(screen.getByLabelText(/^Tank \(gal\)/)).toHaveValue(55);
      expect(screen.getByLabelText(/^Mist length/)).toHaveValue(45);
      expect(screen.getAllByLabelText(/^Mist time \d/).map((i) => i.value)).toEqual(["06:30", "19:30", "22:30"]);
      expect(screen.getByLabelText(/^Product/)).toHaveValue("Sector Misting Concentrate");
      expect(screen.getByLabelText(/^EPA reg\. no\./)).toHaveValue("1021-1834");
      expect(screen.getByLabelText(/^Concentrate in a full tank/)).toHaveValue(64);
      expect(screen.getByLabelText(/^Label limit/)).toHaveValue(9.5);
      expect(screen.getByText("Time one nozzle into a measuring cup for 60 seconds.")).toBeInTheDocument();
      expect(screen.getByText("The height the mist reaches, up to 15 ft.")).toBeInTheDocument();
      expect(screen.queryByLabelText(/^Property/)).not.toBeInTheDocument();
    });

    it("follows the tank size for the concentrate until staff type their own", async () => {
      await openForm();
      fill("Tank \\(gal\\)", "10");
      expect(screen.getByLabelText(/^Concentrate in a full tank/)).toHaveValue(11.6);
      fill("Concentrate in a full tank", "12");
      fill("Tank \\(gal\\)", "20");
      expect(screen.getByLabelText(/^Concentrate in a full tank/)).toHaveValue(12);
    });

    it("shows the live line, and turns it red with the over-label sentence", async () => {
      await openForm();
      expect(screen.queryByTestId("misting-preview")).not.toBeInTheDocument();
      fill("Nozzles", "40");
      fill("Risers", "4");
      fill("Flow per nozzle", "1");
      fill("Treated area", "6000");
      fill("Mist height", "8");
      const line = screen.getByTestId("misting-preview");
      expect(line).toHaveTextContent("Puts out 99 fl oz a day. The label allows 456 at this mix.");
      expect(line.className).not.toMatch(/alert-fg/);
      fill("Nozzles", "16");
      fill("Flow per nozzle", "1.375");
      fill("Treated area", "1000");
      fill("Mist height", "5");
      const over = screen.getByTestId("misting-preview");
      expect(over).toHaveTextContent("This schedule puts out 61.9 fl oz a day. The label allows 47.5. Shorten the mist or run fewer cycles.");
      expect(over.className).toMatch(/alert-fg/);
      fill("Concentrate in a full tank", "128");
      fill("Nozzles", "5");
      fill("Risers", "0");
      expect(screen.getByTestId("misting-preview")).toHaveTextContent("Stronger mix: the daily limit is lower.");
    });

    it("has the three required checks in plain words, and posts the calibration", async () => {
      await openForm();
      fill("Model", "Test 55");
      fill("Nozzles", "40");
      fill("Flow per nozzle", "1");
      fill("Treated area", "6000");
      fill("Mist height", "8");
      fireEvent.click(screen.getByLabelText("Lock the cabinet"));
      fireEvent.click(screen.getByLabelText("Post the label and dilution statement at the unit"));
      fireEvent.click(screen.getByLabelText("Set mist times when people and pets are not outside"));
      mockFetch.mockResolvedValueOnce({ calibration: calibration() });
      mockFetch.mockResolvedValueOnce(records({ calibrations: [calibration()] }));
      fireEvent.click(screen.getByRole("button", { name: "Save calibration" }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(`/admin/misting-records/customers/${CUSTOMER}/calibrations`, expect.objectContaining({ method: "POST" })));
      const body = JSON.parse(mockFetch.mock.calls.find((c) => String(c[0]).endsWith("/calibrations"))[1].body);
      expect(body).toMatchObject({
        vendor: "Pynamite", model: "Test 55", tankGallons: 55, nozzleCount: 40, riserCount: 0, nozzleFlowFlOzPerMin: 1,
        cycleSeconds: 45, mistTimes: ["06:30", "19:30", "22:30"], epaRegNo: "1021-1834", concentrateFlOzPerTank: 64,
        labelMaxFlOzPer1000CuFtDay: 9.5, treatedAreaSqFt: 6000, treatedHeightFt: 8,
        cabinetLocked: true, labelPosted: true, scheduleAvoidsPeople: true,
      });
      expect(await screen.findByText("Calibration saved.")).toBeInTheDocument();
    });

    it("shows the server's refusal text as returned and keeps the form", async () => {
      await openForm();
      fill("Model", "Test 55");
      fill("Nozzles", "40");
      fill("Flow per nozzle", "1");
      fill("Treated area", "6000");
      fill("Mist height", "8");
      mockFetch.mockRejectedValueOnce(httpError(422, "This schedule puts out 61.9 fl oz a day. The label allows 47.5. Shorten the mist or run fewer cycles."));
      fireEvent.click(screen.getByRole("button", { name: "Save calibration" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This schedule puts out 61.9 fl oz a day. The label allows 47.5. Shorten the mist or run fewer cycles.");
      expect(screen.getByRole("form", { name: "Install calibration" })).toBeInTheDocument();
    });

    it("asks which property when the customer has two or more", async () => {
      await openPanel(records({
        properties: [
          { id: "p1", label: "Home", address: "1 Test Lane", isPrimary: true },
          { id: "p2", label: "Lake house", address: "2 Test Lane", isPrimary: false },
        ],
      }));
      fireEvent.click(screen.getByRole("button", { name: "Record install calibration" }));
      const select = screen.getByLabelText(/^Property/);
      expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Pick a property", "Home", "Lake house"]);
    });

    it("pre-fills New calibration from the current one, with the checks unticked", async () => {
      await openPanel(records({ calibrations: [calibration({ nozzleCount: 33 })] }));
      fireEvent.click(screen.getByRole("button", { name: "New calibration" }));
      expect(screen.getByLabelText(/^Nozzles/)).toHaveValue(33);
      expect(screen.getByLabelText(/^Model/)).toHaveValue("Test 55");
      expect(screen.getByLabelText("Lock the cabinet")).not.toBeChecked();
    });
  });

  describe("refill form", () => {
    it("pre-fills the product (read-only) and the full-tank amounts, and posts against the current calibration", async () => {
      await openPanel(records({ calibrations: [calibration()] }));
      fireEvent.click(screen.getByRole("button", { name: "Log refill" }));
      const form = screen.getByRole("form", { name: "Log refill" });
      expect(within(form).getByText(/Sector Misting Concentrate \(EPA Reg\. No\. 1021-1834\)/)).toBeInTheDocument();
      expect(within(form).getByText("Product changed? Record a new calibration.")).toBeInTheDocument();
      expect(within(form).getByLabelText(/^Concentrate added/)).toHaveValue(64);
      expect(within(form).getByLabelText(/^Water added/)).toHaveValue(55);
      fireEvent.change(within(form).getByLabelText(/^Level before/), { target: { value: "15" } });
      fireEvent.click(within(form).getByLabelText("Counter reset"));
      mockFetch.mockResolvedValueOnce({ refill: refill() });
      mockFetch.mockResolvedValueOnce(records({ calibrations: [calibration()], refills: [refill()] }));
      fireEvent.click(within(form).getByRole("button", { name: "Save refill" }));
      await waitFor(() => expect(mockFetch).toHaveBeenCalledWith(`/admin/misting-records/customers/${CUSTOMER}/refills`, expect.objectContaining({ method: "POST" })));
      const body = JSON.parse(mockFetch.mock.calls.find((c) => String(c[0]).endsWith("/refills"))[1].body);
      expect(body).toMatchObject({
        calibrationId: CAL_ID, productName: "Sector Misting Concentrate", epaRegNo: "1021-1834",
        concentrateFlOzAdded: 64, waterGallonsAdded: 55, levelBeforePct: 15, counterReset: true,
      });
      expect(await screen.findByText("Refill saved.")).toBeInTheDocument();
    });

    it("shows the server's refusal text as returned", async () => {
      await openPanel(records({ calibrations: [calibration()] }));
      fireEvent.click(screen.getByRole("button", { name: "Log refill" }));
      mockFetch.mockRejectedValueOnce(httpError(422, "This mix is 1.82 fl oz per gallon; the calibration is 1.16. Record a new calibration first if the mix changed."));
      fireEvent.click(screen.getByRole("button", { name: "Save refill" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("This mix is 1.82 fl oz per gallon; the calibration is 1.16.");
    });

    it("jumps to a new calibration from the product-changed link", async () => {
      await openPanel(records({ calibrations: [calibration()] }));
      fireEvent.click(screen.getByRole("button", { name: "Log refill" }));
      fireEvent.click(screen.getByText("Product changed? Record a new calibration."));
      expect(screen.getByRole("form", { name: "Install calibration" })).toBeInTheDocument();
    });
  });

  it("ignores a save that finishes after the customer changed: the new customer's open form stays", async () => {
    mockFetch.mockResolvedValueOnce(records({ calibrations: [calibration()] }));
    const { rerender } = render(<MistingRecordsPanel customerId={CUSTOMER} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    fireEvent.click(screen.getByRole("button", { name: "Log refill" }));
    let finishSave;
    mockFetch.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Save refill" }));
    await waitFor(() => expect(finishSave).toEqual(expect.any(Function)));

    const OTHER = "99999999-9999-4999-8999-999999999999";
    mockFetch.mockResolvedValueOnce(records({ calibrations: [calibration({ id: "c-other", customerId: OTHER })] }));
    rerender(<MistingRecordsPanel customerId={OTHER} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    fireEvent.click(screen.getByRole("button", { name: "Log refill" }));
    expect(screen.getByRole("form", { name: "Log refill" })).toBeInTheDocument();
    const callsBefore = mockFetch.mock.calls.length;

    finishSave({ refill: refill() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("form", { name: "Log refill" })).toBeInTheDocument();
    expect(screen.queryByText("Refill saved.")).not.toBeInTheDocument();
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it("resets when the customer changes", async () => {
    mockFetch.mockResolvedValueOnce(records({ calibrations: [calibration()] }));
    const { rerender } = render(<MistingRecordsPanel customerId={CUSTOMER} />);
    fireEvent.click(await screen.findByRole("button", { name: "Show" }));
    expect(screen.getByRole("button", { name: "Log refill" })).toBeInTheDocument();
    const OTHER = "99999999-9999-4999-8999-999999999999";
    mockFetch.mockResolvedValueOnce(records());
    rerender(<MistingRecordsPanel customerId={OTHER} />);
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(`/admin/misting-records/customers/${OTHER}/records`));
    expect(await screen.findByRole("button", { name: "Show" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Log refill" })).not.toBeInTheDocument();
  });
});
