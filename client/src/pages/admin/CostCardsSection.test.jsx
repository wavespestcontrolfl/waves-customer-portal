// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CostCardsSection from "./CostCardsSection";

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

const TODAY = "2026-10-26";

const techCard = {
  id: "card-1", technicianId: "tech-1", effectiveDate: "2026-01-01", kind: "w2", imputedHourlyRate: null,
  paidHoursPerWeek: 40, paidHoursPerDay: 10, healthMoneyMonthly: 200, retirementPct: 2, workersCompPct: 4,
  paidDaysOffPerYear: 15, vehicleEquipmentId: "veh-1", note: null,
};
const vehicleCard = {
  id: "vcard-1", equipmentId: "veh-1", effectiveDate: "2026-01-01", lossOfValuePerYear: 6000, insurancePerYear: 2400,
  loanInterestPerYear: 1200, otherFixedPerYear: 600, fuelPerMile: 0.15, upkeepPerMile: 0.08, note: null,
};

const line = (key, label, perYearCents, paid, worked) => ({ key, label, perYearCents, perPaidHourCents: paid, perWorkedHourCents: worked });

const listing = (over = {}) => ({
  enabled: true,
  today: TODAY,
  technicians: [
    { id: "tech-1", name: "Sample Tech", payRate: 21, employmentType: "w2", employmentStatus: "active", cards: [techCard] },
    { id: "tech-2", name: "Second Sample", payRate: null, employmentType: "w2", employmentStatus: "active", cards: [] },
  ],
  vehicles: [
    { id: "veh-1", name: "Sample Truck", status: "active", cards: [vehicleCard] },
    { id: "veh-2", name: "Spare Truck", status: "active", cards: [] },
  ],
  ...over,
});

const rates = {
  date: TODAY,
  technicians: [{
    technicianId: "tech-1", name: "Sample Tech", ok: true, kind: "w2",
    totalPerYearCents: 5260092, laborPerPaidHourCents: 2529, laborPerWorkedHourCents: 2725,
    lines: [
      line("wages", "Wages", 4368000, 2100, 2263),
      line("health", "Health money", 240000, 115, 124),
    ],
  }],
  vehicles: [{
    equipmentId: "veh-1", name: "Sample Truck", ok: true, fixedPerYearCents: 1020000, fixedPerWorkedHourCents: 528,
    perMile: 0.23, spreadOverHoursPerYear: 1930,
  }],
};

let calls;
let handlers;

