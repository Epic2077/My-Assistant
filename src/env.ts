import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Tiny .env loader to keep the project dependency-light. Existing process env wins.
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equalAt = trimmed.indexOf("=");
    if (equalAt < 1) continue;
    const key = trimmed.slice(0, equalAt).trim();
    let value = trimmed.slice(equalAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const env = {
  host: process.env.HOST || "127.0.0.1",
  port: int(process.env.PORT, 4173),
  ownerName: process.env.OWNER_NAME || "Ashkan",
  aiBaseUrl: (process.env.AI_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, ""),
  aiApiKey: process.env.AI_API_KEY || "",
  aiModel: process.env.AI_MODEL || "deepseek-chat",
  aiTimeoutMs: int(process.env.AI_TIMEOUT_MS, 20_000),
  initialDryRun: bool(process.env.DRY_RUN, true),
  telegramEnabled: bool(process.env.TELEGRAM_ENABLED, false),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramOwnerChatId: process.env.TELEGRAM_OWNER_CHAT_ID || "",
  telegramUserEnabled: bool(process.env.TELEGRAM_USER_ENABLED, false),
  telegramUserConsentMessagesEnabled: bool(process.env.TELEGRAM_USER_CONSENT_MESSAGES_ENABLED, false),
  telegramApiId: int(process.env.TELEGRAM_API_ID, 0),
  telegramApiHash: process.env.TELEGRAM_API_HASH || "",
  telegramUserSessionPath: resolve(process.cwd(), process.env.TELEGRAM_USER_SESSION_PATH || "data/telegram-user.session"),
  whatsappEnabled: bool(process.env.WHATSAPP_ENABLED, false),
};
