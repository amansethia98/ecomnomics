import { Trans, useLingui } from "@lingui/react/macro";
import {
  RESTAURANT_MENU_MAX_CHARS,
  RESTAURANT_OUTLET_MAX,
  RestaurantOnboardingInputSchema,
} from "@rakazo/contracts";
import { Button, Input, Label, Textarea } from "@rakazo/ui-web";
import type { FormEvent, ReactNode } from "react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { clearRestaurantSignup } from "../lib/restaurant-signup";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

type OutletDraft = { name: string; address: string; openingHours: string };

const emptyOutlet = (): OutletDraft => ({ name: "", address: "", openingHours: "" });

function isNotFound(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && "code" in error && error.code === "NOT_FOUND",
  );
}

export function RestaurantWelcomePage() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [cuisine, setCuisine] = useState("");
  const [city, setCity] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [outlets, setOutlets] = useState<OutletDraft[]>([emptyOutlet()]);
  const [menuText, setMenuText] = useState("");
  const [menuFileName, setMenuFileName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void rpc.restaurant
      .begin()
      .then((profile) => {
        if (!active) return;
        clearRestaurantSignup();
        if (profile.completed) {
          navigate("/onboarding", { replace: true });
          return;
        }
        setReady(true);
      })
      .catch((caught: unknown) => {
        if (!active) return;
        clearRestaurantSignup();
        if (isNotFound(caught)) {
          navigate("/onboarding", { replace: true });
          return;
        }
        setError(errorText(caught, t`Could not open your restaurant`));
        setReady(true);
      });
    return () => {
      active = false;
    };
  }, [navigate, t]);

  function setOutletCount(value: string) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return;
    const count = Math.min(RESTAURANT_OUTLET_MAX, Math.max(1, parsed));
    setOutlets((current) => {
      if (count === current.length) return current;
      if (count < current.length) return current.slice(0, count);
      return [...current, ...Array.from({ length: count - current.length }, emptyOutlet)];
    });
  }

  function updateOutlet(index: number, patch: Partial<OutletDraft>) {
    setOutlets((current) =>
      current.map((outlet, outletIndex) =>
        outletIndex === index ? { ...outlet, ...patch } : outlet,
      ),
    );
  }

  async function onMenuFile(file: File | undefined) {
    if (!file) return;
    if (file.size > RESTAURANT_MENU_MAX_CHARS) {
      setError(t`Menu files must be text under 100 KB`);
      return;
    }
    const text = await file.text();
    if (text.includes("\u0000")) {
      setError(t`Paste the menu or upload a text file`);
      return;
    }
    setError(null);
    setMenuFileName(file.name);
    setMenuText(text.slice(0, RESTAURANT_MENU_MAX_CHARS));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const payload = {
      name,
      cuisine,
      city,
      contactName,
      contactEmail: contactEmail.trim(),
      contactPhone: contactPhone.trim(),
      outlets,
      menuText,
      menuFileName,
    };
    const parsed = RestaurantOnboardingInputSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t`Check the restaurant`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await rpc.restaurant.save(parsed.data);
      clearRestaurantSignup();
      navigate("/onboarding", { replace: true });
    } catch (caught) {
      setError(errorText(caught, t`Could not save the restaurant`));
      setPending(false);
    }
  }

  if (!ready) return <div className="h-full bg-background" />;

  return (
    <div
      className="min-h-full overflow-auto bg-background px-6 py-12 text-foreground"
      data-rakazo-surface="restaurant-welcome"
    >
      <form
        onSubmit={(event) => void submit(event)}
        className="mx-auto flex w-full max-w-[460px] flex-col"
      >
        <p className="text-sm text-muted-foreground">
          <Trans>Ecomnomics</Trans>
        </p>
        <h1 className="mb-8 mt-2 text-4xl font-medium tracking-tight">
          <Trans>Your restaurant</Trans>
        </h1>
        <Field label={<Trans>Restaurant name</Trans>} id="restaurant-name">
          <Input
            id="restaurant-name"
            className={fieldClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="organization"
          />
        </Field>
        <Field label={<Trans>Cuisine</Trans>} id="cuisine">
          <Input
            id="cuisine"
            className={fieldClass}
            value={cuisine}
            onChange={(event) => setCuisine(event.target.value)}
          />
        </Field>
        <Field label={<Trans>City</Trans>} id="city">
          <Input
            id="city"
            className={fieldClass}
            value={city}
            onChange={(event) => setCity(event.target.value)}
            autoComplete="address-level2"
          />
        </Field>
        <Field label={<Trans>Contact name</Trans>} id="contact-name">
          <Input
            id="contact-name"
            className={fieldClass}
            value={contactName}
            onChange={(event) => setContactName(event.target.value)}
            autoComplete="name"
          />
        </Field>
        <Field label={<Trans>Email</Trans>} id="contact-email">
          <Input
            id="contact-email"
            type="email"
            className={fieldClass}
            value={contactEmail}
            onChange={(event) => setContactEmail(event.target.value)}
            autoComplete="email"
          />
        </Field>
        <Field label={<Trans>Phone</Trans>} id="contact-phone">
          <Input
            id="contact-phone"
            type="tel"
            className={fieldClass}
            value={contactPhone}
            onChange={(event) => setContactPhone(event.target.value)}
            autoComplete="tel"
          />
        </Field>
        <Field label={<Trans>Outlets</Trans>} id="outlet-count">
          <Input
            id="outlet-count"
            type="number"
            min={1}
            max={RESTAURANT_OUTLET_MAX}
            className={fieldClass}
            value={outlets.length}
            onChange={(event) => setOutletCount(event.target.value)}
          />
        </Field>
        {outlets.map((outlet, index) => (
          <fieldset key={index} className="mt-6 space-y-4 border-0 p-0">
            <legend className="text-sm font-medium">
              <Trans>Outlet {index + 1}</Trans>
            </legend>
            <Field label={<Trans>Outlet name</Trans>} id={`outlet-name-${index}`}>
              <Input
                id={`outlet-name-${index}`}
                className={fieldClass}
                value={outlet.name}
                onChange={(event) => updateOutlet(index, { name: event.target.value })}
              />
            </Field>
            <Field label={<Trans>Address</Trans>} id={`outlet-address-${index}`}>
              <Input
                id={`outlet-address-${index}`}
                className={fieldClass}
                value={outlet.address}
                onChange={(event) => updateOutlet(index, { address: event.target.value })}
                autoComplete="street-address"
              />
            </Field>
            <Field label={<Trans>Opening hours</Trans>} id={`outlet-hours-${index}`}>
              <Textarea
                id={`outlet-hours-${index}`}
                className={fieldClass}
                value={outlet.openingHours}
                onChange={(event) => updateOutlet(index, { openingHours: event.target.value })}
              />
            </Field>
          </fieldset>
        ))}
        <Field label={<Trans>Menu</Trans>} id="menu">
          <Textarea
            id="menu"
            className={`${fieldClass} min-h-28`}
            value={menuText}
            placeholder={t`Paste a menu`}
            onChange={(event) => setMenuText(event.target.value)}
          />
        </Field>
        <div className="mt-4">
          <Label htmlFor="menu-file">
            <Trans>Upload a menu</Trans>
          </Label>
          <input
            id="menu-file"
            type="file"
            accept="text/plain,text/markdown,text/csv,.txt,.md,.csv"
            className="mt-2 block w-full text-sm"
            onChange={(event) => void onMenuFile(event.target.files?.[0])}
          />
          {menuFileName ? (
            <button
              type="button"
              className="mt-2 text-sm text-muted-foreground"
              onClick={() => {
                setMenuFileName(null);
                setMenuText("");
              }}
            >
              <Trans>Remove menu</Trans>
            </button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={pending} className="mt-6 h-12 w-full rounded-xl text-base">
          {pending ? <Trans>Working…</Trans> : <Trans>Continue</Trans>}
        </Button>
      </form>
    </div>
  );
}

const fieldClass = "mt-2 h-12 rounded-xl px-4 text-base md:text-base";

function Field({ id, label, children }: { id: string; label: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-4 w-full">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
