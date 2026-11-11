import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { shellQuote } from "./computer-support.js";

/** The computer image's page-browser files: the API ships them in its source tree. */
const COMPUTER_DIR = path.join("infra", "sandboxes", "computer");

let computerDir: string | undefined;

function computerFile(name: string): string {
  if (!computerDir) {
    // Source, tests and the bundled server all sit somewhere below the repository root.
    for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, COMPUTER_DIR);
      if (existsSync(path.join(candidate, "rakazo-page-browser"))) {
        computerDir = candidate;
        break;
      }
      if (path.dirname(dir) === dir) throw new Error(`${COMPUTER_DIR} is missing`);
    }
  }
  return readFileSync(path.join(computerDir, name), "utf8");
}

const asRoot = 'if [ "$(id -u)" -eq 0 ]; then root=""; else root="sudo -n"; fi';

/**
 * Installs the pinned agent-browser into /usr/local/bin with the computer image's own script.
 * It changes only when the pinned version does, so a provider's saved base image can carry it.
 */
export function installAgentBrowserCommand(): string {
  return [
    "set -eu",
    asRoot,
    `$root sh -c ${shellQuote(computerFile("install-agent-browser.sh"))} sh /usr/local/bin >/dev/null`,
  ].join("\n");
}

/**
 * Writes the page-browser wrapper and its secrets helper where the computer image keeps them,
 * from this release's copy, unless they already match it. Small enough to run on every boot,
 * so a hosted computer always runs the helper its API was released with.
 */
export function installPageBrowserFilesCommand(): string {
  const names = [
    "rakazo-page-browser",
    "page_secrets.py",
    "zomato_legacy.py",
    "zomato_browser_246c11b.py",
    "zomato_secrets_246c11b.py",
  ];
  const files = Object.fromEntries(names.map((name) => [name, computerFile(name)]));
  const version = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  // One archive, so the current helper and frozen login runtime change together.
  // Intern lines before compression: the frozen and current runtimes share much of
  // their source. This keeps the shell argument below Linux's 128 KiB per-arg limit.
  const lines: string[] = [];
  const indices = new Map<string, number>();
  const packed = Object.fromEntries(
    Object.entries(files).map(([name, source]) => [
      name,
      source.split("\n").map((line) => {
        let index = indices.get(line);
        if (index === undefined) {
          index = lines.length;
          indices.set(line, index);
          lines.push(line);
        }
        return index;
      }),
    ]),
  );
  const archive = gzipSync(JSON.stringify({ lines, files: packed }), { level: 9 }).toString(
    "base64",
  );
  const unpack = [
    "import gzip, json, os, sys",
    "bundle = json.loads(gzip.decompress(sys.stdin.buffer.read()))",
    "files = {name: '\\n'.join(bundle['lines'][i] for i in indices) for name, indices in bundle['files'].items()}",
    "os.makedirs('/usr/local/lib/rakazo', exist_ok=True)",
    "for name in files:",
    "    mode = 0o755 if name == 'rakazo-page-browser' else 0o644",
    "    target = ('/usr/local/bin/' if mode == 0o755 else '/usr/local/lib/rakazo/') + name",
    "    with open(target + '.new', 'w', encoding='utf-8') as file:",
    "        file.write(files[name])",
    "    os.chmod(target + '.new', mode)",
    "    os.replace(target + '.new', target)",
    `open('/usr/local/lib/rakazo/page-browser.version', 'w').write(${JSON.stringify(version)})`,
  ].join("\n");
  return [
    "set -eu",
    `if [ "$(cat /usr/local/lib/rakazo/page-browser.version 2>/dev/null)" = ${version} ]; then exit 0; fi`,
    asRoot,
    `printf '%s' ${shellQuote(archive)} | base64 -d | $root python3 -c ${shellQuote(unpack)}`,
  ].join("\n");
}

/** Everything a hosted Linux computer needs for the page tools; idempotent and cheap once done. */
export function installPageBrowserCommand(): string {
  return [installAgentBrowserCommand(), installPageBrowserFilesCommand()]
    .map((script) => `( ${script}\n)`)
    .join(" && ");
}
