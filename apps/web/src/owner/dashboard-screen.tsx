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
  formatSignedPct,
} from "@rakazo/contracts";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PlatformDot } from "./marks";
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
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <Answer model={model} />
      <div className="flex flex-col gap-2">
        {plots
          .filter((plot) => plot.id.startsWith("sales-"))
          .map((plot) => (
            <section key={plot.id}>
              <PlatformDot platform={plot.id.endsWith("swiggy") ? "swiggy" : "zomato"} />
              <PlotFigure plot={plot} />
            </section>
          ))}
        {model.pins.length > 0 ? (
          <ol className="flex flex-wrap gap-3 text-body-sm text-muted-foreground">
            {model.pins.map((pin) => (
              <li key={`${pin.week}-${pin.kind}`}>
                {pin.n} <PinLabel kind={pin.kind} />
              </li>
            ))}
          </ol>
        ) : null}
        <Notes model={model} />
      </div>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {model.tiles.map((item) => (
          <NumberCard
            key={item.id}
            tile={item}
            onOpen={() =>
              setParams((current) => {
                current.set("tile", item.id);
                return current;
              })
            }
          />
        ))}
      </section>
      <section>
        <h2 className="text-label text-muted-foreground">{t`When you sell`}</h2>
        <PlotFigure plot={plots.find((plot) => plot.id === "heatmap") ?? plots[0]!} />
      </section>
      <section>
        <h2 className="text-label text-muted-foreground">{t`How customers find you`}</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {(["menu", "cart", "order"] as const).map((step) => (
            <div key={step}>
              <p className="text-body-sm">
                <StepLabel step={step} />
              </p>
              <PlotFigure plot={plots.find((plot) => plot.id === `funnel-${step}`) ?? plots[0]!} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Answer({ model }: { model: OwnerDashboardModel }) {
  const { t } = useLingui();
  const pct = model.answer.pct == null ? null : formatSignedPct(Math.abs(model.answer.pct));
  const lead =
    model.answer.direction === "up" && pct
      ? t`Sales are growing: up ${pct} in ${model.answer.weeks} weeks`
      : model.answer.direction === "down" && pct
        ? t`Sales are falling: down ${pct} in ${model.answer.weeks} weeks`
        : model.answer.direction === "flat"
          ? t`Sales are flat over ${model.answer.weeks} weeks`
          : t`Sales will show here once a few weeks are in`;
  const flat =
    model.answer.flatPlatform === "swiggy"
      ? t`Swiggy has been flat for ${model.answer.flatWeeks} weeks`
      : model.answer.flatPlatform === "zomato"
        ? t`Zomato has been flat for ${model.answer.flatWeeks} weeks`
        : null;
  const dip = model.answer.dipped
    ? model.answer.festival
      ? t`Last week dipped ${formatSignedPct(Math.abs(model.answer.dipped.pct))} after a festival week`
      : t`Last week dipped ${formatSignedPct(Math.abs(model.answer.dipped.pct))}`
    : null;
  const pending =
    model.answer.pendingPlatform === "swiggy"
      ? t`Swiggy pending`
      : model.answer.pendingPlatform === "zomato"
        ? t`Zomato pending`
        : null;
  return (
    <div>
      <h2 className="text-heading2 font-medium">{lead}</h2>
      <p className="text-body-sm text-muted-foreground">
        {[flat, dip, pending].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}

function Notes({ model }: { model: OwnerDashboardModel }) {
  const { t } = useLingui();
  const pending =
    model.pendingNote === "swiggy"
      ? t`Swiggy is pending, so those days are left out of both sides`
      : model.pendingNote === "zomato"
        ? t`Zomato is pending, so those days are left out of both sides`
        : null;
  const missing = model.missingNote ? t`A day is missing and left out of the total` : null;
  const compared = model.compared
    ? t`${model.compared.kept} of ${model.compared.expected} days compared`
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

function PinLabel({ kind }: { kind: "festival" | "discount" | "offline" }) {
  const { t } = useLingui();
  if (kind === "festival") return t`Festival`;
  if (kind === "discount") return t`Discount ended`;
  return t`Offline`;
}

function StepLabel({ step }: { step: "menu" | "cart" | "order" }) {
  const { t } = useLingui();
  if (step === "menu") return t`Opened your menu`;
  if (step === "cart") return t`Added to cart`;
  return t`Placed the order`;
}

function sparkPlot(tile: OwnerDashboardModel["tiles"][number]): OwnerPlot {
  const data = tile.spark.map((sales, week) => ({ week, sales }));
  return {
    id: tile.id,
    width: 640,
    height: 180,
    marks: [
      { type: "lineY", data, options: { x: "week", y: "sales", stroke: "var(--primary)" } },
      {
        type: "linearRegressionY",
        data: data.filter((point) => point.sales != null),
        options: { x: "week", y: "sales", stroke: "var(--primary)", strokeDasharray: "4 3" },
      },
    ],
  };
}

function PlotFigure({ plot }: { plot: OwnerPlot }) {
  const host = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(plot);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let live = true;
    void import("@rakazo/core/plot").then(({ renderPlotSpecToSvg }) => {
      if (!live || !host.current) return;
      host.current.replaceChildren();
      try {
        const markup = renderPlotSpecToSvg(plot, undefined, document);
        const svg = new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
        if (svg.nodeName.toLowerCase() === "svg") host.current.append(svg);
      } catch {
        host.current.replaceChildren();
      }
    });
    return () => {
      live = false;
    };
  }, [key, plot]);
  return <div ref={host} className="owner-plot" />;
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
      value: value.status === "ok" ? value.value : null,
      state: pointState(
        value.status,
        value.missingDates.length > 0,
        point.provisional,
        value.value,
      ),
    })),
  );
}

function pointState(
  status: "ok" | "not_available" | "updating",
  missing: boolean,
  provisional: boolean,
  value: number | null,
): DashReading["state"] {
  if (status === "updating") return "updating";
  if (status === "not_available") return missing ? "missing" : "pending";
  if (provisional && value == null) return "pending";
  return "ok";
}
