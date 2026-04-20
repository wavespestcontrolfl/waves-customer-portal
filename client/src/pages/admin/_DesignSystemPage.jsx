import React, { useState } from 'react';
import {
  Button,
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
} from '../../components/ui';

const ALLOWLIST = (import.meta.env.VITE_DESIGN_SYSTEM_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowed() {
  if (import.meta.env.DEV) return true;
  if (!ALLOWLIST.length) return false;
  const userId = localStorage.getItem('waves_admin_user') || '';
  return ALLOWLIST.includes(userId);
}

function Section({ title, children }) {
  return (
    <section className="mb-10">
      <h2 className="text-11 uppercase tracking-label font-medium text-ink-secondary mb-3">
        {title}
      </h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-center gap-6 py-2">
      <div className="w-32 text-12 text-ink-secondary">{label}</div>
      <div className="flex items-center gap-3 flex-wrap">{children}</div>
    </div>
  );
}

export default function DesignSystemPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [switchOn, setSwitchOn] = useState(true);
  const [tabVal, setTabVal] = useState('one');
  const [selectVal, setSelectVal] = useState('a');
  const [radioVal, setRadioVal] = useState('one');
  const [checked, setChecked] = useState(true);

  if (!isAllowed()) {
    return (
      <div className="p-8">
        <h1 className="text-28 font-normal text-zinc-900">Not available</h1>
        <p className="text-13 text-ink-secondary mt-2">
          The design system reference is only available in development or to
          allowlisted users.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-surface-page min-h-full p-6 font-sans text-zinc-900">
      <header className="mb-8">
        <div className="text-11 uppercase tracking-label text-ink-secondary">
          Internal
        </div>
        <h1 className="text-28 font-normal tracking-tight">Design System</h1>
        <p className="text-13 text-ink-secondary mt-1 max-w-2xl">
          Canonical reference for every primitive in the monochrome admin
          spec. When building a Tier 1 page, render the primitive here and
          match its states rather than hand-styling.
        </p>
      </header>

      <Section title="Buttons">
        <Row label="Primary">
          <Button>Save</Button>
          <Button size="sm">Save</Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row label="Secondary">
          <Button variant="secondary">Cancel</Button>
          <Button variant="secondary" size="sm">Cancel</Button>
        </Row>
        <Row label="Ghost">
          <Button variant="ghost">More</Button>
        </Row>
        <Row label="Danger">
          <Button variant="danger">Delete</Button>
        </Row>
      </Section>

      <Section title="Inputs">
        <Row label="Text (md)">
          <Input placeholder="Search customers" className="w-64" />
        </Row>
        <Row label="Text (sm)">
          <Input size="sm" placeholder="Filter" className="w-48" />
        </Row>
        <Row label="Disabled">
          <Input disabled value="Locked" className="w-48" />
        </Row>
        <Row label="Select">
          <Select
            value={selectVal}
            onChange={(e) => setSelectVal(e.target.value)}
            className="w-48"
          >
            <option value="a">Option A</option>
            <option value="b">Option B</option>
            <option value="c">Option C</option>
          </Select>
        </Row>
        <Row label="Textarea">
          <Textarea placeholder="Notes" className="w-96" />
        </Row>
      </Section>

      <Section title="Toggles">
        <Row label="Checkbox">
          <Checkbox
            id="ds-cb"
            label="Include archived"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
        </Row>
        <Row label="Radio">
          <Radio
            id="ds-r1"
            name="ds-r"
            label="One"
            checked={radioVal === 'one'}
            onChange={() => setRadioVal('one')}
          />
          <Radio
            id="ds-r2"
            name="ds-r"
            label="Two"
            checked={radioVal === 'two'}
            onChange={() => setRadioVal('two')}
          />
        </Row>
        <Row label="Switch">
          <Switch
            id="ds-sw"
            label="Auto-refresh"
            checked={switchOn}
            onChange={setSwitchOn}
          />
        </Row>
      </Section>

      <Section title="Badges">
        <Row label="Tones">
          <Badge>Neutral</Badge>
          <Badge tone="strong">Strong</Badge>
          <Badge tone="alert">Alert</Badge>
        </Row>
        <Row label="With dot">
          <Badge dot>Active</Badge>
          <Badge dot tone="strong">Priority</Badge>
          <Badge dot tone="alert">Overdue</Badge>
        </Row>
        <Row label="Status dots">
          <span className="inline-flex items-center gap-2 text-12">
            <span className="u-dot u-dot--filled" /> Active
          </span>
          <span className="inline-flex items-center gap-2 text-12">
            <span className="u-dot u-dot--hollow" /> Dormant
          </span>
          <span className="inline-flex items-center gap-2 text-12">
            <span className="u-dot u-dot--alert" /> Alert
          </span>
        </Row>
      </Section>

      <Section title="Card">
        <Card className="max-w-md">
          <CardHeader>
            <CardTitle>Revenue — last 30 days</CardTitle>
          </CardHeader>
          <CardBody>
            <div className="u-nums text-28 font-medium">$48,211</div>
            <div className="text-12 text-ink-secondary mt-1">+4.2% vs prior</div>
          </CardBody>
        </Card>
      </Section>

      <Section title="Table">
        <Card>
          <Table>
            <THead>
              <TR>
                <TH>Customer</TH>
                <TH>Status</TH>
                <TH align="right">MRR</TH>
              </TR>
            </THead>
            <TBody>
              <TR>
                <TD>Miller, A.</TD>
                <TD>
                  <Badge dot>Active</Badge>
                </TD>
                <TD align="right" nums>
                  $261
                </TD>
              </TR>
              <TR>
                <TD>Chen, L.</TD>
                <TD>
                  <Badge dot tone="alert">Past due</Badge>
                </TD>
                <TD align="right" nums>
                  $189
                </TD>
              </TR>
              <TR>
                <TD>Rodriguez, M.</TD>
                <TD>
                  <Badge>Dormant</Badge>
                </TD>
                <TD align="right" nums>
                  $0
                </TD>
              </TR>
            </TBody>
          </Table>
        </Card>
      </Section>

      <Section title="Tabs">
        <Tabs value={tabVal} onValueChange={setTabVal}>
          <TabList>
            <Tab value="one">Overview</Tab>
            <Tab value="two">Activity</Tab>
            <Tab value="three">Billing</Tab>
          </TabList>
          <TabPanel value="one">
            <p className="text-13">Overview panel content.</p>
          </TabPanel>
          <TabPanel value="two">
            <p className="text-13">Activity panel content.</p>
          </TabPanel>
          <TabPanel value="three">
            <p className="text-13">Billing panel content.</p>
          </TabPanel>
        </Tabs>
      </Section>

      <Section title="Overlays">
        <Row label="Dialog">
          <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
        </Row>
        <Row label="Sheet">
          <Button variant="secondary" onClick={() => setSheetOpen(true)}>
            Open sheet
          </Button>
        </Row>
      </Section>

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
        <DialogHeader>
          <DialogTitle>Confirm action</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <p className="text-13 text-zinc-700">
            This will archive the selected customer. You can restore them
            later from the archive view.
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setDialogOpen(false)}>
            Cancel
          </Button>
          <Button onClick={() => setDialogOpen(false)}>Archive</Button>
        </DialogFooter>
      </Dialog>

      <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
        <SheetHeader>
          <div>
            <div className="text-11 uppercase tracking-label text-ink-secondary">
              Customer
            </div>
            <div className="text-18 font-medium">Miller, Anna</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setSheetOpen(false)}>
            Close
          </Button>
        </SheetHeader>
        <SheetBody>
          <p className="text-13 text-zinc-700">
            Detail panel content for a selected row. Spec §5.6 — this is where
            Customer 360 lives.
          </p>
        </SheetBody>
        <SheetFooter>
          <Button variant="secondary" onClick={() => setSheetOpen(false)}>
            Close
          </Button>
        </SheetFooter>
      </Sheet>
    </div>
  );
}
