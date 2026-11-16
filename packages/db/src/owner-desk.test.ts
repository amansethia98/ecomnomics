import { expect, it } from "vitest";
import { latestMenuWindows } from "./owner-desk.js";

it("keeps each outlet and app on its own latest menu window", () => {
  const older = new Date("2026-11-09T00:00:00.000Z");
  const newer = new Date("2026-11-16T00:00:00.000Z");
  const windows = latestMenuWindows([
    { outletId: "north", platform: "zomato", periodEnd: newer },
    { outletId: "north", platform: "zomato", periodEnd: older },
    { outletId: "north", platform: "swiggy", periodEnd: older },
    { outletId: "south", platform: "zomato", periodEnd: older },
  ]);
  expect(windows).toEqual([
    { outletId: "north", platform: "zomato", periodEnd: newer },
    { outletId: "north", platform: "swiggy", periodEnd: older },
    { outletId: "south", platform: "zomato", periodEnd: older },
  ]);
});
