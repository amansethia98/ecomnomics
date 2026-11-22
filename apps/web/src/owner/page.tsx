import { useLingui } from "@lingui/react/macro";
import type {
  MarketingScreen,
  OwnerDocuments,
  OwnerHomeModel,
  OwnerHomeQuestion,
  OwnerMenu,
  OwnerPayments,
  OwnerProfile,
  OwnerRatings,
  OwnerView,
  StaffThread,
} from "@rakazo/contracts";
import { indiaCivilDate, parseOwnerView } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { setUiLocale } from "../lib/i18n";
import { OwnerDashboard } from "./dashboard-screen";
import { useDiscardGuard } from "./discard-guard";
import { DocumentsScreen } from "./documents-screen";
import type { OwnerScreenId } from "./frame";
import { isOwnerScreen, OwnerFrame } from "./frame";
import { OwnerHomeScreen } from "./home-screen";
import { MarketingActionsScreen } from "./marketing-screen";
import { MetricState } from "./marks";
import { MenuScreen } from "./menu-screen";
import { PaymentsScreen } from "./payments-screen";
import { RatingsScreen } from "./ratings-screen";
import { StaffScreen } from "./staff-screen";
import "./owner.css";
import type { ProfileDraft } from "./settings";
import { SettingsProfile } from "./settings";

interface RestaurantList {
  restaurants: { id: string; name: string }[];
}

async function ownerJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : String(response.status));
  }
  return response.json() as Promise<T>;
}

