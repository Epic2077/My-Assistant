import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { MessageHandler } from "../src/handler.ts";
import { TelegramUserConnector } from "../src/connectors/telegram-user.ts";
import { env } from "../src/env.ts";
import type { ConversationState, TelegramChatConsent } from "../src/types.ts";

function withStore(run: (store: Store) => Promise<void> | void) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "gatekeeper-telegram-user-test-"));
    try { await run(new Store(join(directory, "state.json"), true)); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  };
}

function incoming(chatId: number, messageId: number, text: string) {
  return {
    isPrivate: true,
    chatId,
    message: {
      id: messageId,
      date: Math.floor(Date.now() / 1000),
      message: text,
      out: false,
      senderId: chatId,
      getSender: async () => ({ id: chatId, firstName: "Test Contact", username: "test_contact", bot: false }),
    },
  };
}

test("unconsented personal Telegram messages are not stored or sent to the AI", withStore(async (store) => {
  store.setMode({ enabled: true, reason: "test work", availableAt: new Date(Date.now() + 20 * 60_000).toISOString(), policy: "balanced" });
  let aiCalls = 0;
  const handler = new MessageHandler(store, {}, async () => {
    aiCalls += 1;
    throw new Error("AI must not be called before consent");
  });
  const connector = new TelegramUserConnector(store, handler, () => undefined);
  const internal = connector as unknown as { processIncomingEvent(event: ReturnType<typeof incoming>): Promise<void> };
  await internal.processIncomingEvent(incoming(2222, 1, "private message content that must not be retained"));

  const state = store.read();
  assert.equal(aiCalls, 0);
  assert.equal(Object.keys(state.conversations).length, 0);
  assert.equal(Object.keys(state.contactMemories).length, 0);
  assert.equal(state.telegramUser.consents["telegram-user:2222"]?.status, "pending");
  assert.ok(!JSON.stringify(state.events).includes("private message content that must not be retained"));
}));

test("a consent phrase sent without a prior disclosure does not grant permission", withStore(async (store) => {
  const handler = new MessageHandler(store, {}, async () => { throw new Error("AI must not be called"); });
  const connector = new TelegramUserConnector(store, handler, () => undefined);
  const internal = connector as unknown as { processIncomingEvent(event: ReturnType<typeof incoming>): Promise<void> };
  await internal.processIncomingEvent(incoming(2255, 1, "I CONSENT TO PERSONAL GATEKEEPER"));
  assert.equal(store.getTelegramConsent("telegram-user:2255")?.status, "pending");
  assert.equal(store.getTelegramConsent("telegram-user:2255")?.grantedAt, null);
  assert.ok(store.read().events.some((event) => event.details.includes("consent was not granted")));
  assert.equal(Object.keys(store.read().conversations).length, 0);
}));

test("explicit per-chat consent enables later AI processing but the consent command itself is excluded", withStore(async (store) => {
  store.setMode({ enabled: true, reason: "test work", availableAt: new Date(Date.now() + 20 * 60_000).toISOString(), policy: "balanced" });
  let aiCalls = 0;
  const handler = new MessageHandler(store, { telegram_user: { async send() {} } }, async () => {
    aiCalls += 1;
    return { action: "answer", urgency: 0.1, confidence: 0.98, summary: "Answered a simple question.", reply: "Here you go.", ownerAlert: false, resolved: true, nextAction: "No action needed." };
  });
  const connector = new TelegramUserConnector(store, handler, () => undefined);
  const internal = connector as unknown as { processIncomingEvent(event: ReturnType<typeof incoming>): Promise<void> };
  await internal.processIncomingEvent(incoming(3333, 1, "asking for a link before consent"));
  // Simulate that the configured, fixed disclosure prompt was actually delivered to this exact chat.
  store.updateTelegramConsent("telegram-user:3333", { lastPromptAt: new Date().toISOString(), requestedAt: new Date().toISOString() });
  await internal.processIncomingEvent(incoming(3333, 2, "I CONSENT TO PERSONAL GATEKEEPER"));
  assert.equal(store.getTelegramConsent("telegram-user:3333")?.status, "granted");
  assert.equal(aiCalls, 0, "the consent command itself must never enter the AI pipeline");

  await internal.processIncomingEvent(incoming(3333, 3, "Can you send me the project link?"));
  assert.equal(aiCalls, 1);
  assert.ok(store.read().conversations["telegram-user:3333"]?.history.some((item) => item.text === "Can you send me the project link?"));
  assert.ok(!store.read().conversations["telegram-user:3333"]?.history.some((item) => item.text.includes("I CONSENT TO PERSONAL GATEKEEPER")));
  const consent = store.getTelegramConsent("telegram-user:3333")!;
  assert.ok(consent.expiresAt && Date.parse(consent.expiresAt) > Date.now());
}));

