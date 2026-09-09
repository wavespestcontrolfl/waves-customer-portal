import React, { useState } from "react";
import {
  Button,
  Field,
  UiSurface,
  Input,
  Select,
  Checkbox,
  Radio,
  Switch,
  Textarea,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Sheet,
  SheetHeader,
  SheetBody,
  SheetFooter,
  Tabs,
  TabList,
  Tab,
  TabPanel,
} from "../../components/ui";

import { FieldExample, SaveExample, DataStatesExample, DraftOwnershipExample, NestedOverlaysExample, WorkflowDensityExamples } from './_DesignSystemExamples';
import examplesSource from './_DesignSystemExamples.jsx?raw';
import primitivesSource from './_DesignSystemPage.jsx?raw';

const ALLOWLIST = (import.meta.env.VITE_DESIGN_SYSTEM_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowed() {
  if (import.meta.env.DEV) return true;
  if (!ALLOWLIST.length) return false;
  const userId = localStorage.getItem("waves_admin_user") || "";
  return ALLOWLIST.includes(userId);
}

function Section({ title, id, children }) {
  return (
    <section id={id} className="mb-10">
      {" "}
      <h2 className="text-18 font-medium text-zinc-900 mb-3">
        {title}
      </h2>{" "}
      <div className="space-y-3">{children}</div>{" "}
    </section>
  );
}

function Row({ label, children }) {
  return (
    <div className="grid sm:grid-cols-[128px_minmax(0,1fr)] gap-2 sm:gap-6 py-2">
      {" "}
      <div className="text-ui-body text-ink-secondary">{label}</div>{" "}
      <div className="min-w-0 flex items-center gap-3 flex-wrap">{children}</div>{" "}
    </div>
  );
}

export default function DesignSystemPage() {
  const [density, setDensity] = useState('comfortable');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [switchOn, setSwitchOn] = useState(true);
  const [tabVal, setTabVal] = useState("one");
  const [selectVal, setSelectVal] = useState("a");
  const [radioVal, setRadioVal] = useState("one");
  const [checked, setChecked] = useState(true);

  if (!isAllowed()) {
    return (
      <div className="p-8">
        {" "}
        <h1 className="text-28 font-normal text-zinc-900">
          Not available
        </h1>{" "}
        <p className="text-ui-body text-ink-secondary mt-2">
          The design system reference is only available in development or to
          allowlisted users.
        </p>{" "}
      </div>
    );
  }

  return (
    <UiSurface density={density} className="bg-surface-page min-h-full max-w-[1500px] mx-auto text-zinc-900">
      {" "}
      <header className="mb-8">
        {" "}
        <div className="ui-label text-ink-secondary">
          Internal
        </div>{" "}
        <h1 className="text-28 font-normal tracking-tight">Design system</h1>{" "}
        <p className="text-ui-body text-ink-secondary mt-1 max-w-2xl">
          The shared reference for new and migrated admin work. Comfortable is the default; compact is an explicit dense-data exception. Existing pages retain their presentation until migrated.
        </p>{" "}
      </header>{" "}
      <Section title="Presentation density">
        <Field label="Density" help="Comfortable: 44px. Compact: 36px on large fine-pointer screens, 44px on tablets or touch. Touch: 48px." className="max-w-md">
          <Select value={density} onChange={(event) => setDensity(event.target.value)}>
            <option value="comfortable">Comfortable (default)</option><option value="compact">Compact</option><option value="touch">Touch</option>
          </Select>
        </Field>
      </Section>
      <Section title="Typography">
        <p className="ui-record-title">Example record title</p>
        <p className="text-ui-body">Body copy uses the shared readable scale.</p>
        <p className="ui-label">Sentence-case label</p>
        <p className="text-ui-caption text-ink-secondary">Captions keep the same 14px minimum.</p>
      </Section>
      <Section title="Buttons">
        {" "}
        <Row label="Primary">
          {" "}
          <Button>Save</Button> <Button size="sm">Save</Button>{" "}
          <Button disabled>Disabled</Button>{" "}
        </Row>{" "}
        <Row label="Secondary">
          {" "}
          <Button variant="secondary">Cancel</Button>{" "}
          <Button variant="secondary" size="sm">
            Cancel
          </Button>{" "}
        </Row>{" "}
        <Row label="Ghost">
          {" "}
          <Button variant="ghost">More</Button>{" "}
        </Row>{" "}
        <Row label="Danger">
          {" "}
          <Button variant="danger">Delete</Button>{" "}
        </Row>{" "}
      </Section>{" "}
      <Section title="Inputs">
        {" "}
        <Row label="Text (md)">
          {" "}
          <Field label="Customer search"><Input placeholder="Search customers" className="w-64 max-w-full" /></Field>{" "}
        </Row>{" "}
        <Row label="Text (sm)">
          {" "}
          <Field label="Filter records"><Input size="sm" placeholder="Filter" className="w-48 max-w-full" /></Field>{" "}
        </Row>{" "}
        <Row label="Disabled">
          {" "}
          <Field label="Managed value" help="Managed by the account settings."><Input disabled value="Locked" className="w-48 max-w-full" /></Field>{" "}
        </Row>{" "}
        <Row label="Select">
          {" "}
          <Field label="Example option"><Select
            value={selectVal}
            onChange={(e) => setSelectVal(e.target.value)}
            className="w-48"
          >
            {" "}
            <option value="a">Option A</option>{" "}
            <option value="b">Option B</option>{" "}
            <option value="c">Option C</option>{" "}
          </Select></Field>{" "}
        </Row>{" "}
        <Row label="Textarea">
          {" "}
          <Field label="Notes"><Textarea placeholder="Add notes" className="w-96 max-w-full" /></Field>{" "}
        </Row>{" "}
      </Section>{" "}
      <Section title="Toggles">
        {" "}
        <Row label="Checkbox">
          {" "}
          <Checkbox
            id="ds-cb"
            label="Include archived"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />{" "}
        </Row>{" "}
        <Row label="Radio">
          {" "}
          <Radio
            id="ds-r1"
            name="ds-r"
            label="One"
            checked={radioVal === "one"}
            onChange={() => setRadioVal("one")}
          />{" "}
          <Radio
            id="ds-r2"
            name="ds-r"
            label="Two"
            checked={radioVal === "two"}
            onChange={() => setRadioVal("two")}
          />{" "}
        </Row>{" "}
        <Row label="Switch">
          {" "}
          <Switch
            id="ds-sw"
            label="Auto-refresh"
            checked={switchOn}
            onChange={setSwitchOn}
          />{" "}
        </Row>{" "}
      </Section>{" "}
      <Section title="Badges">
        {" "}
        <Row label="Tones">
          {" "}
          <Badge>Neutral</Badge> <Badge tone="strong">Strong</Badge>{" "}
          <Badge tone="alert">Alert</Badge>{" "}
        </Row>{" "}
        <Row label="With dot">
          {" "}
          <Badge dot>Active</Badge>{" "}
          <Badge dot tone="strong">
            Priority
          </Badge>{" "}
          <Badge dot tone="alert">
            Overdue
          </Badge>{" "}
        </Row>{" "}
        <Row label="Status dots">
          {" "}
          <span className="inline-flex items-center gap-2 text-ui-label">
            {" "}
            <span className="u-dot u-dot--filled" />
            Active
          </span>{" "}
          <span className="inline-flex items-center gap-2 text-ui-label">
            {" "}
            <span className="u-dot u-dot--hollow" />
            Dormant
          </span>{" "}
          <span className="inline-flex items-center gap-2 text-ui-label">
            {" "}
            <span className="u-dot u-dot--alert" />
            Alert
          </span>{" "}
        </Row>{" "}
      </Section>{" "}
      <Section title="Card">
        {" "}
        {/* Metric card: spec §3.4 — overline label (ui-label, same as the live
            KPI tiles) above the number. CardTitle is NOT the metric label. */}
        <Card className="max-w-md">
          {" "}
          <CardBody>
            {" "}
            <div className="ui-label text-ink-secondary">
              Revenue — last 30 days
            </div>{" "}
            <div className="u-nums text-28 font-medium mt-1.5">$48,211</div>{" "}
            <div className="text-ui-label text-ink-secondary mt-1">
              +4.2% vs prior
            </div>{" "}
          </CardBody>{" "}
        </Card>{" "}
        {/* Content card: CardTitle is the card's actual title
            (14 / 1.4 / 500 per the consistency contract). */}
        <Card className="max-w-md mt-4">
          {" "}
          <CardHeader>
            {" "}
            <CardTitle>Service notes</CardTitle>{" "}
          </CardHeader>{" "}
          <CardBody>
            {" "}
            <p className="text-ui-body text-ink-secondary">
              Perimeter treated; granular bait at the north fence line.
              Follow-up scheduled for the first week of October.
            </p>{" "}
          </CardBody>{" "}
        </Card>{" "}
      </Section>{" "}
      <Section title="Table">
        {" "}
        <Card>
          {" "}
          <Table>

            <THead>

              <TR>

                <TH>Customer</TH><TH>Status</TH>
                <TH align="right">MRR</TH>
              </TR>
            </THead>
            <TBody>

              <TR>

                <TD>Miller, A.</TD>
                <TD>
                  {" "}
                  <Badge dot>Active</Badge>{" "}
                </TD>
                <TD align="right" nums>
                  $261
                </TD>
              </TR>
              <TR>

                <TD>Chen, L.</TD>
                <TD>
                  {" "}
                  <Badge dot tone="alert">
                    Past due
                  </Badge>{" "}
                </TD>
                <TD align="right" nums>
                  $189
                </TD>
              </TR>
              <TR>

                <TD>Rodriguez, M.</TD>
                <TD>
                  {" "}
                  <Badge>Dormant</Badge>{" "}
                </TD>
                <TD align="right" nums>
                  $0
                </TD>
              </TR>
            </TBody>
          </Table>{" "}
        </Card>{" "}
      </Section>{" "}
      <Section title="Tabs">
        {" "}
        <Tabs value={tabVal} onValueChange={setTabVal}>
          {" "}
          <TabList aria-label="Example tabs">
            {" "}
            <Tab value="one">Overview</Tab> <Tab value="two">Activity</Tab>{" "}
            <Tab value="three">Billing</Tab>{" "}
          </TabList>{" "}
          <TabPanel value="one">
            {" "}
            <p className="text-ui-body">Overview panel content.</p>{" "}
          </TabPanel>{" "}
          <TabPanel value="two">
            {" "}
            <p className="text-ui-body">Activity panel content.</p>{" "}
          </TabPanel>{" "}
          <TabPanel value="three">
            {" "}
            <p className="text-ui-body">Billing panel content.</p>{" "}
          </TabPanel>{" "}
        </Tabs>{" "}
      </Section>{" "}
      <Section title="Overlays">
        {" "}
        <Row label="Dialog">
          {" "}
          <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>{" "}
        </Row>{" "}
        <Row label="Sheet">
          {" "}
          <Button variant="secondary" onClick={() => setSheetOpen(true)}>
            Open sheet
          </Button>{" "}
        </Row>{" "}
      </Section>{" "}
      <Section id="field-associations" title="Labels, help, validation, and disabled reasons"><FieldExample /></Section>
      <Section id="save-behavior" title="Loading and failed saves"><SaveExample /></Section>
      <Section id="data-states" title="Directory composition and result states"><DataStatesExample /></Section>
      <Section id="draft-ownership" title="Record header, mobile sections, and draft ownership"><DraftOwnershipExample /></Section>
      <Section id="nested-overlays" title="Nested overlay interaction"><NestedOverlaysExample /></Section>
      <Section id="workflow-compositions" title="Estimate and technician compositions"><WorkflowDensityExamples /></Section>
      <Section title="Implementation examples">
        <p className="text-ui-body text-ink-secondary">These are the actual sources rendered above. Import shared controls from components/ui; customer-specific CSS is not required.</p>
        <details><summary className="py-3 cursor-pointer text-ui-body">Behavior and composition source</summary><pre className="max-h-96 overflow-auto text-ui-caption bg-zinc-50 p-4"><code>{examplesSource}</code></pre></details>
        <details><summary className="py-3 cursor-pointer text-ui-body">Primitive catalog source</summary><pre className="max-h-96 overflow-auto text-ui-caption bg-zinc-50 p-4"><code>{primitivesSource}</code></pre></details>
      </Section>
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        {" "}
        <DialogHeader>
          {" "}
          <DialogTitle>Confirm action</DialogTitle>{" "}
        </DialogHeader>{" "}
        <DialogBody>
          {" "}
          <p className="text-ui-body text-zinc-700">
            This will archive the selected customer. You can restore them later
            from the archive view.
          </p>{" "}
        </DialogBody>{" "}
        <DialogFooter>
          {" "}
          <Button variant="secondary" onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>{" "}
          <Button onClick={() => setDialogOpen(false)}>Archive</Button>{" "}
        </DialogFooter>{" "}
      </Dialog>{" "}
      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} ariaLabel="Customer details">
        {" "}
        <SheetHeader>
          {" "}
          <div>
            {" "}
            <div className="ui-label text-ink-secondary">
              Customer
            </div>{" "}
            <div className="text-18 font-medium">Miller, Anna</div>{" "}
          </div>{" "}
          <Button variant="ghost" size="sm" onClick={() => setSheetOpen(false)}>
            Close
          </Button>{" "}
        </SheetHeader>{" "}
        <SheetBody>
          {" "}
          <p className="text-ui-body text-zinc-700">
            Sheets support focused secondary tasks such as messaging. Customer 360 uses a full-width record workspace by default.
          </p>{" "}
        </SheetBody>{" "}
        <SheetFooter>
          {" "}
          <Button variant="secondary" onClick={() => setSheetOpen(false)}>
            Close
          </Button>{" "}
        </SheetFooter>{" "}
      </Sheet>{" "}
    </UiSurface>
  );
}
