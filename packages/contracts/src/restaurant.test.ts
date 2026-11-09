import { describe, expect, it } from "vitest";
import { RestaurantOnboardingInputSchema } from "./restaurant.js";

const valid = {
  name: "Harbor Grill",
  cuisine: "Seafood",
  city: "Lisbon",
  contactName: "Ana Costa",
  contactEmail: "ana@harbor.test",
  contactPhone: "",
  outlets: [
    {
      name: "Riverside",
      address: "1 Dock Street",
      openingHours: "Tue–Sun 12:00–23:00",
    },
  ],
  menuText: "Grilled fish",
  menuFileName: null,
};

describe("restaurant onboarding input", () => {
  it("accepts a restaurant with one way to reach it", () => {
    expect(RestaurantOnboardingInputSchema.safeParse(valid).success).toBe(true);
    expect(
      RestaurantOnboardingInputSchema.safeParse({
        ...valid,
        contactEmail: "",
        contactPhone: "+351 555 010",
      }).success,
    ).toBe(true);
  });

  it("asks for a contact method and an outlet", () => {
    const missingContact = RestaurantOnboardingInputSchema.safeParse({
      ...valid,
      contactEmail: "",
      contactPhone: "",
    });
    expect(missingContact.success).toBe(false);
    if (!missingContact.success) {
      expect(
        missingContact.error.issues.some(
          (issue) => issue.message === "Add an email or a phone number",
        ),
      ).toBe(true);
    }
    const missingOutlet = RestaurantOnboardingInputSchema.safeParse({ ...valid, outlets: [] });
    expect(missingOutlet.success).toBe(false);
    if (!missingOutlet.success) {
      expect(missingOutlet.error.issues[0]?.message).toBe("Add at least one outlet");
    }
  });
});
