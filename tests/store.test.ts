import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { ConversationState } from "../src/types.ts";

function withStore(run: (store: Store, directory: string) => void | Promise<void>) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "gatekeeper-test-"));
    try {
      const store = new Store(join(directory, "state.json"), true);
      await run(store, directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("contact memory merges facts without duplicating them and survives restart", withStore((store, directory) => {
  store.mergeContactMemory("telegram:123", { summary: "Likes concise replies.", facts: ["Prefers English", "Works in frontend"], sourceMessageId: "m1" });
  store.mergeContactMemory("telegram:123", { facts: ["prefers english", "Likes examples"], sourceMessageId: "m2" });
  const restarted = new Store(join(directory, "state.json"), true);
  const memory = restarted.read().contactMemories["telegram:123"]!;
  assert.equal(memory.summary, "Likes concise replies.");
  assert.equal(memory.facts.length, 3);
  assert.ok(memory.facts.includes("Prefers English"));
  assert.ok(memory.facts.includes("Likes examples"));
}));

test("open issue is updated rather than duplicated, and resolve closes it", withStore((store) => {
  const first = store.upsertIssue({ contactKey: "telegram:123", platform: "telegram", senderName: "Reza", profileName: "Close friend", summary: "Needs help with a deadline", priority: "high", lastAction: "handoff", nextAction: "Call back" });
  const second = store.upsertIssue({ contactKey: "telegram:123", platform: "telegram", senderName: "Reza", profileName: "Close friend", summary: "Deadline is in 15 minutes", priority: "urgent", lastAction: "urgent", nextAction: "Call immediately" });
  assert.equal(first.isNew, true);
  assert.equal(second.isNew, false);
  assert.equal(store.read().issues.filter((issue) => issue.status === "open").length, 1);
  assert.equal(second.issue.priority, "urgent");
  assert.equal(store.resolveIssue(first.issue.id, "Called and resolved"), true);
  assert.equal(store.read().issues[0]!.status, "resolved");
}));

test("old state files receive the new fields without losing existing data", withStore((store, directory) => {
  store.setDryRun(true);
  store.addEvent({ kind: "connector", details: "kept event" });
  const file = join(directory, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  delete state.contactMemories;
  delete state.issues;
  delete state.ownerReports;
  writeFileSync(file, JSON.stringify(state));
  const migrated = new Store(file, false).read();
  assert.deepEqual(migrated.contactMemories, {});
  assert.deepEqual(migrated.issues, []);
  assert.deepEqual(migrated.ownerReports, []);
  assert.equal(migrated.dryRun, true);
  assert.equal(migrated.events[0]!.details, "kept event");
}));

test("takeover state is persisted for a conversation", withStore((store) => {
  const conversation: ConversationState = {
    contactKey: "telegram:99", platform: "telegram", senderName: "Test", profileId: "default", history: [],
    busySessionId: "s1", autoRepliesThisSession: 1, autoPaused: false, lastMessageAt: new Date().toISOString(),
  };
  store.saveConversation(conversation);
  assert.equal(store.setConversationPaused("telegram:99", true), true);
  assert.equal(store.read().conversations["telegram:99"]!.autoPaused, true);
  assert.equal(store.setConversationPaused("telegram:99", false), true);
  assert.equal(store.read().conversations["telegram:99"]!.autoPaused, false);
}));
