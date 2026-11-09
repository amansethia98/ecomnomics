import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { shellQuote } from "./computer-support.js";

/** The computer image's Zomato scripts: the API ships the same files in its source tree. */
const SCRIPTS = [
  "rakazo-zomato-reconcile",
  "rakazo-zomato-monthly-analysis",
  "rakazo-zomato-report",
] as const;
const COMPUTER_DIR = path.join("infra", "sandboxes", "computer");

const source = new Map<string, string>();

function scriptText(name: (typeof SCRIPTS)[number]): string {
  const cached = source.get(name);
  if (cached) return cached;
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, COMPUTER_DIR, name);
    if (existsSync(candidate)) {
      const text = readFileSync(candidate, "utf8");
      source.set(name, text);
      return text;
    }
    if (path.dirname(dir) === dir) throw new Error(`${COMPUTER_DIR}/${name} is missing`);
  }
}

const asRoot = 'if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi';

/**
 * Writes the payout reconciler, the monthly analysis, and the report claim helper where the
 * computer image keeps them, from this release's copies, unless those copies are already there.
 * A hosted computer then has the scripts its API was released with, without a new package install.
 */
export function installZomatoComputerCommands(): string {
  const files = Object.fromEntries(SCRIPTS.map((name) => [name, scriptText(name)]));
  const version = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const archive = gzipSync(JSON.stringify(files), { level: 9 }).toString("base64");
  const names = JSON.stringify(SCRIPTS);
  const unpack = [
    "import gzip, json, os, sys",
    "files = json.loads(gzip.decompress(sys.stdin.buffer.read()))",
    "os.makedirs('/usr/local/lib/rakazo', exist_ok=True)",
    `for name in ${names}:`,
    "    if name not in files:",
    "        raise SystemExit('missing ' + name)",
    "    target = '/usr/local/bin/' + name",
    "    with open(target + '.new', 'w', encoding='utf-8') as handle:",
    "        handle.write(files[name])",
    "    os.chmod(target + '.new', 0o755)",
    "    os.replace(target + '.new', target)",
    `open('/usr/local/lib/rakazo/zomato-scripts.version', 'w').write(${JSON.stringify(version)})`,
  ].join("\n");
  return [
    "set -eu",
    `if [ "$(cat /usr/local/lib/rakazo/zomato-scripts.version 2>/dev/null)" = ${version} ]; then exit 0; fi`,
    asRoot,
    `printf '%s' ${shellQuote(archive)} | base64 -d | $root python3 -c ${shellQuote(unpack)}`,
  ].join("\n");
}