test("STOP AI revokes consent and deletes stored chat memory and issue data", withStore(async (store) => {
  const key = "telegram-user:4444";
  const timestamp = new Date().toISOString();
  const consent: TelegramChatConsent = {
    contactKey: key, chatId: "4444", senderName: "Test Contact", status: "granted",
    scope: "one private chat", consentVersion: "test-v1", requestedAt: timestamp,
    grantedAt: timestamp, expiresAt: new Date(Date.now() + 86400000).toISOString(), updatedAt: timestamp,
    lastPromptAt: timestamp, revokedAt: null,
  };
  store.saveTelegramConsent(consent);
  const conversation: ConversationState = {
    contactKey: key, platform: "telegram_user", senderName: "Test Contact", profileId: "default", history: [],
    busySessionId: "s", autoRepliesThisSession: 0, autoPaused: false, lastMessageAt: timestamp,
  };
  store.saveConversation(conversation);
  store.mergeContactMemory(key, { summary: "private summary", facts: ["private fact"] });
  store.upsertIssue({ contactKey: key, platform: "telegram_user", senderName: "Test Contact", profileName: "Everyone else", summary: "private issue", priority: "high", lastAction: "handoff", nextAction: "review" });

  const handler = new MessageHandler(store, {});
  const connector = new TelegramUserConnector(store, handler, () => undefined);
  const internal = connector as unknown as { processIncomingEvent(event: ReturnType<typeof incoming>): Promise<void> };
  await internal.processIncomingEvent(incoming(4444, 2, "STOP AI"));
  const state = store.read();
  assert.equal(state.telegramUser.consents[key]?.status, "revoked");
  assert.equal(state.conversations[key], undefined);
  assert.equal(state.contactMemories[key], undefined);
  assert.equal(state.issues.some((issue) => issue.contactKey === key), false);
  assert.ok(!JSON.stringify(state.events).includes("private issue"));
}));


test("a declined contact must receive a fresh disclosure before consenting again", withStore(async (store) => {
  const key = "telegram-user:5566";
  const timestamp = new Date().toISOString();
  const consent: TelegramChatConsent = {
    contactKey: key, chatId: "5566", senderName: "Test Contact", status: "declined",
    scope: "one private chat", consentVersion: "personal-telegram-ai-v1", requestedAt: timestamp,
    grantedAt: null, expiresAt: null, updatedAt: timestamp, lastPromptAt: timestamp, revokedAt: null,
  };
  store.saveTelegramConsent(consent);
  const handler = new MessageHandler(store, {}, async () => { throw new Error("AI must not be called"); });
  const connector = new TelegramUserConnector(store, handler, () => undefined);
  const internal = connector as unknown as { processIncomingEvent(event: ReturnType<typeof incoming>): Promise<void> };

  await internal.processIncomingEvent(incoming(5566, 8, "I CONSENT TO PERSONAL GATEKEEPER"));

  const after = store.getTelegramConsent(key)!;
  assert.equal(after.status, "pending");
  assert.equal(after.grantedAt, null);
  assert.equal(after.lastPromptAt, null, "old disclosure must not be reused after a decline");
  assert.equal(Object.keys(store.read().conversations).length, 0);
}));


test("new private chats receive a fixed disclosure before AI processing, even in dry-run", withStore(async (store) => {
  const oldConsentMessageSetting = env.telegramUserConsentMessagesEnabled;
  env.telegramUserConsentMessagesEnabled = true;
  try {
    let aiCalls = 0;
    let sentTo: unknown;
    let sentText = "";
    store.setMode({ enabled: true, reason: "test work", availableAt: new Date(Date.now() + 20 * 60_000).toISOString(), policy: "balanced" });
    const handler = new MessageHandler(store, {}, async () => {
      aiCalls += 1;
      throw new Error("AI must not be called before consent");
    });
    const connector = new TelegramUserConnector(store, handler, () => undefined);
    const senderEntity = { id: 6677, firstName: "Test Contact", bot: false };
    const internal = connector as unknown as {
      client: { sendMessage(entity: unknown, options: { message: string }): Promise<void> } | null;
      recipientEntities: Map<string, unknown>;
      processIncomingEvent(event: ReturnType<typeof incoming>): Promise<void>;
    };
    internal.client = { async sendMessage(entity, options) { sentTo = entity; sentText = options.message; } };
    internal.recipientEntities = new Map();
    const event = incoming(6677, 1, "my private message should not enter AI yet");
    event.message.getSender = async () => senderEntity;

    await internal.processIncomingEvent(event);

    assert.equal(sentTo, senderEntity, "send using sender entity returned by Telegram, not a guessed ID");
    assert.ok(sentText.includes("I CONSENT TO PERSONAL GATEKEEPER"));
    assert.ok(sentText.includes("the AI service configured by Ashkan"));
    assert.ok(!sentText.includes("my private message should not enter AI yet"));
    assert.equal(aiCalls, 0);
    assert.equal(store.getTelegramConsent("telegram-user:6677")?.status, "pending");
    assert.ok(store.getTelegramConsent("telegram-user:6677")?.lastPromptAt);
  } finally {
    env.telegramUserConsentMessagesEnabled = oldConsentMessageSetting;
  }
}));


test("does not send consent prompts or retain message content while Busy Mode is off", withStore(async (store) => {
  const oldConsentMessageSetting = env.telegramUserConsentMessagesEnabled;
  env.telegramUserConsentMessagesEnabled = true;
  try {
    let sends = 0;
    const handler = new MessageHandler(store, {}, async () => { throw new Error("AI must not be called while idle"); });
    const connector = new TelegramUserConnector(store, handler, () => undefined);
    const internal = connector as unknown as {
      client: { sendMessage(entity: unknown, options: { message: string }): Promise<void> } | null;
      recipientEntities: Map<string, unknown>;
      processIncomingEvent(event: ReturnType<typeof incoming>): Promise<void>;
    };
    internal.client = { async sendMessage() { sends += 1; } };
    internal.recipientEntities = new Map();
    await internal.processIncomingEvent(incoming(7788, 1, "should not be retained or forwarded"));
    assert.equal(sends, 0);
    assert.equal(store.getTelegramConsent("telegram-user:7788"), undefined);
    assert.equal(Object.keys(store.read().conversations).length, 0);
    assert.ok(!JSON.stringify(store.read()).includes("should not be retained or forwarded"));
  } finally {
    env.telegramUserConsentMessagesEnabled = oldConsentMessageSetting;
  }
}));
