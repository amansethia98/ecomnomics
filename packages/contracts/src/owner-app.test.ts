import { describe, expect, it } from "vitest";
import { formatRupees } from "./ops/format.js";
import {
  connectionStatus,
  countsInTotal,
  customRange,
  displayOutletName,
  metricReading,
  OwnerProfilePatchSchema,
  ownerMetricsRequest,
  ownerRangeBounds,
  parseOwnerView,
  previewLocalDatabase,
  rangeThrough,
} from "./owner-app.js";

const blank = {
  hasHistory: true,
  updating: false,
  pending: false,
  gap: false,
  denominator: null,
  value: 0,
};

describe("owner reading rules", () => {
  it("keeps a lag, a gap, and a running fetch out of the number", () => {
    expect(metricReading({ ...blank, pending: true })).toEqual({ kind: "pending" });
    expect(metricReading({ ...blank, gap: true })).toEqual({ kind: "not_in_yet" });
    expect(metricReading({ ...blank, updating: true, pending: true })).toEqual({
      kind: "updating",
    });
    expect(metricReading({ ...blank, denominator: 0, value: 12 })).toEqual({
      kind: "not_applicable",
    });
    expect(metricReading({ ...blank, hasHistory: false, value: 12 })).toEqual({ kind: "empty" });
    for (const reading of [
      metricReading({ ...blank, pending: true }),
      metricReading({ ...blank, gap: true }),
      metricReading({ ...blank, updating: true }),
      metricReading({ ...blank, denominator: 0 }),
      metricReading({ ...blank, hasHistory: false }),
    ]) {
      expect(countsInTotal(reading)).toBe(false);
      expect(reading).not.toHaveProperty("value");
    }
  });

  it("keeps a stored zero when the day really had none", () => {
    const reading = metricReading(blank);
    expect(reading).toEqual({ kind: "value", value: 0 });
    expect(countsInTotal(reading)).toBe(true);
  });

  it("shows the current outlet name after a rename", () => {
    expect(displayOutletName("Koramangala", "Old name")).toBe("Koramangala");
  });
});

describe("owner view", () => {
  const today = "2026-11-15";

  it("uses Asia/Kolkata civil dates for the presets", () => {
    expect(ownerRangeBounds("7d", today)).toEqual({ from: "2026-11-09", to: "2026-11-16" });
    expect(ownerRangeBounds("4w", today)).toEqual({ from: "2026-10-19", to: "2026-11-16" });
    expect(ownerRangeBounds("12w", today).from).toBe("2026-08-24");
  });

  it("reads the range, platform, and outlet from the URL", () => {
    const params = new URLSearchParams("range=4w&platform=swiggy&outlet=outlet-1");
    const view = parseOwnerView(params, today);
    expect(view).toMatchObject({ range: "4w", platform: "swiggy", outlet: "outlet-1" });
    expect(ownerMetricsRequest(view)).toEqual({
      platform: "swiggy",
      from: "2026-10-19",
      to: "2026-11-16",
      basis: "order_date",
      likeForLike: false,
      outletIds: ["outlet-1"],
    });
  });

  it("rolls every outlet up when the URL asks for all", () => {
    const view = parseOwnerView(new URLSearchParams("platform=both"), today);
    expect(ownerMetricsRequest(view).platform).toBe("all");
    expect(ownerMetricsRequest(view).outletIds).toBeUndefined();
  });

  it("keeps the 4W chip when the dates are that preset", () => {
    const bounds = ownerRangeBounds("4w", today);
    const view = parseOwnerView(
      new URLSearchParams(`range=custom&from=${bounds.from}&to=${bounds.to}`),
      today,
    );
    expect(view.range).toBe("4w");
  });

  it("keeps a custom range's last day inclusive", () => {
    expect(customRange("2026-11-01", "2026-11-15")).toEqual({
      from: "2026-11-01",
      to: "2026-11-16",
    });
    expect(rangeThrough("2026-11-16")).toBe("2026-11-15");
  });

  it("falls back when a custom range has no dates", () => {
    const view = parseOwnerView(new URLSearchParams("range=custom"), today);
    expect(view.range).toBe("12w");
    expect(view.from).toBe("2026-08-24");
  });
});

describe("owner profile", () => {
  it("formats paise in Indian rupees", () => {
    expect(formatRupees(640_000)).toBe("₹6,400");
    expect(formatRupees(11_248_000)).toBe("₹1,12,480");
  });

  it("derives connection status from the run log only", () => {
    expect(connectionStatus({ linked: false, latest: null })).toBe("not_connected");
    expect(connectionStatus({ linked: true, latest: "stored" })).toBe("connected");
    expect(connectionStatus({ linked: true, latest: "signed_out" })).toBe("login_needs_attention");
    expect(connectionStatus({ linked: true, latest: "needs_owner" })).toBe("login_needs_attention");
    expect(connectionStatus({ linked: true, latest: null })).toBe("not_updated");
    expect(connectionStatus({ linked: true, latest: "download_failed" })).toBe("not_updated");
  });

  it("rejects credentials and platform ids on a profile save", () => {
    expect(
      OwnerProfilePatchSchema.safeParse({
        ownerName: "Ravi Kumar",
        locale: "hi",
        restaurantName: "Kesar Kitchen",
        outlets: [{ id: "outlet-1", name: "Indiranagar", city: "Bengaluru" }],
      }).success,
    ).toBe(true);
    for (const extra of [{ password: "secret" }, { zomatoResId: "1" }, { phone: "9000000000" }]) {
      expect(OwnerProfilePatchSchema.safeParse(extra).success).toBe(false);
    }
  });
});

describe("preview:local", () => {
  it("requires a database URL and does not invent one", () => {
    expect(() => previewLocalDatabase({})).toThrow(/DATABASE_URL/);
    expect(previewLocalDatabase({ DATABASE_URL: "postgres://example/db" })).toBe(
      "postgres://example/db",
    );
  });
});