export function OwnerPage() {
  const { t } = useLingui();
  const { restaurantId, screen: screenParam } = useParams();
  const [params] = useSearchParams();
  const search = params.toString();
  const navigate = useNavigate();
  const today = indiaCivilDate(new Date());
  const [restaurants, setRestaurants] = useState<RestaurantList | null>(null);
  const [profile, setProfile] = useState<OwnerProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [home, setHome] = useState<OwnerHomeModel | null>(null);
  const [homeTick, setHomeTick] = useState(0);
  const [staff, setStaff] = useState<StaffThread | null>(null);
  const [marketing, setMarketing] = useState<MarketingScreen | null>(null);
  const [staffNotice, setStaffNotice] = useState<string | null>(null);
  const [payments, setPayments] = useState<OwnerPayments | null>(null);
  const [documents, setDocuments] = useState<OwnerDocuments | null>(null);
  const [menu, setMenu] = useState<OwnerMenu | null>(null);
  const [ratings, setRatings] = useState<OwnerRatings | null>(null);
  const [licenceSaving, setLicenceSaving] = useState(false);

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

  useEffect(() => {
    if (!restaurantId || screenParam !== "home") return;
    let live = true;
    setHome(null);
    const outlet = new URLSearchParams(search).get("outlet");
    const query = outlet && outlet !== "all" ? `?outletId=${encodeURIComponent(outlet)}` : "";
    ownerJson<OwnerHomeModel>(`/api/v1/restaurants/${restaurantId}/home${query}`)
      .then((next) => {
        if (live) setHome(next);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [restaurantId, screenParam, search, homeTick]);

  useEffect(() => {
    if (!restaurantId || (screenParam !== "chief-of-staff" && screenParam !== "marketing")) return;
    let live = true;
    setStaff(null);
    setMarketing(null);
    const path =
      screenParam === "marketing"
        ? `/api/v1/restaurants/${restaurantId}/marketing`
        : `/api/v1/restaurants/${restaurantId}/staff`;
    ownerJson<StaffThread | MarketingScreen>(path)
      .then((next) => {
        if (!live) return;
        if (screenParam === "marketing") setMarketing(next as MarketingScreen);
        else setStaff(next as StaffThread);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [restaurantId, screenParam]);

  useEffect(() => {
    if (!restaurantId || !isDeskScreen(screenParam)) return;
    let live = true;
    setPayments(null);
    setDocuments(null);
    setMenu(null);
    setRatings(null);
    const query = new URLSearchParams(search);
    const outlet = query.get("outlet");
    const outletQuery = outlet && outlet !== "all" ? `outletId=${encodeURIComponent(outlet)}` : "";
    const cycle = query.get("cycle");
    const paymentsQuery = [outletQuery, cycle ? `cycle=${encodeURIComponent(cycle)}` : ""]
      .filter(Boolean)
      .join("&");
    const path =
      screenParam === "payments"
        ? `/api/v1/restaurants/${restaurantId}/payments${paymentsQuery ? `?${paymentsQuery}` : ""}`
        : screenParam === "documents"
          ? `/api/v1/restaurants/${restaurantId}/documents`
          : screenParam === "menu"
            ? `/api/v1/restaurants/${restaurantId}/menu${outletQuery ? `?${outletQuery}` : ""}`
            : `/api/v1/restaurants/${restaurantId}/ratings${outletQuery ? `?${outletQuery}` : ""}`;
    ownerJson<OwnerPayments | OwnerDocuments | OwnerMenu | OwnerRatings>(path)
      .then((next) => {
        if (!live) return;
        if (screenParam === "payments") setPayments(next as OwnerPayments);
        else if (screenParam === "documents") setDocuments(next as OwnerDocuments);
        else if (screenParam === "menu") setMenu(next as OwnerMenu);
        else setRatings(next as OwnerRatings);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [restaurantId, screenParam, search]);

  useEffect(() => {
    setDirty(false);
    setSaveError(false);
  }, [screenParam]);

  const confirmLeave = useDiscardGuard(dirty, t`Leave without saving?`);

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
    const previousLocale = profile.owner.locale;
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
      if (draft.locale !== previousLocale && (draft.locale === "en" || draft.locale === "hi")) {
        await setUiLocale(draft.locale);
      }
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
      ) : screen === "home" ? (
        profile.outlets.length === 0 ? (
          <MetricState kind="empty" />
        ) : home ? (
          <OwnerHomeScreen
            restaurantId={restaurantId}
            restaurantName={profile.restaurant.name}
            home={home}
            onSnooze={(ids, days) => {
              void Promise.all(
                ids.map((id) =>
                  ownerJson(`/api/v1/restaurants/${restaurantId}/ops/alerts/${id}/snooze`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ days }),
                  }),
                ),
              ).then(() => setHomeTick((value) => value + 1));
            }}
            onAnswer={(question: OwnerHomeQuestion, status) => {
              void ownerJson(`/api/v1/restaurants/${restaurantId}/outlet-days`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ outletId: question.outletId, date: question.date, status }),
              }).then(() => setHomeTick((value) => value + 1));
            }}
          />
        ) : (
          <p className="text-muted-foreground">{t`Loading`}</p>
        )
      ) : screen === "dashboard" ? (
        <OwnerDashboard restaurantId={restaurantId} view={view} today={today} />
      ) : screen === "chief-of-staff" ? (
        staff ? (
          <StaffScreen
            restaurantId={restaurantId}
            thread={staff}
            notice={staffNotice}
            onAsk={(text, key) => {
              setStaffNotice(null);
              void ownerJson<StaffThread>(`/api/v1/restaurants/${restaurantId}/staff/questions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text, key }),
              })
                .then((next) => setStaff(next))
                .catch((error: unknown) =>
                  setStaffNotice(error instanceof Error ? error.message : t`Try again.`),
                );
            }}
            onChoose={(actionId, choice) => {
              setStaffNotice(null);
              void ownerJson<StaffThread>(`/api/v1/restaurants/${restaurantId}/staff/choices`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ actionId, choice }),
              })
                .then((next) => setStaff(next))
                .catch((error: unknown) =>
                  setStaffNotice(error instanceof Error ? error.message : t`Try again.`),
                );
            }}
          />
        ) : (
          <p className="text-muted-foreground">{t`Loading`}</p>
        )
      ) : screen === "marketing" ? (
        marketing ? (
          <MarketingActionsScreen
            restaurantId={restaurantId}
            screen={marketing}
            onConfirm={(actionId, done) => {
              void ownerJson<MarketingScreen>(
                `/api/v1/restaurants/${restaurantId}/marketing/${actionId}/confirm`,
                {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ done }),
                },
              ).then((next) => setMarketing(next));
            }}
            onDecide={(actionId, choice) => {
              void ownerJson<StaffThread>(`/api/v1/restaurants/${restaurantId}/staff/choices`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ actionId, choice }),
              })
                .then(() =>
                  ownerJson<MarketingScreen>(`/api/v1/restaurants/${restaurantId}/marketing`),
                )
                .then((next) => setMarketing(next));
            }}
          />
        ) : (
          <p className="text-muted-foreground">{t`Loading`}</p>
        )
      ) : screen === "payments" ? (
        payments ? (
          <PaymentsScreen
            screen={payments}
            today={today}
            onSelect={(id) => {
              const next = new URLSearchParams(search);
              next.set("cycle", id);
              navigate({ search: `?${next.toString()}` });
            }}
          />
        ) : (
          <p className="text-muted-foreground">{t`Loading`}</p>
        )
      ) : screen === "documents" ? (
        documents ? (
          <>
            <DocumentsScreen
              screen={documents}
              saving={licenceSaving}
              onDirty={setDirty}
              onSave={(draft) => {
                setLicenceSaving(true);
                setSaveError(false);
                void ownerJson<OwnerDocuments>(`/api/v1/restaurants/${restaurantId}/documents`, {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(draft),
                })
                  .then((next) => {
                    setDocuments(next);
                    setDirty(false);
                  })
                  .catch(() => setSaveError(true))
                  .finally(() => setLicenceSaving(false));
              }}
            />
            {saveError ? (
              <p className="mt-3 text-body-sm text-destructive">{t`Couldn't save. Try again.`}</p>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">{t`Loading`}</p>
        )
      ) : screen === "menu" ? (
        menu ? (
          <MenuScreen screen={menu} />
        ) : (
          <p className="text-muted-foreground">{t`Loading`}</p>
        )
      ) : screen === "ratings" ? (
        ratings ? (
          <RatingsScreen screen={ratings} />
        ) : (
          <p className="text-muted-foreground">{t`Loading`}</p>
        )
      ) : (
        <Placeholder />
      )}
    </OwnerFrame>
  );
}

function effectiveView(view: OwnerView, profile: OwnerProfile): OwnerView {
  const linked = new Set(
    profile.outlets
      .filter((outlet) => outlet.active)
      .flatMap((outlet) =>
        outlet.connections
          .filter((connection) => connection.status !== "not_connected")
          .map((connection) => connection.platform),
      ),
  );
  const platform = linked.size === 1 ? ([...linked][0] ?? view.platform) : view.platform;
  const active = profile.outlets.filter((item) => item.active);
  const known = active.some((item) => item.id === view.outlet);
  const outlet = active.length < 2 || view.outlet === "all" || !known ? "all" : view.outlet;
  return { ...view, platform, outlet };
}

function isDeskScreen(
  value: string | undefined,
): value is "payments" | "documents" | "menu" | "ratings" {
  return value === "payments" || value === "documents" || value === "menu" || value === "ratings";
}

function Placeholder() {
  const { t } = useLingui();
  return <p className="text-muted-foreground">{t`Coming soon`}</p>;
}
