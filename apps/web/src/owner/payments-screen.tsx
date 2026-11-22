import { useLingui } from "@lingui/react/macro";
import type { OwnerPayments } from "@rakazo/contracts";
import {
  formatExclusiveRange,
  formatRupees,
  labeledPayoutTotals,
  paymentPeriods,
} from "@rakazo/contracts";
import { useState } from "react";
import { PlatformDot } from "./marks";

export function PaymentsScreen({
  screen,
  onSelect,
}: {
  screen: OwnerPayments;
  today: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useLingui();
  const periods = paymentPeriods(screen.payouts);
  const periodKey = (period: (typeof periods)[number]) =>
    `${period.from}|${period.to}|${period.zomato?.id ?? ""}|${period.swiggy?.id ?? ""}`;
  const initial = periods.find(
    (period) => period.zomato?.id === screen.selectedId || period.swiggy?.id === screen.selectedId,
  );
  const [week, setWeek] = useState(
    initial ? periodKey(initial) : periods[0] ? periodKey(periods[0]) : "",
  );
  const [ordersOpen, setOrdersOpen] = useState(false);
  if (screen.payouts.length === 0) {
    return <p>{t`This week's payout file isn't out yet (usually Thursday morning).`}</p>;
  }
  const chosen = periods.find((item) => periodKey(item) === week) ?? periods[0] ?? null;
  const weekLabel = chosen ? formatExclusiveRange(chosen.from, chosen.to) : "";
  const heroRows = [chosen?.zomato, chosen?.swiggy].filter((row) => row != null);
  const shown = heroRows;
  const totals = labeledPayoutTotals(heroRows);
  return (
    <div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-8 overflow-x-clip">
      {chosen ? (
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-label text-muted-foreground">{t`Latest payouts · Zomato and Swiggy`}</p>
            <h2 className="owner-title">
              {totals.paidPaise != null ? (
                <span className="block">
                  {t`Paid`} {formatRupees(totals.paidPaise)}
                </span>
              ) : null}
              {totals.pendingPaise != null ? (
                <span className="block">
                  {t`Pending`} {formatRupees(totals.pendingPaise)}
                </span>
              ) : null}
            </h2>
            <p data-testid="payout-week" className="text-body-sm text-muted-foreground">
              {weekLabel}
              {(["zomato", "swiggy"] as const).map((platform) => {
                const payout = chosen[platform];
                const name = platform === "zomato" ? t`Zomato` : t`Swiggy`;
                const text = payoutText(name, payout, {
                  missing: t`Report not in yet`,
                  paid: t`paid`,
                  expected: t`expected`,
                  pending: t`pending`,
                });
                return (
                  <span key={platform}>
                    {" · "}
                    <span
                      className={
                        platform === "zomato"
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
          {periods.length > 0 ? (
            <select
              aria-label={t`Week`}
              className="h-8 shrink-0 rounded-full border border-border bg-background px-3"
              value={chosen ? periodKey(chosen) : week}
              onChange={(event) => {
                const next = event.target.value;
                setWeek(next);
                const period = periods.find((item) => periodKey(item) === next);
                const payout = period?.zomato ?? period?.swiggy ?? null;
                if (payout && payout.id !== screen.selectedId) onSelect(payout.id);
              }}
            >
              {periods.map((item) => (
                <option key={periodKey(item)} value={periodKey(item)}>
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
                <span>{rowAmount(row, t`Not in report`)}</span>
              </li>
            ))}
          </ul>
          <Reach screen={screen} />
        </section>
      ) : null}
      <ul>
        {shown.map((payout) => (
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
                    : payout.expectedPaise != null
                      ? ` · ${formatRupees(payout.expectedPaise)}`
                      : ` · ${t`Not in report`}`}
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

function shownExpected(payout: OwnerPayments["payouts"][number]): number | null {
  if (payout.expectedPaise != null) return payout.expectedPaise;
  return payout.bankBasis === "net" ? payout.netPayoutPaise : null;
}

function payoutText(
  name: string,
  payout: OwnerPayments["payouts"][number] | null,
  label: { missing: string; paid: string; expected: string; pending: string },
): string {
  if (!payout) return `${name} ${label.missing}`;
  const expected = shownExpected(payout);
  if (payout.bankBasis === "paid" && payout.paidAmountPaise != null) {
    const paid = `${name} ${formatRupees(payout.paidAmountPaise)} ${label.paid}`;
    return expected == null ? paid : `${paid} · ${label.expected} ${formatRupees(expected)}`;
  }
  if (expected != null) return `${name} ${formatRupees(expected)} ${label.pending}`;
  return `${name} ${label.missing}`;
}

function rowAmount(row: OwnerPayments["breakdown"][number], missing: string): string {
  if (row.paise == null) return missing;
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
