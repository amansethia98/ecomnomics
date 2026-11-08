import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillMd, parseSkillMd, restaurantTemplateSpawnKey } from "@rakazo/core";
import { restaurantStarterBotsEnabled } from "./restaurant-mode.js";

export type RestaurantTemplateSkill = {
  name: string;
  description: string;
  content: string;
};

export type RestaurantTemplate = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  spawnKey: string;
  skills: RestaurantTemplateSkill[];
};

const TEMPLATE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The in-repo folder, from source or from a bundled API/worker dist file. */
export function restaurantTemplatesRoot(from = fileURLToPath(import.meta.url)): string {
  let dir = path.dirname(from);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, "restaurant-templates");
    if (existsSync(path.join(candidate, "menu-manager", "bot.md"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "restaurant-templates was not found. Keep that folder next to the application and restart.",
  );
}

function readTemplate(root: string, id: string, skillNames: Set<string>): RestaurantTemplate {
  if (!TEMPLATE_ID.test(id)) {
    throw new Error(
      `Restaurant template folder "${id}" must use lowercase letters, numbers, and hyphens.`,
    );
  }
  const botPath = path.join(root, id, "bot.md");
  if (!existsSync(botPath)) throw new Error(`Restaurant template "${id}" needs a bot.md file.`);
  const parsed = parseSkillMd(readFileSync(botPath, "utf8"));
  if ("error" in parsed) throw new Error(`Restaurant template "${id}": ${parsed.error}`);
  const instructions = parsed.body.trim();
  if (!instructions) throw new Error(`Restaurant template "${id}" needs instructions.`);
  return {
    id,
    name: parsed.name,
    description: parsed.description,
    instructions,
    spawnKey: restaurantTemplateSpawnKey(id),
    skills: readSkills(path.join(root, id, "skills"), skillNames),
  };
}

function readSkills(dir: string, seen: Set<string>): RestaurantTemplateSkill[] {
  if (!existsSync(dir)) return [];
  const folders = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const skills: RestaurantTemplateSkill[] = [];
  for (const folder of folders) {
    const file = path.join(dir, folder, "SKILL.md");
    if (!existsSync(file)) {
      throw new Error(`Restaurant skill folder "${folder}" needs a SKILL.md file.`);
    }
    const parsed = parseSkillMd(readFileSync(file, "utf8"));
    if ("error" in parsed) throw new Error(`Restaurant skill "${folder}": ${parsed.error}`);
    const key = parsed.name.trim().toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Restaurant skill "${parsed.name}" is defined more than once.`);
    }
    seen.add(key);
    skills.push({
      name: parsed.name,
      description: parsed.description,
      content: buildSkillMd(parsed),
    });
  }
  return skills;
}

/** Bots and locked skills from `restaurant-templates/`, in folder order. */
export function loadRestaurantTemplates(root = restaurantTemplatesRoot()): RestaurantTemplate[] {
  const ids = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const skillNames = new Set<string>();
  const templates = ids.map((id) => readTemplate(root, id, skillNames));
  if (templates.length === 0) throw new Error("No restaurant templates were found.");
  return templates;
}

/** Locked skills shipped with the templates. Empty unless starter bots are turned on. */
export function restaurantSkillRecords(
  env: NodeJS.ProcessEnv = process.env,
): RestaurantTemplateSkill[] {
  if (!restaurantStarterBotsEnabled(env)) return [];
  return loadRestaurantTemplates().flatMap((template) => template.skills);
}
