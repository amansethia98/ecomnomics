import { useLingui } from "@lingui/react/macro";
import type { AdminOwnerView, AdminPanel } from "@rakazo/contracts";
import { formatRupees, panelFromAdminRows } from "@rakazo/contracts";
import { useEffect, useState } from "react";

export function AdminPanelScreen({
  panel,
  view,
  onView,
}: {
  panel: AdminPanel;
  view: AdminOwnerView | null;
  onView: (restaurantId: string) => void;
}) {
  const { t } = useLingui();
  const stateLabel = {
    in_progress: t`In progress`,
    done: t`Done`,
    not_started: t`Didn't start`,
    failed: t`Failed`,
    paused: t`Paused`,
  };
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-6">
      <section>
        <h2 className="owner-title">{panel.health}</h2>
        {!panel.needsYou && panel.health.startsWith("All ") ? <p>{t`Nothing needs you`}</p> : null}
      </section>
      <section>
        <h2 className="text-label text-muted-foreground">{t`Runs`}</h2>
        <ul>
          {panel.runs.map((run) => (
            <li key={run.restaurant} className="flex justify-between border-t border-border py-2">
              <span>{run.restaurant}</span>
              <span>{stateLabel[run.state]}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="text-label text-muted-foreground">{t`Restaurants`}</h2>
        {panel.restaurants.length === 0 ? <p>{t`Add your first restaurant`}</p> : null}
        <ul>
          {panel.restaurants.map((restaurant) => (
            <li
              key={restaurant.restaurantId}
              className="flex items-center justify-between gap-3 border-t border-border py-2"
            >
              <span>
                {restaurant.name}
                {restaurant.paused ? (
                  <span className="ml-2 text-body-sm text-muted-foreground">{t`Paused`}</span>
                ) : null}
              </span>
              <button
                type="button"
                className="text-body-sm text-primary"
                onClick={() => onView(restaurant.restaurantId)}
              >
                {t`View as owner`}
              </button>
            </li>
          ))}
        </ul>
      </section>
      {view ? (
        <section className="owner-panel px-4 py-3">
          <p className="text-label text-muted-foreground">{t`Read only`}</p>
          <p className="font-medium">{view.name}</p>
          <ul>
            {view.outlets.map((outlet) => (
              <li key={outlet.name} className="text-body-sm">
                {outlet.name} · {outlet.city}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section>
        <h2 className="text-label text-muted-foreground">{t`Connections`}</h2>
        <ul>
          {panel.connections.map((row) => (
            <li key={`${row.restaurant}-${row.outlet}`} className="border-t border-border py-2">
              <span className="font-medium">{row.outlet}</span>
              <span className="ml-2 text-body-sm text-muted-foreground">
                {row.zomato === "connected" ? t`Zomato connected` : t`Zomato not connected`}
                {" · "}
                {row.swiggy === "connected" ? t`Swiggy connected` : t`Swiggy not connected`}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="text-label text-muted-foreground">{t`Messages`}</h2>
        <p>{panel.messages}</p>
      </section>
      <section>
        <h2 className="text-label text-muted-foreground">{t`Costs`}</h2>
        <p>{panel.costsPaise == null ? "—" : formatRupees(panel.costsPaise)}</p>
      </section>
      <section>
        <h2 className="text-label text-muted-foreground">{t`Rules`}</h2>
        <p>{panel.rules}</p>
      </section>
    </div>
  );
}

export function PlatformAdminPage() {
  const { t } = useLingui();
  const [panel, setPanel] = useState<AdminPanel | null>(null);
  const [view, setView] = useState<AdminOwnerView | null>(null);
  const [denied, setDenied] = useState(false);

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

  if (denied) return <p className="px-4 py-6">{t`You don't have access.`}</p>;
  if (!panel) return null;
  return (
    <AdminPanelScreen
      panel={panel}
      view={view}
      onView={(restaurantId) => {
        void fetch(`/admin/v1/restaurants/${restaurantId}/view`, {
          method: "POST",
          credentials: "include",
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((body: { view?: AdminOwnerView } | null) => {
            if (body?.view?.readOnly) setView(body.view);
          });
      }}
    />
  );
}
