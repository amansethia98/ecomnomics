import { useLingui } from "@lingui/react/macro";
import type { OwnerRatings } from "@rakazo/contracts";
import { formatCivilDay } from "@rakazo/contracts";
import { PlatformDot } from "./marks";

export function RatingsScreen({ screen }: { screen: OwnerRatings }) {
  const { t } = useLingui();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {screen.rating != null ? (
        <p className="text-heading2 font-medium">{screen.rating.toFixed(2)}</p>
      ) : null}
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
