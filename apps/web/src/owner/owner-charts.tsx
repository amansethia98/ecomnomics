import { useLingui } from "@lingui/react/macro";
import type { OwnerDashboardModel } from "@rakazo/contracts";
import { formatCivilDay, formatCompactRupees, formatCount, formatRupees } from "@rakazo/contracts";
import type { ChartConfig } from "@rakazo/ui-web";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { Brush, Line, LineChart, XAxis, YAxis } from "recharts";

const config = {
  zomato: { label: "Zomato", color: "var(--owner-zomato)" },
  swiggy: { label: "Swiggy", color: "var(--owner-swiggy)" },
} satisfies ChartConfig;

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 420px)");
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
  return narrow;
}

function salesRows(model: OwnerDashboardModel) {
  const dates = [
    ...new Set(model.panels.flatMap((panel) => panel.points.map((point) => point.week))),
  ].sort();
  const rows = dates.map((date) => {
    const row: Record<string, string | number | null> = { date, label: formatCivilDay(date) };
    for (const panel of model.panels) {
      row[panel.platform] = panel.points.find((point) => point.week === date)?.sales ?? null;
    }
    return row;
  });
  const trend = trendValues(rows);
  return rows.map((row, index) => ({ ...row, trend: trend[index] ?? null }));
}

