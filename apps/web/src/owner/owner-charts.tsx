import { useLingui } from "@lingui/react/macro";
import type { OwnerDashboardModel } from "@rakazo/contracts";
import { formatCivilDay, formatCompactRupees } from "@rakazo/contracts";
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
  return dates.map((date) => {
    const row: Record<string, string | number | null> = { date, label: formatCivilDay(date) };
    for (const panel of model.panels) {
      row[panel.platform] = panel.points.find((point) => point.week === date)?.sales ?? null;
    }
    return row;
  });
}

/** Line chart for the selected range. The x domain is the points, inset so the last label fits. */
export function SalesChart({ model, fitWidth }: { model: OwnerDashboardModel; fitWidth?: number }) {
  const narrow = useNarrow();
  const rows = salesRows(model);
  const brush = model.answer.unit === "week" && model.answer.weeks >= 12;
  const chart = (
    <LineChart
      data={rows}
      width={fitWidth}
      height={fitWidth ? 220 : undefined}
      margin={{ top: 12, right: 28, left: 4, bottom: 0 }}
    >
      <XAxis dataKey="label" interval="preserveStartEnd" tickMargin={8} minTickGap={16} />
      <YAxis hide width={36} tickFormatter={(value: number) => formatCompactRupees(value)} />
      <ChartTooltip
        trigger={narrow || fitWidth === 390 ? "click" : "hover"}
        content={<ChartTooltipContent />}
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

export function SparkLine({ values }: { values: Array<number | null> }) {
  const rows = values.map((value, index) => ({ index, value }));
  return (
    <ChartContainer
      config={{ value: { label: "Value", color: "var(--primary)" } }}
      className="h-40"
    >
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <XAxis dataKey="index" hide />
        <ChartTooltip trigger="hover" content={<ChartTooltipContent />} />
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
  const weeks = [...new Set(model.heatmap.map((cell) => cell.week))].sort();
  const max = Math.max(
    1,
    ...model.heatmap.flatMap((cell) => (cell.orders == null ? [] : [cell.orders])),
  );
  return (
    <div
      className="grid w-full min-w-0 gap-0.5"
      style={{ gridTemplateColumns: `2.5rem repeat(${Math.max(weeks.length, 1)}, minmax(0, 1fr))` }}
    >
      {WEEKDAYS.map((weekday) => (
        <div key={weekday} className="contents">
          <span className="text-label text-muted-foreground">{weekday}</span>
          {weeks.map((week) => {
            const cell = model.heatmap.find(
              (item) => item.week === week && item.weekday === weekday,
            );
            const orders = cell?.orders ?? 0;
            const mix = cell?.orders == null ? 0 : Math.round((orders / max) * 100);
            return (
              <span
                key={`${week}-${weekday}`}
                title={cell?.orders == null ? weekday : `${weekday} ${orders}`}
                className="block h-4 rounded-sm"
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
        <ChartTooltip trigger={narrow ? "click" : "hover"} content={<ChartTooltipContent />} />
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
