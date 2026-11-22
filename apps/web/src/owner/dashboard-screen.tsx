import { useLingui } from "@lingui/react/macro";
import type {
  DashReading,
  OwnerDashboardModel,
  OwnerMetricsResponse,
  OwnerPlot,
  OwnerView,
} from "@rakazo/contracts";
import {
  addIsoDays,
  composeOwnerDashboard,
  DEFAULT_OPS_RULES_CONFIG,
  dashboardPlots,
  dashReadingState,
  formatCivilDay,
  formatCompactRupees,
  formatPct1,
  resolveOwnerPlot,
} from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { NumberCard } from "./number-card";

const KEYS = [
  "ops_sales_paise",
  "swiggy_net_sales_paise",
  "delivered_orders",
  "aov_paise",
  "online_pct",
  "kpt_minutes",
  "rejected_orders",
  "restaurant_cancelled_orders",
  "rating",
  "ads_sales_paise",
  "cpc_sales_paise",
  "ad_spend_paise",
  "cpc_spend_paise",
  "discount_paise",
  "impressions",
  "menu_opens",
  "cart_builds",
  "placed_orders",
  "swiggy_funnel_orders",
];

export function OwnerDashboard({
  restaurantId,
  view,
  today,
}: {
  restaurantId: string;
  view: OwnerView;
  today: string;
}) {
  const { t } = useLingui();
  const [params, setParams] = useSearchParams();
  const [model, setModel] = useState<OwnerDashboardModel | null>(null);
  const [failed, setFailed] = useState(false);
  const tile = params.get("tile");

  useEffect(() => {
    let live = true;
    const platforms =
      view.platform === "both" ? (["zomato", "swiggy"] as const) : ([view.platform] as const);
    const from = addIsoDays(today, -168);
    const to = addIsoDays(today, 1);
    Promise.all(
      platforms.flatMap((platform) =>
        (["week", "day"] as const).map((grain) =>
          loadMetrics(restaurantId, platform, from, to, grain, view.outlet).then((response) =>
            toReadings(response, platform, grain === "week" ? "week" : "day"),
          ),
        ),
      ),
    )
      .then((groups) => {
        if (!live) return;
        const readings = groups.flat();
        const days = new Set(
          readings
            .filter((reading) => reading.grain === "day" && reading.state === "ok")
            .map((reading) => reading.from),
        );
        setModel(
          composeOwnerDashboard({
            today,
            range: view.range,
            from: view.from,
            to: view.to,
            platform: view.platform,
            holidays: DEFAULT_OPS_RULES_CONFIG.holidayDates,
            readings,
            historyDays: days.size,
          }),
        );
        setFailed(false);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [restaurantId, today, view.from, view.to, view.outlet, view.platform, view.range]);

  if (failed) return <p>{t`Couldn't open this restaurant.`}</p>;
  if (!model) return <p className="text-muted-foreground">{t`Loading`}</p>;
  const open = model.tiles.find((item) => item.id === tile) ?? null;
  if (open) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <button
          type="button"
          className="text-left text-body-sm text-primary"
          onClick={() =>
            setParams((current) => {
              current.delete("tile");
              return current;
            })
          }
        >
          {t`Dashboard`}
        </button>
        <NumberCard tile={open} onOpen={() => undefined} />
        <PlotFigure plot={sparkPlot(open)} />
      </div>
    );
  }
  const plots = dashboardPlots(model);
  const openTile = (id: string) =>
    setParams((current) => {
      current.set("tile", id);
      return current;
    });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <Answer model={model} />
      <section className="owner-panel flex flex-col gap-2 p-3">
        {plots
          .filter((plot) => plot.id.startsWith("sales"))
          .map((plot) => (
            <PlotFigure key={plot.id} plot={plot} />
          ))}
        {model.pins.length > 0 ? (
          <ol className="flex flex-nowrap gap-3 overflow-x-auto text-body-sm whitespace-nowrap text-muted-foreground">
            {model.pins.map((pin) => (
              <li key={`${pin.week}-${pin.kind}`}>
                {pin.n} <PinLabel kind={pin.kind} label={pin.label} />
              </li>
            ))}
          </ol>
        ) : null}
        <Notes model={model} />
      </section>
      <section className="owner-panel p-4">
        <h2 className="text-label text-muted-foreground">{t`Key numbers · ${model.periodPhrase}`}</h2>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-6 lg:grid-cols-4">
          {model.tiles.map((item) => (
            <NumberCard key={item.id} tile={item} onOpen={() => openTile(item.id)} />
          ))}
        </div>
      </section>
      <section className="grid gap-6 lg:grid-cols-2">
        <div>
          <h2 className="text-label text-muted-foreground">{t`When you sell · last 12 weeks`}</h2>
          {model.heatmapLine ? <p className="mt-1 font-medium">{model.heatmapLine}</p> : null}
          <PlotFigure plot={plots.find((plot) => plot.id === "heatmap") ?? plots[0]!} />
          <p className="text-body-sm text-muted-foreground">{t`Fewer ▭ More orders · both apps`}</p>
        </div>
        <div>
          <h2 className="text-label text-muted-foreground">{t`How customers find you`}</h2>
          {model.funnelLine ? <FunnelLine text={model.funnelLine} /> : null}
          {(["menu", "cart", "order"] as const).map((step) => (
            <div key={step}>
              <p className="text-body-sm">
                <StepLabel step={step} />{" "}
                <span className="text-muted-foreground">
                  <StepHint step={step} />
                </span>
              </p>
              <PlotFigure plot={plots.find((plot) => plot.id === `funnel-${step}`) ?? plots[0]!} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function Answer({ model }: { model: OwnerDashboardModel }) {
  const { t } = useLingui();
  const pct =
    model.answer.pct == null
      ? null
      : model.periodPhrase === "in 12 weeks"
        ? `${Math.round(Math.abs(model.answer.pct))}%`
        : `${formatPct1(Math.abs(model.answer.pct))}%`;
  const basis = model.periodPhrase;
  const hasSales = model.tiles.find((tile) => tile.id === "sales")?.state === "value";
  const lead =
    model.answer.direction === "up" && pct
      ? t`Sales are growing: up ${pct}, ${basis}`
      : model.answer.direction === "down" && pct
        ? t`Sales are falling: down ${pct}, ${basis}`
        : model.answer.direction === "flat"
          ? t`Sales are flat, ${basis}`
          : hasSales
            ? t`Sales, ${basis}`
            : t`Sales will show here once a few weeks are in`;
  const flat =
    model.answer.flatPlatform === "swiggy"
      ? model.answer.flatWeeks === 1
        ? t`Swiggy has been flat for 1 week`
        : t`Swiggy has been flat for ${model.answer.flatWeeks} weeks`
      : model.answer.flatPlatform === "zomato"
        ? model.answer.flatWeeks === 1
          ? t`Zomato has been flat for 1 week`
          : t`Zomato has been flat for ${model.answer.flatWeeks} weeks`
        : null;
  const dipPct =
    model.answer.dipped == null ? null : `${formatPct1(Math.abs(model.answer.dipped.pct))}%`;
  const dip = dipPct
    ? model.answer.unit === "day"
      ? t`The last day dipped ${dipPct} vs ${model.answer.dipped?.against ?? "the day before"}`
      : t`Last week (${model.answer.dipped?.against ?? ""}) dipped ${dipPct}`
    : null;
  const festival =
    model.answer.festival || model.tiles.some((tile) => tile.festival) ? t`festival week` : null;
  const pending =
    model.answer.pendingPlatform === "swiggy"
      ? t`Swiggy pending`
      : model.answer.pendingPlatform === "zomato"
        ? t`Zomato pending`
        : null;
  return (
    <div>
      <h2 className="owner-title">{lead}</h2>
      <p className="text-body-sm text-muted-foreground">
        {[flat, dip, festival, pending].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}

function Notes({ model }: { model: OwnerDashboardModel }) {
  const { t } = useLingui();
  const pendingWhen = model.pendingDate ? formatCivilDay(model.pendingDate) : null;
  const pending =
    model.pendingNote === "swiggy"
      ? t`Swiggy ${pendingWhen ?? ""} pending, left out of both weeks`
      : model.pendingNote === "zomato"
        ? t`Zomato ${pendingWhen ?? ""} pending, left out of both weeks`
        : null;
  const missing = model.missingNote ? t`A day is missing and left out of the total` : null;
  const unit = model.answer.unit === "day" ? t`days` : t`weeks`;
  const compared =
    model.compared && model.compared.kept > 0 && model.compared.kept !== model.compared.expected
      ? t`${model.compared.kept} of ${model.compared.expected} ${unit} compared`
      : null;
  const young = model.comparisonsStart ? t`Comparisons start on ${model.comparisonsStart}` : null;
  const notes = [pending, missing, compared, young].filter((note): note is string => Boolean(note));
  if (notes.length === 0) return null;
  return (
    <ul className="text-body-sm text-muted-foreground">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

function PinLabel({ kind, label }: { kind: "festival" | "discount" | "offline"; label: string }) {
  const { t } = useLingui();
  if (kind === "festival") return label;
  if (kind === "discount") return t`Discount ended`;
  return t`Offline`;
}

function StepLabel({ step }: { step: "menu" | "cart" | "order" }) {
  const { t } = useLingui();
  if (step === "menu") return t`Opened your menu`;
  if (step === "cart") return t`Added to cart`;
  return t`Placed the order`;
}

function StepHint({ step }: { step: "menu" | "cart" | "order" }) {
  const { t } = useLingui();
  if (step === "menu") return t`of people who saw you`;
  if (step === "cart") return t`of menu opens`;
  return t`of carts`;
}

function sparkPlot(tile: OwnerDashboardModel["tiles"][number]): OwnerPlot {
  const data = tile.spark.map((sales, week) => ({ week, sales }));
  return {
    id: tile.id,
    width: 640,
    height: 180,
    marginLeft: tile.format === "paise" ? 64 : 40,
    y:
      tile.format === "paise"
        ? { label: null, tickFormat: (value: number) => formatCompactRupees(Number(value)) }
        : { label: null },
    marks: [
      { type: "lineY", data, options: { x: "week", y: "sales", stroke: "var(--primary)" } },
      ...(data.filter((point) => point.sales != null).length >= 2
        ? [
            {
              type: "linearRegressionY" as const,
              data: data.filter((point) => point.sales != null),
              options: {
                x: "week",
                y: "sales",
                stroke: "var(--primary)",
                strokeDasharray: "4 3",
              },
            },
          ]
        : []),
    ],
  };
}

export function FunnelLine({ text }: { text: string }) {
  const match = /^(.*?)(down \d+ weeks in a row)$/.exec(text);
  return (
    <p className="mt-1 font-medium text-foreground">
      <span aria-hidden="true" className="text-destructive">
        ●{" "}
      </span>
      {match ? (
        <>
          {match[1]}
          <span className="text-destructive">{match[2]}</span>
        </>
      ) : (
        text
      )}
    </p>
  );
}

function PlotFigure({ plot }: { plot: OwnerPlot }) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const key = JSON.stringify(plot);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let live = true;
    void import("@rakazo/core/plot").then(({ renderPlotSpecToSvg }) => {
      if (!live || !host.current) return;
      host.current.replaceChildren();
      try {
        const markup = renderPlotSpecToSvg(resolveOwnerPlot(plot), undefined, document);
        const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
        if (svg.nodeName.toLowerCase() !== "svg") {
          console.error("owner plot did not return an svg", plot.id);
          setFailed(true);
          return;
        }
        svg.setAttribute("font-size", "12");
        const drawn = Number(svg.getAttribute("width") ?? plot.width ?? 0);
        if (drawn > 400) svg.style.minWidth = `${drawn}px`;
        host.current.append(svg);
        setFailed(false);
      } catch (error) {
        console.error(error);
        host.current.replaceChildren();
        setFailed(true);
      }
    });
    return () => {
      live = false;
    };
  }, [key, plot]);
  return (
    <div>
      <div
        ref={host}
        className={(plot.width ?? 960) <= 400 ? "owner-plot owner-plot-fit" : "owner-plot"}
      />
      {failed ? <PlotFallback plot={plot} /> : null}
    </div>
  );
}

function PlotFallback({ plot }: { plot: OwnerPlot }) {
  const { t } = useLingui();
  const mark = plot.marks.find((item) => {
    const x = item.options?.x;
    const y = item.options?.y;
    return typeof x === "string" && typeof y === "string" && (item.data?.length ?? 0) > 0;
  });
  const rows = mark?.data?.filter(
    (row): row is Record<string, unknown> => !!row && typeof row === "object",
  );
  const x = typeof mark?.options?.x === "string" ? mark.options.x : null;
  const y = typeof mark?.options?.y === "string" ? mark.options.y : null;
  if (!rows || rows.length === 0 || !x || !y) {
    return <p className="text-body-sm text-muted-foreground">{t`Not in yet`}</p>;
  }
  return (
    <table className="text-body-sm text-muted-foreground">
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[x])}>
            <td className="pr-4">{String(row[x])}</td>
            <td>{String(row[y])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

async function loadMetrics(
  restaurantId: string,
  platform: "zomato" | "swiggy",
  from: string,
  to: string,
  grain: "day" | "week",
  outlet: string,
): Promise<OwnerMetricsResponse> {
  const params = new URLSearchParams();
  params.set("platform", platform);
  params.set("from", from);
  params.set("to", to);
  params.set("basis", "order_date");
  params.set("likeForLike", "false");
  params.set("grain", grain === "week" ? "week_mon_sun" : "day");
  for (const key of KEYS) params.append("keys", key);
  if (outlet !== "all") params.append("outletIds", outlet);
  const response = await fetch(`/api/v1/restaurants/${restaurantId}/metrics?${params}`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<OwnerMetricsResponse>;
}

function toReadings(
  response: OwnerMetricsResponse,
  platform: "zomato" | "swiggy",
  grain: "day" | "week",
): DashReading[] {
  return (response.series ?? []).flatMap((point) =>
    point.values.map((value) => ({
      from: point.from.slice(0, 10),
      grain,
      platform,
      key: value.key,
      value: value.value == null || value.coverageDays === 0 ? null : value.value,
      state: dashReadingState({
        status: value.status,
        value: value.value,
        coverageDays: value.coverageDays,
        provisional: point.provisional,
      }),
    })),
  );
}