/** Straight line through the combined sales, in the same paise the series uses. */
function trendValues(rows: Array<Record<string, string | number | null>>): Array<number | null> {
  const points = rows.flatMap((row, index) => {
    const zomato = typeof row.zomato === "number" ? row.zomato : null;
    const swiggy = typeof row.swiggy === "number" ? row.swiggy : null;
    if (zomato == null && swiggy == null) return [];
    return [{ index, value: (zomato ?? 0) + (swiggy ?? 0) }];
  });
  if (points.length < 2) return rows.map(() => null);
  const count = points.length;
  const sumX = points.reduce((total, point) => total + point.index, 0);
  const sumY = points.reduce((total, point) => total + point.value, 0);
  const sumXY = points.reduce((total, point) => total + point.index * point.value, 0);
  const sumXX = points.reduce((total, point) => total + point.index * point.index, 0);
  const denom = count * sumXX - sumX * sumX;
  if (denom === 0) return rows.map(() => null);
  const slope = (count * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / count;
  return rows.map((_, index) => Math.round(intercept + slope * index));
}

/** Line chart for the selected range. The x domain is the points, inset so the last label fits. */
export function SalesChart({ model, fitWidth }: { model: OwnerDashboardModel; fitWidth?: number }) {
  const narrow = useNarrow();
  const rows = salesRows(model);
  const brush =
    !narrow && fitWidth !== 390 && model.answer.unit === "week" && model.answer.weeks >= 12;
  const chart = (
    <LineChart
      data={rows}
      width={fitWidth}
      height={fitWidth ? 220 : undefined}
      margin={{ top: 12, right: 12, left: 4, bottom: 0 }}
    >
      <XAxis dataKey="label" interval="preserveStartEnd" tickMargin={8} minTickGap={16} />
      <YAxis width={52} tickFormatter={(value: number) => formatCompactRupees(value)} />
      <ChartTooltip
        trigger={narrow || fitWidth === 390 ? "click" : "hover"}
        content={<ChartTooltipContent formatValue={formatRupees} />}
      />
      {model.panels.map((panel) => (
        <Line
          key={panel.platform}
          type="monotone"
          dataKey={panel.platform}
          name={config[panel.platform].label}
          stroke={panel.platform === "zomato" ? "var(--owner-zomato)" : "var(--owner-swiggy)"}
          strokeWidth={1.5}
          dot={false}
          connectNulls
        />
      ))}
      <Line
        type="linear"
        dataKey="trend"
        name="Trend"
        stroke="var(--muted-foreground)"
        strokeDasharray="4 4"
        strokeWidth={1.5}
        dot={false}
        connectNulls
      />
      {brush ? <Brush dataKey="label" height={20} stroke="var(--border)" /> : null}
    </LineChart>
  );
  if (fitWidth) {
    return (
      <div data-testid="sales-chart" style={{ width: fitWidth, maxWidth: "100%" }}>
        {chart}
      </div>
    );
  }
  return (
    <ChartContainer config={config} className="h-56">
      {chart}
    </ChartContainer>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function SparkLine({ values, money }: { values: Array<number | null>; money?: boolean }) {
  const rows = values.map((value, index) => ({ index, value }));
  return (
    <ChartContainer
      config={{ value: { label: "Value", color: "var(--primary)" } }}
      className="h-40"
    >
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <XAxis dataKey="index" hide />
        <ChartTooltip
          trigger="hover"
          content={
            <ChartTooltipContent
              formatValue={money ? formatRupees : (value) => formatCount(value)}
            />
          }
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke="var(--primary)"
          dot={false}
          strokeWidth={1.5}
        />
      </LineChart>
    </ChartContainer>
  );
}

export function HeatGrid({ model }: { model: OwnerDashboardModel }) {
  const max = Math.max(
    1,
    ...model.heatmap.flatMap((cell) => (cell.salesPaise == null ? [] : [cell.salesPaise])),
  );
  return (
    <div
      className="grid w-full min-w-0 gap-px"
      data-testid="sales-heatmap"
      style={{ gridTemplateColumns: "2.5rem repeat(24, minmax(0, 1fr))" }}
    >
      <span />
      {Array.from({ length: 24 }, (_, hour) => (
        <span key={hour} className="truncate text-center text-label text-muted-foreground">
          {hour % 6 === 0 ? String(hour) : ""}
        </span>
      ))}
      {WEEKDAYS.map((weekday) => (
        <div key={weekday} className="contents">
          <span className="text-label text-muted-foreground">{weekday}</span>
          {Array.from({ length: 24 }, (_, hour) => {
            const cell = model.heatmap.find(
              (item) => item.weekday === weekday && item.hour === hour,
            );
            const sales = cell?.salesPaise ?? 0;
            const mix = cell?.salesPaise == null ? 0 : Math.round((sales / max) * 100);
            return (
              <span
                key={hour}
                title={
                  cell?.salesPaise == null
                    ? `${weekday} ${hour}`
                    : `${weekday} ${hour}:00 ${formatRupees(sales)}`
                }
                className="block h-4 min-w-0 rounded-sm"
                style={{
                  background: `color-mix(in oklch, var(--primary) ${mix}%, var(--muted))`,
                }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function FunnelChart({
  model,
  step,
}: {
  model: OwnerDashboardModel;
  step: "menu" | "cart" | "order";
}) {
  const { t } = useLingui();
  const narrow = useNarrow();
  const dates = [
    ...new Set(
      model.funnel
        .filter((series) => series.step === step)
        .flatMap((series) => series.points.map((point) => point.week)),
    ),
  ].sort();
  const rows = dates.map((date) => {
    const row: Record<string, string | number | null> = { label: formatCivilDay(date) };
    for (const series of model.funnel) {
      if (series.step !== step) continue;
      row[series.platform] = series.points.find((point) => point.week === date)?.pct ?? null;
    }
    return row;
  });
  return (
    <ChartContainer config={config} className="h-24">
      <LineChart data={rows} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
        <XAxis dataKey="label" interval="preserveStartEnd" tickMargin={4} hide={dates.length > 8} />
        <YAxis hide domain={[0, 100]} />
        <ChartTooltip
          trigger={narrow ? "click" : "hover"}
          content={<ChartTooltipContent formatValue={(value) => `${Math.round(value)}%`} />}
        />
        {(["zomato", "swiggy"] as const).map((platform) =>
          rows.some((row) => row[platform] != null) ? (
            <Line
              key={platform}
              type="monotone"
              dataKey={platform}
              name={platform === "zomato" ? t`Zomato` : t`Swiggy`}
              stroke={platform === "zomato" ? "var(--owner-zomato)" : "var(--owner-swiggy)"}
              strokeWidth={1.5}
              dot={false}
              connectNulls
            />
          ) : null,
        )}
      </LineChart>
    </ChartContainer>
  );
}
