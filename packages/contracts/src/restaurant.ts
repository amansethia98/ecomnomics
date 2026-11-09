import { z } from "zod";

/** A restaurant name is also the workspace name, which is limited to 60 characters. */
export const RESTAURANT_NAME_MAX = 60;
export const RESTAURANT_OUTLET_MAX = 50;
export const RESTAURANT_MENU_MAX_CHARS = 100_000;

const outletField = "Add a name, address, and opening hours for each outlet";

export const RestaurantOutletInputSchema = z.object({
  name: z.string().trim().min(1, { error: outletField }).max(80, { error: outletField }),
  address: z.string().trim().min(1, { error: outletField }).max(200, { error: outletField }),
  openingHours: z.string().trim().min(1, { error: outletField }).max(500, { error: outletField }),
});
export type RestaurantOutletInput = z.infer<typeof RestaurantOutletInputSchema>;

export const RestaurantOnboardingInputSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { error: "Add a restaurant name" })
      .max(RESTAURANT_NAME_MAX, { error: "Restaurant name must be 60 characters or less" }),
    cuisine: z
      .string()
      .trim()
      .min(1, { error: "Add the cuisine" })
      .max(80, { error: "Add the cuisine" }),
    city: z.string().trim().min(1, { error: "Add the city" }).max(80, { error: "Add the city" }),
    contactName: z
      .string()
      .trim()
      .min(1, { error: "Add a contact name" })
      .max(80, { error: "Add a contact name" }),
    contactEmail: z.union([
      z.literal(""),
      z.string().trim().max(200).email({ error: "Add a valid email" }),
    ]),
    contactPhone: z.string().trim().max(40, { error: "Add an email or a phone number" }),
    outlets: z
      .array(RestaurantOutletInputSchema)
      .min(1, { error: "Add at least one outlet" })
      .max(RESTAURANT_OUTLET_MAX, { error: "A restaurant can have at most 50 outlets" }),
    menuText: z.string().max(RESTAURANT_MENU_MAX_CHARS, { error: "Menu text is too long" }),
    menuFileName: z.union([
      z.null(),
      z.string().trim().max(200, { error: "Menu file name is too long" }),
    ]),
  })
  .refine((value) => value.contactEmail !== "" || value.contactPhone !== "", {
    error: "Add an email or a phone number",
  })
  .refine(
    (value) => !value.menuText.includes("\u0000") && !(value.menuFileName ?? "").includes("\u0000"),
    { error: "Paste the menu or upload a text file" },
  );
export type RestaurantOnboardingInput = z.infer<typeof RestaurantOnboardingInputSchema>;

export const RestaurantOutletSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  openingHours: z.string(),
});

export const RestaurantProfileSchema = z.object({
  name: z.string(),
  cuisine: z.string(),
  city: z.string(),
  contactName: z.string(),
  contactEmail: z.string(),
  contactPhone: z.string(),
  menuText: z.string(),
  menuFileName: z.string().nullable(),
  completed: z.boolean(),
  outlets: z.array(RestaurantOutletSchema),
});
export type RestaurantProfile = z.infer<typeof RestaurantProfileSchema>;

/** Read-only counts for a later billing step. Nothing in the product caps these. */
export const RestaurantCountsSchema = z.object({
  bots: z.number().int().nonnegative(),
  outlets: z.number().int().nonnegative(),
});
export type RestaurantCounts = z.infer<typeof RestaurantCountsSchema>;
