import { useLingui } from "@lingui/react/macro";
import type { OwnerProfile, OwnerView } from "@rakazo/contracts";
import { indiaCivilDate, parseOwnerView } from "@rakazo/contracts";
import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { OwnerScreenId } from "./frame";
import { isOwnerScreen, OwnerFrame } from "./frame";
import { MetricState } from "./marks";
import "./owner.css";
import type { ProfileDraft } from "./settings";
import { SettingsProfile } from "./settings";

interface RestaurantList {
  restaurants: { id: string; name: string }[];
}

async function ownerJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include" });
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

export function OwnerPage() {
  const { t } = useLingui();
  const { restaurantId, screen: screenParam } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const today = indiaCivilDate(new Date());
  const [restaurants, setRestaurants] = useState<RestaurantList | null>(null);
  const [profile, setProfile] = useState<OwnerProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let live = true;
    ownerJson<RestaurantList>("/api/v1/restaurants")
      .then((list) => {
        if (live) setRestaurants(list);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!restaurantId) return;
    let live = true;
    setProfile(null);
    ownerJson<OwnerProfile>(`/api/v1/restaurants/${restaurantId}/profile`)
      .then((next) => {
        if (live) setProfile(next);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [restaurantId]);

  const confirmLeave = useCallback(() => {
    if (!dirty) return true;
    return window.confirm(t`Leave without saving?`);
  }, [dirty, t]);

  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

  if (failed) {
    return <p className="p-8 text-body">{t`Couldn't open this restaurant.`}</p>;
  }
  if (!restaurants || (restaurantId && !profile)) {
    return <p className="p-8 text-muted-foreground">{t`Loading`}</p>;
  }
  if (!restaurantId) {
    const only = restaurants.restaurants[0];
    if (restaurants.restaurants.length === 1 && only) {
      return <Navigate to={`/restaurants/${only.id}/home`} replace />;
    }
    if (restaurants.restaurants.length === 0) {
      return (
        <div className="ecomnomics min-h-svh bg-muted p-8" data-theme="light">
          <h1 className="text-heading3 font-medium">{t`Ecomnomics`}</h1>
          <p className="mt-4">
            <MetricState kind="empty" />
          </p>
        </div>
      );
    }
    return (
      <div className="ecomnomics min-h-svh bg-muted p-8" data-theme="light">
        <h1 className="mb-4 text-heading3 font-medium">{t`Ecomnomics`}</h1>
        <ul className="flex flex-col gap-2">
          {restaurants.restaurants.map((restaurant) => (
            <li key={restaurant.id}>
              <a className="text-primary" href={`/restaurants/${restaurant.id}/home`}>
                {restaurant.name}
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (!profile) return null;
  const screen: OwnerScreenId = isOwnerScreen(screenParam) ? screenParam : "home";
  if (!isOwnerScreen(screenParam)) {
    return <Navigate to={`/restaurants/${restaurantId}/home`} replace />;
  }
  const view = effectiveView(parseOwnerView(params, today), profile);
  const setView = (next: OwnerView) => {
    const params = new URLSearchParams();
    params.set("range", next.range);
    params.set("platform", next.platform);
    if (next.outlet !== "all") params.set("outlet", next.outlet);
    if (next.range === "custom") {
      params.set("from", next.from);
      params.set("to", next.to);
    }
    navigate({ search: `?${params.toString()}` });
  };
  const save = async (draft: ProfileDraft) => {
    setSaving(true);
    setSaveError(false);
    try {
      const next = await ownerJson<OwnerProfile>(`/api/v1/restaurants/${restaurantId}/profile`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ownerName: draft.ownerName,
          locale: draft.locale,
          restaurantName: draft.restaurantName,
          outlets: draft.outlets,
        }),
      });
      setProfile(next);
      setDirty(false);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <OwnerFrame
      restaurantId={restaurantId}
      profile={profile}
      screen={screen}
      view={view}
      today={today}
      onView={setView}
      confirmLeave={confirmLeave}
    >
      {screen === "settings" ? (
        <>
          <SettingsProfile profile={profile} saving={saving} onSave={save} onDirty={setDirty} />
          {saveError ? (
            <p className="mt-3 text-body-sm text-destructive">{t`Couldn't save. Try again.`}</p>
          ) : null}
        </>
      ) : profile.outlets.length === 0 && screen === "home" ? (
        <MetricState kind="empty" />
      ) : (
        <Placeholder />
      )}
    </OwnerFrame>
  );
}

function effectiveView(view: OwnerView, profile: OwnerProfile): OwnerView {
  const linked = new Set(
    profile.outlets.flatMap((outlet) =>
      outlet.connections
        .filter((connection) => connection.status !== "not_connected")
        .map((connection) => connection.platform),
    ),
  );
  const platform = linked.size === 1 ? ([...linked][0] ?? view.platform) : view.platform;
  const known = profile.outlets.some((item) => item.id === view.outlet);
  const outlet =
    profile.outlets.length < 2 || view.outlet === "all" || !known ? "all" : view.outlet;
  return { ...view, platform, outlet };
}

function Placeholder() {
  const { t } = useLingui();
  return <p className="text-muted-foreground">{t`Coming soon`}</p>;
}
