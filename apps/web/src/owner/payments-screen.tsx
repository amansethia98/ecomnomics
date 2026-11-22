import { useLingui } from "@lingui/react/macro";
import type { OwnerPayments } from "@rakazo/contracts";
import {
  formatInclusiveRange,
  formatRupees,
  largestRemainderRupees,
  paymentPeriodLabel,
  paymentPeriods,
  payoutAppFigures,
  payoutAppLine,
  unstoredPayoutWindows,
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
  const payouts = [
    ...screen.payouts,
    ...unstoredPayoutWindows(screen.payouts, today).map((window) => ({
      id: `unstored-${window.platform}-${window.from}`,
      outletId: "",
      platform: window.platform,
      from: window.from,
      to: window.to,
      orderCount: null,
      netPayoutPaise: null,
      paidAmountPaise: null,
      expectedPaise: null,
      outletName: null,
      bankBasis: "missing" as const,
      status: "pending_check" as const,
    })),
  ];
  const periods = paymentPeriods(payouts);
  const periodKey = (period: (typeof periods)[number]) =>
    `${period.zomato?.id ?? period.swiggy?.id ?? ""}`;
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
  const names = { zomato: t`Zomato`, swiggy: t`Swiggy` };
  const words = { missing: t`Report not in yet`, paid: t`Paid`, expected: t`Expected` };
  const latest = payoutAppFigures(payouts);
  const shown = [chosen?.zomato ?? chosen?.swiggy].filter((row) => row != null);
  const storedOpen = shown.some((row) => !row.id.startsWith("unstored-"));
  const amounts = displayPaise(screen.breakdown ?? []);
  return (
    <div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-8 overflow-x-hidden pb-4">
      {chosen ? (
        <div className="flex min-w-0 flex-col gap-3">
          <div className="min-w-0">
            <p className="text-label text-muted-foreground">{t`Latest payouts · Zomato and Swiggy`}</p>
            <div
              data-testid="payout-week"
              className="mt-1 flex flex-col gap-1 text-heading3 font-medium"
            >
              {(["zomato", "swiggy"] as const).map((platform) => (
                <p key={platform}>
                  <span
                    className={
                      platform === "zomato"
                        ? "owner-dot owner-dot-zomato"
                        : "owner-dot owner-dot-swiggy"
                    }
                    aria-hidden="true"
                  />{" "}
                  {payoutAppLine(names[platform], latest[platform], words)}
                </p>
              ))}
            </div>
          </div>
          {periods.length > 0 ? (
            <select
              aria-label={t`Week`}
              className="h-10 w-full max-w-full rounded-full border border-border bg-background px-4"
              value={chosen ? periodKey(chosen) : week}
              onChange={(event) => {
                const next = event.target.value;
                setWeek(next);
                const period = periods.find((item) => periodKey(item) === next);
                const payout = period?.zomato ?? period?.swiggy;
                if (
                  payout &&
                  !payout.id.startsWith("unstored-") &&
                  payout.id !== screen.selectedId
                ) {
                  onSelect(payout.id);
                }
              }}
            >
              {periods.map((item) => {
                const payout = item.zomato ?? item.swiggy;
                const label = paymentPeriodLabel(item, names);
                const text =
                  payout?.id.startsWith("unstored-") === true
                    ? `${label} · ${words.missing}`
                    : label;
                return (
                  <option key={periodKey(item)} value={periodKey(item)}>
                    {text}
                  </option>
                );
              })}
            </select>
          ) : null}
        </div>
      ) : null}
      {storedOpen && (screen.breakdown ?? []).length > 0 ? (
        <section>
          <h2 className="text-label text-muted-foreground">{t`Where your money went`}</h2>
          <ul>
            {(screen.breakdown ?? []).map((row) => (
              <li key={row.id} className="flex justify-between border-t border-border py-2">
                <span>{row.label}</span>
                <span>{rowAmount(row, amounts, t`Not in report`)}</span>
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
                if (payout.id.startsWith("unstored-")) return;
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
                <span className="block font-medium">
                  {formatInclusiveRange(payout.from, payout.to)}
                </span>
                <span className="block text-body-sm text-muted-foreground">
                  {payout.id === screen.selectedId && !ordersOpen ? `${t`View orders`} · ` : ""}
                  {payoutFigure(payout, {
                    missing: t`Report not in yet`,
                    paid: t`Paid`,
                    expected: t`Expected`,
                  })}
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

function payoutFigure(
  payout: OwnerPayments["payouts"][number],
  label: { missing: string; paid: string; expected: string },
): string {
  if (payout.bankBasis === "paid" && payout.paidAmountPaise != null) {
    return `${label.paid} ${formatRupees(payout.paidAmountPaise)}`;
  }
  const expected = shownExpected(payout);
  if (expected != null) return `${label.expected} ${formatRupees(expected)}`;
  return label.missing;
}

function signedLine(row: OwnerPayments["breakdown"][number]): number | null {
  if (row.paise == null || row.id === "bank" || row.id === "net" || row.id === "gst") return null;
  if (row.id === "adjustments") return null;
  if (row.id === "sales" || row.id === "other") return row.paise;
  return -Math.abs(row.paise);
}

function displayPaise(rows: OwnerPayments["breakdown"]): Record<string, number> {
  const total = rows.find((row) => row.id === "bank" || row.id === "net")?.paise;
  if (total == null) return {};
  const parts = rows.flatMap((row) => {
    const paise = signedLine(row);
    return paise == null ? [] : [{ id: row.id, paise }];
  });
  if (parts.reduce((sum, part) => sum + part.paise, 0) !== total) return {};
  return largestRemainderRupees(parts, total);
}

function rowAmount(
  row: OwnerPayments["breakdown"][number],
  amounts: Record<string, number>,
  missing: string,
): string {
  if (row.paise == null) return missing;
  const shown = amounts[row.id] ?? row.paise;
  const signed =
    row.label.startsWith("−") || row.label.startsWith("+") || row.label.startsWith("=");
  return formatRupees(signed ? Math.abs(shown) : shown);
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
  const bank = screen.breakdown.find((row) => row.id === "bank");
  const net = screen.breakdown.find((row) => row.id === "net");
  const closing = bank ?? net;
  if (sales == null || sales <= 0 || closing?.paise == null) return null;
  const reached = Math.round((closing.paise / sales) * 100);
  return (
    <p className="mt-3 text-body-sm">
      {closing.basis === "paid"
        ? t`Out of every ₹100 in sales, ₹${reached} reached your bank`
        : t`Out of every ₹100 in sales, ₹${reached} is expected, not paid yet`}
    </p>
  );
}
