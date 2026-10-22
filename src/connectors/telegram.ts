import { env } from "../env.ts";
import { Store } from "../store.ts";
import type { InboundMessage } from "../types.ts";
import type { MessageHandler } from "../handler.ts";

interface TelegramUser { id: number; first_name?: string; last_name?: string; username?: string; is_bot?: boolean }
interface TelegramChat { id: number; type?: string; title?: string; first_name?: string; last_name?: string; username?: string }
interface TelegramMessage {
  message_id: number;
  date: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  business_connection_id?: string;
  sender_business_bot?: TelegramUser;
}
interface TelegramUpdate {
  update_id: number;
  business_connection?: { id: string; user?: TelegramUser; rights?: { can_reply?: boolean }; is_enabled?: boolean };
  business_message?: TelegramMessage;
  edited_business_message?: TelegramMessage;
  message?: TelegramMessage;
}
interface TelegramApiResponse<T> { ok: boolean; result: T; description?: string }

function fullName(user?: TelegramUser, chat?: TelegramChat): string {
  const source = user || chat;
  if (!source) return "Telegram contact";
  const name = [source.first_name, source.last_name].filter(Boolean).join(" ").trim();
  return name || (source.username ? `@${source.username}` : "Telegram contact");
}

export class TelegramConnector {
  private stopped = false;
  private running = false;
  private readonly apiBase: string;
  private readonly store: Store;
  private readonly handler: MessageHandler;
  private readonly onStatus: (status: string) => void;

