import { useLingui } from "@lingui/react/macro";
import type { OwnerMenu } from "@rakazo/contracts";
import { formatCivilDay, formatRupees } from "@rakazo/contracts";

export function MenuScreen({ screen }: { screen: OwnerMenu }) {
  const { t } = useLingui();
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="owner-panel p-4">
          <p className="text-label text-primary">{t`Coming soon`}</p>
          <h2 className="owner-title">{t`Dish-by-dish insights are on the way`}</h2>
          <p className="mt-2 text-body-sm text-muted-foreground">
            {t`To tell you which dishes to promote, re-price or drop, we need dish-level sales. That download is being added. Nothing for you to set up.`}
          </p>
        </div>
        <section className="owner-panel p-4">
          <h2 className="text-label text-muted-foreground">{t`What you'll get`}</h2>
          <ul className="mt-2 text-body-sm">
            <li>{t`Which dishes to keep and promote`}</li>
            <li>{t`Which to raise the price on`}</li>
            <li>{t`Which need a better photo`}</li>
            <li>{t`Which to think about removing`}</li>
          </ul>
          <ul className="mt-3 text-body-sm">
            {(
              [
                [t`Paneer butter masala`, t`Keep & promote`],
                [t`Veg biryani`, t`Raise price a little`],
                [t`Malai kofta`, t`Needs a better photo`],
                [t`Corn soup`, t`Think about removing`],
              ] as const
            ).map(([name, action]) => (
              <li key={name} className="flex items-center justify-between gap-3 py-2">
                <span>{name}</span>
                <span className="text-muted-foreground">{action}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {screen.swiggy ? (
        <section>
          <h2 className="text-label text-muted-foreground">{t`What we can already see · Swiggy menu, last 12 weeks`}</h2>
          <ul className="text-body-sm">
            <Fact
              label={t`Menu score`}
              value={screen.swiggy.score}
              points={screen.swiggy.scorePoints}
            />
            <Fact label={t`Dishes with photos`} value={screen.swiggy.photoPct} percent />
            <Fact
              label={t`Dishes with descriptions`}
              value={screen.swiggy.descriptionPct}
              percent
            />
            <Fact
              label={t`Top dishes`}
              value={screen.swiggy.top5SharePct ?? screen.swiggy.top5RevenuePaise}
              percent={screen.swiggy.top5SharePct != null}
              rupees={screen.swiggy.top5SharePct == null}
            />
            {screen.swiggy.scoreAsOf ? (
              <li className="text-body-sm text-muted-foreground">
                {t`Menu score as of ${formatCivilDay(screen.swiggy.scoreAsOf)}`}
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
      <p className="text-body-sm text-muted-foreground">
        {t`Zomato doesn't share menu scores in its reports.`}
      </p>
    </div>
  );
}

function Fact({
  label,
  value,
  percent = false,
  rupees = false,
  points,
}: {
  label: string;
  value: number | null | undefined;
  percent?: boolean;
  rupees?: boolean;
  points?: number[];
}) {
  const { t } = useLingui();
  const shown =
    value == null ? "—" : rupees ? formatRupees(value) : percent ? `${value}%` : String(value);
  return (
    <li className="flex items-center justify-between gap-3 border-t border-border py-2">
      <span>{label}</span>
      <span className="flex items-center gap-2">
        <Sparkline points={points} />
        {value == null ? "—" : shown}
        <span className="owner-pill bg-muted text-muted-foreground">
          {value == null ? t`Not in reports` : t`In reports`}
        </span>
      </span>
    </li>
  );
}

function Sparkline({ points }: { points?: number[] }) {
  if (!points || points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = 48 / (points.length - 1);
  const d = points
    .map((point, index) => {
      const x = (index * step).toFixed(1);
      const y = (16 - ((point - min) / span) * 14).toFixed(1);
      return `${index === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
  return (
    <svg aria-hidden="true" viewBox="0 0 48 16" className="h-4 w-12 text-foreground">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
