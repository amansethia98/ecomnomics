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
      <p>{t`Menu editing is coming soon.`}</p>
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
        {shown}
        {value == null ? (
          <span className="ml-2 text-muted-foreground">{t`Not in reports`}</span>
        ) : null}
      </span>
    </li>
  );
}