beforeEach(() => {
  calls = [];
  handlers = {};
  vi.stubGlobal("localStorage", { getItem: () => "synthetic-token" });
  vi.stubGlobal("fetch", vi.fn(async (url, options = {}) => {
    const path = String(url).replace(/^\/api/, "");
    calls.push({ path, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    const handler = handlers[`${options.method || "GET"} ${path.split("?")[0]}`];
    if (!handler) throw new Error(`Unexpected synthetic request: ${options.method || "GET"} ${path}`);
    return handler(path, options);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Cost cards section", () => {
  it("gate off: renders nothing and asks for nothing else", async () => {
    handlers["GET /admin/cost-cards"] = () => response({ enabled: false });
    const { container } = render(<CostCardsSection />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Cost cards")).not.toBeInTheDocument();
    expect(calls.map((c) => c.path)).toEqual(["/admin/cost-cards"]);
  });

  it("a failed load shows the reason in plain words", async () => {
    handlers["GET /admin/cost-cards"] = () => response({ error: "Cost cards failed. Try again." }, 500);
    render(<CostCardsSection />);
    expect(await screen.findByText("Cost cards failed. Try again.")).toBeInTheDocument();
  });

  describe("gate on", () => {
    beforeEach(() => {
      handlers["GET /admin/cost-cards"] = () => response(listing());
      handlers["GET /admin/cost-cards/rates"] = () => response(rates);
      // GATE_TECH_OPEN_TIME off by default: the open time route answers 404.
      handlers["GET /admin/cost-cards/open-time"] = () => response({ enabled: false }, 404);
    });

    it("shows each technician's card and the breakdown, per year, per paid hour and per worked hour", async () => {
      render(<CostCardsSection />);
      expect(await screen.findByText("Sample Tech")).toBeInTheDocument();
      expect(screen.getByText(/In effect since 2026-01-01: W-2, 40 paid hours a week, 15 paid days off a year/)).toBeInTheDocument();
      const table = screen.getByRole("table", { name: "Cost breakdown" });
      for (const heading of ["Cost line", "Per year", "Per paid hour", "Per worked hour"]) {
        expect(within(table).getByText(heading)).toBeInTheDocument();
      }
      expect(within(table).getByText("Wages")).toBeInTheDocument();
      expect(within(table).getByText("$43,680.00")).toBeInTheDocument();
      expect(within(table).getByText("Total labor cost")).toBeInTheDocument();
      expect(within(table).getByText("$52,600.92")).toBeInTheDocument();
      expect(within(table).getByText("$25.29")).toBeInTheDocument();
      expect(within(table).getByText("$27.25")).toBeInTheDocument();
      expect(calls.find((c) => c.path.startsWith("/admin/cost-cards/rates")).path).toBe(`/admin/cost-cards/rates?date=${TODAY}`);
    });

    it("a technician with no card says costing keeps the company rate", async () => {
      render(<CostCardsSection />);
      await screen.findByText("Second Sample");
      expect(screen.getByText(/No card yet\. Costing uses the company labor rate and drive cost per stop\./)).toBeInTheDocument();
    });

    it("shows each vehicle's card and its fixed cost per worked hour", async () => {
      render(<CostCardsSection />);
      await screen.findByText("Add card for Sample Truck");
      expect(screen.getByText(/fuel \$0\.15 and upkeep \$0\.08 per mile/)).toBeInTheDocument();
      expect(screen.getByText(/Fixed costs \$10,200\.00 a year = \$5\.28 per worked hour \(spread over 1930 worked hours/)).toBeInTheDocument();
      expect(screen.getByText(/No vehicle cost is added to visits\./)).toBeInTheDocument();
    });

    it("uses plain labels on the add-card form", async () => {
      render(<CostCardsSection />);
      await screen.findByText("Add card for Sample Tech");
      for (const label of [
        "Effective date", "Kind of card", "Paid hours per week", "Paid hours per day", "Health money per month",
        "Retirement %", "Workers' comp %", "Paid days off per year", "Vehicle driven",
        "Loss of value per year", "Insurance per year", "Loan interest per year", "Other fixed costs per year",
        "Fuel per mile", "Upkeep per mile",
      ]) {
        expect(screen.getAllByText(label).length).toBeGreaterThan(0);
      }
    });

    it("adds a W-2 technician card: effective date defaults to today, blanks are left for the server defaults", async () => {
      let posted = null;
      handlers["POST /admin/cost-cards/technicians/tech-2"] = (_p, options) => {
        posted = JSON.parse(options.body);
        return response({ card: { ...techCard, id: "card-2", technicianId: "tech-2" } }, 201);
      };
      render(<CostCardsSection />);
      const heading = await screen.findByText("Add card for Second Sample");
      const form = heading.parentElement;
      expect(within(form).getAllByDisplayValue(TODAY)).toHaveLength(1);
      // No pay rate on file: the wage starts blank and is typed on the card.
      expect(within(form).getByLabelText("Hourly wage")).toHaveValue(null);
      fireEvent.change(within(form).getByLabelText("Hourly wage"), { target: { value: "21" } });
      fireEvent.change(within(form).getByLabelText("Health money per month"), { target: { value: "200" } });
      fireEvent.change(within(form).getByLabelText("Workers' comp %"), { target: { value: "4" } });
      fireEvent.change(within(form).getByLabelText("Vehicle driven"), { target: { value: "veh-1" } });
      fireEvent.click(within(form).getByRole("button", { name: "Add card" }));
      expect(await within(form).findByText("Card added.")).toBeInTheDocument();
      expect(posted).toEqual({
        effectiveDate: TODAY, kind: "w2", hourlyWage: 21, healthMoneyMonthly: 200, workersCompPct: 4, vehicleEquipmentId: "veh-1",
      });
      // The section reloads so the new card shows.
      expect(calls.filter((c) => c.method === "GET" && c.path === "/admin/cost-cards").length).toBeGreaterThanOrEqual(2);
    });

    it("a W-2 card starts from the technician's pay rate, keeps the wage on the card, and needs one", async () => {
      let posted = null;
      handlers["POST /admin/cost-cards/technicians/tech-1"] = (_p, options) => {
        posted = JSON.parse(options.body);
        return response({ card: { ...techCard, id: "card-3", hourlyWage: 21 } }, 201);
      };
      render(<CostCardsSection />);
      const heading = await screen.findByText("Add card for Sample Tech");
      const form = heading.parentElement;
      expect(within(form).getByLabelText("Hourly wage")).toHaveValue(21);
      fireEvent.change(within(form).getByLabelText("Hourly wage"), { target: { value: "" } });
      fireEvent.click(within(form).getByRole("button", { name: "Add card" }));
      expect(await within(form).findByText("Enter the hourly wage.")).toBeInTheDocument();
      expect(calls.some((c) => c.method === "POST")).toBe(false);
      fireEvent.change(within(form).getByLabelText("Hourly wage"), { target: { value: "22.50" } });
      fireEvent.click(within(form).getByRole("button", { name: "Add card" }));
      expect(await within(form).findByText("Card added.")).toBeInTheDocument();
      expect(posted).toMatchObject({ kind: "w2", hourlyWage: 22.5 });
    });

    it("an imputed card asks for an hourly rate and refuses a missing one without posting", async () => {
      render(<CostCardsSection />);
      const heading = await screen.findByText("Add card for Second Sample");
      const form = heading.parentElement;
      fireEvent.change(within(form).getByLabelText("Kind of card"), { target: { value: "imputed" } });
      fireEvent.click(within(form).getByRole("button", { name: "Add card" }));
      expect(await within(form).findByText("Enter an hourly rate above zero.")).toBeInTheDocument();
      expect(calls.some((c) => c.method === "POST")).toBe(false);
    });

    it("a negative number is refused on the form, and a server refusal is shown", async () => {
      handlers["POST /admin/cost-cards/technicians/tech-2"] = () => response({ error: "Enter the hourly wage, or set the technician's pay rate first." }, 400);
      render(<CostCardsSection />);
      const heading = await screen.findByText("Add card for Second Sample");
      const form = heading.parentElement;
      fireEvent.change(within(form).getByLabelText("Hourly wage"), { target: { value: "21" } });
      fireEvent.change(within(form).getByLabelText("Retirement %"), { target: { value: "-1" } });
      fireEvent.click(within(form).getByRole("button", { name: "Add card" }));
      expect(await within(form).findByText('"Retirement %" must be a number of 0 or more.')).toBeInTheDocument();
      expect(calls.some((c) => c.method === "POST")).toBe(false);
      fireEvent.change(within(form).getByLabelText("Retirement %"), { target: { value: "2" } });
      fireEvent.click(within(form).getByRole("button", { name: "Add card" }));
      expect(await within(form).findByText("Enter the hourly wage, or set the technician's pay rate first.")).toBeInTheDocument();
    });

    it("adds a vehicle card", async () => {
      let posted = null;
      handlers["POST /admin/cost-cards/vehicles/veh-2"] = (_p, options) => {
        posted = JSON.parse(options.body);
        return response({ card: { ...vehicleCard, id: "vcard-2", equipmentId: "veh-2" } }, 201);
      };
      render(<CostCardsSection />);
      const heading = await screen.findByText("Add card for Spare Truck");
      const form = heading.parentElement;
      fireEvent.change(within(form).getByLabelText("Insurance per year"), { target: { value: "2400" } });
      fireEvent.change(within(form).getByLabelText("Fuel per mile"), { target: { value: "0.15" } });
      fireEvent.click(within(form).getByRole("button", { name: "Add card" }));
      expect(await within(form).findByText("Card added.")).toBeInTheDocument();
      expect(posted).toEqual({ effectiveDate: TODAY, insurancePerYear: 2400, fuelPerMile: 0.15 });
    });

    it("a W-2 card whose technician has no pay rate says why there is no breakdown", async () => {
      handlers["GET /admin/cost-cards"] = () => response(listing({
        technicians: [{ id: "tech-1", name: "Sample Tech", payRate: null, cards: [techCard] }],
      }));
      handlers["GET /admin/cost-cards/rates"] = () => response({
        date: TODAY, vehicles: [], technicians: [{ technicianId: "tech-1", ok: false, reason: "no_pay_rate" }],
      });
      render(<CostCardsSection />);
      expect(await screen.findByText(/no pay rate on file, so a W-2 card cannot give a cost yet/)).toBeInTheDocument();
      expect(screen.queryByRole("table", { name: "Cost breakdown" })).not.toBeInTheDocument();
    });

    it("a card dated in the future is not shown as the current card", async () => {
      handlers["GET /admin/cost-cards"] = () => response(listing({
        technicians: [{ id: "tech-1", name: "Sample Tech", payRate: 21, cards: [{ ...techCard, effectiveDate: "2026-12-01" }] }],
      }));
      render(<CostCardsSection />);
      expect((await screen.findAllByText(/No card yet\. Costing uses the company labor rate/)).length).toBeGreaterThan(0);
      expect(screen.queryByRole("table", { name: "Cost breakdown" })).not.toBeInTheDocument();
    });
    describe("open time panel (GATE_TECH_OPEN_TIME)", () => {
      const openTime = (over = {}) => ({
        enabled: true,
        from: "2026-09-27",
        to: "2026-10-25",
        totals: { days: 3, paidMinutes: 1800, bookedMinutes: 900, openMinutes: 900, openCostCents: 40875, bookedShare: 0.5 },
        technicians: [{
          technicianId: "tech-1", name: "Sample Tech", days: 3, paidMinutes: 1800, bookedMinutes: 900, onJobMinutes: 700,
          driveMinutes: 200, openMinutes: 900, overMinutes: 0, openCostCents: 40875, bookedShare: 0.5,
        }],
        leftOut: { days: 0, visits: 0, byReason: {} },
        ...over,
      });

      it("a 404 renders nothing: no panel, no error text", async () => {
        render(<CostCardsSection />);
        await screen.findByText("Sample Tech");
        await waitFor(() => expect(calls.some((c) => c.path === "/admin/cost-cards/open-time")).toBe(true));
        expect(screen.queryByText("Open time, last 30 days")).not.toBeInTheDocument();
        expect(screen.queryByTestId("open-time")).not.toBeInTheDocument();
        expect(screen.queryByText(/Request failed/)).not.toBeInTheDocument();
      });

      it("shows one row per technician: days, paid, booked, open hours, open cost and booked share", async () => {
        handlers["GET /admin/cost-cards/open-time"] = () => response(openTime());
        render(<CostCardsSection />);
        expect(await screen.findByText("Open time, last 30 days")).toBeInTheDocument();
        const table = screen.getByRole("table", { name: "Open time by technician" });
        for (const heading of ["Technician", "Days", "Paid hours", "Booked hours (on site + drive)", "Open hours", "Open cost", "Booked share"]) {
          expect(within(table).getByText(heading)).toBeInTheDocument();
        }
        const row = within(table).getByText("Sample Tech").closest("tr");
        expect(within(row).getByText("3")).toBeInTheDocument();
        expect(within(row).getByText("30")).toBeInTheDocument(); // 1800 paid minutes
        expect(within(row).getAllByText("15")).toHaveLength(2); // 900 booked minutes and 900 open minutes
        expect(within(row).getByText("$408.75")).toBeInTheDocument();
        expect(within(row).getByText("50%")).toBeInTheDocument();
        expect(screen.getByText("Paid hours come from the time clock, else the card's paid hours a day on days with a visit.")).toBeInTheDocument();
        expect(screen.queryByText(/left out/)).not.toBeInTheDocument();
        expect(calls.find((c) => c.path === "/admin/cost-cards/open-time").method).toBe("GET");
      });

      it("says how many days were left out because visits were costed before the card", async () => {
        handlers["GET /admin/cost-cards/open-time"] = () => response(openTime({ leftOut: { days: 4, visits: 6, byReason: { costed_before_card: 4 } } }));
        render(<CostCardsSection />);
        expect(await screen.findByText("4 days left out: visits costed before the card.")).toBeInTheDocument();
      });

      it("no finished day with a card yet reads as a plain sentence", async () => {
        handlers["GET /admin/cost-cards/open-time"] = () => response(openTime({ technicians: [], totals: { days: 0 }, leftOut: { days: 1, visits: 1, byReason: { costed_before_card: 1 } } }));
        render(<CostCardsSection />);
        expect(await screen.findByText("No finished days with a cost card yet.")).toBeInTheDocument();
        expect(screen.getByText("1 day left out: visits costed before the card.")).toBeInTheDocument();
        expect(screen.queryByRole("table", { name: "Open time by technician" })).not.toBeInTheDocument();
      });

      it("saving a card reloads the open time too, so a new or back-dated card shows there", async () => {
        let openTimeReads = 0;
        handlers["GET /admin/cost-cards/open-time"] = () => {
          openTimeReads += 1;
          return response(openTimeReads === 1 ? openTime() : openTime({ technicians: [{ ...openTime().technicians[0], openCostCents: 12300 }] }));
        };
        handlers["POST /admin/cost-cards/technicians/tech-2"] = () => response({ card: { id: "card-2", technicianId: "tech-2" } }, 201);
        render(<CostCardsSection />);
        expect(await screen.findByText("$408.75")).toBeInTheDocument();
        const form = (await screen.findByText("Add card for Second Sample")).parentElement;
        fireEvent.change(within(form).getByLabelText("Hourly wage"), { target: { value: "21" } });
        fireEvent.click(within(form).getByRole("button", { name: "Add card" }));
        expect(await screen.findByText("$123.00")).toBeInTheDocument();
        expect(openTimeReads).toBe(2);
      });

      it("a failed load shows the reason and leaves the cards alone", async () => {
        handlers["GET /admin/cost-cards/open-time"] = () => response({ error: "Cost cards failed. Try again." }, 500);
        render(<CostCardsSection />);
        expect(await screen.findByText("Cost cards failed. Try again.")).toBeInTheDocument();
        expect(screen.getByText("Sample Tech")).toBeInTheDocument();
      });
    });
  });
});
