import { useId } from "react";
import { Tabs, TabList, Tab } from "../ui";

export const CUSTOMER_360_SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "services", label: "Services" },
  { key: "estimates", label: "Estimates" },
  { key: "billing", label: "Billing" },
  { key: "contracts", label: "Contracts" },
  { key: "comms", label: "Comms" },
  { key: "property", label: "Property" },
  { key: "compliance", label: "Compliance" },
];

export const CUSTOMER_WORKSPACE_SECTIONS = [
  { key: "overview", label: "Summary" },
  { key: "comms", label: "Activity" },
  { key: "billing", label: "Billing" },
  { key: "property", label: "Details" },
];

export default function Customer360Sections({ active, onChange, contentId, sections }) {
  const id = useId();
  return <nav className="c360-section-navigation" aria-label="Customer sections">
    <Tabs value={active} onValueChange={onChange} variant="section" className="min-w-0 w-full">
      <TabList scrollable aria-label="Customer sections">
        {sections.map((section) => <Tab key={section.key} value={section.key} id={`${id}-${section.key}`} aria-controls={contentId}>{section.label}</Tab>)}
      </TabList>
    </Tabs>
  </nav>;
}
