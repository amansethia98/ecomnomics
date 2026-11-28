import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";

/**
 * A signed-in owner who already has a restaurant opens that restaurant.
 * An account still onboarding, or with no restaurant, keeps the page it was given
 * (the agent shell, a bot link, password reset, or passkeys).
 */
export function OwnerEntry({ fallback }: { fallback: ReactNode }) {
  const [target, setTarget] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const giveUp = window.setTimeout(() => {
      if (live) setTarget((current) => (current === undefined ? null : current));
    }, 2000);
    fetch("/api/v1/restaurants", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { restaurants?: Array<{ id: string }> } | null) => {
        if (!live) return;
        const id = body?.restaurants?.[0]?.id;
        setTarget(id ? `/restaurants/${id}/home` : null);
      })
      .catch(() => {
        if (live) setTarget(null);
      });
    return () => {
      live = false;
      window.clearTimeout(giveUp);
    };
  }, []);
  if (target === undefined) return <PageLoading />;
  if (target) return <Navigate to={target} replace />;
  return fallback;
}
