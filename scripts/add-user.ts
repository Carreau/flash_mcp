// Create (or reset the password of) a login, without any third-party provider.
//
//   npm run add-user -- you@example.com ["Your Name"]
//
// Prompts for the password (hidden), then prints the wrangler command that
// writes the hashed password to D1. Only the PBKDF2 hash leaves this machine.

import { stdin, stdout } from "node:process";
import { hashPassword } from "../src/auth/password";

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    stdout.write(prompt);
    let value = "";
    const tty = stdin.isTTY;
    if (tty) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          if (tty) stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const [email, name] = process.argv.slice(2);
if (!email || !email.includes("@")) {
  console.error('usage: npm run add-user -- you@example.com ["Your Name"]');
  process.exit(1);
}
const pw = await ask("Password: ");
if (pw.length < 10) {
  console.error("Use at least 10 characters.");
  process.exit(1);
}
if ((await ask("Again: ")) !== pw) {
  console.error("Passwords differ.");
  process.exit(1);
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sql =
  `INSERT INTO users (id, email, name, password_hash, created_at) VALUES ` +
  `(${q(crypto.randomUUID())}, ${q(email.trim().toLowerCase())}, ${name ? q(name) : "NULL"}, ${q(await hashPassword(pw, Number(process.env.PBKDF2_ITERATIONS) || undefined))}, ${Date.now()}) ` +
  `ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash, name = COALESCE(excluded.name, users.name);`;

console.log("\nRun this where wrangler is logged in (add --local instead of --remote for `wrangler dev`):\n");
console.log(`npx wrangler d1 execute flash-mcp --remote --command "${sql.replace(/(["$`\\])/g, "\\$1")}"`);
