import { useLingui } from "@lingui/react/macro";
import type { OwnerRatings } from "@rakazo/contracts";
import { formatCivilDay } from "@rakazo/contracts";
import { PlatformDot } from "./marks";

export function reportedPoor(app: OwnerRatings["apps"][number]): number | null {
  return app.poorRatedOrders;
}

export function TopComplaint({ apps }: { apps: OwnerRatings["apps"] }) {
  const { t } = useLingui();
  let top: { label: string; count: number; platform: "zomato" | "swiggy" } | null = null;
  for (const app of apps) {
    for (const row of app.complaints) {
      if (row.count == null || row.count <= 0) continue;
      if (!top || row.count > top.count) {
        top = { label: row.label, count: row.count, platform: app.platform };
      }
    }
  }
  if (!top) return null;
  const appName = top.platform === "swiggy" ? t`Swiggy` : t`Zomato`;
  return <p className="text-body-sm">{t`Most complaints: ${top.label} · ${appName}`}</p>;
}

export function RatingsScreen({ screen }: { screen: OwnerRatings }) {
  const { t } = useLingui();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="owner-panel p-4">
        <p className="text-label text-primary">{t`Coming soon`}</p>
        <h2 className="owner-title">{t`Reviews and replies are on the way`}</h2>
        <p className="mt-2 text-body-sm text-muted-foreground">
          {t`Soon you'll read every review here, with a reply drafted for you to approve. Until then, here is what the ratings and complaints already say.`}
        </p>
      </div>
      <TopComplaint apps={screen.apps ?? []} />
      {(screen.apps ?? []).map((app) => (
        <section
          key={app.platform}
          className="grid grid-cols-3 items-start gap-3 border-t border-border py-3"
        >
          <div>
            <PlatformDot platform={app.platform} />
            {app.ratingState === "not_in_report" || app.rating == null ? (
              <p className="text-body-sm text-muted-foreground">
                {app.platform === "swiggy" ? t`Not in Swiggy's reports yet` : "—"}
              </p>
            ) : (
              <p>★ {app.rating.toFixed(2)}</p>
            )}
          </div>
          <ul>
            {app.complaints.map((row) => {
              const max = Math.max(
                1,
                ...app.complaints.map((item) => (item.count == null ? 0 : item.count)),
              );
              return (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-2 py-0.5 text-body-sm"
                >
                  <span>{row.label}</span>
                  {row.count == null ? (
                    <span className="text-muted-foreground">{t`Not in reports`}</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      {row.count > 0 ? (
                        <span
                          className={`block h-1.5 ${row.id === "complaints_missing" || row.id === "complaints_wrong" ? "bg-destructive" : "bg-warning"}`}
                          style={{ width: `${Math.max(8, (row.count / max) * 64)}px` }}
                        />
                      ) : null}
                      {String(row.count)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="text-body-sm text-muted-foreground">
            {t`Poorly rated orders`}{" "}
            {app.poorRatedPct != null
              ? `${app.poorRatedPct}%`
              : reportedPoor(app) == null
                ? t`Not in reports`
                : String(reportedPoor(app))}
          </p>
        </section>
      ))}
      {screen.reviews.length === 0 ? null : (
        <ul>
          {screen.reviews.map((review) => (
            <li key={review.id} className="border-t border-border py-3">
              <p className="flex items-center gap-2">
                <PlatformDot platform={review.platform} />
                {review.rating != null ? <span>{review.rating.toFixed(1)}</span> : null}
                <span className="text-body-sm text-muted-foreground">
                  {formatCivilDay(review.date)}
                </span>
              </p>
              <p className="mt-1">{review.text}</p>
              {review.reply ? (
                <p className="mt-2 text-body-sm text-muted-foreground">{review.reply}</p>
              ) : null}
              {review.reply ? (
                <button
                  type="button"
                  className="mt-2 text-body-sm text-primary"
                  onClick={() => {
                    void navigator.clipboard.writeText(review.reply ?? "");
                  }}
                >
                  {t`Copy reply`}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
