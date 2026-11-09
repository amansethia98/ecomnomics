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
  });

  it("explains a monthly comparison only from the bundled script", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((item) => item.name === "Zomato monthly analysis");
    expect(skill?.description.length).toBeLessThanOrEqual(72);
    expect(skill?.content).toContain("python3 /usr/local/bin/rakazo-zomato-report begin monthly");
    expect(skill?.content).toContain("python3 /usr/local/bin/rakazo-zomato-report monthly");
    expect(skill?.content).toContain("Do not calculate anything yourself");
    expect(skill?.content).toContain("Do not use fixed click positions");
    expect(skill?.content).not.toMatch(/\b24802\b/);
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
