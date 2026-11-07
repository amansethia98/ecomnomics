import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { shellQuote } from "./computer-support.js";

/** The computer image's reconciler: the API ships the same file in its source tree. */
const SCRIPT = "rakazo-zomato-reconcile";
const COMPUTER_DIR = path.join("infra", "sandboxes", "computer");

let source: string | undefined;

function scriptText(): string {
  if (!source) {
    for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, COMPUTER_DIR, SCRIPT);
      if (existsSync(candidate)) {
        source = readFileSync(candidate, "utf8");
        break;
      }
      if (path.dirname(dir) === dir) throw new Error(`${COMPUTER_DIR}/${SCRIPT} is missing`);
    }
  }
  return source;
}

const asRoot = 'if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi';

/**
 * Writes the payout reconciler where the computer image keeps it, from this release's copy,
 * unless that copy is already there. A hosted computer then has the script its API was released
 * with, without a new package install.
 */
export function installZomatoReconcileCommand(): string {
  const text = scriptText();
  const version = createHash("sha256").update(text).digest("hex");
  const archive = gzipSync(JSON.stringify({ [SCRIPT]: text }), { level: 9 }).toString("base64");
  const unpack = [
    "import gzip, json, os, sys",
    "files = json.loads(gzip.decompress(sys.stdin.buffer.read()))",
    "os.makedirs('/usr/local/lib/rakazo', exist_ok=True)",
    `target = ${JSON.stringify(`/usr/local/bin/${SCRIPT}`)}`,
    "with open(target + '.new', 'w', encoding='utf-8') as file:",
    `    file.write(files[${JSON.stringify(SCRIPT)}])`,
    "os.chmod(target + '.new', 0o755)",
    "os.replace(target + '.new', target)",
    `open('/usr/local/lib/rakazo/zomato-reconcile.version', 'w').write(${JSON.stringify(version)})`,
  ].join("\n");
  return [
    "set -eu",
    `if [ "$(cat /usr/local/lib/rakazo/zomato-reconcile.version 2>/dev/null)" = ${version} ]; then exit 0; fi`,
    asRoot,
    `printf '%s' ${shellQuote(archive)} | base64 -d | $root python3 -c ${shellQuote(unpack)}`,
  ].join("\n");
}
