import { useLingui } from "@lingui/react/macro";
import type { ConnectionStatus, OwnerProfile } from "@rakazo/contracts";
import { Button, Input, SectionHeading } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { StatusPill } from "./marks";

export interface ProfileDraft {
  ownerName: string;
  locale: "en" | "hi";
  restaurantName: string;
  outlets: { id: string; name: string; city: string }[];
}

export function draftFromProfile(profile: OwnerProfile): ProfileDraft {
  return {
    ownerName: profile.owner.name,
    locale: profile.owner.locale === "hi" ? "hi" : "en",
    restaurantName: profile.restaurant.name,
    outlets: profile.outlets.map((outlet) => ({
      id: outlet.id,
      name: outlet.name,
      city: outlet.city,
    })),
  };
}

function sameDraft(a: ProfileDraft, b: ProfileDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function SettingsProfile({
  profile,
  saving,
  onSave,
  onDirty,
}: {
  profile: OwnerProfile;
  saving: boolean;
  onSave: (draft: ProfileDraft) => void;
  onDirty?: (dirty: boolean) => void;
}) {
  const { t } = useLingui();
  const nameId = useId();
  const emailId = useId();
  const languageId = useId();
  const restaurantId = useId();
  const saved = draftFromProfile(profile);
  const [draft, setDraft] = useState(saved);
  const [seen, setSeen] = useState(profile);
  if (seen !== profile) {
    setSeen(profile);
    setDraft(draftFromProfile(profile));
  }
  const dirty = !sameDraft(draft, saved);
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);
  const setOutlet = (id: string, patch: Partial<{ name: string; city: string }>) => {
    setDraft({
      ...draft,
      outlets: draft.outlets.map((outlet) => (outlet.id === id ? { ...outlet, ...patch } : outlet)),
    });
  };

  return (
    <form
      className="mx-auto flex max-w-3xl flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty) onSave(draft);
      }}
    >
      <section className="flex flex-col gap-4">
        <SectionHeading as="h2" variant="label">
          {t`You`}
        </SectionHeading>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-body-sm" htmlFor={nameId}>
            {t`Name`}
            <Input
              id={nameId}
              value={draft.ownerName}
              disabled={saving}
              onChange={(event) => setDraft({ ...draft, ownerName: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-body-sm" htmlFor={emailId}>
            {t`Email`}
            <Input id={emailId} value={profile.owner.email} readOnly />
          </label>
          <label className="flex flex-col gap-1.5 text-body-sm" htmlFor={languageId}>
            {t`Language`}
            <select
              id={languageId}
              className="h-8 rounded-lg border border-input bg-background px-2"
              value={draft.locale}
              disabled={saving}
              onChange={(event) =>
                setDraft({ ...draft, locale: event.target.value === "hi" ? "hi" : "en" })
              }
            >
              <option value="en">{t`English`}</option>
              <option value="hi">{t`Hindi`}</option>
            </select>
          </label>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <SectionHeading as="h2" variant="label">
          {t`Restaurant`}
        </SectionHeading>
        <label className="flex max-w-md flex-col gap-1.5 text-body-sm" htmlFor={restaurantId}>
          {t`Restaurant name`}
          <Input
            id={restaurantId}
            value={draft.restaurantName}
            disabled={saving}
            onChange={(event) => setDraft({ ...draft, restaurantName: event.target.value })}
          />
        </label>
      </section>

      <section className="flex flex-col gap-2">
        <SectionHeading as="h2" variant="label">
          {t`Outlets`}
        </SectionHeading>
        <ul className="divide-y divide-border">
          {profile.outlets.map((outlet) => {
            const row = draft.outlets.find((item) => item.id === outlet.id);
            return (
              <li key={outlet.id} className="flex flex-col gap-3 py-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label
                    className="flex flex-col gap-1.5 text-body-sm"
                    htmlFor={`${outlet.id}-name`}
                  >
                    {t`Outlet`}
                    <Input
                      id={`${outlet.id}-name`}
                      value={row?.name ?? outlet.name}
                      disabled={saving}
                      onChange={(event) => setOutlet(outlet.id, { name: event.target.value })}
                    />
                  </label>
                  <label
                    className="flex flex-col gap-1.5 text-body-sm"
                    htmlFor={`${outlet.id}-city`}
                  >
                    {t`City`}
                    <Input
                      id={`${outlet.id}-city`}
                      value={row?.city ?? outlet.city}
                      disabled={saving}
                      onChange={(event) => setOutlet(outlet.id, { city: event.target.value })}
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  {outlet.connections.map((connection) => (
                    <ConnectionMark
                      key={connection.platform}
                      platform={connection.platform}
                      status={connection.status}
                    />
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="text-body-sm text-muted-foreground">
          {t`A login problem is handled by your Ecomnomics contact. We never ask for a Zomato or Swiggy password.`}
        </p>
      </section>

      {dirty ? (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={saving} onClick={() => setDraft(saved)}>
            {t`Cancel`}
          </Button>
          <Button type="submit" disabled={saving}>
            {t`Save changes`}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function ConnectionMark({
  platform,
  status,
}: {
  platform: "zomato" | "swiggy";
  status: ConnectionStatus;
}) {
  const { t } = useLingui();
  const label =
    platform === "zomato"
      ? status === "connected"
        ? t`Zomato connected`
        : status === "login_needs_attention"
          ? t`Zomato login needs attention`
          : status === "not_updated"
            ? t`Zomato not updated`
            : t`Zomato not connected`
      : status === "connected"
        ? t`Swiggy connected`
        : status === "login_needs_attention"
          ? t`Swiggy login needs attention`
          : status === "not_updated"
            ? t`Swiggy not updated`
            : t`Swiggy not connected`;
  if (status === "connected") return <StatusPill kind="good" label={label} />;
  if (status === "login_needs_attention") return <StatusPill kind="watch" label={label} />;
  return <span className="text-body-sm text-muted-foreground">{label}</span>;
}
