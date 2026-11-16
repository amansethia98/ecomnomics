import { useLingui } from "@lingui/react/macro";
import type { OwnerDocuments } from "@rakazo/contracts";
import { formatCivilDay } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
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
  const [editing, setEditing] = useState(screen.expiresOn == null);
  const [reference, setReference] = useState(screen.reference ?? "");
  const [expiresOn, setExpiresOn] = useState(screen.expiresOn ?? "");
  const [gstin, setGstin] = useState(screen.gstin ?? "");

  useEffect(() => {
    setReference(screen.reference ?? "");
    setExpiresOn(screen.expiresOn ?? "");
    setGstin(screen.gstin ?? "");
    setEditing(screen.expiresOn == null);
  }, [screen]);

  useEffect(() => {
    const dirty =
      (reference.trim() || null) !== screen.reference ||
      (expiresOn || null) !== screen.expiresOn ||
      (gstin.trim() || null) !== screen.gstin;
    onDirty(dirty);
  }, [reference, expiresOn, gstin, screen, onDirty]);

  const reminder =
    screen.reminder === "expired"
      ? t`Your FSSAI licence has expired.`
      : screen.reminder === "7" && screen.daysLeft === 0
        ? t`Your FSSAI licence expires today.`
        : screen.reminder != null && screen.expiresOn
          ? t`Your FSSAI licence expires on ${formatCivilDay(screen.expiresOn)}.`
          : null;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      {reminder ? (
        <p
          className={
            screen.reminder === "7" || screen.reminder === "expired"
              ? "text-destructive"
              : undefined
          }
        >
          {reminder}
        </p>
      ) : null}
      {editing ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSave({
              reference: reference.trim() || null,
              expiresOn: expiresOn || null,
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
              type="date"
              required
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
      ) : (
        <div>
          <p className="font-medium">{screen.reference ?? t`FSSAI licence`}</p>
          {screen.expiresOn ? (
            <p className="text-body-sm text-muted-foreground">{formatCivilDay(screen.expiresOn)}</p>
          ) : null}
          {screen.gstin ? <p className="text-body-sm">{screen.gstin}</p> : null}
          <button
            type="button"
            className="mt-2 text-body-sm text-primary"
            onClick={() => setEditing(true)}
          >
            {t`Edit`}
          </button>
        </div>
      )}
      <section>
        <h2 className="text-label text-muted-foreground">{t`Reports`}</h2>
        {screen.reports.length === 0 ? (
          <p className="mt-2">{t`No reports yet.`}</p>
        ) : (
          <ul>
            {screen.reports.map((report) => (
              <li key={report.id} className="border-t border-border py-2">
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
                  {formatCivilDay(report.from)} – {formatCivilDay(report.to)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
