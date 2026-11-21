import { useLingui } from "@lingui/react/macro";
import type { OwnerMenu, OwnerMenuFacts } from "@rakazo/contracts";
import { formatRupees } from "@rakazo/contracts";
import { useState } from "react";
import { PlatformDot } from "./marks";

export function MenuScreen({ screen }: { screen: OwnerMenu }) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const rows = needle
    ? screen.rows.filter((row) => row.name.toLowerCase().includes(needle))
    : screen.rows;
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
          <Fact label={t`Top dishes`} value={screen.swiggy.top5RevenuePaise} rupees />
        </ul>
      ) : (
        <p className="text-body-sm text-muted-foreground">
          {t`Zomato doesn't share menu scores in its reports.`}
        </p>
      )}
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
      {screen.missingCount > 0 ? (
        <p className="text-body-sm text-muted-foreground">
          {screen.missingCount === 1
            ? t`1 item not on one app`
            : t`${screen.missingCount} items not on one app`}
        </p>
      ) : null}
      {screen.rows.length > 0 ? (
        <input
          type="search"
          aria-label={t`Search menu`}
          className="h-9 rounded-lg border border-border bg-background px-2"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}
      {screen.rows.length === 0 ? (
        <p>{t`No menu items are in yet.`}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.name} className="flex items-center gap-3 border-t border-border py-2">
              <span className="flex-1">{row.name}</span>
              {row.platforms.map((platform) => (
                <PlatformDot key={platform} platform={platform} />
              ))}
              <span>{formatRupees(row.revenuePaise)}</span>
            </li>
          ))}
        </ul>
      )}
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
  value: OwnerMenuFacts[keyof OwnerMenuFacts];
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
