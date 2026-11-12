import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { shellQuote } from "./computer-support.js";

/** The computer image's report scripts and payout calculators. The API ships the same files. */
const BIN_SCRIPTS = [
  "rakazo-zomato-reconcile",
  "rakazo-zomato-monthly-analysis",
  "rakazo-zomato-report",
  "payout-owner-reconcile",
  "payout-swiggy-reconcile",
  "payout-combined",
  "agent-v1-post",
] as const;

const LIB_FILES = [
  "payout/reconcile_base.py",
  "payout/owner_reconcile.py",
  "payout/swiggy_reconcile.py",
  "payout/swiggy_math.py",
  "payout/combined_owner.py",
  "payout/outlet_map.py",
  "payout/reconciliation_policy.py",
  "payout/owner-confirmed-outlet-map.csv",
  "payout/examples/outlet-settings.example.json",
  "payout/examples/swiggy-settings.example.json",
] as const;

const COMPUTER_DIR = path.join("infra", "sandboxes", "computer");

const source = new Map<string, string>();

function computerFile(name: string): string {
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
 * Writes the report commands and the payout calculators where the computer image keeps them,
 * from this release's copies, unless those copies are already there. A hosted computer then
 * has the scripts its API was released with, without a new package install.
 */
export function installZomatoComputerCommands(): string {
  const files = {
    bin: Object.fromEntries(BIN_SCRIPTS.map((name) => [name, computerFile(name)])),
    lib: Object.fromEntries(LIB_FILES.map((name) => [name, computerFile(name)])),
  };
  const version = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const archive = gzipSync(JSON.stringify(files), { level: 9 }).toString("base64");
  const unpack = [
    "import gzip, json, os, sys",
    "files = json.loads(gzip.decompress(sys.stdin.buffer.read()))",
    "os.makedirs('/usr/local/lib/rakazo/payout/examples', exist_ok=True)",
    "os.makedirs('/usr/local/share/payout-reconciliation', exist_ok=True)",
    "for name, text in files['bin'].items():",
    "    target = '/usr/local/bin/' + name",
    "    with open(target + '.new', 'w', encoding='utf-8') as handle:",
    "        handle.write(text)",
    "    os.chmod(target + '.new', 0o755)",
    "    os.replace(target + '.new', target)",
    "for name, text in files['lib'].items():",
    "    target = '/usr/local/lib/rakazo/' + name",
    "    os.makedirs(os.path.dirname(target), exist_ok=True)",
    "    with open(target + '.new', 'w', encoding='utf-8') as handle:",
    "        handle.write(text)",
    "    os.chmod(target + '.new', 0o644)",
    "    os.replace(target + '.new', target)",
    "share = {",
    "    'payout/examples/outlet-settings.example.json': 'outlet-settings.example.json',",
    "    'payout/examples/swiggy-settings.example.json': 'swiggy-settings.example.json',",
    "    'payout/owner-confirmed-outlet-map.csv': 'owner-confirmed-outlet-map.csv',",
    "}",
    "for source, name in share.items():",
    "    target = '/usr/local/share/payout-reconciliation/' + name",
    "    with open(target + '.new', 'w', encoding='utf-8') as handle:",
    "        handle.write(files['lib'][source])",
    "    os.chmod(target + '.new', 0o644)",
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
