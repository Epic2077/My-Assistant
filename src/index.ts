import { resolve } from "node:path";
import { env } from "./env.ts";
import { MessageHandler } from "./handler.ts";
import { startDashboardServer } from "./server.ts";
import { Store } from "./store.ts";
import type { RuntimeStatus } from "./types.ts";

const store = new Store(resolve(process.cwd(), "data", "state.json"), env.initialDryRun);
const runtime: RuntimeStatus = {
  dashboard: `http://${env.host}:${env.port}`,
  ai: env.aiApiKey || env.aiBaseUrl.includes("127.0.0.1") || env.aiBaseUrl.includes("localhost") ? `configured · ${env.aiModel}` : "needs API key or local model",
  telegram: env.telegramEnabled ? "starting" : "disabled in .env",
  telegramUser: env.telegramUserEnabled ? "starting" : "disabled in .env",
  whatsapp: env.whatsappEnabled ? "starting" : "disabled in .env",
  startedAt: new Date().toISOString(),
};
const handler = new MessageHandler(store, {});
const server = startDashboardServer(store, runtime, handler);

let telegramConnector: { stop: () => void } | undefined;
let telegramUserConnector: { stop: () => Promise<void> } | undefined;
let whatsappConnector: { stop: () => Promise<void> } | undefined;

async function startConnectors(): Promise<void> {
  if (env.telegramEnabled) {
    try {
      const { TelegramConnector } = await import("./connectors/telegram.ts");
      const connector = new TelegramConnector(store, handler, (status) => { runtime.telegram = status; });
      handler.registerConnector("telegram", connector);
      handler.registerOwnerNotifier(connector);
      telegramConnector = connector;
      await connector.start();
    } catch (error) {
      runtime.telegram = "error · check .env / token";
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[Telegram] Could not start: ${detail}`);
      store.addEvent({ kind: "error", platform: "telegram", details: `Could not start Telegram connector: ${detail}` });
    }
  }

  if (env.telegramUserEnabled) {
    try {
      const { TelegramUserConnector } = await import("./connectors/telegram-user.ts");
      const connector = new TelegramUserConnector(store, handler, (status) => { runtime.telegramUser = status; });
      handler.registerConnector("telegram_user", connector);
      telegramUserConnector = connector;
      await connector.start();
    } catch (error) {
      runtime.telegramUser = "error · check API credentials, session, and consent settings";
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[Telegram User] Could not start: ${detail}`);
      store.saveTelegramUser({ connectionStatus: "error" });
      store.addEvent({ kind: "error", platform: "telegram_user", details: `Could not start personal Telegram client: ${detail}` });
    }
  }

  if (env.whatsappEnabled) {
    try {
      const { WhatsAppConnector } = await import("./connectors/whatsapp.ts");
      const connector = new WhatsAppConnector(store, handler, (status) => { runtime.whatsapp = status; });
      handler.registerConnector("whatsapp", connector);
      whatsappConnector = connector;
      await connector.start();
    } catch (error) {
      runtime.whatsapp = "error · check installation / session";
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[WhatsApp] Could not start: ${detail}`);
      store.addEvent({ kind: "error", platform: "whatsapp", details: `Could not start WhatsApp connector: ${detail}` });
    }
  }
}

void startConnectors();

const expiryTimer = setInterval(() => {
  const mode = store.read().mode;
  if (mode.enabled && mode.availableAt && Date.now() >= new Date(mode.availableAt).getTime()) {
    store.setMode({ enabled: false, reason: mode.reason, availableAt: mode.availableAt, policy: mode.policy });
    void handler.notifyBusyModeEnded(mode);
    console.log("[Busy Mode] Scheduled end time reached; Busy Mode disabled automatically.");
  }
}, 10_000);

async function shutdown(): Promise<void> {
  clearInterval(expiryTimer);
  telegramConnector?.stop();
  await telegramUserConnector?.stop();
  await whatsappConnector?.stop();
  server.close();
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
