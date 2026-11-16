import { useLingui } from "@lingui/react/macro";
import type { MarketingRow, MarketingScreen } from "@rakazo/contracts";
import { formatRupees } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { Link } from "react-router-dom";

export function MarketingActionsScreen({
  restaurantId,
  screen,
  onConfirm,
}: {
  restaurantId: string;
  screen: MarketingScreen;
  onConfirm: (actionId: string, done: boolean) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const waiting = open ? [...screen.waiting, ...screen.overflow] : screen.waiting;
  if (screen.hero === "empty") {
    return (
      <div className="mx-auto max-w-3xl">
        <p>{t`Your chief of staff will suggest your first action after a week of data.`}</p>
        <Link className="text-primary" to={`/restaurants/${restaurantId}/chief-of-staff`}>
          {t`Ask chief of staff`}
        </Link>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {screen.hero === "result" && screen.resultTitle ? (
        <div>
          <h2 className="text-heading2 font-medium">{screen.resultTitle}</h2>
          {screen.resultPaise != null ? (
            <p className={screen.resultPaise < 0 ? "owner-change-down" : "owner-change-up"}>
              {formatRupees(Math.abs(screen.resultPaise))}
            </p>
          ) : null}
        </div>
      ) : null}
      {waiting.length > 0 ? (
        <section>
          <h2 className="text-label text-muted-foreground">{t`Waiting · ${screen.waiting.length + screen.overflow.length}`}</h2>
          <ul>
            {waiting.map((row) => (
              <Row key={row.id} row={row} onConfirm={onConfirm} />
            ))}
          </ul>
          {screen.overflow.length > 0 ? (
            <button
              type="button"
              className="mt-2 text-body-sm text-primary"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? t`Show less` : t`Show ${screen.overflow.length} more`}
            </button>
          ) : null}
        </section>
      ) : null}
      {screen.rows.length > 0 ? (
        <ul>
          {screen.rows.map((row) => (
            <Row key={row.id} row={row} onConfirm={onConfirm} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Row({
  row,
  onConfirm,
}: {
  row: MarketingRow;
  onConfirm: (actionId: string, done: boolean) => void;
}) {
  const { t } = useLingui();
  const label =
    row.display === "not_seen"
      ? t`Not seen yet`
      : row.display === "too_early"
        ? t`Too early`
        : row.display === "festival"
          ? t`Festival week, can't judge fairly`
          : row.display === "live"
            ? t`Live`
            : row.display === "result"
              ? t`Result`
              : t`Waiting`;
  return (
    <li className="border-t border-border py-3">
      <p className="font-medium">{row.title}</p>
      <p className="text-body-sm text-muted-foreground">{row.detail}</p>
      <p className="mt-1 text-body-sm">{label}</p>
      {row.display === "result" && row.resultPaise != null ? (
        <p className={row.resultPaise < 0 ? "owner-change-down" : "owner-change-up"}>
          {formatRupees(Math.abs(row.resultPaise))}
        </p>
      ) : null}
      {(row.display === "waiting" || row.display === "not_seen") && row.maxCostPaise != null ? (
        <p className="text-body-sm text-muted-foreground">
          {t`Maximum cost`} {formatRupees(row.maxCostPaise)}
        </p>
      ) : null}
      {row.display === "not_seen" ? (
        <div className="mt-2 flex items-center gap-2">
          <p className="text-body-sm">{t`Did you switch it on?`}</p>
          <Button type="button" variant="outline" onClick={() => onConfirm(row.id, true)}>
            {t`Yes`}
          </Button>
          <Button type="button" variant="outline" onClick={() => onConfirm(row.id, false)}>
            {t`Not yet`}
          </Button>
        </div>
      ) : null}
    </li>
  );
}
