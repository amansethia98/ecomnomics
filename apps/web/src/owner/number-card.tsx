import { useLingui } from "@lingui/react/macro";
import type { DashTile } from "@rakazo/contracts";
import { formatRupees, formatSignedPct } from "@rakazo/contracts";
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
    <button type="button" className="owner-tile text-left" onClick={onOpen}>
      <p className="text-label text-muted-foreground">{labels[tile.id] ?? tile.id}</p>
      <p className="mt-2 text-heading3 font-medium">
        <TileValue tile={tile} />
      </p>
      {tile.changePct != null ? (
        <p
          className={
            tile.changePct < 0 ? "owner-change-down text-body-sm" : "owner-change-up text-body-sm"
          }
        >
          {formatSignedPct(tile.changePct)}
        </p>
      ) : null}
      {word ? (
        <p
          className={
            tile.good === false
              ? "owner-change-down text-body-sm"
              : tile.good
                ? "owner-change-up text-body-sm"
                : "text-body-sm text-muted-foreground"
          }
        >
          {word}
          {tile.weeks > 0 ? ` · ${tile.weeks} ${tile.weeks === 1 ? t`wk` : t`wks`}` : ""}
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
  if (tile.state === "not_in_report") return t`Not in Swiggy's reports yet`;
  if (tile.state === "no_ads") return t`No ads ran in this period.`;
  if (tile.state === "pending") return t`Pending`;
  if (tile.state === "missing") return t`Not in yet`;
  if (tile.state === "updating") return t`Updating`;
  if (tile.state === "na") return t`n/a`;
  if (tile.state === "empty" || tile.value == null) return t`Not in yet`;
  if (tile.format === "paise") return formatRupees(tile.value);
  if (tile.format === "pct") return `${Math.round(tile.value)}%`;
  if (tile.format === "minutes") return t`${tile.value.toFixed(1)} min`;
  if (tile.format === "rating") return tile.value.toFixed(1);
  if (tile.format === "ratio") return `₹${tile.value.toFixed(2)}`;
  return String(Math.round(tile.value));
}
