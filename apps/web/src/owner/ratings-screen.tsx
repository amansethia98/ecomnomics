import { useLingui } from "@lingui/react/macro";
import type { OwnerRatings } from "@rakazo/contracts";
import { formatCivilDay } from "@rakazo/contracts";
import { PlatformDot } from "./marks";

export function reportedPoor(app: OwnerRatings["apps"][number]): number | null {
  if (app.poorRatedOrders == null) return null;
  if (app.poorRatedOrders === 0 && app.complaints.every((row) => row.count == null)) return null;
  return app.poorRatedOrders;
}

export function RatingsScreen({ screen }: { screen: OwnerRatings }) {
  const { t } = useLingui();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="owner-panel p-4">
        <p className="text-label text-primary">{t`Coming soon`}</p>
        <h2 className="owner-title">{t`Reviews and replies are on the way`}</h2>
        <p className="mt-2 text-body-sm text-muted-foreground">
          {t`Soon you'll read every review here, with a reply drafted for you to approve. Until then, here is what the ratings and complaints already say. Copy reply never posts.`}
        </p>
      </div>
      {(screen.apps ?? []).map((app) => (
        <section key={app.platform}>
          <p className="flex items-center gap-2 font-medium">
            <PlatformDot platform={app.platform} />
            {app.ratingState === "not_in_report" ? (
              <span className="text-body-sm font-normal text-muted-foreground">
                {app.platform === "swiggy" ? t`Not in Swiggy's reports yet` : t`Not in reports`}
              </span>
            ) : app.rating != null ? (
              <span>★ {app.rating.toFixed(2)}</span>
            ) : (
              <span className="text-body-sm font-normal text-muted-foreground">{t`Not in reports`}</span>
            )}
          </p>
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
                          className="block h-1.5 bg-primary"
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
      {screen.reviews.length === 0 ? (
        <p>{t`No reviews are in yet.`}</p>
      ) : (
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