  constructor(store: Store, handler: MessageHandler, onStatus: (status: string) => void) {
    this.store = store;
    this.handler = handler;
    this.onStatus = onStatus;
    this.apiBase = `https://api.telegram.org/bot${env.telegramBotToken}`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!env.telegramBotToken) throw new Error("TELEGRAM_BOT_TOKEN is missing from .env.");
    this.running = true;
    this.stopped = false;
    this.onStatus("connecting");
    this.store.saveTelegram({ connectionStatus: "connecting" });
    try {
      await this.api("getMe", {});
      this.onStatus("connected · polling updates");
      this.store.saveTelegram({ connectionStatus: "connected" });
      const telegramState = this.store.read().telegram;
      console.log("[Telegram] Bot API connection verified. Polling for updates and owner-chat commands.");
      if (!telegramState.businessConnectionId) {
        console.warn("[Telegram] DIAGNOSTIC: no Telegram Business connection has been recorded. Commands sent to this bot can work while messages sent to your personal Telegram inbox remain invisible to it.");
        console.warn("[Telegram] To process personal inbox messages, Telegram must deliver business_message updates after a supported Business bot connection has been configured. A normal bot chat is separate.");
      } else if (!telegramState.canReply) {
        console.warn("[Telegram] DIAGNOSTIC: a Business connection exists, but can_reply is false. Incoming processing may be limited and replies will be blocked.");
      } else {
        console.log("[Telegram] Stored Business connection found with can_reply permission.");
      }
      void this.pollLoop();
    } catch (error) {
      this.running = false;
      this.onStatus("error");
      this.store.saveTelegram({ connectionStatus: "error" });
      throw error;
    }
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
    this.onStatus("stopped");
    this.store.saveTelegram({ connectionStatus: "stopped" });
  }

  async send(message: InboundMessage, text: string): Promise<void> {
    const state = this.store.read();
    const body: Record<string, unknown> = {
      chat_id: message.chatId,
      text,
      disable_web_page_preview: true,
    };
    // Ordinary bot DMs use the standard Bot API. Only replies to messages that
    // arrived through a Business connection should carry business_connection_id.
    if (message.businessConnectionId) {
      if (!state.telegram.canReply) throw new Error("Telegram Business connection does not currently grant can_reply. Reconnect it with reply permission enabled.");
      body.business_connection_id = message.businessConnectionId;
    }
    await this.api("sendMessage", body);
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        const state = this.store.read();
        const response = await this.api<TelegramUpdate[]>("getUpdates", {
          offset: state.telegram.offset,
          timeout: 25,
          // `message` supports the private owner control chat and regular DMs sent directly to the bot.
          // Regular bot DMs remain separate from the owner's personal inbox.
          allowed_updates: ["message", "business_connection", "business_message", "edited_business_message"],
        }, 32_000);
        const updates = response || [];
        for (const update of updates) {
          if (this.stopped) break;
          try {
            const updateTypes = ([
              ["message", update.message],
              ["business_connection", update.business_connection],
              ["business_message", update.business_message],
              ["edited_business_message", update.edited_business_message],
            ] as const).filter(([, value]) => value !== undefined).map(([name]) => name);
            console.log(`[Telegram] Update received: type=${updateTypes.join(",") || "unknown"} update_id=${update.update_id}`);
            await this.processUpdate(update);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            console.error(`[Telegram] Update ${update.update_id} failed: ${detail}`);
            this.store.addEvent({ kind: "error", platform: "telegram", details: `Telegram update ${update.update_id} failed: ${detail}` });
          } finally {
            this.store.saveTelegram({ offset: update.update_id + 1 });
          }
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!this.stopped) {
          this.onStatus(`retrying · ${detail.slice(0, 80)}`);
          this.store.saveTelegram({ connectionStatus: "retrying" });
          console.error(`[Telegram] Poll failed: ${detail}`);
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      }
    }
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.processOwnerBotMessage(update.message);
      return;
    }

    if (update.business_connection) {
      const connection = update.business_connection;
      const enabled = connection.is_enabled !== false;
      this.store.saveTelegram({
        businessConnectionId: enabled ? connection.id : null,
        businessUserId: connection.user?.id ?? null,
        canReply: enabled && connection.rights?.can_reply === true,
        connectionStatus: enabled ? (connection.rights?.can_reply ? "connected" : "connected · no reply permission") : "business connection disabled",
      });
      this.onStatus(enabled ? (connection.rights?.can_reply ? "connected" : "connected · no reply permission") : "business connection disabled");
      this.store.addEvent({ kind: "connector", platform: "telegram", details: enabled ? `Telegram Business connection updated. can_reply=${connection.rights?.can_reply === true}.` : "Telegram Business connection disabled." });
      return;
    }

    // Deliberately process only Business messages. Ordinary bot chats do not give the assistant access to the owner's personal inbox.
    const message = update.business_message;
    if (!message) {
      const knownKeys = ["update_id", "message", "business_connection", "business_message", "edited_business_message"];
      const keys = Object.keys(update).filter((key) => !knownKeys.includes(key));
      this.store.addEvent({ kind: "connector", platform: "telegram", details: `Received an unsupported Telegram update type${keys.length ? ` (${keys.join(", ")})` : ""}; ignored safely.` });
      return;
    }
    const state = this.store.read();
    if (message.sender_business_bot || message.from?.is_bot) {
      console.log(`[Telegram] Ignored business message from a bot. message_id=${message.message_id}`);
      return;
    }
    console.log(`[Telegram] Business message received from contact_id=${message.from?.id ?? "unknown"}, chat_type=${message.chat.type || "unknown"}, message_id=${message.message_id}. Message content is not printed.`);
    if (state.telegram.businessUserId && message.from?.id === state.telegram.businessUserId) {
      if (message.chat.type === "private") {
        this.handler.observeOwnerMessage("telegram", `telegram:${message.chat.id}`, message.text || message.caption || "", new Date((message.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(), String(message.message_id));
      }
      return;
    }
    if (message.chat.type !== "private") {
      this.store.addEvent({ kind: "message_skipped", platform: "telegram", details: `Ignored non-private Telegram Business message (${message.chat.type || "unknown chat type"}).` });
      return;
    }
    const senderId = message.from?.id ?? message.chat.id;
    const text = (message.text || message.caption || "").trim();
    const inbound: InboundMessage = {
      platform: "telegram",
      id: `${update.update_id}:${message.message_id}`,
      chatId: String(message.chat.id),
      contactKey: `telegram:${senderId}`,
      senderName: fullName(message.from, message.chat),
      text: text || "[The contact sent a non-text message. Ask what they need; do not infer unseen attachment content.]",
      timestamp: new Date((message.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      businessConnectionId: message.business_connection_id || state.telegram.businessConnectionId || undefined,
    };
    await this.handler.handle(inbound);
  }


  private async processOwnerBotMessage(message: TelegramMessage): Promise<void> {
    if (message.chat.type !== "private" || message.from?.is_bot) return;
    const text = (message.text || message.caption || "").trim();
    const chatId = String(message.chat.id);
    const isConfiguredOwnerChat = Boolean(env.telegramOwnerChatId) && chatId === env.telegramOwnerChatId;
    const isStartCommand = /^\/start(?:@\w+)?(?:\s|$)/i.test(text);

    // The configured owner control chat is reserved for commands; don't have
    // the assistant talk over its owner in this channel.
    if (isConfiguredOwnerChat) {
      if (!text.startsWith("/")) {
        console.log(`[Telegram] Ordinary message in owner control chat ignored; this chat is reserved for commands and reports. chat_id=${chatId}. Message content is not printed.`);
        this.store.addEvent({ kind: "message_skipped", platform: "telegram", details: `Ordinary message in owner control chat ignored; chat_id=${chatId}.` });
        return;
      }
      try {
        const response = await this.handler.handleOwnerCommand(text);
        await this.sendOwnerMessage(response);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[Telegram] Owner command failed: ${detail}`);
        await this.sendOwnerMessage(`Command failed safely: ${detail.slice(0, 250)}`).catch(() => undefined);
      }
      return;
    }

    // On first setup, /start is used to learn the owner's control-chat ID.
    // Until it is configured, don't accidentally treat that setup step as a contact.
    if (!env.telegramOwnerChatId && isStartCommand) {
      console.log(`[Telegram] To enable owner reports/commands, add TELEGRAM_OWNER_CHAT_ID=${chatId} to .env and restart. No message content was logged.`);
      this.store.addEvent({ kind: "connector", platform: "telegram", details: `Received /start in a private bot chat. To enable owner control, configure TELEGRAM_OWNER_CHAT_ID=${chatId} in .env and restart.` });
      return;
    }

    if (!text) {
      this.store.addEvent({ kind: "message_skipped", platform: "telegram", details: `Received a non-text message in a regular bot chat (chat_id=${chatId}); multimedia is not interpreted yet.` });
      console.log(`[Telegram] Non-text message in regular bot chat; multimedia handling is not implemented. chat_id=${chatId}.`);
      return;
    }

    // Other people can use the free standalone bot as an assistant. Owner commands
    // are never run for them: slash commands from other chats are treated as message text.
    const senderId = message.from?.id ?? message.chat.id;
    const inbound: InboundMessage = {
      platform: "telegram",
      id: `bot-chat:${message.chat.id}:${message.message_id}`,
      chatId: chatId,
      contactKey: `telegram:${senderId}`,
      senderName: fullName(message.from, message.chat),
      text,
      timestamp: new Date((message.date || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    };
    console.log(`[Telegram] Incoming message for assistant from ${inbound.senderName}, chat_id=${chatId}, message_id=${message.message_id}. Message content is not printed.`);
    await this.handler.handle(inbound);
  }

  async sendOwnerMessage(text: string): Promise<void> {
    if (!env.telegramOwnerChatId) throw new Error("TELEGRAM_OWNER_CHAT_ID is not configured. Start a private chat with the bot, set the chat ID in .env, and restart.");
    await this.api("sendMessage", {
      chat_id: env.telegramOwnerChatId,
      text: text.slice(0, 3900),
      disable_web_page_preview: true,
    });
  }

  private async api<T = unknown>(method: string, body: Record<string, unknown>, timeoutMs = 35_000): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.apiBase}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      const payload = JSON.parse(text) as TelegramApiResponse<T>;
      if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram API ${method} failed with HTTP ${response.status}`);
      return payload.result;
    } finally {
      clearTimeout(timeout);
    }
  }
}
