import React, { useEffect, useId, useRef, useState } from 'react';
import {
  ActionFeedback, Badge, Button, Checkbox, Dialog, DialogBody, DialogFooter,
  DialogHeader, DialogTitle, Field, Input, Select, Sheet, SheetBody, SheetHeader,
  Table, THead, TBody, TR, TH, TD, TableToolbar, TablePagination, TableColumnPicker, TableSavedViews,
  Tabs, TabList, Tab, TabPanel, Textarea, UiSurface,
} from '../../components/ui';
import AdminCommandHeader from '../../components/admin/AdminCommandHeader';
import { useAdminTableViews } from '../../hooks/useAdminTableViews';
import { normalizeTableColumns } from '../../lib/adminTableViewStorage';
import { FileText } from 'lucide-react';

// Catalog actions use synthetic state only; no API or customer writes.
export function SaveExample() {
  const [note, setNote] = useState('Leave the gate as found.');
  const [fail, setFail] = useState(true);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);
  const [attempts, setAttempts] = useState(0);
  const inFlight = useRef(false);
  async function save(event) {
    event.preventDefault();
    // The action owns deduplication, including Enter/programmatic submission.
    // Disabling a Button alone is only presentation protection.
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setResult(null);
    setAttempts((count) => count + 1);
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      if (fail) throw new Error('Example save failed. Your note is still here.');
      setResult({ text: 'Example saved.' });
    } catch (error) {
      setResult({ error: true, text: error.message });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }
  return <form onSubmit={save} className="space-y-3 max-w-2xl" aria-label="Save behavior example">
    <Field label="Service note" help="This example keeps your text after a failed save.">
      <Textarea value={note} onChange={(event) => setNote(event.target.value)} />
    </Field>
    <Checkbox label="Simulate a save failure" checked={fail} onChange={(event) => setFail(event.target.checked)} />
    <div className="ui-record-actions">
      <Button type="submit" loading={pending}>Save note</Button>
      <span className="text-ui-caption text-ink-secondary">Save attempts: {attempts}</span>
    </div>
    {result && <ActionFeedback error={result.error}>{result.text}</ActionFeedback>}
  </form>;
}

export function FieldExample() {
  const [email, setEmail] = useState('invalid');
  return <div className="grid md:grid-cols-2 gap-4 max-w-3xl">
    <Field label="Contact email" required help="Use the address that should receive updates."
      error={!email.includes('@') ? 'Enter an email address with an @ sign.' : undefined}>
      <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
    </Field>
    <Field label="Account number" help="Assigned automatically; it cannot be edited here.">
      <Input disabled value="DEMO-1042" />
    </Field>
  </div>;
}

export function DataStatesExample() {
  const [state, setState] = useState('partial');
  return <div className="space-y-4">
    <Field label="Result state" className="max-w-sm">
      <Select value={state} onChange={(event) => setState(event.target.value)}>
        <option value="loading">Loading</option><option value="empty">No results</option>
        <option value="error">Load failed</option><option value="partial">Partial data</option>
        <option value="ready">Ready</option>
      </Select>
    </Field>
    <div className="min-h-[180px]" aria-busy={state === 'loading'}>
      {state === 'loading' && <ActionFeedback>Loading example records…</ActionFeedback>}
      {state === 'empty' && <ActionFeedback>No records match these filters. Clear the filters to try again.</ActionFeedback>}
      {state === 'error' && <ActionFeedback error onRetry={() => setState('ready')}>Records could not be loaded.</ActionFeedback>}
      {['partial', 'ready'].includes(state) && <>
        {state === 'partial' && <ActionFeedback>Some balances are unavailable. Recorded zero balances remain visible.</ActionFeedback>}
        <Table layout="records">
          <caption className="text-left text-ui-body py-3">Example directory — fictional records</caption>
          <THead><TR><TH scope="col">Customer</TH><TH scope="col">Property</TH><TH scope="col" align="right">Balance</TH></TR></THead>
          <TBody>{[
            { id: 'a', name: 'Avery Example with a long household and property name', balance: 0 },
            { id: 'b', name: 'Jordan Example', balance: state === 'partial' ? null : 25 },
          ].map((record) => <TR key={record.id}>
            <TD>{record.name}</TD>
            <TD data-label="Property">123 Demonstration Boulevard, Building With A Long Identifier, Example City</TD>
            <TD data-label="Balance" align="right" nums>{record.balance == null ? 'Not recorded' : `$${record.balance.toFixed(2)}`}</TD>
          </TR>)}</TBody>
        </Table>
      </>}
    </div>
  </div>;
}

