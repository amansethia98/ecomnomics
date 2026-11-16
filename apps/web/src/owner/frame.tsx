import { useLingui } from "@lingui/react/macro";
import type { OwnerProfile, OwnerView } from "@rakazo/contracts";
import {
  addIsoDays,
  customRange,
  formatCivilDay,
  ownerRangeBounds,
  rangeThrough,
} from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import {
  FileText,
  Home,
  LayoutDashboard,
  Megaphone,
  Settings,
  Sparkles,
  Star,
  Utensils,
  Wallet,
} from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { PlatformDot } from "./marks";

export const OWNER_SCREENS = [
  { id: "home", icon: Home },
  { id: "dashboard", icon: LayoutDashboard },
  { id: "payments", icon: Wallet },
  { id: "menu", icon: Utensils, soon: true },
  { id: "chief-of-staff", icon: Sparkles },
  { id: "marketing", icon: Megaphone },
  { id: "documents", icon: FileText },
  { id: "settings", icon: Settings },
  { id: "ratings", icon: Star, soon: true },
] as const;

export type OwnerScreenId = (typeof OWNER_SCREENS)[number]["id"];

const PHONE_TABS: OwnerScreenId[] = ["home", "dashboard", "chief-of-staff", "payments"];

export function isOwnerScreen(value: string | undefined): value is OwnerScreenId {
  return OWNER_SCREENS.some((screen) => screen.id === value);
}

function linkedPlatforms(profile: OwnerProfile): Array<"zomato" | "swiggy"> {
  const linked = new Set<"zomato" | "swiggy">();
  for (const outlet of profile.outlets) {
    if (!outlet.active) continue;
    for (const connection of outlet.connections) {
      if (connection.status !== "not_connected") linked.add(connection.platform);
    }
  }
  return [...linked];
}

