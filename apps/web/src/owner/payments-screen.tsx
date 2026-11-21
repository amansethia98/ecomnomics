import { useLingui } from "@lingui/react/macro";
import type { OwnerPayments } from "@rakazo/contracts";
import { formatCivilDay, formatRupees } from "@rakazo/contracts";
import { useState } from "react";
import { PlatformDot } from "./marks";
import { PlotFigure } from "./plot-figure";

const ORDER_FOLD = 8;

export function PaymentsScreen({
  screen,
  onSelect,
}: {
  screen: OwnerPayments;
  onSelect: (id: string) => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const selected = screen.payouts.find((payout) => payout.id === screen.selectedId) ?? null;
  const [week, setWeek] = useState(selected ? `${selected.from}|${selected.to}` : "");
  if (screen.payouts.length === 0) {
    return <p>{t`This week's payout file isn't out yet (usually Thursday morning).`}</p>;
  }
  const weeks = [
    ...new Map(screen.payouts.map((payout) => [`${payout.from}|${payout.to}`, payout])).values(),
  ];
  const shown = screen.payouts.filter((payout) => `${payout.from}|${payout.to}` === week);
  const visible = open ? screen.orders : screen.orders.slice(0, ORDER_FOLD);
  const hidden = Math.max(0, screen.orders.length - ORDER_FOLD);
  const heroPaise =
    selected?.bankBasis === "paid"
      ? selected.paidAmountPaise
      : selected?.bankBasis === "net"
        ? selected.netPayoutPaise
        : null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      {selected && heroPaise != null ? (
        <div>
          <h2 className="owner-title">
            {selected.bankBasis === "paid"
              ? selected.platform === "zomato"
                ? t`${formatRupees(heroPaise)} paid to your bank (per Zomato)`
                : t`${formatRupees(heroPaise)} paid to your bank (per Swiggy)`
              : t`${formatRupees(heroPaise)} net in the payout file`}
          </h2>
          {selected.bankBasis === "net" ? (
            <p className="text-body-sm text-muted-foreground">
              {t`The bank amount isn't in this file.`}
            </p>
          ) : null}
        </div>
      ) : null}
      {(screen.breakdown ?? []).length > 0 ? (
        <section>
          <h2 className="text-label text-muted-foreground">{t`Where your money went`}</h2>
          <ul>
            {(screen.breakdown ?? []).map((row) => (
              <li key={row.id} className="flex justify-between border-t border-border py-2">
                <span>{row.label}</span>
                <span>{row.paise == null ? "—" : formatRupees(row.paise)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {weeks.length > 0 ? (
        <label className="flex items-center gap-2 text-body-sm">
          {t`Week`}
          <select
            aria-label={t`Week`}
            className="h-8 rounded-lg border border-border bg-background px-2"
            value={week}
            onChange={(event) => {
              const next = event.target.value;
              setWeek(next);
              const payout = screen.payouts.find((item) => `${item.from}|${item.to}` === next);
              if (payout) onSelect(payout.id);
            }}
          >
            {weeks.map((payout) => (
              <option key={`${payout.from}|${payout.to}`} value={`${payout.from}|${payout.to}`}>
                {formatCivilDay(payout.from)} – {formatCivilDay(payout.to)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <ul>
        {(shown.length > 0 ? shown : screen.payouts).map((payout) => (
          <li key={payout.id} className="border-t border-border">
            <button
              type="button"
              className={`flex w-full items-center gap-3 py-3 text-left ${payout.id === screen.selectedId ? "text-primary" : ""}`}
              aria-pressed={payout.id === screen.selectedId}
              onClick={() => onSelect(payout.id)}
            >
              <PlatformDot platform={payout.platform} />
              <span className="flex-1">
                <span className="block font-medium">{payout.outletName ?? t`Outlet`}</span>
                <span className="block text-body-sm text-muted-foreground">
                  {payout.bankBasis === "paid"
                    ? t`Paid to bank`
                    : payout.bankBasis === "net"
                      ? t`Net in file`
                      : t`Net in file`}
                  {payout.paidAmountPaise != null
                    ? ` · ${formatRupees(payout.paidAmountPaise)}`
                    : payout.netPayoutPaise != null
                      ? ` · ${formatRupees(payout.netPayoutPaise)}`
                      : " · —"}
                </span>
              </span>
              <span className="owner-pill owner-pill-watch">{t`Check runs Thursday`}</span>
            </button>
          </li>
        ))}
      </ul>
      {screen.deductions.length > 0 ? (
        <section>
          <h2 className="text-label text-muted-foreground">{t`Where the money went`}</h2>
          <ul>
            {screen.deductions.map((row) => (
              <li key={row.id} className="flex justify-between border-t border-border py-2">
                <span>{row.label}</span>
                <span>{formatRupees(row.paise)}</span>
              </li>
            ))}
          </ul>
          {screen.plot ? <PlotFigure plot={screen.plot} /> : null}
        </section>
      ) : null}
      {screen.orders.length > 0 ? (
        <section>
          <h2 className="text-label text-muted-foreground">{t`Orders in this payout`}</h2>
          <ul>
            {visible.map((order) => (
              <li
                key={order.orderId}
                className="flex justify-between gap-3 border-t border-border py-2"
              >
                <span>
                  {order.orderId}
                  <span className="ml-2 text-body-sm text-muted-foreground">
                    {formatCivilDay(order.date)}
                  </span>
                </span>
                {order.netPayoutPaise != null ? (
                  <span>{formatRupees(order.netPayoutPaise)}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {hidden > 0 ? (
            <button
              type="button"
              className="mt-2 text-body-sm text-primary"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? t`Show less` : t`Show ${hidden} more`}
            </button>
          ) : null}
        </section>
      ) : null}
      {screen.adjustments.length > 0 ? (
        <section>
          <h2 className="text-label text-muted-foreground">{t`Adjustments`}</h2>
          <ul>
            {screen.adjustments.map((row) => (
              <li
                key={`${row.label}-${row.amountPaise}`}
                className="flex justify-between border-t border-border py-2"
              >
                <span>{row.label}</span>
                <span>{formatRupees(row.amountPaise)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
