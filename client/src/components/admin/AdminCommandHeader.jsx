import React from "react";
import { Button, cn } from "../ui";

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
  className,
  headingLevel = 1,
  sticky = true,
}) {
  const resolvedActions = actions?.length ? actions : action ? [action] : [];
  const Heading = headingLevel === 2 ? "h2" : "h1";
  const hasSections = sections.length > 0;

  return (
    <div
      className={cn(
        sticky && "md:sticky md:top-0",
        "z-20 mb-5 bg-surface-page/95 pb-3",
        className,
      )}
    >
      <div className="overflow-hidden rounded-md border-hairline border-zinc-200 bg-white">
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 px-4 py-3",
            hasSections && "border-b border-hairline border-zinc-200",
          )}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="h-9 w-9 rounded-sm bg-zinc-900 text-white flex items-center justify-center flex-shrink-0">
              {Icon && <Icon size={17} strokeWidth={1.9} aria-hidden />}
            </div>
            <Heading
              className={cn(
                "m-0 min-w-0 font-medium tracking-normal text-zinc-900",
                headingLevel === 2 ? "text-18" : "text-22",
              )}
            >
              {title}
            </Heading>
          </div>
          {resolvedActions.length > 0 && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {resolvedActions.map((item) => {
                const ActionIcon = item.icon;
                return (
                  <Button
                    key={item.key || item.label}
                    size={item.size || "md"}
                    variant={item.variant || "primary"}
                    className={cn(
                      "gap-2 text-12 font-medium uppercase tracking-label",
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
            aria-label={ariaLabel || `${title} section`}
            className={cn("grid gap-1 p-2", navGridClassName)}
          >
            {sections.map(
              ({
                key,
                label,
                Icon: SectionIcon,
                className: sectionClassName,
              }) => {
                const active = activeKey === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => onSectionChange?.(key)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "inline-flex h-11 min-w-0 items-center justify-center gap-2 rounded-sm border-hairline px-3 sm:h-9",
                      "text-center text-12 font-medium uppercase leading-tight tracking-label u-focus-ring transition-colors",
                      active
                        ? "bg-zinc-900 text-white border-zinc-900"
                        : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 hover:text-zinc-900",
                      sectionClassName,
                    )}
                  >
                    {SectionIcon && (
                      <SectionIcon size={15} strokeWidth={1.8} aria-hidden />
                    )}
                    {label}
                  </button>
                );
              },
            )}
          </nav>
        )}
      </div>
    </div>
  );
}