export function OwnerFrame({
  restaurantId,
  profile,
  screen,
  view,
  today,
  onView,
  confirmLeave,
  children,
}: {
  restaurantId: string;
  profile: OwnerProfile;
  screen: OwnerScreenId;
  view: OwnerView;
  today: string;
  onView: (next: OwnerView) => void;
  confirmLeave: () => boolean;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const labels: Record<OwnerScreenId, string> = {
    home: t`Home`,
    dashboard: t`Dashboard`,
    payments: t`Payments`,
    menu: t`Menu`,
    "chief-of-staff": t`Chief of staff`,
    marketing: t`Marketing actions`,
    documents: t`Documents`,
    settings: t`Settings`,
    ratings: t`Ratings & reviews`,
  };
  const platforms = linkedPlatforms(profile);
  const outlets = profile.outlets.filter((outlet) => outlet.active);
  const showRange = screen === "dashboard";
  const showPlatform = showRange && platforms.length > 1;
  const showOutlets = outlets.length > 1 && screen !== "settings";
  const base = `/restaurants/${restaurantId}`;

  const go = (next: OwnerView) => {
    if (!confirmLeave()) return;
    onView(next);
  };

  return (
    <div className="ecomnomics flex min-h-svh bg-muted text-foreground" data-theme="light">
      <aside className="hidden w-56 shrink-0 flex-col gap-1 border-r border-border bg-background p-3 md:flex">
        <p className="flex items-center gap-2 px-2 py-3 text-body-lg font-medium">
          <span className="owner-mark" aria-hidden="true">
            E
          </span>
          {t`Ecomnomics`}
        </p>
        {OWNER_SCREENS.map((item) => (
          <NavItem
            key={item.id}
            to={`${base}/${item.id}${windowSearch(view)}`}
            icon={item.icon}
            label={labels[item.id]}
            soon={"soon" in item}
            onClick={() => confirmLeave()}
          />
        ))}
        <p className="mt-auto px-2 pt-6 text-body-sm text-muted-foreground">
          {profile.restaurant.name}
          <br />
          {outlets.length === 1 ? outlets[0]?.city : t`${outlets.length} outlets`}
        </p>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 px-4 py-4 md:px-8">
          <h1 className="mr-auto text-body font-medium">{labels[screen]}</h1>
          {showOutlets ? (
            <select
              aria-label={t`Outlet`}
              className="h-8 shrink-0 rounded-lg border border-border bg-background px-2 text-body-sm"
              value={view.outlet}
              onChange={(event) => go({ ...view, outlet: event.target.value })}
            >
              <option value="all">{t`All outlets (${outlets.length})`}</option>
              {outlets.map((outlet) => (
                <option key={outlet.id} value={outlet.id}>
                  {outlet.name}
                </option>
              ))}
            </select>
          ) : null}
          {screen === "home" ? (
            <span className="shrink-0 rounded-lg border border-border bg-background px-2 py-1 text-body-sm">
              {formatCivilDay(addIsoDays(today, -1))}
            </span>
          ) : null}
          {showRange ? (
            <div className="flex w-full shrink-0 gap-2 overflow-x-auto md:w-auto">
              <div className="flex shrink-0 rounded-lg bg-background p-0.5">
                {(["7d", "4w", "12w", "custom"] as const).map((range) => (
                  <Button
                    key={range}
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-pressed={view.range === range}
                    className={view.range === range ? "bg-primary/10 text-primary" : undefined}
                    onClick={() =>
                      go(
                        range === "custom"
                          ? { ...view, range }
                          : { ...view, range, ...ownerRangeBounds(range, today) },
                      )
                    }
                  >
                    {range === "7d"
                      ? t`7D`
                      : range === "4w"
                        ? t`4W`
                        : range === "12w"
                          ? t`12W`
                          : t`Custom`}
                  </Button>
                ))}
              </div>
              {showPlatform ? (
                <div className="flex shrink-0 rounded-lg bg-background p-0.5">
                  {(["both", "zomato", "swiggy"] as const).map((platform) => (
                    <Button
                      key={platform}
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-pressed={view.platform === platform}
                      className={
                        view.platform === platform ? "bg-primary/10 text-primary" : undefined
                      }
                      onClick={() => go({ ...view, platform })}
                    >
                      {platform === "both" ? t`Both` : <PlatformDot platform={platform} />}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </header>
        {showRange && view.range === "custom" ? (
          <div className="flex gap-3 px-4 pb-2 md:px-8">
            <label className="flex items-center gap-2 text-body-sm">
              {t`From`}
              <input
                type="date"
                className="h-8 rounded-lg border border-border bg-background px-2"
                value={view.from}
                onChange={(event) =>
                  go({
                    ...view,
                    range: "custom",
                    ...customRange(event.target.value, rangeThrough(view.to)),
                  })
                }
              />
            </label>
            <label className="flex items-center gap-2 text-body-sm">
              {t`To`}
              <input
                type="date"
                className="h-8 rounded-lg border border-border bg-background px-2"
                value={rangeThrough(view.to)}
                onChange={(event) =>
                  go({ ...view, range: "custom", ...customRange(view.from, event.target.value) })
                }
              />
            </label>
          </div>
        ) : null}
        <main className="owner-page flex-1 px-4 pb-28 md:px-8 md:pb-10">{children}</main>
      </div>
      <nav className="owner-tabbar flex border-t border-border bg-background md:hidden">
        {PHONE_TABS.map((id) => {
          const item = OWNER_SCREENS.find((screen) => screen.id === id);
          if (!item) return null;
          const Icon = item.icon;
          return (
            <NavLink
              key={id}
              to={`${base}/${id}${windowSearch(view)}`}
              onClick={(event) => {
                if (!confirmLeave()) event.preventDefault();
              }}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center gap-1 py-2 text-label ${isActive ? "text-primary" : "text-muted-foreground"}`
              }
            >
              <Icon aria-hidden="true" className="size-5" />
              {labels[id]}
            </NavLink>
          );
        })}
        <details className="relative flex flex-1 flex-col items-center py-2 text-label text-muted-foreground">
          <summary className="flex cursor-pointer list-none flex-col items-center gap-1">
            <span aria-hidden="true" className="flex size-5 items-center justify-center">
              •••
            </span>
            {t`More`}
          </summary>
          <div className="absolute bottom-12 right-2 flex w-48 flex-col rounded-lg border border-border bg-background p-1 shadow-sm">
            {OWNER_SCREENS.filter((item) => !PHONE_TABS.includes(item.id)).map((item) => (
              <NavLink
                key={item.id}
                to={`${base}/${item.id}${windowSearch(view)}`}
                onClick={(event) => {
                  if (!confirmLeave()) event.preventDefault();
                }}
                className="rounded-md px-2 py-2 text-body-sm text-foreground"
              >
                {labels[item.id]}
              </NavLink>
            ))}
          </div>
        </details>
      </nav>
    </div>
  );
}

function windowSearch(view: OwnerView): string {
  const params = new URLSearchParams();
  params.set("range", view.range);
  params.set("platform", view.platform);
  if (view.outlet !== "all") params.set("outlet", view.outlet);
  if (view.range === "custom") {
    params.set("from", view.from);
    params.set("to", view.to);
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function NavItem({
  to,
  icon: Icon,
  label,
  soon,
  onClick,
}: {
  to: string;
  icon: typeof Home;
  label: string;
  soon: boolean;
  onClick: () => boolean;
}) {
  const { t } = useLingui();
  return (
    <NavLink
      to={to}
      onClick={(event) => {
        if (!onClick()) event.preventDefault();
      }}
      className={({ isActive }) =>
        `flex items-center gap-2 rounded-lg px-2 py-1.5 text-body-sm ${isActive ? "bg-primary/10 text-primary" : "text-foreground"}`
      }
    >
      <Icon aria-hidden="true" className="size-4" />
      <span className="flex-1">{label}</span>
      {soon ? <span className="text-label text-muted-foreground">{t`Soon`}</span> : null}
    </NavLink>
  );
}
