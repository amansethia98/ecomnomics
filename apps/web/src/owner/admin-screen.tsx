import { useLingui } from "@lingui/react/macro";
import type { AdminPanel, AdminRestaurantFilter } from "@rakazo/contracts";
import {
  filterAdminRestaurants,
  formatCivilDay,
  formatRupees,
  panelFromAdminRows,
} from "@rakazo/contracts";
import { Activity, IndianRupee, Link2, Mail, Moon, Shield, Store } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const SECTIONS = [
  "health",
  "restaurants",
  "runs",
  "connections",
  "messages",
  "costs",
  "rules",
] as const;

type AdminSection = (typeof SECTIONS)[number];

export function AdminAccessDenied() {
  const { t } = useLingui();
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <div className="owner-panel p-6">
        <p className="text-label text-muted-foreground">{t`Admin`}</p>
        <h1 className="owner-title mt-1">{t`You don't have admin access`}</h1>
        <a className="mt-4 inline-block text-body-sm text-primary" href="/restaurants">
          {t`Back to the owner app`}
        </a>
        <p className="mt-2 text-body-sm text-muted-foreground">
          {t`Admin access · never shows passwords`}
        </p>
      </div>
    </div>
  );
}

export function AdminPanelScreen({
  panel,
  onView,
}: {
  panel: AdminPanel;
  onView: (restaurantId: string) => void;
}) {
  const { t } = useLingui();
  const [section, setSection] = useState<AdminSection>("health");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AdminRestaurantFilter>("all");
  const labels: Record<AdminSection, string> = {
    health: t`Platform health`,
    restaurants: t`Restaurants`,
    runs: t`Nightly runs`,
    connections: t`Logins & connections`,
    messages: t`Messages sent`,
    costs: t`Costs & usage`,
    rules: t`Rules & data quality`,
  };
  const stateLabel = {
    in_progress: t`In progress`,
    done: t`Done`,
    not_started: t`Didn't start`,
    failed: t`Failed`,
    paused: t`Paused`,
  };
  const rows = filterAdminRestaurants(panel.restaurants, query, filter);
  const filters: Array<[AdminRestaurantFilter, string]> = [
    ["all", t`All (${panel.restaurants.length})`],
    [
      "attention",
      t`Needs attention (${filterAdminRestaurants(panel.restaurants, "", "attention").length})`,
    ],
    ["paused", t`Paused (${panel.restaurants.filter((row) => row.paused).length})`],
  ];
  return (
    <div className="flex min-h-screen">
      <nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-card px-3 py-6">
        <p className="px-2 py-2 text-body font-medium">{t`Ecomnomics · Admin`}</p>
        {SECTIONS.map((id) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? "page" : undefined}
            className={
              section === id
                ? "flex items-center gap-2 rounded-lg bg-muted px-2 py-2 text-left text-body-sm"
                : "flex items-center gap-2 rounded-lg px-2 py-2 text-left text-body-sm text-muted-foreground"
            }
            onClick={() => setSection(id)}
          >
            <SectionIcon id={id} />
            {labels[id]}
          </button>
        ))}
        <p className="mt-auto px-2 text-body-sm text-muted-foreground">
          {t`Admin access · never shows passwords`}
        </p>
      </nav>
      <main className="min-w-0 flex-1 px-6 py-6">
        <p className="text-label text-muted-foreground">{labels[section]}</p>
        {section === "health" ? (
          <section className="mt-4 flex flex-col gap-6">
            <h2 className="text-heading1 font-semibold">{panel.health}</h2>
            <p className="text-body-sm text-muted-foreground">
              {t`Last night's run`}
              {" · "}
              {panel.restaurants.length === 1
                ? t`1 restaurant`
                : t`${panel.restaurants.length} restaurants`}
            </p>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat
                label={t`Downloads OK`}
                value={`${panel.runs.filter((run) => run.state === "done").length}/${panel.runs.length}`}
              />
              <Stat label={t`Briefs sent`} value="—" />
              <Stat
                label={t`Swiggy pending`}
                value={String(
                  panel.connections.filter((row) => row.swiggy === "not_connected").length,
                )}
              />
              <Stat
                label={t`Cost this month`}
                value={panel.costsPaise == null ? "—" : formatRupees(panel.costsPaise)}
              />
            </div>
            {panel.needsYou ? (
              <section className="owner-panel p-4">
                <h3 className="text-label text-muted-foreground">{t`Needs a person`}</h3>
                <ul>
                  {panel.runs
                    .filter((run) => run.state !== "done")
                    .map((run) => (
                      <li key={run.restaurant} className="border-t border-border py-2">
                        {run.restaurant} · {stateLabel[run.state]}
                      </li>
                    ))}
                </ul>
              </section>
            ) : (
              <p className="owner-pill owner-pill-good w-fit">{t`Nothing needs you`}</p>
            )}
            <ul>
              {panel.runs.map((run) => (
                <li
                  key={run.restaurant}
                  className="flex justify-between border-t border-border py-2"
                >
                  <span>{run.restaurant}</span>
                  <span>{stateLabel[run.state]}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {section === "restaurants" ? (
          <section className="mt-4 flex flex-col gap-4">
            <h2 className="owner-title">
              {t`${panel.restaurants.length} restaurants`}
              {" · "}
              {t`${panel.connections.length} outlets`}
            </h2>
            <input
              type="search"
              aria-label={t`Search restaurants`}
              placeholder={t`Search restaurants`}
              className="h-9 max-w-sm rounded-lg border border-border bg-background px-2"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              {filters.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={filter === id}
                  className={
                    filter === id ? "owner-pill bg-primary text-primary-foreground" : "owner-pill"
                  }
                  onClick={() => setFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {panel.restaurants.length === 0 ? <p>{t`Add your first restaurant`}</p> : null}
            {panel.restaurants.length > 0 && rows.length === 0 ? (
              <p>{t`No restaurants match.`}</p>
            ) : null}
            <table className="w-full text-body-sm">
              <thead>
                <tr className="text-left text-label text-muted-foreground">
                  <th className="py-2 font-medium">{t`Restaurant`}</th>
                  <th className="py-2 font-medium">{t`Connections`}</th>
                  <th className="py-2 font-medium">{t`Last download`}</th>
                  <th className="py-2 font-medium">{t`Cost`}</th>
                  <th className="py-2 font-medium">{t`Questions`}</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.restaurantId} className="border-t border-border">
                    <td className="py-3">
                      <span className="font-medium">{row.name}</span>
                      <span className="block text-muted-foreground">
                        {row.outlets === 1 ? t`1 outlet` : t`${row.outlets} outlets`}
                        {row.paused ? ` · ${t`Paused`}` : ""}
                      </span>
                    </td>
                    <td className="py-3">
                      {row.zomato === "connected" ? t`Zomato OK` : "—"}
                      {" · "}
                      {row.swiggy === "connected" ? t`Swiggy OK` : "—"}
                    </td>
                    <td className="py-3">
                      {row.lastDownload ? formatCivilDay(row.lastDownload) : "—"}
                    </td>
                    <td className="py-3">
                      {row.costPaise == null ? "—" : formatRupees(row.costPaise)}
                    </td>
                    <td className="py-3">—</td>
                    <td className="py-3 text-right">
                      <button
                        type="button"
                        className="rounded-lg border border-border px-3 py-1"
                        onClick={() => onView(row.restaurantId)}
                      >
                        {t`View as owner`}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        {section === "runs" ? (
          <section className="mt-4">
            <h2 className="text-heading1 font-semibold">
              {t`${panel.runs.filter((run) => run.state === "done").length} of ${panel.runs.length} downloads OK last night`}
            </h2>
            <table className="mt-4 w-full text-body-sm">
              <thead>
                <tr className="text-left text-label text-muted-foreground">
                  <th className="py-2 font-medium">{t`Restaurant`}</th>
                  <th className="py-2 font-medium">{t`Result`}</th>
                  <th className="py-2 font-medium">{t`Tries`}</th>
                  <th className="py-2 font-medium">{t`Rows`}</th>
                  <th className="py-2 font-medium">{t`Time`}</th>
                  <th className="py-2 font-medium">{t`AI cost`}</th>
                </tr>
              </thead>
              <tbody>
                {panel.runs.map((run) => (
                  <tr key={run.restaurant} className="border-t border-border">
                    <td className="py-3">{run.restaurant}</td>
                    <td className="py-3">
                      <span className="owner-pill">{stateLabel[run.state]}</span>
                    </td>
                    <td className="py-3">—</td>
                    <td className="py-3">—</td>
                    <td className="py-3">—</td>
                    <td className="py-3">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        {section === "connections" ? (
          <section className="mt-4 flex flex-col gap-4">
            <p className="text-body-sm text-muted-foreground">
              {t`Status only. Passwords and codes are never shown or stored here.`}
            </p>
            <ul>
              {panel.connections.map((row) => (
                <li key={`${row.restaurant}-${row.outlet}`} className="border-t border-border py-2">
                  <span className="font-medium">{row.outlet}</span>
                  <span className="ml-2 text-body-sm text-muted-foreground">{row.restaurant}</span>
                  <span className="ml-2 text-body-sm">
                    {row.zomato === "connected" ? t`Zomato connected` : t`Zomato not connected`}
                    {" · "}
                    {row.swiggy === "connected" ? t`Swiggy connected` : t`Swiggy not connected`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {section === "messages" ? (
          <div className="owner-panel mt-4 p-4">
            <h2 className="text-heading1 font-semibold">{t`Messages sent`}</h2>
            <p className="mt-2 text-body-sm text-muted-foreground">{panel.messages}</p>
          </div>
        ) : null}
        {section === "costs" ? (
          <section className="mt-4 flex flex-col gap-4">
            <h2 className="text-heading1 font-semibold">
              {panel.costsPaise == null
                ? "—"
                : t`${formatRupees(panel.costsPaise)} so far this month`}
            </h2>
            <table className="w-full text-body-sm">
              <tbody>
                {panel.restaurants.map((row) => (
                  <tr key={row.restaurantId} className="border-t border-border">
                    <td className="py-2">{row.name}</td>
                    <td className="py-2">
                      {row.costPaise == null ? "—" : formatRupees(row.costPaise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
        {section === "rules" ? (
          <section className="owner-panel mt-4 p-4">
            <p className="text-body-sm text-muted-foreground">{t`Confirmed in the rules file`}</p>
            <p className="mt-2">{panel.rules}</p>
            {panel.quality.length > 0 ? (
              <ul className="mt-3">
                {panel.quality.map((note) => (
                  <li key={note} className="border-t border-border py-2 text-body-sm">
                    {note}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </main>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="owner-panel p-3">
      <p className="text-label text-muted-foreground">{label}</p>
      <p className="text-heading3 font-medium">{value}</p>
    </div>
  );
}

function SectionIcon({ id }: { id: AdminSection }) {
  const className = "size-4 shrink-0";
  if (id === "health") return <Activity aria-hidden="true" className={className} />;
  if (id === "restaurants") return <Store aria-hidden="true" className={className} />;
  if (id === "runs") return <Moon aria-hidden="true" className={className} />;
  if (id === "connections") return <Link2 aria-hidden="true" className={className} />;
  if (id === "messages") return <Mail aria-hidden="true" className={className} />;
  if (id === "costs") return <IndianRupee aria-hidden="true" className={className} />;
  return <Shield aria-hidden="true" className={className} />;
}

export function PlatformAdminPage() {
  const [panel, setPanel] = useState<AdminPanel | null>(null);
  const [denied, setDenied] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let gone = false;
    void (async () => {
      const [restaurants, findings] = await Promise.all([
        fetch("/admin/v1/restaurants", { credentials: "include" }),
        fetch("/admin/v1/label-findings?status=open", { credentials: "include" }),
      ]);
      if (restaurants.status === 403 || findings.status === 403) {
        if (!gone) setDenied(true);
        return;
      }
      if (!restaurants.ok || !findings.ok) return;
      const listed = (await restaurants.json()) as {
        restaurants: Parameters<typeof panelFromAdminRows>[0];
      };
      const open = (await findings.json()) as { findings?: unknown[] };
      if (!gone) setPanel(panelFromAdminRows(listed.restaurants, open.findings?.length ?? 0));
    })();
    return () => {
      gone = true;
    };
  }, []);

  if (denied) return <AdminAccessDenied />;
  if (!panel) return null;
  return (
    <AdminPanelScreen
      panel={panel}
      onView={(restaurantId) => {
        void fetch(`/admin/v1/restaurants/${restaurantId}/view`, {
          method: "POST",
          credentials: "include",
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((body: { view?: { readOnly?: boolean } } | null) => {
            if (body?.view?.readOnly) {
              navigate(`/restaurants/${restaurantId}/home?readonly=1`);
            }
          });
      }}
    />
  );
}
