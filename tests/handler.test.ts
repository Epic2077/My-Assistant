import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageHandler } from "../src/handler.ts";
import { Store } from "../src/store.ts";

test("owner commands show status and safe empty queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatekeeper-handler-test-"));
  try {
    const store = new Store(join(directory, "state.json"), true);
    const handler = new MessageHandler(store, {});
    const status = await handler.handleOwnerCommand("/status");
    assert.match(status, /Busy Mode: OFF/);
    assert.match(status, /Dry-run: ON/);
    assert.match(await handler.handleOwnerCommand("/queue"), /queue is clear/i);
    assert.match(await handler.handleOwnerCommand("/help"), /\/takeover/);
    assert.match(await handler.handleOwnerCommand("/help"), /\/telegram/);
    const telegramDiagnostics = await handler.handleOwnerCommand("/telegram");
    assert.match(telegramDiagnostics, /Business connection received: NO/);
    assert.match(telegramDiagnostics, /Business reply permission \(can_reply\): NO/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("incoming message uses injected decision, saves memory/issues, reports owner, and never sends in dry-run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "gatekeeper-pipeline-test-"));
  try {
    const store = new Store(join(directory, "state.json"), true);
    store.setMode({ enabled: true, reason: "deep work", availableAt: new Date(Date.now() + 45 * 60_000).toISOString(), policy: "balanced" });
    let sendsToContact = 0;
    const ownerReports: string[] = [];
    const handler = new MessageHandler(store, {
      telegram: { async send() { sendsToContact += 1; } },
      ownerNotifier: { async sendOwnerMessage(text: string) { ownerReports.push(text); } },
    }, async () => ({
      action: "clarify", urgency: 0.25, confidence: 0.92,
      summary: "Reza needs help deciding which project file to use.",
      reply: "I'm checking what you mean—can you share the filename?",
      ownerAlert: true, alertReason: "The request needs follow-up.", resolved: false,
      nextAction: "Review Reza's answer when available.",
      memoryUpdate: { summary: "Reza is asking about a project file.", facts: ["Reza is working on a project file"] },
    }));
    await handler.handle({
      platform: "telegram", id: "message-1", chatId: "123", contactKey: "telegram:123", senderName: "Reza",
      text: "Which project file should I use?", timestamp: new Date().toISOString(),
    });
    const state = store.read();
    assert.equal(sendsToContact, 0, "dry-run must suppress contact messages");
    assert.equal(ownerReports.length, 1, "new unresolved issue should report to owner");
    assert.match(ownerReports[0]!, /Reza/);
    assert.match(ownerReports[0]!, /UNRESOLVED/);
    assert.equal(state.issues.filter((issue) => issue.status === "open").length, 1);
    assert.ok(state.contactMemories["telegram:123"]!.facts.includes("Reza is working on a project file"));
    assert.ok(state.events.some((event) => event.kind === "message_sent" && event.dryRun));
    assert.match(await handler.handleOwnerCommand("/queue"), /Reza/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