const DIRECTORY_COLUMNS = [{ id: 'name', label: 'Customer', required: true }, { id: 'property', label: 'Property' }];
const DIRECTORY_RECORDS = Array.from({ length: 62 }, (_, index) => ({
  id: index, name: `Example customer ${String(index + 1).padStart(2, '0')}`,
  property: `${index + 1} Demonstration Street`,
}));
const DIRECTORY_VIEW_DEFAULTS = { search: '', sort: 'asc', page: 1, pageSize: 25, columns: ['name', 'property'], scrollTop: 0 };
const normalizeDirectoryView = (value) => ({
  search: typeof value.search === 'string' ? value.search.slice(0, 160) : '',
  sort: value.sort === 'desc' ? 'desc' : 'asc',
  pageSize: [25, 50, 100, 500].includes(value.pageSize) ? value.pageSize : 25,
  columns: normalizeTableColumns(value.columns, DIRECTORY_COLUMNS),
});

export function TableControlsExample() {
  const views = useAdminTableViews({ tableId: 'design-system', enabled: true, defaults: DIRECTORY_VIEW_DEFAULTS, normalize: normalizeDirectoryView });
  const { search, sort, page, pageSize, columns } = views.state;
  const results = DIRECTORY_RECORDS.filter((record) => `${record.name} ${record.property}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (sort === 'asc' ? 1 : -1) * a.name.localeCompare(b.name));
  const totalPages = Math.max(1, Math.ceil(results.length / pageSize));
  useEffect(() => {
    if (page > totalPages) views.setState((current) => ({ ...current, page: totalPages }));
  }, [page, totalPages, views.setState]);
  const changeSearch = (value) => views.setState((current) => ({ ...current, search: value, page: 1 }));
  return <div className="space-y-3">
    <TableToolbar label="Example directory" search={search} onSearchChange={changeSearch}
      searchPlaceholder="Search fictional records" onReset={() => changeSearch('')} canReset={Boolean(search)}>
      <Field label="Sort" className="w-44"><Select value={sort} onChange={(event) => views.setState((current) => ({ ...current, sort: event.target.value, page: 1 }))}>
        <option value="asc">Name A–Z</option><option value="desc">Name Z–A</option>
      </Select></Field>
      <TableColumnPicker label="Example directory" columns={DIRECTORY_COLUMNS} visibleColumns={columns} onChange={(value) => views.setState((current) => ({ ...current, columns: value }))} />
      <TableSavedViews label="Example directory" controller={views} />
    </TableToolbar>
    <Table layout="records" aria-label="Example directory records">
      <THead><TR><TH scope="col">Customer</TH>{columns.includes('property') && <TH scope="col">Property</TH>}</TR></THead>
      <TBody>{results.slice((page - 1) * pageSize, page * pageSize).map((record) => <TR key={record.id}>
        <TD>{record.name}</TD>{columns.includes('property') && <TD data-label="Property">{record.property}</TD>}
      </TR>)}</TBody>
    </Table>
    {!results.length && <p className="text-ui-body">No fictional records match this search.</p>}
    <TablePagination label="Example directory" page={page} totalPages={totalPages}
      total={results.length} pageSize={pageSize} onPageChange={(value) => views.setState((current) => ({ ...current, page: value }))}
      onPageSizeChange={(size) => views.setState((current) => ({ ...current, pageSize: size, page: 1 }))} />
  </div>;
}

function DraftFields() {
  const [subject, setSubject] = useState('');
  const [notes, setNotes] = useState('');
  return <div className="space-y-3 max-w-2xl">
    <Field label="Draft title"><Input value={subject} onChange={(event) => setSubject(event.target.value)} /></Field>
    <Field label="Draft notes"><Textarea value={notes} onChange={(event) => setNotes(event.target.value)} /></Field>
  </div>;
}

function RecordDraftExample({ role }) {
  const [section, setSection] = useState('draft');
  return <Tabs value={section} onValueChange={setSection} variant="section">
    <TabList scrollable aria-label="Example record sections">
      <Tab value="draft">Draft</Tab><Tab value="activity">Activity</Tab><Tab value="details">Details</Tab>
      {role === 'admin' && <Tab value="billing">Billing</Tab>}
    </TabList>
    <TabPanel value="draft" keepMounted><DraftFields /></TabPanel>
    <TabPanel value="activity"><p className="text-ui-body">Return to Draft to continue editing.</p></TabPanel>
    <TabPanel value="details"><p className="text-ui-body">No property notes on this fictional record.</p></TabPanel>
    {role === 'admin' && <TabPanel value="billing" keepMounted><Field label="Internal billing note"><Input /></Field></TabPanel>}
  </Tabs>;
}

export function DraftOwnershipExample() {
  const [record, setRecord] = useState('a');
  const [role, setRole] = useState('admin');
  return <div className="space-y-4">
    <AdminCommandHeader variant="workspace" title="Example record" icon={FileText} headingLevel={2} sticky={false} />
    <div className="grid sm:grid-cols-2 gap-4 max-w-2xl">
      <Field label="Example customer"><Select value={record} onChange={(event) => setRecord(event.target.value)}><option value="a">Avery Example</option><option value="b">Jordan Example</option></Select></Field>
      <Field label="Example role"><Select value={role} onChange={(event) => setRole(event.target.value)}><option value="admin">Admin</option><option value="tech">Technician</option></Select></Field>
    </div>
    <p className="text-ui-body text-ink-secondary">Section changes retain this draft. Customer and role changes clear it. Refresh recovery is not promised by TabPanel; the workflow must own persistence separately.</p>
    {/* Identity/security boundaries remount the form; hidden panels are never
        used as a permission boundary. Restricted children are not rendered. */}
    <RecordDraftExample key={`${record}:${role}`} role={role} />
  </div>;
}

export function NestedOverlaysExample() {
  const [sheet, setSheet] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [ancestorClicks, setAncestorClicks] = useState(0);
  const [draft, setDraft] = useState('A fictional message draft.');
  const titleId = useId();
  return <div onClick={() => setAncestorClicks((count) => count + 1)}>
    <Button variant="secondary" aria-haspopup="dialog" onClick={(event) => { event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); setSheet(true); }}>Open example message drawer</Button>
    <p className="text-ui-caption text-ink-secondary">Ancestor clicks: {ancestorClicks}</p>
    <Sheet open={sheet} onClose={() => setSheet(false)} ariaLabel="Example message drawer">
      <SheetHeader><h2 className="text-18 font-medium">Message draft</h2><Button variant="ghost" onClick={() => setSheet(false)}>Close drawer</Button></SheetHeader>
      <SheetBody>
        <Field label="Example message"><Textarea value={draft} onChange={(event) => setDraft(event.target.value)} /></Field>
        <Button className="mt-4" aria-haspopup="dialog" onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); setDialog(true); }}>Review example draft</Button>
      </SheetBody>
      <Dialog open={dialog} layer={130} onClose={() => setDialog(false)}>
        <DialogHeader><DialogTitle id={titleId}>Review draft</DialogTitle></DialogHeader>
        <DialogBody><p className="text-ui-body break-words">{draft}</p></DialogBody>
        <DialogFooter><Button onClick={() => setDialog(false)}>Keep editing</Button></DialogFooter>
      </Dialog>
    </Sheet>
  </div>;
}

export function WorkflowDensityExamples() {
  return <div className="grid xl:grid-cols-2 gap-6">
    <div className="space-y-3">
      <h3 className="text-18 font-medium">Estimate form composition</h3>
      <p className="text-ui-body text-ink-secondary">Shared fields and actions; the estimate workflow still owns its pricing and saved draft.</p>
      <Field label="Property address"><Input defaultValue="123 Demonstration Boulevard" /></Field>
      <Field label="Scope notes"><Textarea placeholder="Describe the proposed work" /></Field>
      <div className="ui-record-actions"><Button disabled aria-describedby="estimate-example-reason">Create estimate</Button></div>
      <p id="estimate-example-reason" className="text-ui-caption text-ink-secondary">This catalog example is not connected to estimate creation.</p>
    </div>
    <UiSurface density="touch" className="space-y-3">
      <h3 className="text-18 font-medium">Technician form composition</h3>
      <p className="text-ui-body text-ink-secondary">Touch density shares control behavior. The Tech portal keeps its Today / Visit / Complete layout and its own surface tokens.</p>
      <Field label="Access instructions"><Input readOnly value="Use the side gate." /></Field>
      <Field label="Actual treatment notes"><Textarea placeholder="Record work completed" /></Field>
      <div className="ui-record-actions"><Badge>Pending sync example</Badge><Button disabled aria-describedby="visit-example-reason">Complete visit</Button></div>
      <p id="visit-example-reason" className="text-ui-caption text-ink-secondary">Completion, photos, offline recovery, and sync belong to the existing visit workflow. This example has no backend.</p>
    </UiSurface>
  </div>;
}
