import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Tabs, TabList, Tab } from "../ui";

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
  const strip = useRef(null);
  const id = useId();
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  const measure = () => {
    const element = strip.current;
    if (element) setEdges({ overflow: element.scrollWidth > element.clientWidth + 2, left: element.scrollLeft > 2, right: element.scrollLeft + element.clientWidth < element.scrollWidth - 2 });
  };
  const revealSelected = () => {
    const element = strip.current;
    const selected = element?.querySelector('[aria-selected="true"]');
    if (!selected) return;
    const bounds = element.getBoundingClientRect(), item = selected.getBoundingClientRect();
    if (item.left < bounds.left + 8) element.scrollLeft -= bounds.left + 8 - item.left;
    else if (item.right > bounds.right - 8) element.scrollLeft += item.right - bounds.right + 8;
    measure();
  };
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => { measure(); revealSelected(); });
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, []);
  useEffect(revealSelected, [active, edges.overflow, sections.length]);

  return <nav className="c360-section-navigation" aria-label="Customer sections">
    {edges.overflow && <Button variant="ghost" className="c360-section-arrow" aria-label="Scroll sections left" disabled={!edges.left} onClick={() => strip.current.scrollBy({ left: -220, behavior: "instant" })}><ChevronLeft size={18} /></Button>}
    <div ref={strip} className="c360-section-strip" onScroll={measure}>
      <Tabs value={active} onValueChange={onChange}>
        <TabList className="c360-section-list" aria-label="Customer sections">
          {sections.map((section, index) => <Tab key={section.key} value={section.key} id={`${id}-${section.key}`} aria-controls={contentId} tabIndex={active === section.key ? 0 : -1} className="c360-section-tab" onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : (index + (event.key === "ArrowRight" ? 1 : sections.length - 1)) % sections.length;
            const next = sections[nextIndex];
            onChange(next.key);
            document.getElementById(`${id}-${next.key}`)?.focus({ preventScroll: true });
          }}>{section.label}</Tab>)}
        </TabList>
      </Tabs>
    </div>
    {edges.overflow && <Button variant="ghost" className="c360-section-arrow" aria-label="Scroll sections right" disabled={!edges.right} onClick={() => strip.current.scrollBy({ left: 220, behavior: "instant" })}><ChevronRight size={18} /></Button>}
  </nav>;
}
