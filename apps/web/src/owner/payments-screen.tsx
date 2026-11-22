import { useLingui } from "@lingui/react/macro";
import type { OwnerPayments } from "@rakazo/contracts";
import { formatExclusiveRange, formatRupees, paymentsHeroRows } from "@rakazo/contracts";
import { useState } from "react";
import { PlatformDot } from "./marks";

export function PaymentsScreen({
  screen,
  onSelect,
}: {
  screen: OwnerPayments;
  onSelect: (id: string) => void;
}) {
  const { t } = useLingui();
  const selected = screen.payouts.find((payout) => payout.id === screen.selectedId) ?? null;
  const [week, setWeek] = useState(selected ? `${selected.from}|${selected.to}` : "");
  const [ordersOpen, setOrdersOpen] = useState(false);
  if (screen.payouts.length === 0) {
    return <p>{t`This week's payout file isn't out yet (usually Thursday morning).`}</p>;
  }
  const weeks = [
    ...new Map(screen.payouts.map((payout) => [`${payout.from}|${payout.to}`, payout])).values(),
  ];
  const shown = screen.payouts.filter((payout) => `${payout.from}|${payout.to}` === week);
  const [weekFrom, weekTo] = week.split("|");
  const heroRows =
    weekFrom && weekTo ? paymentsHeroRows(screen.payouts, weekFrom, weekTo) : screen.payouts;
  const heroPaise = heroRows.reduce((total, payout) => {
    const amount = payoutAmount(payout);
    return amount == null ? total : total + amount;
  }, 0);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      {heroRows.length > 0 ? (
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-label text-muted-foreground">{t`Latest payouts · Zomato and Swiggy`}</p>
            <h2 className="owner-title">{formatRupees(heroPaise)}</h2>
            <p className="text-body-sm text-muted-foreground">
              {heroRows.map((payout, index) => {
                const amount = payoutAmount(payout);
                const name = payout.platform === "zomato" ? t`Zomato` : t`Swiggy`;
                const when = formatExclusiveRange(payout.from, payout.to);
                const how = payout.bankBasis === "paid" ? t`paid` : t`expected`;
                const text =
                  amount == null
                    ? `${name} ${when}`
                    : `${name} ${formatRupees(amount)} ${how} ${when}`;
                return (
                  <span key={payout.id}>
                    {index > 0 ? " · " : ""}
                    <span
                      className={
                        payout.platform === "zomato"
                          ? "owner-dot owner-dot-zomato"
                          : "owner-dot owner-dot-swiggy"
                      }
                      aria-hidden="true"
                    />{" "}
                    {text}
                  </span>
                );
              })}
            </p>
          </div>
          {weeks.length > 0 ? (
            <select
              aria-label={t`Week`}
              className="h-8 shrink-0 rounded-full border border-border bg-background px-3"
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
                  {formatExclusiveRange(payout.from, payout.to)}
                </option>
              ))}
            </select>
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
                <span>{rowAmount(row)}</span>
              </li>
            ))}
          </ul>
          <Reach screen={screen} />
        </section>
      ) : null}
      <ul>
        {(shown.length > 0 ? shown : screen.payouts).map((payout) => (
          <li key={payout.id} className="border-t border-border">
            <button
              type="button"
              className={`flex w-full items-center gap-3 py-3 text-left ${payout.id === screen.selectedId ? "text-primary" : ""}`}
              aria-pressed={payout.id === screen.selectedId}
              onClick={() => {
                if (payout.id === screen.selectedId) {
                  setOrdersOpen((open) => !open);
                  return;
                }
                setOrdersOpen(true);
                onSelect(payout.id);
              }}
            >
              <PlatformDot platform={payout.platform} />
              <span className="flex-1">
                <span className="block font-medium">{payout.outletName ?? t`Outlet`}</span>
                <span className="block text-body-sm text-muted-foreground">
                  {payout.id === screen.selectedId && !ordersOpen ? `${t`View orders`} · ` : ""}
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
              <span className="owner-pill bg-muted text-muted-foreground">{t`Check runs Thursday`}</span>
              <span aria-hidden="true">›</span>
            </button>
            {payout.id === screen.selectedId && ordersOpen ? (
              <PayoutOrders screen={screen} />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function payoutAmount(payout: OwnerPayments["payouts"][number]): number | null {
  return payout.bankBasis === "paid" ? payout.paidAmountPaise : payout.netPayoutPaise;
}

function rowAmount(row: OwnerPayments["breakdown"][number]): string {
  if (row.paise == null) return "—";
  const signed =
    row.label.startsWith("−") || row.label.startsWith("+") || row.label.startsWith("=");
  return formatRupees(signed ? Math.abs(row.paise) : row.paise);
}

function PayoutOrders({ screen }: { screen: OwnerPayments }) {
  const { t } = useLingui();
  if (screen.orders.length === 0)
    return <p className="pb-3 text-body-sm">{t`No orders in this payout.`}</p>;
  return (
    <ul className="pb-3">
      {screen.orders.map((order) => (
        <li key={order.orderId} className="flex justify-between text-body-sm text-muted-foreground">
          <span>
            {order.orderId} · {order.date}
          </span>
          <span>{order.netPayoutPaise == null ? "—" : formatRupees(order.netPayoutPaise)}</span>
        </li>
      ))}
    </ul>
  );
}

function Reach({ screen }: { screen: OwnerPayments }) {
  const { t } = useLingui();
  const sales = screen.breakdown.find((row) => row.id === "sales")?.paise;
  const bank = screen.breakdown.find((row) => row.id === "bank" || row.id === "net")?.paise;
  if (sales == null || sales <= 0 || bank == null) return null;
  const reached = Math.round((bank / sales) * 100);
  return (
    <p className="mt-3 text-body-sm">
      {t`Out of every ₹100 in sales, ₹${reached} reached your bank`}
    </p>
  );
}
