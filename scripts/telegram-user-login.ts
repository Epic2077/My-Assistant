import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { env } from "../src/env.ts";

async function readHidden(prompt: string): Promise<string> {
  // On non-interactive input there is no terminal echo to hide. On a TTY, detach
  // readline before switching stdin to raw mode so the password is not echoed by it.
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return readline.question(prompt);
  readline.close();
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolveQuestion, rejectQuestion) => {
      let value = "";
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString("utf8")) {
          if (char === "\u0003") { cleanup(); rejectQuestion(new Error("Login cancelled.")); return; }
          if (char === "\r" || char === "\n") { cleanup(); stdout.write("\n"); resolveQuestion(value); return; }
          if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
          if (char >= " ") value += char;
        }
      };
      const cleanup = () => { stdin.off("data", onData); };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    readline = createInterface({ input: stdin, output: stdout });
  }
}

const apiId = env.telegramApiId;
const apiHash = env.telegramApiHash;
if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env. Obtain these from https://my.telegram.org/apps.");
  process.exit(1);
}

let readline = createInterface({ input: stdin, output: stdout });
const clientPackageName: string = "teleproto";
const sessionsPackageName: string = "teleproto/sessions";
const lib = await import(clientPackageName) as any;
const sessions = await import(sessionsPackageName) as any;
const saved = existsSync(env.telegramUserSessionPath) ? readFileSync(env.telegramUserSessionPath, "utf8").trim() : "";
const client = new lib.TelegramClient(new sessions.StringSession(saved), apiId, apiHash, { connectionRetries: 5 });

try {
  await client.start({
    phoneNumber: async () => (await readline.question("Telegram phone number (with country code): ")).trim(),
    phoneCode: async (_isCodeViaApp?: boolean, info?: { type?: string }) => (await readline.question(`Login code from Telegram${info?.type ? ` (${info.type})` : ""}: `)).trim(),
    password: async () => (await readHidden("Telegram two-step verification password (input hidden): ")).trim(),
    emailAddress: async () => (await readline.question("Telegram login email: ")).trim(),
    emailVerification: async () => ({ type: "code", code: (await readline.question("Telegram email verification code: ")).trim() }),
    onError: (error: unknown) => { console.error("Telegram login step failed:", error instanceof Error ? error.message : String(error)); },
  });
  const me = await client.getMe();
  const session = String(client.session.save());
  const destination = resolve(env.telegramUserSessionPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${session}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(destination, 0o600);
  console.log(`Authenticated Telegram personal account ID ${String(me?.id ?? "unknown")} .`);
  console.log(`Session saved to ${destination}. Treat this file like a password; never share it or commit it.`);
} catch (error) {
  console.error("Telegram personal-account login failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  readline.close();
  await client.disconnect().catch(() => undefined);
}
