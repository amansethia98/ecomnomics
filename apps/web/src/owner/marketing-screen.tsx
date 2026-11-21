import { useLingui } from "@lingui/react/macro";
import type { MarketingDisplay, MarketingScreen } from "@rakazo/contracts";
import { formatRupees } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useState } from "react";
import { Link } from "react-router-dom";

type Stage = "all" | "waiting" | "approved" | "live" | "result";

export function MarketingActionsScreen({
  restaurantId,
  screen,
  onConfirm,
  onDecide,
  readOnly = false,
}: {
  restaurantId: string;
  screen: MarketingScreen;
  onConfirm: (actionId: string, done: boolean) => void;
  onDecide?: (actionId: string, choice: "approve" | "not_now") => void;
  readOnly?: boolean;
}) {
  const { t } = useLingui();
  const [stage, setStage] = useState<Stage>("all");
  const all = [...screen.waiting, ...screen.overflow, ...screen.rows];
  const counts = {
    all: all.length,
    waiting: all.filter((row) => stageOf(row.display) === "waiting").length,
    approved: all.filter((row) => stageOf(row.display) === "approved").length,
    live: all.filter((row) => stageOf(row.display) === "live").length,
    result: all.filter((row) => stageOf(row.display) === "result").length,
  };
  const shown = stage === "all" ? all : all.filter((row) => stageOf(row.display) === stage);
  const waiting = all.filter((row) => stageOf(row.display) === "waiting");
  const hero =
    waiting.length > 0
      ? t`${waiting.length} suggestions are waiting for your OK`
      : screen.hero === "result" && screen.resultTitle
        ? screen.resultTitle
        : t`No suggestions are waiting`;
  if (all.length === 0) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <h2 className="owner-title">
          {t`Your chief of staff will suggest your first action after a week of data`}
        </h2>
        <Link className="text-primary" to={`/restaurants/${restaurantId}/chief-of-staff`}>
          {t`Ask your chief of staff →`}
        </Link>
        <p className="text-body-sm text-muted-foreground">
          {t`You switch offers on in the Zomato or Swiggy app. We spot them in the next report, or you can tap “I've done it”. Results compare the same weekdays before and after, after 2 weeks.`}
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <p className="text-body-sm text-muted-foreground">
        {t`Suggested by your chief of staff → you approve → it goes live → we measure the result`}
      </p>
      <h2 className="owner-title">{hero}</h2>
      {waiting.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {waiting.map((row) => (
            <li key={row.id} className="owner-panel p-4">
              <p className="font-medium">{row.title}</p>
              <p className="text-body-sm text-muted-foreground">{row.detail}</p>
              {row.maxCostPaise != null ? (
                <p className="mt-1 text-body-sm text-muted-foreground">
                  {t`Most it can cost ${formatRupees(row.maxCostPaise)} a week`}
                </p>
              ) : null}
              {readOnly ? null : (
                <div className="mt-3 flex gap-2">
                  <Button type="button" onClick={() => onDecide?.(row.id, "approve")}>
                    {t`Approve`}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => onDecide?.(row.id, "not_now")}
                  >
                    {t`Not now`}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {(
          [
            ["all", t`All (${counts.all})`],
            ["waiting", t`Waiting (${counts.waiting})`],
            ["approved", t`Approved (${counts.approved})`],
            ["live", t`Live (${counts.live})`],
            ["result", t`Results (${counts.result})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`rounded-full px-3 py-1 ${stage === id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
            onClick={() => setStage(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <table className="w-full text-body-sm">
        <thead>
          <tr className="text-left text-label text-muted-foreground">
            <th className="py-2 font-medium">{t`Action`}</th>
            <th className="py-2 font-medium">{t`Stage`}</th>
            <th className="py-2 font-medium">{t`Result`}</th>
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td className="py-3 text-muted-foreground" colSpan={3}>
                {t`No suggestions yet.`}
              </td>
            </tr>
          ) : (
            shown.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <td className="py-3">
                  <p className="font-medium">{row.title}</p>
                  <p className="text-muted-foreground">{row.detail}</p>
                  {row.display === "not_seen" && !readOnly ? (
                    <div className="mt-2 flex items-center gap-2">
                      <p>{t`Did you switch it on?`}</p>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => onConfirm(row.id, true)}
                      >
                        {t`Yes`}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => onConfirm(row.id, false)}
                      >
                        {t`Not yet`}
                      </Button>
                    </div>
                  ) : null}
                </td>
                <td className="py-3">
                  <StageName display={row.display} />
                </td>
                <td className="py-3">
                  {row.display === "result" && row.resultPaise != null ? (
                    <span className={row.resultPaise < 0 ? "owner-change-down" : "owner-change-up"}>
                      {formatRupees(row.resultPaise)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <p className="text-body-sm text-muted-foreground">
        {t`You switch offers on in the Zomato or Swiggy app. We spot them in the next report, or you can tap “I've done it”. Results compare the same weekdays before and after, after 2 weeks.`}
      </p>
    </div>
  );
}

function stageOf(display: MarketingDisplay): Exclude<Stage, "all"> {
  if (display === "waiting") return "waiting";
  if (display === "live") return "live";
  if (display === "result") return "result";
  return "approved";
}

function StageName({ display }: { display: MarketingDisplay }) {
  const { t } = useLingui();
  if (display === "waiting") return t`Waiting`;
  if (display === "live") return t`Live`;
  if (display === "result") return t`Result`;
  if (display === "not_seen") return t`Not seen yet`;
  if (display === "festival") return t`Festival week, can't judge fairly`;
  if (display === "too_early") return t`Too early`;
  return t`Approved`;
}
