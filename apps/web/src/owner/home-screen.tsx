import { useLingui } from "@lingui/react/macro";
import type { OwnerHomeItem, OwnerHomeModel, OwnerHomeQuestion } from "@rakazo/contracts";
import {
  formatCivilDay,
  formatRupees,
  formatSignedPct,
  formatWeekdayName,
  groupedHomeRows,
} from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Eye } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ChangeBadge, PlatformDot, StatusPill } from "./marks";

export function OwnerHomeScreen({
  restaurantId,
  restaurantName,
  home,
  onSnooze,
  onAnswer,
}: {
  restaurantId: string;
  restaurantName: string;
  home: OwnerHomeModel;
  onSnooze: (ids: string[], days: 1 | 3 | 7) => void;
  onAnswer: (question: OwnerHomeQuestion, status: "closed" | "not_sure") => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [fix, setFix] = useState(false);
  const weekday = home.baselineDate ? formatWeekdayName(home.baselineDate) : null;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      {home.staleNote ? (
        <p className="text-body-sm text-muted-foreground">{home.staleNote}</p>
      ) : null}
      {home.corrections.map((correction) => (
        <p key={correction} className="text-body-sm text-muted-foreground">
          {correction}
        </p>
      ))}
      <div>
        {home.date ? (
          <p className="text-body-sm text-muted-foreground">
            {t`Good morning`}
            {weekday
              ? ` · ${formatCivilDay(home.date)} ${t`compared with last`} ${weekday}`
              : ` · ${formatCivilDay(home.date)}`}
          </p>
        ) : null}
        <h2 className="owner-title mt-1">
          <HomeHeadline home={home} restaurantName={restaurantName} />
        </h2>
      </div>
      {home.kind === "welcome" ? (
        <p>
          {t`Your first numbers arrive after tonight's 5:30 AM download.`}{" "}
          <Link className="text-primary" to={`/restaurants/${restaurantId}/chief-of-staff`}>
            {t`Ask chief of staff`}
          </Link>
        </p>
      ) : null}
      {home.kind === "clear" ? (
        <p className="flex flex-wrap items-center gap-3">
          <StatusPill kind="good" label={t`All good · ${home.checksPassed} checks passed`} />
          <HomePositive home={home} />
        </p>
      ) : null}
      {home.card ? (
        <article
          className={
            home.card.severity === "act_now" ? "owner-card" : "owner-card owner-card-watch"
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              kind={home.card.severity === "act_now" ? "act_now" : "watch"}
              label={home.card.severity === "act_now" ? t`Act now` : t`Watch`}
            />
            {home.card.fresh ? (
              <span className="text-label text-muted-foreground">{t`New since 9 AM`}</span>
            ) : null}
            {home.card.platform !== "combined" ? (
              <span className="inline-flex items-center gap-2 text-body-sm">
                <PlatformDot platform={home.card.platform} />
                {home.card.outletName ? <span>· {home.card.outletName}</span> : null}
              </span>
            ) : null}
          </div>
          <h3 className="mt-3 text-heading3 font-medium">{home.card.text}</h3>
          {home.card.impactPaise > 0 ? (
            <p className="owner-change-down mt-2 text-heading3 font-medium">
              {formatRupees(home.card.impactPaise)} {t`in sales`}
            </p>
          ) : null}
          {home.card.consecutiveDays > 1 ? (
            <p className="mt-1 text-body-sm text-muted-foreground">
              {t`${ordinal(home.card.consecutiveDays)} day in a row`}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" onClick={() => setFix((value) => !value)}>
              {t`See what to check`}
            </Button>
            <Link
              className="inline-flex h-9 items-center rounded-lg px-3 text-body-sm text-primary"
              to={`/restaurants/${restaurantId}/chief-of-staff`}
            >
              {t`Ask chief of staff`}
            </Link>
            {home.card.canSnooze ? <Snooze ids={home.card.ids} onSnooze={onSnooze} /> : null}
          </div>
          {fix ? <p className="mt-3 text-body-sm">{home.card.fix}</p> : null}
        </article>
      ) : null}
      {home.kind !== "welcome" ? (
        <section>
          <h3 className="text-label text-muted-foreground">{t`Yesterday`}</h3>
          <div className="mt-3 grid gap-6 sm:grid-cols-3">
            <HeadlineNumber
              label={t`Net sales`}
              value={home.sales.paise != null ? formatRupees(home.sales.paise) : t`Not in yet`}
              change={home.sales.changePct}
              pending={home.sales.pendingPlatform}
              compare={weekday}
              asOf={home.sales.asOf}
            />
            <HeadlineNumber
              label={t`Delivered orders`}
              value={home.delivered.count != null ? String(home.delivered.count) : t`Not in yet`}
              change={home.delivered.changePct}
              pending={home.delivered.pendingPlatform}
              compare={weekday}
              asOf={home.delivered.asOf}
            />
            <div>
              <p className="text-label text-muted-foreground">{t`Last week's payout`}</p>
              <p className="mt-1 text-heading3 font-medium">
                {home.payout.paise != null
                  ? formatRupees(home.payout.paise)
                  : t`Check runs Thursday`}
              </p>
              {home.payout.toCheck > 0 ? (
                <p className="owner-change-down mt-1 text-body-sm">
                  {t`${home.payout.toCheck} to check`}
                </p>
              ) : null}
              <p className="text-body-sm text-muted-foreground">
                {t`Next payout`} {formatCivilDay(home.payout.nextDate)}
              </p>
            </div>
          </div>
        </section>
      ) : null}
      {home.rows.length > 0 ? (
        <section>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-label text-muted-foreground">{t`Also keep an eye on · ${home.rows.length + home.overflow.length}`}</h3>
            <span className="text-body-sm text-muted-foreground">{t`Most costly first`}</span>
          </div>
          <ul className="mt-2">
            {(open
              ? groupedHomeRows([...home.rows, ...home.overflow]).flatMap((group) => group.items)
              : home.rows
            ).map((item) => (
              <Row key={item.ids.join("-")} item={item} onSnooze={onSnooze} />
            ))}
          </ul>
          {home.overflow.length > 0 ? (
            <button
              type="button"
              className="mt-2 text-body-sm text-primary"
              onClick={() => setOpen((value) => !value)}
            >
              {open ? t`Show less` : t`Show ${home.overflow.length} more`}
            </button>
          ) : null}
        </section>
      ) : null}
      {home.questions.length > 0 ? (
        <section>
          <h3 className="text-label text-muted-foreground">{t`Quick question`}</h3>
          <ul className="mt-2 flex flex-col gap-3">
            {home.questions.map((question) => (
              <li
                key={`${question.outletId}-${question.date}`}
                className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3"
              >
                <div>
                  <p>
                    {t`${question.outletName} had 0 orders on ${formatCivilDay(question.date)}. Was it closed?`}
                  </p>
                  <p className="text-body-sm text-muted-foreground">
                    {t`If not, the app may not have updated yet. We'll check again for 2 days.`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onAnswer(question, "closed")}
                  >
                    {t`Yes, closed`}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onAnswer(question, "not_sure")}
                  >
                    {t`Not sure`}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {home.kind !== "welcome" ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-body-sm text-muted-foreground">
          <p>
            {home.updated.zomato
              ? t`Zomato updated ${clockLabel(home.updated.zomato)}`
              : t`Zomato pending, usually in by 11 AM`}
            {" · "}
            {home.updated.swiggy
              ? t`Swiggy updated ${clockLabel(home.updated.swiggy)}`
              : t`Swiggy pending, usually in by 11 AM`}
          </p>
          <Link className="text-primary" to={`/restaurants/${restaurantId}/dashboard`}>
            {t`Open full dashboard`}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function HomeHeadline({ home, restaurantName }: { home: OwnerHomeModel; restaurantName: string }) {
  const { t } = useLingui();
  if (home.kind === "welcome") return t`Welcome, ${restaurantName}`;
  if (home.kind === "waiting") return t`Yesterday's numbers aren't in yet`;
  if (home.kind === "clear") return t`All good yesterday`;
  if (home.kind === "watch") {
    return home.watch === 1
      ? t`1 thing to keep an eye on`
      : t`${home.watch} things to keep an eye on`;
  }
  const count = home.urgent + home.watch;
  const lead = count === 1 ? t`1 thing needs you today` : t`${count} things need you today`;
  return home.urgent > 0 && count > 1 ? `${lead} · ${t`${home.urgent} urgent`}` : lead;
}

function HomePositive({ home }: { home: OwnerHomeModel }) {
  const { t } = useLingui();
  if (home.positive?.kind === "best") {
    return t`Best ${home.positive.weekday} in ${home.positive.weeks} weeks: ${formatRupees(home.positive.paise)}`;
  }
  const weekday = home.positive?.kind === "steady" ? home.positive.weekday : t`day`;
  return t`Steady day, in line with last ${weekday}`;
}

function HeadlineNumber({
  label,
  value,
  change,
  pending,
  compare,
  asOf,
}: {
  label: string;
  value: string;
  change: number | null;
  pending: "zomato" | "swiggy" | null;
  compare: string | null;
  asOf: string | null;
}) {
  const { t } = useLingui();
  const pendingLabel =
    pending === "swiggy"
      ? t`Zomato only · Swiggy pending`
      : pending === "zomato"
        ? t`Swiggy only · Zomato pending`
        : null;
  return (
    <div>
      <p className="text-label text-muted-foreground">{label}</p>
      <p className="mt-1 text-heading3 font-medium">{value}</p>
      {change != null && compare ? (
        <ChangeBadge
          direction={change < 0 ? "down" : "up"}
          label={`${formatSignedPct(change)} ${t`vs last`} ${compare}`}
        />
      ) : null}
      {pendingLabel ? <p className="text-body-sm text-muted-foreground">{pendingLabel}</p> : null}
      {asOf ? (
        <p className="text-body-sm text-muted-foreground">{t`As of ${formatCivilDay(asOf)}`}</p>
      ) : null}
    </div>
  );
}

function Row({
  item,
  onSnooze,
}: {
  item: OwnerHomeItem;
  onSnooze: (ids: string[], days: 1 | 3 | 7) => void;
}) {
  return (
    <li className="flex items-center gap-3 border-t border-border py-3">
      <span
        className={
          item.severity === "act_now"
            ? "owner-round owner-round-act"
            : "owner-round owner-round-watch"
        }
        aria-hidden="true"
      >
        <Eye className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block">{item.text}</span>
        {item.detail ? (
          <span className="block text-body-sm text-muted-foreground">{item.detail}</span>
        ) : null}
      </span>
      {item.canSnooze ? <Snooze ids={item.ids} onSnooze={onSnooze} /> : null}
      <span className="text-muted-foreground" aria-hidden="true">
        ›
      </span>
    </li>
  );
}

function Snooze({
  ids,
  onSnooze,
}: {
  ids: string[];
  onSnooze: (ids: string[], days: 1 | 3 | 7) => void;
}) {
  const { t } = useLingui();
  return (
    <details className="text-body-sm">
      <summary className="cursor-pointer text-muted-foreground" aria-label={t`More`}>
        ···
      </summary>
      <div className="mt-1 flex gap-2">
        <button type="button" onClick={() => onSnooze(ids, 1)}>
          {t`1 day`}
        </button>
        <button type="button" onClick={() => onSnooze(ids, 3)}>
          {t`3 days`}
        </button>
        <button type="button" onClick={() => onSnooze(ids, 7)}>
          {t`7 days`}
        </button>
      </div>
    </details>
  );
}

function clockLabel(value: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match?.[1] || !match[2]) return value;
  const hours = Number(match[1]);
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour12 = hours % 12 || 12;
  return `${hour12}:${match[2]} ${suffix}`;
}

function ordinal(value: number): string {
  const mod = value % 10;
  const teen = value % 100;
  if (teen >= 11 && teen <= 13) return `${value}th`;
  if (mod === 1) return `${value}st`;
  if (mod === 2) return `${value}nd`;
  if (mod === 3) return `${value}rd`;
  return `${value}th`;
}
