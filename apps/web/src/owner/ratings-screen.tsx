import { useLingui } from "@lingui/react/macro";
import type { OwnerRatings } from "@rakazo/contracts";
import { formatCivilDay } from "@rakazo/contracts";
import { PlatformDot } from "./marks";

export function reportedPoor(app: OwnerRatings["apps"][number]): number | null {
  return app.poorRatedOrders;
}

export function TopComplaint({ apps }: { apps: OwnerRatings["apps"] }) {
  const { t } = useLingui();
  let top: { label: string; count: number } | null = null;
  for (const app of apps) {
    for (const row of app.complaints) {
      if (row.count == null || row.count <= 0) continue;
      if (!top || row.count > top.count) top = { label: row.label, count: row.count };
    }
  }
  if (!top) return null;
  return <p className="text-body-sm">{t`Most complaints: ${top.label}`}</p>;
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
      <div className="grid grid-cols-3 gap-3">
        {(screen.apps ?? []).map((app) => (
          <p key={app.platform} className="flex flex-col gap-1">
            <span className="flex items-center gap-2 font-medium">
              <PlatformDot platform={app.platform} />
              {app.platform === "zomato" ? t`Zomato` : t`Swiggy`}
            </span>
            {app.ratingState === "not_in_report" || app.rating == null ? (
              <span className="text-body-sm text-muted-foreground">
                {app.platform === "swiggy" ? t`Not in Swiggy's reports yet` : "—"}
              </span>
            ) : (
              <span>★ {app.rating.toFixed(2)}</span>
            )}
          </p>
        ))}
      </div>
      <TopComplaint apps={screen.apps ?? []} />
      {(screen.apps ?? []).map((app) => (
        <section key={app.platform}>
          <p className="text-body-sm text-muted-foreground">
            {t`Poorly rated orders`}{" "}
            {reportedPoor(app) == null ? (
              <>
                — <span>{t`Not in reports`}</span>
              </>
            ) : (
              String(reportedPoor(app))
            )}
          </p>
          <ul>
            {app.complaints.map((row) => {
              const max = Math.max(
                1,
                ...app.complaints.map((item) => (item.count == null ? 0 : item.count)),
              );
              return (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 border-t border-border py-1 text-body-sm"
                >
                  <span>{row.label}</span>
                  {row.count == null ? (
                    <span>
                      — <span className="text-muted-foreground">{t`Not in reports`}</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-2">
                      {row.count > 0 ? (
                        <span
                          className={`block h-1.5 ${row.id === "complaints_missing" ? "bg-destructive" : "bg-warning"}`}
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
