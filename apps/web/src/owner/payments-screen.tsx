import { useLingui } from "@lingui/react/macro";
import type { OwnerPayments } from "@rakazo/contracts";
import {
  formatExclusiveRange,
  formatRupees,
  paymentsHeroRows,
  paymentWeeks,
} from "@rakazo/contracts";
import { useState } from "react";
import { PlatformDot } from "./marks";

export function PaymentsScreen({
  screen,
  today,
  onSelect,
}: {
  screen: OwnerPayments;
  today: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useLingui();
  const selected = screen.payouts.find((payout) => payout.id === screen.selectedId) ?? null;
  const earliest = screen.payouts.map((payout) => payout.from).sort()[0] ?? null;
  const weeks = paymentWeeks(today, earliest);
  const selectedRank = selected ? payoutRank(screen.payouts, selected.id) : 0;
  const initial = weeks[selectedRank] ?? weeks[0];
  const [week, setWeek] = useState(initial ? `${initial.from}|${initial.to}` : "");
  const [ordersOpen, setOrdersOpen] = useState(false);
  if (screen.payouts.length === 0) {
    return <p>{t`This week's payout file isn't out yet (usually Thursday morning).`}</p>;
  }
  const weekFrom = week.split("|")[0] ?? "";
  const chosen = weeks.find((item) => `${item.from}|${item.to}` === week);
  const weekLabel = chosen ? formatExclusiveRange(chosen.from, chosen.to) : "";
  const heroRows = weekFrom ? paymentsHeroRows(screen.payouts, weekFrom, today) : screen.payouts;
  const shown = heroRows.length > 0 ? heroRows : screen.payouts;
  const heroPaise = heroRows.reduce((total, payout) => {
    const amount = payoutAmount(payout);
    return amount == null ? total : total + amount;
  }, 0);
  return (
    <div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-8 overflow-x-clip">
      {heroRows.length > 0 ? (
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-label text-muted-foreground">{t`Latest payouts · Zomato and Swiggy`}</p>
            <h2 className="owner-title">{formatRupees(heroPaise)}</h2>
            <p data-testid="payout-week" className="text-body-sm text-muted-foreground">
              {weekLabel}
              {heroRows.map((payout, index) => {
                const amount = payoutAmount(payout);
                const name = payout.platform === "zomato" ? t`Zomato` : t`Swiggy`;
                const how = payout.bankBasis === "paid" ? t`paid` : t`expected`;
                const text = amount == null ? name : `${name} ${formatRupees(amount)} ${how}`;
                return (
                  <span key={payout.id}>
                    {index > 0 || weekLabel ? " · " : ""}
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
                const from = next.split("|")[0] ?? "";
                const rows = paymentsHeroRows(screen.payouts, from, today);
                const payout = rows.find((item) => item.id === screen.selectedId) ?? rows[0];
                if (payout && payout.id !== screen.selectedId) onSelect(payout.id);
              }}
            >
              {weeks.map((item) => (
                <option key={`${item.from}|${item.to}`} value={`${item.from}|${item.to}`}>
                  {formatExclusiveRange(item.from, item.to)}
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

function payoutRank(payouts: OwnerPayments["payouts"], id: string): number {
  const payout = payouts.find((item) => item.id === id);
  if (!payout) return 0;
  const rows = payouts
    .filter((item) => item.platform === payout.platform)
    .slice()
    .sort((left, right) => right.to.localeCompare(left.to));
  const index = rows.findIndex((item) => item.id === id);
  return Math.max(index, 0);
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
