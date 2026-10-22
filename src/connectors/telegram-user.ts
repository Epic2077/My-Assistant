import { existsSync, readFileSync } from "node:fs";
import { env } from "../env.ts";
import { Store } from "../store.ts";
import type { ConsentStatus, InboundMessage, TelegramChatConsent } from "../types.ts";
import type { MessageHandler, OutboundPort } from "../handler.ts";

const CONSENT_VERSION = "personal-telegram-ai-v1";
const CONSENT_VALID_DAYS = 90;
const PROMPT_COOLDOWN_DAYS = 30;
const MAX_REPLY_LENGTH = 3500;
const CONTACT_KEY_PREFIX = "telegram-user:";

interface TelegramEventLike {
  isPrivate?: boolean;
  chatId?: unknown;
  message: {
    id?: number | string;
    date?: number;
    message?: string;
    out?: boolean;
    senderId?: unknown;
    getSender?: () => Promise<unknown>;
  };
}

interface TelegramClientLike {
  connect(): Promise<void>;
  checkAuthorization(): Promise<boolean>;
  getMe(): Promise<any>;
  sendMessage(entity: unknown, options: { message: string }): Promise<unknown>;
  addEventHandler(callback: (event: TelegramEventLike) => Promise<void> | void, builder: unknown): void;
  disconnect(): Promise<void>;
}

function isoNow(): string { return new Date().toISOString(); }
function contactKey(chatId: string): string { return `${CONTACT_KEY_PREFIX}${chatId}`; }
function normalizedCommand(text: string): string { return text.trim().replace(/\s+/g, " ").toLocaleUpperCase(); }

function senderDisplayName(sender: any, fallbackId: string): string {
  const first = String(sender?.firstName ?? sender?.first_name ?? "").trim();
  const last = String(sender?.lastName ?? sender?.last_name ?? "").trim();
  const full = `${first} ${last}`.trim();
  if (full) return full.slice(0, 120);
  const username = String(sender?.username ?? "").trim();
  return username ? `@${username}` : `Telegram contact ${fallbackId}`;
}

function providerDisclosure(): string {
  try {
    const url = new URL(env.aiBaseUrl);
    return url.hostname ? `the AI service configured by Ashkan at ${url.hostname}` : "the AI service configured by Ashkan";
  } catch {
    return "the AI service configured by Ashkan";
  }
}

function createConsentRecord(input: { key: string; chatId: string; senderName: string; status?: ConsentStatus }): TelegramChatConsent {
  const timestamp = isoNow();
  return {
    contactKey: input.key,
    chatId: input.chatId,
    senderName: input.senderName.slice(0, 120),
    status: input.status || "pending",
    scope: "AI processing and assistant replies for this one-to-one Telegram chat only; no groups or other chats.",
    consentVersion: CONSENT_VERSION,
    requestedAt: null,
    grantedAt: null,
    expiresAt: null,
    updatedAt: timestamp,
    lastPromptAt: null,
    revokedAt: null,
  };
}

export function buildTelegramConsentPrompt(senderName: string): string {
  const provider = providerDisclosure();
  return [
    `Hi${senderName ? ` ${senderName}` : ""} — I'm an automated personal assistant that Ashkan uses when he's busy. This is not Ashkan typing.`,
    "",
    "Before I can use AI to handle this chat, I need your explicit permission.",
    `• If you agree, messages in this one-to-one chat and relevant recent context may be processed by ${provider}. The provider's own data-handling policies may apply.`,
    "• Relevant conversation history and limited notes may be stored locally on Ashkan's laptop so the assistant can follow up accurately.",
    "• When Busy Mode is active, the assistant may send replies from Ashkan's Telegram account and send Ashkan private summaries of unresolved or urgent matters.",
    "• This permission covers only this private chat, not group chats or any other conversation.",
    "• Until you explicitly opt in, your message content will not be sent to AI or saved as conversation history by this assistant.",
    "",
    "To consent, reply exactly: I CONSENT TO PERSONAL GATEKEEPER",
    "To decline, reply: NO AI",
    `Consent lasts ${CONSENT_VALID_DAYS} days. After that, processing pauses and local chat data is cleared until you consent again. You can withdraw at any time by replying: STOP AI. Withdrawal stops future AI processing and deletes locally saved conversation history, memory, and issue records for this chat. Data already sent to an AI provider cannot be recalled.`,
  ].join("\n").slice(0, MAX_REPLY_LENGTH);
}

