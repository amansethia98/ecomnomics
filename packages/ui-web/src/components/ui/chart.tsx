import { cn } from "@rakazo/ui-web/lib/utils";
import * as React from "react";
import * as RechartsPrimitive from "recharts";

export type ChartConfig = Record<string, { label?: React.ReactNode; color?: string }>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const lines = Object.entries(config)
    .filter((entry): entry is [string, { label?: React.ReactNode; color: string }] =>
      Boolean(entry[1].color),
    )
    .map(([key, item]) => `--color-${key}: ${item.color};`);
  if (lines.length === 0) return null;
  return <style>{`[data-chart="${id}"] { ${lines.join(" ")} }`}</style>;
}

/** shadcn chart frame. Series colours are CSS variables on this element. */
export function ChartContainer({
  id,
  config,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}) {
  const generated = React.useId().replace(/:/g, "");
  const chartId = id ?? generated;
  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        className={cn("relative h-56 w-full min-w-0 max-w-full text-body-sm", className)}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer
          width="100%"
          height="100%"
          minWidth={0}
          initialDimension={{ width: 320, height: 180 }}
          className="absolute inset-0 h-full max-w-full"
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

export function ChartTooltipContent({
  active,
  payload,
  label,
  formatValue,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{
    name?: string;
    value?: number | string;
    color?: string;
    dataKey?: string | number;
  }>;
  label?: string;
  /** Turns a stored number into the words the tooltip shows. Money uses the shared rupee helper. */
  formatValue?: (value: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-background px-2 py-1 text-body-sm shadow-sm">
      {label ? <p className="text-muted-foreground">{label}</p> : null}
      {payload.map((item) => (
        <p key={String(item.dataKey ?? item.name)}>
          <span style={{ color: item.color }}>{item.name}</span>{" "}
          {typeof item.value === "number" && formatValue ? formatValue(item.value) : item.value}
        </p>
      ))}
    </div>
  );
}
