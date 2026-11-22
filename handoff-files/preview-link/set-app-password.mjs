// Hash a password with Better Auth. Never prints the plaintext.
// Usage:
//   set-app-password.mjs <password-file> <email>
//   set-app-password.mjs --stdin <email>     (reads plaintext from stdin)
// Writes only the hash to stdout.
import { readFileSync } from "node:fs";
import { hashPassword } from "/workspace/preview-s2/node_modules/.pnpm/better-auth@1.7.18_@opentelemetry+api@1.10.0_@prisma+client@7.10.1_prisma@7.10.1_@types_7095741fd79e695a2d3cce0ea6e24519/node_modules/better-auth/dist/crypto/index.mjs";

const source = process.argv[2];
const email = process.argv[3];
if (!source || !email) {
  console.error("usage: set-app-password.mjs <password-file|--stdin> <email>");
  process.exit(2);
}
let password;
if (source === "--stdin") {
  password = readFileSync(0, "utf8").replace(/\n$/, "");
} else {
  password = readFileSync(source, "utf8").replace(/\n$/, "");
}
if (password.length < 8) {
  console.error("password too short");
  process.exit(2);
}
const hash = await hashPassword(password);
process.stdout.write(hash);
