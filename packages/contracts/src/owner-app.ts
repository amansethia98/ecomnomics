import * as z from "zod";
import { addIsoDays } from "./metric-dates.js";
import type { OwnerPlatform } from "./owner-metrics.js";

/** Inclusive start, exclusive end. `to` matches the metrics read. */
export const OWNER_RANGES = ["7d", "4w", "12w", "custom"] as const;
export type OwnerRange = (typeof OWNER_RANGES)[number];

export const OWNER_VIEW_PLATFORMS = ["both", "zomato", "swiggy"] as const;
export type OwnerViewPlatform = (typeof OWNER_VIEW_PLATFORMS)[number];

export const OWNER_LOCALES = ["en", "hi"] as const;
export type OwnerLocale = (typeof OWNER_LOCALES)[number];

export const CONNECTION_STATUSES = [
  "connected",
  "login_needs_attention",
  "not_connected",
  "not_updated",
] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

const LOGIN_ATTENTION = new Set(["signed_out", "needs_owner"]);
const NOT_UPDATED = new Set([
  "download_failed",
  "ui_changed",
  "layout_changed",
  "parse_failed",
  "local_mismatch",
  "rejected_mismatch",
  "missing_platform_id",
]);

/** Latest run-log status for one outlet and platform. Never a credential. */
export function connectionStatus(input: {
  linked: boolean;
  latest: string | null;
}): ConnectionStatus {
  if (!input.linked) return "not_connected";
  if (input.latest == null || NOT_UPDATED.has(input.latest)) return "not_updated";
  if (LOGIN_ATTENTION.has(input.latest)) return "login_needs_attention";
  return "connected";
}

export type MetricReading =
  | { kind: "empty" }
  | { kind: "updating" }
  | { kind: "pending" }
  | { kind: "not_in_yet" }
  | { kind: "not_applicable" }
  | { kind: "value"; value: number };

/**
 * Shared reading rules. Pending, a gap, and a running fetch never become a number,
 * so they stay out of totals and out of both sides of a comparison.
 */
export function metricReading(input: {
  hasHistory: boolean;
  updating: boolean;
  pending: boolean;
  gap: boolean;
  denominator: number | null;
  value: number | null;
}): MetricReading {
  if (!input.hasHistory) return { kind: "empty" };
  if (input.updating) return { kind: "updating" };
  if (input.pending) return { kind: "pending" };
  if (input.gap) return { kind: "not_in_yet" };
  if (input.denominator === 0) return { kind: "not_applicable" };
  return { kind: "value", value: input.value ?? 0 };
}

export function countsInTotal(reading: MetricReading): boolean {
  return reading.kind === "value";
}

/** The name on the outlet row. A name seen in an older download is not shown. */
export function displayOutletName(currentName: string, _observedName?: string | null): string {
  return currentName;
}

export function ownerRangeDays(range: Exclude<OwnerRange, "custom">): number {
  if (range === "7d") return 7;
  if (range === "4w") return 28;
  return 84;
}

/** Inclusive last day, stored as the exclusive end the metrics read uses. */
export function customRange(from: string, through: string): { from: string; to: string } {
  return { from, to: addIsoDays(through, 1) };
}

export function rangeThrough(exclusiveTo: string): string {
  return addIsoDays(exclusiveTo, -1);
}

/** `today` is an Asia/Kolkata civil date. Custom bounds are passed through. */
export function ownerRangeBounds(
  range: OwnerRange,
  today: string,
  custom?: { from: string; to: string },
): { from: string; to: string } {
  if (range === "custom") {
    if (!custom) throw new Error("A custom range needs from and to.");
    return custom;
  }
  return { from: addIsoDays(today, 1 - ownerRangeDays(range)), to: addIsoDays(today, 1) };
}

export interface OwnerView {
  range: OwnerRange;
  platform: OwnerViewPlatform;
  outlet: string;
  from: string;
  to: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseOwnerView(
  params: { get(name: string): string | null },
  today: string,
): OwnerView {
  const rawRange = params.get("range");
  const range = OWNER_RANGES.includes(rawRange as OwnerRange) ? (rawRange as OwnerRange) : "12w";
  const rawPlatform = params.get("platform");
  const platform = OWNER_VIEW_PLATFORMS.includes(rawPlatform as OwnerViewPlatform)
    ? (rawPlatform as OwnerViewPlatform)
    : "both";
  const outlet = params.get("outlet")?.trim() || "all";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const preset = presetFor(from, to, today);
  if ((range === "custom" || range === preset) && preset) {
    return { range: preset, platform, outlet, ...ownerRangeBounds(preset, today) };
  }
  if (range === "custom" && ISO.test(from) && ISO.test(to) && from < to) {
    return { range, platform, outlet, from, to };
  }
  const bounds = ownerRangeBounds(range === "custom" ? "12w" : range, today);
  return { range: range === "custom" ? "12w" : range, platform, outlet, ...bounds };
}

/** A custom URL whose dates are exactly a chip is that chip, not Custom. */
export function presetFor(
  from: string,
  to: string,
  today: string,
): Exclude<OwnerRange, "custom"> | null {
  if (!ISO.test(from) || !ISO.test(to)) return null;
  for (const range of ["7d", "4w", "12w"] as const) {
    const bounds = ownerRangeBounds(range, today);
    if (bounds.from === from && bounds.to === to) return range;
  }
  return null;
}

/** The view, as the existing metrics read expects it. Keys are chosen by the screen. */
export function ownerMetricsRequest(view: OwnerView): {
  platform: OwnerPlatform;
  from: string;
  to: string;
  basis: "order_date";
  likeForLike: false;
  outletIds?: string[];
} {
  return {
    platform: view.platform === "both" ? "all" : view.platform,
    from: view.from,
    to: view.to,
    basis: "order_date",
    likeForLike: false,
    ...(view.outlet === "all" ? {} : { outletIds: [view.outlet] }),
  };
}

export interface OwnerOutletConnection {
  platform: "zomato" | "swiggy";
  status: ConnectionStatus;
}

export interface OwnerOutletProfile {
  id: string;
  name: string;
  city: string;
  active: boolean;
  connections: OwnerOutletConnection[];
}

export interface OwnerProfile {
  restaurant: { id: string; name: string; timezone: string };
  owner: { name: string; email: string; locale: string };
  outlets: OwnerOutletProfile[];
}

const OutletPatch = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(80),
  city: z.string().trim().max(80),
});

/** Profile fields the owner can change. Platform ids and credentials are not fields. */
export const OwnerProfilePatchSchema = z
  .object({
    ownerName: z.string().trim().min(1).max(80).optional(),
    locale: z.enum(OWNER_LOCALES).optional(),
    restaurantName: z.string().trim().min(1).max(80).optional(),
    outlets: z.array(OutletPatch).max(50).optional(),
  })
  .strict();

export type OwnerProfilePatch = z.infer<typeof OwnerProfilePatchSchema>;

/**
 * Confirms a preview is pointed at a database the caller supplied.
 * It does not seed, migrate, or invent a connection string.
 */
export function previewLocalDatabase(env: { DATABASE_URL?: string }): string {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "preview:local needs DATABASE_URL in the environment. It does not seed, migrate, or start a database.",
    );
  }
  return url;
}
