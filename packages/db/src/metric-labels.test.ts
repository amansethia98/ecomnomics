import { seedLabelBook } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "./client.js";
import { loadLabelBook } from "./metric-labels.js";

describe("metric label book", () => {
  it("uses the built-in labels when the database read fails", async () => {
    const db = {
      metricLabelRegistry: {
        findUnique: () => {
          throw new Error("database unavailable");
        },
      },
    } as unknown as PrismaClient;
    expect(await loadLabelBook(db)).toEqual(seedLabelBook());
  });
});