export class TelegramUserConnector implements OutboundPort {
  private readonly store: Store;
  private readonly handler: MessageHandler;
  private readonly onStatus: (status: string) => void;
  private client: TelegramClientLike | null = null;
  private stopped = false;
  private readonly automatedOutgoing = new Map<string, number>();
  private readonly recipientEntities = new Map<string, unknown>();

  constructor(store: Store, handler: MessageHandler, onStatus: (status: string) => void) {
    this.store = store;
    this.handler = handler;
    this.onStatus = onStatus;
  }

  async start(): Promise<void> {
    if (!env.telegramUserEnabled) throw new Error("TELEGRAM_USER_ENABLED is false.");
    if (!env.telegramApiId || !env.telegramApiHash) throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH from https://my.telegram.org/apps.");
    if (!existsSync(env.telegramUserSessionPath)) throw new Error("No personal Telegram session found. Run `npm run telegram:user-login` first.");
    if (!env.telegramUserConsentMessagesEnabled) {
      throw new Error("The personal-account connector requires TELEGRAM_USER_CONSENT_MESSAGES_ENABLED=true so it can request explicit per-chat consent. Only fixed consent notices are allowed by this setting; AI replies still obey DRY_RUN.");
    }

    this.stopped = false;
    this.onStatus("loading personal-account session");
    this.store.saveTelegramUser({ connectionStatus: "connecting" });

    // Resolve the dependency dynamically so the rest of the app and tests can run before
    // teleproto is installed. `teleproto` is the maintained successor to the archived GramJS package.
    const clientPackageName: string = "teleproto";
    const sessionPackageName: string = "teleproto/sessions";
    const eventsPackageName: string = "teleproto/events";
    const lib = await import(clientPackageName) as any;
    const sessions = await import(sessionPackageName) as any;
    const events = await import(eventsPackageName) as any;
    const sessionText = readFileSync(env.telegramUserSessionPath, "utf8").trim();
    const client = new lib.TelegramClient(new sessions.StringSession(sessionText), env.telegramApiId, env.telegramApiHash, { connectionRetries: 5 }) as TelegramClientLike;
    await client.connect();
    if (!(await client.checkAuthorization())) {
      await client.disconnect().catch(() => undefined);
      throw new Error("Saved personal Telegram session is not authorized. Run `npm run telegram:user-login` again.");
    }

    const me = await client.getMe();
    this.client = client;
    this.store.saveTelegramUser({ connectionStatus: "connected · consent-gated personal inbox", accountId: String(me?.id ?? "unknown") });
    this.onStatus("connected · consent-gated personal inbox");
    console.log(`[Telegram User] Connected as personal account ID ${String(me?.id ?? "unknown")}. Only private one-to-one messages are eligible; unconsented content is never sent to AI.`);
    console.log(`[Telegram User] Consent notices: enabled. AI message replies: ${this.store.read().dryRun ? "dry-run (suppressed)" : "live sending enabled"}.`);

    client.addEventHandler(async (event: TelegramEventLike) => {
      try { await this.processIncomingEvent(event); }
      catch (error) { this.logError("incoming update", error); }
    }, new events.NewMessage({ incoming: true }));
    client.addEventHandler(async (event: TelegramEventLike) => {
      try { await this.processOutgoingEvent(event); }
      catch (error) { this.logError("outgoing update", error); }
    }, new events.NewMessage({ outgoing: true }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.onStatus("stopped");
    this.store.saveTelegramUser({ connectionStatus: "stopped" });
    if (this.client) await this.client.disconnect().catch(() => undefined);
    this.client = null;
    this.recipientEntities.clear();
    this.automatedOutgoing.clear();
  }

  async send(message: InboundMessage, text: string): Promise<void> {
    if (!this.client || this.stopped) throw new Error("Personal Telegram client is not connected.");
    const consent = this.store.getTelegramConsent(message.contactKey);
    if (!consent || consent.status !== "granted" || consent.consentVersion !== CONSENT_VERSION || !consent.grantedAt || !consent.expiresAt || Date.parse(consent.expiresAt) <= Date.now()) {
      throw new Error("Blocked outgoing AI reply because active, current-version per-chat AI consent is missing or expired.");
    }
    await this.sendFixedOrAssistantMessage(message.chatId, text.slice(0, MAX_REPLY_LENGTH));
  }

  private async sendFixedOrAssistantMessage(chatId: string, text: string): Promise<void> {
    if (!this.client) throw new Error("Personal Telegram client is not connected.");
    const signature = this.outgoingKey(chatId, text);
    this.automatedOutgoing.set(signature, Date.now() + 30_000);
    try {
      const recipient = this.recipientEntities.get(chatId);
      // MTProto needs entity/access-hash context. Fail closed instead of guessing from a
      // bare numeric chat ID if the current incoming update did not resolve its sender.
      if (!recipient) throw new Error("Telegram recipient entity is unavailable; no message was sent. Wait for a fresh private-message update and retry.");
      await this.client.sendMessage(recipient, { message: text.slice(0, MAX_REPLY_LENGTH) });
      console.log(`[Telegram User] Sent an assistant/control message to chat ${chatId}; content omitted from logs.`);
    } catch (error) {
      this.automatedOutgoing.delete(signature);
      throw error;
    }
  }

  private outgoingKey(chatId: string, text: string): string { return `${chatId}\n${text.trim()}`; }

  private async processIncomingEvent(event: TelegramEventLike): Promise<void> {
    if (this.stopped || event.message.out) return;
    if (event.isPrivate !== true) {
      console.log("[Telegram User] Ignored incoming group/channel update; this connector only handles one-to-one private chats.");
      return;
    }
    const message = event.message;
    const chatId = String(event.chatId ?? message.senderId ?? "");
    if (!chatId || !/^\d+$/.test(chatId)) {
      console.warn("[Telegram User] Ignored private update with an invalid chat identifier.");
      return;
    }
    const senderId = String(message.senderId ?? chatId);
    if (senderId === this.store.read().telegramUser.accountId) return;
    const sender = message.getSender ? await message.getSender().catch(() => null) : null;
    if ((sender as any)?.bot === true || (sender as any)?.isBot === true) return;
    if (sender) this.recipientEntities.set(chatId, sender);
    const senderName = senderDisplayName(sender, senderId);
    const text = String(message.message ?? "").trim();
    const key = contactKey(chatId);
    const messageId = String(message.id ?? `${chatId}:${message.date ?? Date.now()}`);

    // Expire old permissions before checking for renewal commands. This prevents an old
    // consent phrase from silently renewing a 90-day consent without a fresh disclosure.
    const priorConsent = this.store.getTelegramConsent(key);
    if (priorConsent?.status === "granted" && (priorConsent.consentVersion !== CONSENT_VERSION || !priorConsent.expiresAt || Date.parse(priorConsent.expiresAt) <= Date.now())) {
      this.store.clearContactData(key);
      const expired: TelegramChatConsent = {
        ...priorConsent, status: "pending", grantedAt: null, expiresAt: null, requestedAt: null,
        revokedAt: null, lastPromptAt: null, updatedAt: isoNow(), senderName,
      };
      this.store.saveTelegramConsent(expired);
      this.store.addEvent({ kind: "connector", platform: "telegram_user", senderName, contactKey: key, details: "AI consent expired after 90 days; local conversation data cleared and processing paused pending renewed consent." });
    }

    const command = normalizedCommand(text);
    // Consent/revocation phrases are parsed locally. They are never sent to the AI pipeline.
    if (command === "I CONSENT TO PERSONAL GATEKEEPER") {
      await this.grantConsent(key, chatId, senderName, messageId);
      return;
    }
    if (command === "NO AI") {
      await this.declineOrRevoke(key, chatId, senderName, false);
      return;
    }
    if (command === "STOP AI" || command === "REVOKE AI CONSENT") {
      await this.declineOrRevoke(key, chatId, senderName, true);
      return;
    }

    const consent = this.store.getTelegramConsent(key);
    if (!consent || consent.status === "pending") {
      // This assistant is a busy-mode gatekeeper, not an always-on inbox auto-responder.
      // Defer consent notices until Busy Mode is active to avoid unsolicited prompts during free time.
      if (!this.store.read().mode.enabled) return;
      await this.ensureConsentPrompt(key, chatId, senderName);
      return;
    }
    if (consent.status === "declined" || consent.status === "revoked") {
      // Deliberately do not store message text, add content-bearing logs, or call AI.
      return;
    }

    const inbound: InboundMessage = {
      platform: "telegram_user",
      id: `personal:${chatId}:${messageId}`,
      chatId,
      contactKey: key,
      senderName,
      text: text || "[The contact sent a non-text message. Ask what they need; do not infer unseen attachment content.]",
      timestamp: new Date((Number(message.date) || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    };
    console.log(`[Telegram User] Consent-granted message received from ${senderName}; chat_id=${chatId}, message_id=${messageId}. Message content is not printed.`);
    this.store.addEvent({ kind: "message_received", platform: "telegram_user", senderName, contactKey: key, details: "Incoming personal Telegram message received in a consented private chat; content is stored according to the active consent." });
    await this.handler.handle(inbound);
  }

  private async ensureConsentPrompt(key: string, chatId: string, senderName: string): Promise<void> {
    if (!this.store.read().mode.enabled) return;
    const current = this.store.getTelegramConsent(key) || createConsentRecord({ key, chatId, senderName });
    if (!current.requestedAt) current.requestedAt = isoNow();
    current.senderName = senderName;
    current.updatedAt = isoNow();
    const cooldown = PROMPT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    if (current.lastPromptAt && Date.now() - Date.parse(current.lastPromptAt) < cooldown) {
      this.store.saveTelegramConsent(current);
      return;
    }
    if (current.status === "declined" || current.status === "revoked") return;
    if (!this.store.read().telegramUser.consents[key]) this.store.saveTelegramConsent(current);
    if (!env.telegramUserConsentMessagesEnabled || !this.client) {
      console.warn(`[Telegram User] Consent is pending for chat ${chatId}; automatic disclosure prompt is disabled. No AI processing occurred.`);
      return;
    }
    await this.sendFixedOrAssistantMessage(chatId, buildTelegramConsentPrompt(senderName));
    current.lastPromptAt = isoNow();
    current.requestedAt ||= current.lastPromptAt;
    current.updatedAt = isoNow();
    this.store.saveTelegramConsent(current);
    this.store.addEvent({ kind: "connector", platform: "telegram_user", senderName, contactKey: key, details: "Sent fixed AI-consent disclosure to a private chat. Message contents remain excluded until affirmative consent is recorded." });
  }

  private async grantConsent(key: string, chatId: string, senderName: string, sourceMessageId: string): Promise<void> {
    const existing = this.store.getTelegramConsent(key);
    // Require a recent disclosure in this exact chat. A declined/revoked contact must
    // receive a fresh disclosure before opting back in; old consent text is not reusable.
    const promptAge = existing?.lastPromptAt ? Date.now() - Date.parse(existing.lastPromptAt) : Number.POSITIVE_INFINITY;
    const disclosureIsRecent = Number.isFinite(promptAge) && promptAge >= 0 && promptAge <= PROMPT_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    const previouslyDeclined = existing?.status === "declined" || existing?.status === "revoked";
    if (!existing?.lastPromptAt || !disclosureIsRecent || previouslyDeclined) {
      const pending = existing || createConsentRecord({ key, chatId, senderName });
      pending.status = "pending";
      pending.senderName = senderName;
      pending.chatId = chatId;
      pending.lastPromptAt = null;
      pending.requestedAt = null;
      pending.updatedAt = isoNow();
      this.store.saveTelegramConsent(pending);
      if (this.store.read().mode.enabled) await this.ensureConsentPrompt(key, chatId, senderName);
      this.store.addEvent({ kind: "connector", platform: "telegram_user", senderName, contactKey: key, details: "A consent phrase was received without a recent disclosure in this chat; consent was not granted." });
      return;
    }
    const now = Date.now();
    const grantedAt = new Date(now).toISOString();
    const consent: TelegramChatConsent = {
      ...existing,
      contactKey: key,
      chatId,
      senderName,
      status: "granted",
      scope: "AI processing and assistant replies for this one-to-one Telegram chat only; no groups or other chats.",
      consentVersion: CONSENT_VERSION,
      requestedAt: existing.requestedAt || grantedAt,
      grantedAt,
      expiresAt: new Date(now + CONSENT_VALID_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: grantedAt,
      lastPromptAt: existing.lastPromptAt,
      revokedAt: null,
    };
    this.store.saveTelegramConsent(consent);
    this.store.addEvent({ kind: "connector", platform: "telegram_user", senderName, contactKey: key, details: `Explicit AI-processing consent granted for this private chat; consent expires in ${CONSENT_VALID_DAYS} days. Consent command message ${sourceMessageId} was not sent to AI.` });
    if (env.telegramUserConsentMessagesEnabled && this.client) {
      await this.sendFixedOrAssistantMessage(chatId, "Thank you. Your consent is recorded for this private chat for 90 days. The assistant may now use AI for messages in this chat while Ashkan has enabled Busy Mode. Reply STOP AI at any time to withdraw consent and delete the locally saved chat history, memory, and issue records.");
    }
    console.log(`[Telegram User] Explicit AI consent granted by ${senderName}; scoped to one private chat and expires in ${CONSENT_VALID_DAYS} days. The consent command itself was not sent to AI.`);
  }

  private async declineOrRevoke(key: string, chatId: string, senderName: string, isRevocation: boolean): Promise<void> {
    const existing = this.store.getTelegramConsent(key) || createConsentRecord({ key, chatId, senderName });
    const wasGranted = existing.status === "granted";
    const status: ConsentStatus = wasGranted || isRevocation ? "revoked" : "declined";
    const timestamp = isoNow();
    const record: TelegramChatConsent = {
      ...existing, contactKey: key, chatId, senderName, status,
      grantedAt: null, expiresAt: null, updatedAt: timestamp,
      revokedAt: status === "revoked" ? timestamp : existing.revokedAt,
    };
    // Wipe all locally retained content associated with this chat once permission is declined/revoked.
    this.store.clearContactData(key);
    this.store.saveTelegramConsent(record);
    this.store.addEvent({ kind: "connector", platform: "telegram_user", senderName, contactKey: key, details: status === "revoked" ? "AI consent revoked; local conversation history, memory, and issue/report content deleted for this chat." : "AI processing declined for this private chat; message content was not sent to AI." });
    if (env.telegramUserConsentMessagesEnabled && this.client) {
      const reply = status === "revoked"
        ? "Understood. AI processing is stopped for this chat, and the locally saved conversation history, memory, and issue/report records for this chat have been deleted. This won't retract data already sent to an AI provider."
        : "Understood. I won't send messages from this chat to AI or automatically reply using AI. If you change your mind, you can reply I CONSENT TO PERSONAL GATEKEEPER.";
      await this.sendFixedOrAssistantMessage(chatId, reply);
    }
    console.log(`[Telegram User] AI consent ${status} for chat ${chatId}; message content was not sent to AI.`);
  }

  private async processOutgoingEvent(event: TelegramEventLike): Promise<void> {
    if (this.stopped || !event.message.out || event.isPrivate !== true) return;
    const chatId = String(event.chatId ?? "");
    if (!chatId || !/^\d+$/.test(chatId)) return;
    // Ignore Saved Messages / self-chat; owner notes are not a conversation to auto-handle.
    if (chatId === this.store.read().telegramUser.accountId) return;
    const text = String(event.message.message ?? "").trim();
    const signature = this.outgoingKey(chatId, text);
    const expiresAt = this.automatedOutgoing.get(signature);
    for (const [key, expiry] of this.automatedOutgoing) if (expiry < Date.now()) this.automatedOutgoing.delete(key);
    if (expiresAt && expiresAt >= Date.now()) {
      this.automatedOutgoing.delete(signature);
      return;
    }
    const key = contactKey(chatId);
    const consent = this.store.getTelegramConsent(key);
    if (!consent || consent.status !== "granted" || consent.consentVersion !== CONSENT_VERSION || !consent.expiresAt || Date.parse(consent.expiresAt) <= Date.now()) {
      // Do not retain owner messages in chats that have not consented to AI processing.
      this.store.addEvent({ kind: "owner_message_observed", platform: "telegram_user", contactKey: key, details: "Manual owner reply detected, but not stored because active AI consent is missing." });
      return;
    }
    this.handler.observeOwnerMessage("telegram_user", key, text || "[Owner sent a non-text message]", new Date((Number(event.message.date) || Math.floor(Date.now() / 1000)) * 1000).toISOString(), String(event.message.id ?? ""));
  }

  private logError(area: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[Telegram User] ${area} failed: ${detail}`);
    this.store.addEvent({ kind: "error", platform: "telegram_user", details: `Personal Telegram ${area} failed: ${detail.slice(0, 300)}` });
  }
}
