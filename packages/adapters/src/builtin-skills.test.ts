import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS, RAKAZO_DOCS_URLS } from "./builtin-skills.js";

const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);
const publishedSlugs = [
  ...readFileSync(repoFile("apps/www/src/docs.ts"), "utf8").matchAll(/slug: "([\w-]+)"/g),
].map((match) => match[1]);

describe("Zomato report skills", () => {
  it("keeps a signed-in browser and reconciles the paid cycle with the script", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((item) => item.name === "Zomato payout reconciliation");
    expect(skill?.description.length).toBeLessThanOrEqual(72);
    expect(skill?.content).toContain("payout date and a UTR");
    expect(skill?.content).toContain("current or upcoming cycle");
    expect(skill?.content).toContain("python3 /usr/local/bin/rakazo-zomato-report begin payout");
    expect(skill?.content).toContain("python3 /usr/local/bin/rakazo-zomato-report payout");
    expect(skill?.content).toContain("rakazo-zomato-reconcile");
    expect(skill?.content).toContain("do not install packages");
    expect(skill?.content).toContain("already signed in");
    expect(skill?.content).toContain("Never type a password");
    expect(skill?.content).not.toContain("xdotool");
    expect(skill?.content).toContain("one consolidated report");
    expect(skill?.content).toContain("Payout reconciliation");
  });

  it("explains a monthly comparison only from the bundled script", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((item) => item.name === "Zomato monthly analysis");
    expect(skill?.description.length).toBeLessThanOrEqual(72);
    expect(skill?.content).toContain("python3 /usr/local/bin/rakazo-zomato-report begin monthly");
    expect(skill?.content).toContain("python3 /usr/local/bin/rakazo-zomato-report monthly");
    expect(skill?.content).toContain("Do not calculate anything yourself");
    expect(skill?.content).toContain("Do not use fixed click positions");
    expect(skill?.content).toContain('--outlet "OUTLET ID"');
  });
});

describe("Payout reconciliation", () => {
  it("requires both platforms to load the guide and preflight before browser work", () => {
    const bot = readFileSync(repoFile("restaurant-templates/payouts/bot.md"), "utf8");
    const skill = BUILTIN_AGENT_SKILLS.find((item) => item.name === "Payout reconciliation")!;
    expect(bot).toContain("call `skill_read` for **Payout reconciliation**");
    expect(bot).toContain("Zomato AND Swiggy");
    expect(bot).toContain("Read it once per task");
    expect(skill.description).toContain("Swiggy");
    expect(skill.content).toContain("payout-preflight --platform zomato");
    expect(skill.content).toContain("--platform swiggy");
    expect(skill.content).toContain("already contains a fresh snapshot");
    expect(skill.content).toContain("outlet ID from this restaurant's settings");
    expect(skill.content).toContain("Do not assume a particular tab exists");
    expect(skill.content).toContain("calculator does not support that export scope");
    expect(skill.content).not.toContain("Swiggy + Toing");
    expect(skill.content).not.toMatch(/\b(?:Oct|Nov)\s+2026\b/);
    expect(skill.content).toContain("Write `~/.local/share/payout-reconciliation/job.json` first");
  });

  it("keeps operational guidance and documentation free of live dates and literal outlet IDs", () => {
    const files = [
      "restaurant-templates/payouts/bot.md",
      "restaurant-templates/payouts/skills/payout-reconciliation/SKILL.md",
      "docs/payout-installation-and-performance.md",
    ];
    for (const file of files) {
      const text = readFileSync(repoFile(file), "utf8");
      expect(text, file).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
      expect(text, file).not.toMatch(/\b(?:RID|outlet_id|restaurant_id)\s*[:=]\s*["']?\d{3,}/i);
      expect(text, file).not.toMatch(
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+20\d{2}\b/,
      );
    }
  });

  it("delivers one consolidated report and keeps the dashboards read-only", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((item) => item.name === "Payout reconciliation");
    expect(skill?.description.length).toBeLessThanOrEqual(72);
    expect(skill?.content).toContain("ALWAYS ONE CONSOLIDATED REPORT");
    expect(skill?.content).toContain("did Zomato pay me");
    expect(skill?.content).toContain("payout-owner-reconcile");
    expect(skill?.content).toContain("payout-swiggy-reconcile");
    expect(skill?.content).toContain("payout-combined");
    expect(skill?.content).toContain("send report to mail");
    expect(skill?.content).toContain("absolute gap strictly below");
    expect(skill?.content).toContain("assumed rate X% (onboarding rate not yet provided)");
    expect(skill?.content).toContain("owner-confirmed-outlet-map.csv");
    expect(skill?.content).toContain("fill_code");
    expect(skill?.content).toContain("never replay the code");
    expect(skill?.content).not.toContain("native Backspace");
    expect(skill?.content).toContain("Do not use fixed click positions");
    expect(skill?.content).not.toContain("x-ai/");
    expect(skill?.content).not.toContain("Gemini");
  });
});

describe("Rakazo skill", () => {
  it("links only to published docs pages", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((s) => s.name === "Rakazo")!;
    const urls = [...skill.content.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
    expect(urls).toEqual(RAKAZO_DOCS_URLS);
    for (const url of urls) {
      const slug =
        url === "https://rakazo.com/docs.md"
          ? publishedSlugs[0]
          : /^https:\/\/rakazo\.com\/docs\/([\w-]+)\.md$/.exec(url)?.[1];
      expect(publishedSlugs, url).toContain(slug);
      expect(existsSync(repoFile(`docs/${slug}.md`)), url).toBe(true);
    }
  });
});
