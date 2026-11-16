import { useLingui } from "@lingui/react/macro";
import type { MetricReading } from "@rakazo/contracts";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Eye } from "lucide-react";

export type StatusKind = "act_now" | "watch" | "good";

const PILL_CLASS: Record<StatusKind, string> = {
  act_now: "owner-pill owner-pill-act",
  watch: "owner-pill owner-pill-watch",
  good: "owner-pill owner-pill-good",
};

export function StatusPill({ kind, label }: { kind: StatusKind; label: string }) {
  const icon =
    kind === "act_now" ? (
      <AlertTriangle aria-hidden="true" className="size-3.5" />
    ) : kind === "watch" ? (
      <Eye aria-hidden="true" className="size-3.5" />
    ) : (
      <Check aria-hidden="true" className="size-3.5" />
    );
  return (
    <span className={PILL_CLASS[kind]}>
      {icon}
      {label}
    </span>
  );
}

export function PlatformDot({ platform }: { platform: "zomato" | "swiggy" }) {
  const { t } = useLingui();
  const label = platform === "zomato" ? t`Zomato` : t`Swiggy`;
  return (
    <span className="inline-flex items-center gap-1.5 text-body-sm text-foreground">
      <span
        className={
          platform === "zomato" ? "owner-dot owner-dot-zomato" : "owner-dot owner-dot-swiggy"
        }
        aria-hidden="true"
      />
      {label}
    </span>
  );
}

export function ChangeBadge({ direction, label }: { direction: "up" | "down"; label: string }) {
  const { t } = useLingui();
  const down = direction === "down";
  return (
    <span
      className={
        down
          ? "owner-change-down inline-flex items-center gap-0.5 text-body-sm"
          : "owner-change-up inline-flex items-center gap-0.5 text-body-sm"
      }
    >
      {down ? (
        <ArrowDown aria-hidden="true" className="size-3.5" />
      ) : (
        <ArrowUp aria-hidden="true" className="size-3.5" />
      )}
      <span className="sr-only">{down ? t`Down` : t`Up`}</span>
      {label}
    </span>
  );
}

export function MetricState({ kind }: { kind: MetricReading["kind"] }) {
  const { t } = useLingui();
  if (kind === "value") return null;
  const label =
    kind === "empty"
      ? t`Your first numbers arrive after tonight's download.`
      : kind === "updating"
        ? t`Updating`
        : kind === "pending"
          ? t`Pending`
          : kind === "not_in_yet"
            ? t`Not in yet`
            : t`n/a`;
  const quiet = kind === "updating" || kind === "pending" || kind === "not_in_yet";
  return <span className={quiet ? "text-muted-foreground" : undefined}>{label}</span>;
}
