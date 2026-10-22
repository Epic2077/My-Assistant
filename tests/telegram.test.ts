import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramConnector } from "../src/connectors/telegram.ts";
import { MessageHandler } from "../src/handler.ts";
import { Store } from "../src/store.ts";

interface TestTelegramMessage {
  message_id: number;
  date: number;
  from: { id: number; first_name: string; is_bot?: boolean };
  chat: { id: number; type: string; first_name: string };
  text: string;
}

test("regular Telegram bot DMs enter the AI pipeline without Business connection", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatekeeper-telegram-test-"));
  try {
    const store = new Store(join(directory, "state.json"), true);
    store.setMode({ enabled: true, reason: "test", availableAt: new Date(Date.now() + 10 * 60_000).toISOString(), policy: "balanced" });
    const handler = new MessageHandler(store, {}, async () => ({
      action: "answer", urgency: 0.1, confidence: 0.99,
      summary: "The contact asks a simple question.",
      reply: "I can help with that.", ownerAlert: false, resolved: true,
      nextAction: "No action needed.",
    }));
    const connector = new TelegramConnector(store, handler, () => undefined);
    handler.registerConnector("telegram", connector);
    const internal = connector as unknown as { processOwnerBotMessage(message: TestTelegramMessage): Promise<void> };
    await internal.processOwnerBotMessage({
      message_id: 42,
      date: Math.floor(Date.now() / 1000),
      from: { id: 12345, first_name: "Test Contact" },
      chat: { id: 12345, type: "private", first_name: "Test Contact" },
      text: "Can you help me find the project link?",
    });
    const state = store.read();
    assert.ok(state.events.some((event) => event.kind === "message_received" && event.contactKey === "telegram:12345"));
    assert.ok(state.events.some((event) => event.kind === "decision" && event.contactKey === "telegram:12345"));
    assert.ok(state.events.some((event) => event.kind === "message_sent" && event.dryRun === true));
    assert.equal(state.conversations["telegram:12345"]?.history.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
