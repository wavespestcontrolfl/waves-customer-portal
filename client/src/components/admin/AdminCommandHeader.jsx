import React, { useEffect, useRef } from "react";
import { Button, cn, useUiDensity } from "../ui";

const PRESENTATIONS = {
  framed: {
    frame: "overflow-hidden rounded-md border-hairline border-zinc-200 bg-white",
    heading: "flex flex-wrap items-center justify-between gap-2 px-3 py-2 md:gap-3 md:px-4 md:py-3",
    titleSize: "text-18 md:text-22",
    divider: "border-b border-hairline border-zinc-200",
    nav: "u-scroll-strip flex p-1 md:grid md:gap-1 md:overflow-visible md:p-2",
    item: "inline-flex h-11 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 border-0 border-b-2 border-solid bg-transparent text-12 font-medium uppercase leading-tight tracking-label u-focus-ring transition-colors md:h-9 md:min-w-0 md:shrink md:justify-center md:gap-2 md:whitespace-normal md:text-center md:rounded-sm md:border-hairline",
    selected: "border-zinc-900 text-zinc-900 md:bg-zinc-900 md:text-white",
    idle: "border-transparent text-ink-secondary hover:text-zinc-900 md:border-zinc-200 md:bg-white md:text-zinc-700 md:hover:bg-zinc-50",
  },
  workspace: {
    frame: "ui-workspace-command",
    heading: "ui-workspace-command-heading",
    titleSize: "text-22",
    nav: "ui-workspace-nav",
    item: "ui-workspace-nav-action u-focus-ring",
  },
};

export default function AdminCommandHeader({
  title,
  icon: Icon,
  action,
  actions,
  sections = [],
  activeKey,
  onSectionChange,
  ariaLabel,
  navGridClassName = "grid-cols-2 lg:grid-cols-4",
  // Optional second tab row, for hub pages whose active area has its own
  // sub-sections (Pricing → Logic & Margins, Contracts → Templates). Rendered
  // inside the same card so a page never stacks two headers.
  secondarySections = [],
  secondaryActiveKey,
  onSecondaryChange,
  secondaryAriaLabel,
  secondaryNavGridClassName = "grid-cols-2 lg:grid-cols-4",
  className,
  headingLevel = 1,
  sticky = true,
  variant = "framed",
}) {
  const density = useUiDensity();
  const presentation = PRESENTATIONS[variant];
  const resolvedActions = actions?.length ? actions : [action].filter(Boolean);
  const Heading = headingLevel === 2 ? "h2" : "h1";
  const hasSections = sections.length > 0;
  const hasSecondary = secondarySections.length > 0;

  // Below md the strip scrolls; a deep link can select a section that sits
  // past the viewport edge, so bring the active tab into view whenever it
  // changes (no-op at md+ where nothing overflows).
  const primaryNavRef = useRef(null);
  const secondaryNavRef = useRef(null);
  useEffect(() => {
    for (const nav of [primaryNavRef.current, secondaryNavRef.current]) {
      const el = nav?.querySelector('[aria-current="page"]');
      if (el && nav.scrollWidth > nav.clientWidth) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    }
  }, [activeKey, secondaryActiveKey]);

  const renderSections = (list, active, onChange) =>
    list.map(({ key, label, Icon: SectionIcon, className: sectionClassName }) => {
      const isActive = active === key;
      return (
        <button
          key={key}
          type="button"
          onClick={() => onChange?.(key)}
          aria-current={isActive ? "page" : undefined}
          className={cn(
            // Below md: one underline tab in a horizontally scrolling strip
            // (shrink-0 + nowrap so the row overflows instead of wrapping
            // into the 2-column tile grid that ate ~60% of a phone screen).
            // md+: the boxed tile grid, unchanged.
            presentation.item,
            isActive ? presentation.selected : presentation.idle,
            sectionClassName,
          )}
        >
          {SectionIcon && <SectionIcon size={15} strokeWidth={1.8} aria-hidden />}
          {label}
        </button>
      );
    });

  return (
    <div
      className={cn(
        // Sticky at md+ only. Below md the header scrolls with the page:
        // a sticky header that tracked --vv-offset-top jumped to the top of
        // the visual viewport whenever iOS panned for a focused field, and
        // on hub pages with 6-8 sections it was taller than the space the
        // keyboard leaves — so it covered the field being typed in (the SMS
        // composer bug). Not being sticky removes the coupling entirely; the
        // fixed shell bar still tracks the pan on its own. At md+ there is
        // no fixed bar and top-0 pins below the 24px page padding. z-20
        // stays under the shell chrome (top bar 90 / tab bar 95 / backdrop
        // 99 / sidebar 100) and Dialog overlays.
        sticky && "md:sticky md:top-0",
        "z-20 mb-4 md:mb-5 md:bg-surface-page/95 md:pb-3",
        className,
      )}
    >
      <div className={presentation.frame}>
        <div
          className={cn(
            presentation.heading,
            hasSections && presentation.divider,
          )}
        >
          <div className="flex min-w-0 items-center gap-2 md:gap-3">
            <div className="h-8 w-8 md:h-9 md:w-9 rounded-sm bg-zinc-900 text-white flex items-center justify-center flex-shrink-0">
              {Icon && <Icon size={17} strokeWidth={1.9} aria-hidden />}
            </div>
            <Heading
              className={cn(
                "m-0 min-w-0 font-medium tracking-normal text-zinc-900",
                headingLevel === 2
                  ? "text-16 md:text-18"
                  : density === "legacy"
                    ? presentation.titleSize
                    : "text-22 leading-[1.3]",
              )}
            >
              {title}
            </Heading>
          </div>
          {resolvedActions.length > 0 && (
            <div className="ui-record-actions justify-end">
              {resolvedActions.map((item) => {
                const ActionIcon = item.icon;
                return (
                  <Button
                    key={item.key || item.label}
                    size={item.size || "md"}
                    variant={item.variant || "primary"}
                    className={cn(
                      density === "legacy" && "gap-2 px-3 text-12 font-medium uppercase tracking-label md:px-4",
                      item.className,
                    )}
                    onClick={item.onClick}
                    disabled={item.disabled}
                    aria-disabled={item.disabled || undefined}
                  >
                    {ActionIcon && (
                      <ActionIcon size={15} strokeWidth={1.9} aria-hidden />
                    )}
                    {item.label}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
        {hasSections && (
          <nav
            ref={primaryNavRef}
            aria-label={ariaLabel || `${title} section`}
            className={cn(
              // p-1 on mobile leaves room for the 2px focus ring inside the
              // strip's clip box (the outline sits 2px outside the button).
              presentation.nav,
              navGridClassName,
            )}
          >
            {renderSections(sections, activeKey, onSectionChange)}
          </nav>
        )}
        {hasSecondary && (
          <nav
            ref={secondaryNavRef}
            aria-label={secondaryAriaLabel || `${title} sub-section`}
            className={cn(
              presentation.nav,
              "border-t border-hairline border-zinc-200",
              secondaryNavGridClassName,
            )}
          >
            {renderSections(secondarySections, secondaryActiveKey, onSecondaryChange)}
          </nav>
        )}
      </div>
    </div>
  );
}
