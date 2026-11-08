import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS, RAKAZO_DOCS_URLS } from "./builtin-skills.js";

const repoFile = (path: string) => new URL(`../../../${path}`, import.meta.url);
const publishedSlugs = [
  ...readFileSync(repoFile("apps/www/src/docs.ts"), "utf8").matchAll(/slug: "([\w-]+)"/g),
].map((match) => match[1]);

describe("Zomato payout reconciliation skill", () => {
  it("tells every bot to download the paid cycle and run the bundled script", () => {
    const skill = BUILTIN_AGENT_SKILLS.find((item) => item.name === "Zomato payout reconciliation");
    expect(skill?.description.length).toBeLessThanOrEqual(72);
    expect(skill?.content).toContain("Finance, then Payouts");
    expect(skill?.content).toContain("payout date and a UTR");
    expect(skill?.content).toContain("current or upcoming cycle");
    expect(skill?.content).toContain("python3 /usr/local/bin/rakazo-zomato-reconcile");
    expect(skill?.content).toContain("Do not install packages");
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
