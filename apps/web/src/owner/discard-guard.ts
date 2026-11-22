import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** Asks before a dirty profile is dropped, including browser Back inside the app. */
export function useDiscardGuard(active: boolean, message: string): () => boolean {
  const navigate = useNavigate();
  const location = useLocation();
  const allow = useRef(false);

  useEffect(() => {
    if (!active) allow.current = false;
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const stay = `${location.pathname}${location.search}${location.hash}`;
    const onUnload = (event: BeforeUnloadEvent) => {
      if (allow.current) return;
      event.preventDefault();
    };
    const onPop = () => {
      if (allow.current) return;
      if (window.confirm(message)) {
        allow.current = true;
        return;
      }
      navigate(stay);
    };
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("popstate", onPop);
    };
  }, [active, location.hash, location.pathname, location.search, message, navigate]);

  return useCallback(() => {
    if (!active || allow.current) return true;
    if (!window.confirm(message)) return false;
    allow.current = true;
    return true;
  }, [active, message]);
}
