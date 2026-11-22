import { useLingui } from "@lingui/react/macro";
import type { OwnerMenu } from "@rakazo/contracts";
import { formatCivilDay, formatRupees } from "@rakazo/contracts";

export function MenuScreen({ screen }: { screen: OwnerMenu }) {
  const { t } = useLingui();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="owner-panel p-4">
        <p className="text-label text-primary">{t`Coming soon`}</p>
        <h2 className="owner-title">{t`Dish-by-dish insights are on the way`}</h2>
        <p className="mt-2 text-body-sm text-muted-foreground">
          {t`To tell you which dishes to promote, re-price or drop, we need dish-level sales. That download is being added. Nothing for you to set up.`}
        </p>
      </div>
      {screen.swiggy ? (
        <ul className="text-body-sm">
          <Fact label={t`Menu score`} value={screen.swiggy.score} />
          <Fact label={t`Dishes with photos`} value={screen.swiggy.photoPct} percent />
          <Fact label={t`Dishes with descriptions`} value={screen.swiggy.descriptionPct} percent />
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
      ) : null}
      <p className="text-body-sm text-muted-foreground">
        {t`Zomato doesn't share menu scores in its reports.`}
      </p>
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
  );
}

function Fact({
  label,
  value,
  percent = false,
  rupees = false,
}: {
  label: string;
  value: number | null | undefined;
  percent?: boolean;
  rupees?: boolean;
}) {
  const { t } = useLingui();
  const shown =
    value == null ? "—" : rupees ? formatRupees(value) : percent ? `${value}%` : String(value);
  return (
    <li className="flex justify-between gap-3 border-t border-border py-2">
      <span>{label}</span>
      <span>
        {value == null ? "—" : shown}
        {value == null ? (
          <span className="ml-2 text-muted-foreground">{t`Not in reports`}</span>
        ) : null}
      </span>
    </li>
  );
}
