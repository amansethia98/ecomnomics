import { useLingui } from "@lingui/react/macro";
import type { OwnerMenu } from "@rakazo/contracts";
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
