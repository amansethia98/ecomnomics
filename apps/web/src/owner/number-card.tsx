import { useLingui } from "@lingui/react/macro";
import type { DashTile } from "@rakazo/contracts";
import { formatRupees, formatSignedPct } from "@rakazo/contracts";
import { ChangeBadge } from "./marks";

export function NumberCard({ tile, onOpen }: { tile: DashTile; onOpen: () => void }) {
  const { t } = useLingui();
  const labels: Record<string, string> = {
    sales: t`Net sales`,
    orders: t`Delivered orders`,
    aov: t`Average order value`,
    online: t`Online time`,
    prep: t`Kitchen prep time`,
    rejected: t`Rejected or cancelled orders`,
    rating: t`Zomato rating`,
    ads: t`Ad sales per ₹1`,
  };
  const word =
    tile.word === "growing"
      ? t`Growing`
      : tile.word === "falling"
        ? t`Falling`
        : tile.word === "steady"
          ? t`Steady`
          : tile.word === "slower"
            ? t`Slower`
            : tile.word === "faster"
              ? t`Faster`
              : tile.word === "rising"
                ? t`Rising`
                : tile.word === "improving"
                  ? t`Improving`
                  : null;
  return (
    <button type="button" className="owner-kpi text-left" onClick={onOpen}>
      <p className="text-label text-muted-foreground">{labels[tile.id] ?? tile.id}</p>
      <p className="mt-1 text-heading2 font-medium">
        <TileValue tile={tile} />
      </p>
      {tile.state === "not_in_report" ? (
        <p className="text-body-sm text-muted-foreground">{t`Not in reports`}</p>
      ) : null}
      {tile.changePct != null ? (
        <ChangeBadge
          direction={tile.changePct < 0 ? "down" : "up"}
          label={formatSignedPct(tile.changePct)}
        />
      ) : null}
      <Spark values={tile.spark} />
      {word ? (
        <p
          className={
            tile.good === false
              ? "owner-pill owner-change-down mt-1"
              : tile.good
                ? "owner-pill owner-change-up mt-1"
                : "owner-pill mt-1 text-muted-foreground"
          }
        >
          {word}
          {tile.weeks > 0 ? ` · ${tile.weeks} ${tile.weeks === 1 ? t`wk` : t`wks`}` : ""}
        </p>
      ) : null}
      {tile.splits.length > 1 ? (
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-body-sm text-muted-foreground">
          {tile.splits.map((split) => (
            <span key={split.platform} className="inline-flex items-center gap-1">
              <span
                className={
                  split.platform === "zomato"
                    ? "owner-dot owner-dot-zomato"
                    : "owner-dot owner-dot-swiggy"
                }
                aria-hidden="true"
              />
              {split.inReport && split.value != null ? (
                <SplitValue tile={tile} value={split.value} />
              ) : (
                t`Not in reports`
              )}
            </span>
          ))}
        </p>
      ) : null}
      {tile.festival ? (
        <p className="text-label text-muted-foreground">{t`festival week`}</p>
      ) : null}
    </button>
  );
}

function TileValue({ tile }: { tile: DashTile }) {
  const { t } = useLingui();
  if (tile.state === "not_in_report" || tile.state === "empty" || tile.value == null) return "—";
  if (tile.state === "no_ads") return t`No ads ran`;
  if (tile.state === "pending") return t`Pending`;
  if (tile.state === "missing") return t`Not in yet`;
  if (tile.state === "updating") return t`Updating`;
  if (tile.state === "na") return t`n/a`;
  return <SplitValue tile={tile} value={tile.value} />;
}

function SplitValue({ tile, value }: { tile: DashTile; value: number }) {
  const { t } = useLingui();
  if (tile.format === "paise") return formatRupees(value);
  if (tile.format === "pct") return `${Math.round(value)}%`;
  if (tile.format === "minutes") return t`${value.toFixed(1)} min`;
  if (tile.format === "rating") return value.toFixed(1);
  if (tile.format === "ratio") return `₹${value.toFixed(2)}`;
  return String(Math.round(value));
}

function Spark({ values }: { values: Array<number | null> }) {
  const known = values.flatMap((value, index) => (value == null ? [] : [{ index, value }]));
  if (known.length < 2) return null;
  const min = Math.min(...known.map((point) => point.value));
  const max = Math.max(...known.map((point) => point.value));
  const span = max - min || 1;
  const width = 72;
  const height = 24;
  const path = known
    .map((point, index) => {
      const x = (point.index / Math.max(values.length - 1, 1)) * width;
      const y = height - 3 - ((point.value - min) / span) * (height - 6);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="mt-1 text-foreground" width={width} height={height} aria-hidden="true">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
