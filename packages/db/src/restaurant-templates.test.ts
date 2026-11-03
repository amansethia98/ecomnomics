import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isSkillReadOnly, parseSkillMd } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadRestaurantTemplates,
  restaurantSkillRecords,
  restaurantTemplatesRoot,
} from "./restaurant-templates.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("restaurant templates", () => {
  it("ships Menu Manager and Reviews Replier as editable placeholders", () => {
    const templates = loadRestaurantTemplates(restaurantTemplatesRoot());
    expect(templates.map((template) => template.name)).toEqual(["Menu Manager", "Reviews Replier"]);
    expect(templates.map((template) => template.spawnKey)).toEqual([
      "restaurant-template:menu-manager",
      "restaurant-template:reviews-replier",
    ]);
    for (const template of templates) {
      expect(template.instructions.startsWith("EDIT THIS:")).toBe(true);
      expect(template.description.length).toBeGreaterThan(0);
    }
    const skills = templates.flatMap((template) => template.skills);
    expect(skills.map((skill) => skill.name)).toEqual(["Update menu", "Reply to reviews"]);
    for (const skill of skills) {
      const parsed = parseSkillMd(skill.content);
      expect(parsed).toMatchObject({ name: skill.name });
      if ("error" in parsed) throw new Error(parsed.error);
      expect(parsed.body).toContain("EDIT THIS:");
      expect(skill.description.length).toBeLessThanOrEqual(72);
      expect(isSkillReadOnly("builtin")).toBe(true);
    }
  });

  it("hides template skills until starter bots are turned on", () => {
    expect(restaurantSkillRecords({})).toEqual([]);
    vi.stubEnv("RESTAURANT_STARTER_BOTS_ENABLED", "true");
    expect(restaurantSkillRecords().map((skill) => skill.name)).toEqual([
      "Update menu",
      "Reply to reviews",
    ]);
  });

  it("rejects a skill name that is used twice", () => {
    const root = mkdtempSync(path.join(tmpdir(), "restaurant-templates-"));
    const skill = `---\nname: Update menu\ndescription: One skill\n---\n\nSteps\n`;
    for (const id of ["alpha", "beta"]) {
      mkdirSync(path.join(root, id, "skills", "shared"), { recursive: true });
      writeFileSync(
        path.join(root, id, "bot.md"),
        `---\nname: ${id}\ndescription: A bot\n---\n\nEDIT THIS: instructions\n`,
      );
      writeFileSync(path.join(root, id, "skills", "shared", "SKILL.md"), skill);
    }
    expect(() => loadRestaurantTemplates(root)).toThrow(/defined more than once/);
  });
});
