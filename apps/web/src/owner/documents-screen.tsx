import { useLingui } from "@lingui/react/macro";
import type { OwnerDocuments } from "@rakazo/contracts";
import { formatCivilDay, formatIstClock, parseDisplayDate } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { FileText } from "lucide-react";
import { useEffect, useState } from "react";

export function DocumentsScreen({
  screen,
  saving,
  onSave,
  onDirty,
}: {
  screen: OwnerDocuments;
  saving: boolean;
  onSave: (draft: {
    reference: string | null;
    expiresOn: string | null;
    gstin: string | null;
  }) => void;
  onDirty: (dirty: boolean) => void;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [reportFilter, setReportFilter] = useState<"all" | "daily" | "weekly" | "payout">("all");
  const [reference, setReference] = useState(screen.reference ?? "");
  const [expiresOn, setExpiresOn] = useState(
    screen.expiresOn ? formatCivilDay(screen.expiresOn) : "",
  );
  const [gstin, setGstin] = useState(screen.gstin ?? "");

  useEffect(() => {
    setReference(screen.reference ?? "");
    setExpiresOn(screen.expiresOn ? formatCivilDay(screen.expiresOn) : "");
    setGstin(screen.gstin ?? "");
    setEditing(false);
  }, [screen]);

  useEffect(() => {
    const dirty =
      (reference.trim() || null) !== screen.reference ||
      (parseDisplayDate(expiresOn) || null) !== screen.expiresOn ||
      (gstin.trim() || null) !== screen.gstin;
    onDirty(dirty);
  }, [reference, expiresOn, gstin, screen, onDirty]);

  const reminder =
    screen.reminder === "expired" && screen.expiresOn
      ? t`FSSAI licence expired on ${formatCivilDay(screen.expiresOn)}.`
      : screen.reminder === "7" && screen.daysLeft === 0
        ? t`Your FSSAI licence expires today.`
        : screen.reminder != null && screen.expiresOn
          ? t`Your FSSAI licence expires on ${formatCivilDay(screen.expiresOn)}.`
          : screen.expiresOn
            ? t`All documents up to date.`
            : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      {reminder ? (
        <div className="owner-panel p-4">
          <p className="text-label text-muted-foreground">
            {screen.reminder === "30" || screen.reminder === "7"
              ? t`1 licence expires soon`
              : screen.reminder === "expired"
                ? t`Licence expired`
                : t`Documents`}
          </p>
          <p
            className={
              screen.reminder === "7" || screen.reminder === "expired"
                ? "mt-1 text-destructive"
                : "mt-1"
            }
          >
            {reminder}
          </p>
          <p className="mt-2">
            <span
              className={
                screen.reminder == null
                  ? "owner-pill owner-pill-good"
                  : screen.reminder === "expired" || screen.reminder === "7"
                    ? "owner-pill owner-pill-act"
                    : "owner-pill owner-pill-watch"
              }
            >
              {screen.reminder == null
                ? t`Valid`
                : screen.reminder === "expired"
                  ? t`Expired`
                  : t`Renew soon`}
            </span>
          </p>
        </div>
      ) : (
        <div className="owner-panel p-4">
          <p className="text-label text-muted-foreground">{t`Documents`}</p>
          <h2 className="owner-title mt-1">{t`Add your FSSAI licence expiry`}</h2>
          <button
            type="button"
            className="mt-3 text-body-sm text-primary"
            onClick={() => setEditing(true)}
          >
            {t`Add expiry`}
          </button>
        </div>
      )}
      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              reference: reference.trim() || null,
              expiresOn: parseDisplayDate(expiresOn),
              gstin: gstin.trim() || null,
            });
          }}
        >
          <label className="flex flex-col gap-1 text-body-sm">
            {t`FSSAI number`}
            <input
              className="h-9 rounded-lg border border-border bg-background px-2"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-body-sm">
            {t`Licence expiry`}
            <input
              required
              inputMode="text"
              placeholder={t`DD MMM YYYY`}
              aria-label={t`Licence expiry, DD MMM YYYY`}
              className="h-9 rounded-lg border border-border bg-background px-2"
              value={expiresOn}
              onChange={(event) => setExpiresOn(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-body-sm">
            {t`GSTIN`}
            <input
              className="h-9 rounded-lg border border-border bg-background px-2"
              value={gstin}
              onChange={(event) => setGstin(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={saving}>
            {t`Save`}
          </Button>
        </form>
      ) : null}
      <section>
        <h2 className="text-label text-muted-foreground">{t`Business documents`}</h2>
        <ul>
          <li className="flex items-center justify-between gap-3 border-t border-border py-2">
            <button type="button" className="text-left" onClick={() => setEditing(true)}>
              <span className="block font-medium">{t`FSSAI licence`}</span>
              <span className="block text-body-sm text-muted-foreground">
                {screen.expiresOn ? formatCivilDay(screen.expiresOn) : t`No expiry typed`}
              </span>
            </button>
            <span
              className={
                screen.reminder === "expired" || screen.reminder === "7" || screen.reminder === "30"
                  ? "owner-pill owner-pill-watch"
                  : screen.expiresOn
                    ? "owner-pill owner-pill-good"
                    : "owner-pill"
              }
            >
              {screen.expiresOn ? (screen.reminder ? t`Renew soon` : t`Valid`) : t`Missing`}
            </span>
          </li>
        </ul>
      </section>
      <section>
        <h2 className="text-label text-muted-foreground">{t`Reports we sent you`}</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ["all", t`All`],
              ["daily", t`Daily briefs`],
              ["weekly", t`Weekly reviews`],
              ["payout", t`Payout checks`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={reportFilter === id}
              className={
                reportFilter === id ? "owner-pill bg-primary text-primary-foreground" : "owner-pill"
              }
              onClick={() => setReportFilter(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {screen.reports.length === 0 ? (
          <p className="mt-2">{t`Your first brief arrives tomorrow at 9:00 AM.`}</p>
        ) : (
          <ul>
            {screen.reports
              .filter((report) => reportFilter === "all" || report.kind === reportFilter)
              .map((report) => (
                <li key={report.id} className="flex items-center gap-2 border-t border-border py-2">
                  <FileText aria-hidden="true" className="size-4 shrink-0" />
                  <span className="font-medium">
                    {report.kind === "daily"
                      ? t`Daily brief`
                      : report.kind === "weekly"
                        ? t`Weekly review`
                        : report.kind === "payout"
                          ? t`Payout check`
                          : t`Report`}
                  </span>
                  <span className="ml-2 text-body-sm text-muted-foreground">
                    {formatCivilDay(report.createdOn)}
                    {report.createdAt ? ` · ${formatIstClock(new Date(report.createdAt))}` : ""}
                  </span>
                  {report.urgent === 1 ? (
                    <span className="owner-pill bg-muted text-muted-foreground">{t`1 urgent`}</span>
                  ) : report.urgent != null && report.urgent > 1 ? (
                    <span className="owner-pill bg-muted text-muted-foreground">
                      {t`${report.urgent} urgent`}
                    </span>
                  ) : null}
                  <span className="owner-pill bg-muted text-muted-foreground">{t`Sent`}</span>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
