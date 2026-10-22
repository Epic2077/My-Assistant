import { randomUUID } from "node:crypto";
import { decideMessage, formatAvailableAt, safeFallbackDecision } from "./ai.ts";
import { env } from "./env.ts";
import { Store } from "./store.ts";
import type { AiDecision, BusyMode, ContactProfile, ConversationState, InboundMessage, IssuePriority, OpenIssue, Platform } from "./types.ts";

export interface OutboundPort {
  send(message: InboundMessage, text: string): Promise<void>;
}

export interface OwnerNotificationPort { sendOwnerMessage(text: string): Promise<void> }

export interface HandlerRuntime {
  telegram?: OutboundPort;
  telegram_user?: OutboundPort;
  whatsapp?: OutboundPort;
  ownerNotifier?: OwnerNotificationPort;
}

const MAX_AUTOREPLIES_PER_BUSY_SESSION = 8;
const MAX_HISTORY = 30;
const queueByContact = new Map<string, Promise<void>>();

function getProfile(profiles: ContactProfile[], contactKey: string): ContactProfile {
  const normalizedKey = contactKey.trim().toLowerCase();
  for (const profile of profiles) {
    if (profile.isDefault) continue;
    if (profile.identifiers.some((id) => id.trim().toLowerCase() === normalizedKey)) return profile;
  }
  return profiles.find((profile) => profile.isDefault) || profiles[0]!;
}

function friendlyPrefix(profile: ContactProfile): string {
  switch (profile.relationship) {
    case "family": return "Hey! ";
    case "partner": return "Hey ❤️ ";
    case "close_friend": return "Hey! ";
    default: return "Hello — ";
  }
}

export function ensureDisclosure(reply: string, profile: ContactProfile, reason: string, availableAt: string | null): string {
  const hasDisclosure = /\b(i am|i'm|this is|assistant for)\b.{0,70}\bassistant\b/i.test(reply);
  if (hasDisclosure) return reply;
  const until = formatAvailableAt(availableAt);
  const prefix = `${friendlyPrefix(profile)}I'm ${env.ownerName}'s assistant. ${env.ownerName} is busy with ${reason} until ${until}. `;
  return `${prefix}${reply}`.slice(0, 3500);
}

function fallbackReply(message: InboundMessage, profile: ContactProfile, reason: string, availableAt: string | null): AiDecision {
  const decision = safeFallbackDecision("AI is not available, so a conservative holding message was used.");
  decision.reply = `${friendlyPrefix(profile)}I'm ${env.ownerName}'s assistant. ${env.ownerName} is busy with ${reason} until ${formatAvailableAt(availableAt)}. Tell me what you need and I'll see whether I can help. If something serious or time-sensitive has happened, please call ${env.ownerName} directly.`;
  // Do not flood the owner with repeat alerts for every failed fallback; the first such event is still recorded.
  return decision;
}

function formatIdentity(message: InboundMessage): string {
  return message.contactKey;
}

function makeConversation(message: InboundMessage, profileId: string, previous?: ConversationState): ConversationState {
  return previous || {
    contactKey: message.contactKey,
    platform: message.platform,
    senderName: message.senderName || "Unknown sender",
    profileId,
    history: [],
    busySessionId: "",
    autoRepliesThisSession: 0,
    autoPaused: false,
    lastMessageAt: message.timestamp,
  };
}

export class MessageHandler {
  private readonly store: Store;
  private readonly runtime: HandlerRuntime;
  private readonly decisionEngine: typeof decideMessage;

  constructor(store: Store, runtime: HandlerRuntime, decisionEngine: typeof decideMessage = decideMessage) {
    this.store = store;
    this.runtime = runtime;
    this.decisionEngine = decisionEngine;
  }

  registerConnector(platform: Platform, port: OutboundPort): void {
    this.runtime[platform] = port;
  }

  registerOwnerNotifier(port: OwnerNotificationPort): void {
    this.runtime.ownerNotifier = port;
  }

  async handleOwnerCommand(text: string): Promise<string> {
    const [rawCommand = "", ...args] = text.trim().split(/\s+/);
    const command = rawCommand.toLowerCase().split("@")[0];
    const state = this.store.read();
    const open = state.issues.filter((issue) => issue.status === "open");
    const sorted = [...open].sort((a, b) => {
      const rank: Record<IssuePriority, number> = { urgent: 0, high: 1, normal: 2 };
      return rank[a.priority] - rank[b.priority] || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
    });
    const issueText = (issue: OpenIssue) => `• ${issue.priority.toUpperCase()} · ${issue.senderName} (${issue.platform})\n  ${issue.summary.slice(0, 180)}\n  Next: ${issue.nextAction.slice(0, 180)}\n  ID: ${issue.id}\n  Contact: ${issue.contactKey}`;
    switch (command) {
      case "/start": return `Personal Gatekeeper owner channel is ready. Use /help for commands.\nBusy Mode: ${state.mode.enabled ? "ON" : "OFF"}; dry-run: ${state.dryRun ? "ON" : "OFF"}.`;
      case "/help": return ["Personal Gatekeeper commands", "/queue — all open issues in priority order", "/urgent — urgent issues", "/unresolved — all unresolved issues", "/takeover <issue-id-or-contact-key> — pause AI replies", "/resume <issue-id-or-contact-key> — resume AI handling", "/resolve <issue-id> [resolution] — close an issue", "/status — Busy Mode and queue status", "/telegram — diagnose Bot API/Business connection", "/consents — show personal Telegram AI-consent states"].join("\n");
      case "/status": return `Busy Mode: ${state.mode.enabled ? "ON" : "OFF"}\nReason: ${state.mode.reason}\nAvailable at: ${state.mode.availableAt ? new Date(state.mode.availableAt).toLocaleString() : "not set"}\nDry-run: ${state.dryRun ? "ON (outgoing replies suppressed)" : "OFF (live sending)"}\nOpen issues: ${open.length}\nUrgent issues: ${open.filter((issue) => issue.priority === "urgent").length}`;
      case "/consents": {
        const consents = Object.values(state.telegramUser.consents || {});
        if (!consents.length) return "No personal Telegram chat consent records yet.";
        return `Personal Telegram AI consent (${consents.length} chat(s))\n\n${consents.slice(0, 30).map((entry) => `• ${entry.senderName} — ${entry.status.toUpperCase()}\n  Chat: ${entry.chatId}\n  ${entry.status === "granted" ? `Expires: ${entry.expiresAt ? new Date(entry.expiresAt).toLocaleString() : "not set"}` : `Updated: ${new Date(entry.updatedAt).toLocaleString()}`}`).join("\n\n")}`;
      }
      case "/telegram": return [
        "Telegram Bot API / Business diagnostics",
        `Bot API status: ${state.telegram.connectionStatus || "unknown"}`,
        `Business connection received: ${state.telegram.businessConnectionId ? "YES" : "NO"}`,
        `Business reply permission (can_reply): ${state.telegram.canReply ? "YES" : "NO"}`,
        `Connected Telegram account ID: ${state.telegram.businessUserId ?? "not detected"}`,
        `Last polling offset: ${state.telegram.offset}`,
        "Note: /start and other owner commands prove the bot can receive bot-chat messages; they do not prove your personal inbox is connected.",
      ].join("\n");
      case "/queue":
      case "/unresolved":
      case "/urgent": {
        const selected = command === "/urgent" ? sorted.filter((issue) => issue.priority === "urgent") : sorted;
        if (!selected.length) return command === "/urgent" ? "No urgent open issues." : "Your queue is clear. No unresolved issues.";
        return `Gatekeeper queue (${selected.length})\n\n${selected.slice(0, 12).map(issueText).join("\n\n")}${selected.length > 12 ? `\n\n…and ${selected.length - 12} more.` : ""}`;
      }
      case "/takeover":
      case "/resume": {
        const target = args[0];
        if (!target) return `Usage: ${command} <issue-id-or-contact-key>`;
        const issue = state.issues.find((candidate) => candidate.id === target || candidate.contactKey === target);
        const contactKey = issue?.contactKey || target;
        const changed = this.store.setConversationPaused(contactKey, command === "/takeover");
        return changed ? (command === "/takeover" ? `AI replies paused for ${contactKey}.` : `AI replies resumed for ${contactKey}; Busy Mode still determines whether the assistant replies.`) : `No saved conversation found for ${target}. Use /queue to find an issue ID or contact key.`;
      }
      case "/resolve": {
        const issueId = args[0];
        if (!issueId) return "Usage: /resolve <issue-id> [resolution]";
        const ok = this.store.resolveIssue(issueId, args.slice(1).join(" ") || "Reviewed and resolved by owner.");
        return ok ? `Issue ${issueId} marked resolved.` : `No open issue found with ID ${issueId}.`;
      }
      default: return "Unknown command. Send /help to see available commands.";
    }
  }

  async notifyBusyModeEnded(previousMode: BusyMode): Promise<void> {
    const open = this.store.read().issues.filter((issue) => issue.status === "open").sort((a, b) => {
      const rank: Record<IssuePriority, number> = { urgent: 0, high: 1, normal: 2 };
      return rank[a.priority] - rank[b.priority] || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
    });
    const headline = `Busy Mode ended${previousMode.reason ? ` (${previousMode.reason})` : ""}. Automatic busy-mode replies are now off.`;
    const queue = open.length ? `\n\nUnresolved queue (${open.length}):\n${open.slice(0, 12).map((issue) => `• [${issue.priority.toUpperCase()}] ${issue.senderName}: ${issue.summary.slice(0, 130)}\n  Next: ${issue.nextAction.slice(0, 120)}\n  ID: ${issue.id}`).join("\n")}${open.length > 12 ? `\n…and ${open.length - 12} more.` : ""}` : "\n\nNo unresolved issues are currently tracked.";
    await this.deliverOwnerReport(`${headline}${queue}`, "busy_mode_ended", `${headline} ${open.length} unresolved issue(s).`);
  }

  async handle(message: InboundMessage): Promise<void> {
    const prior = queueByContact.get(message.contactKey) || Promise.resolve();
    const current = prior.catch(() => undefined).then(() => this.process(message));
    queueByContact.set(message.contactKey, current);
    try { await current; }
    finally { if (queueByContact.get(message.contactKey) === current) queueByContact.delete(message.contactKey); }
  }

  observeOwnerMessage(platform: Platform, contactKey: string, text: string, timestamp = new Date().toISOString(), messageId?: string): void {
    const state = this.store.read();
    const profile = getProfile(state.profiles, contactKey);
    const conversation = state.conversations[contactKey] || {
      contactKey,
      platform,
      senderName: profile.name,
      profileId: profile.id,
      history: [],
      busySessionId: state.mode.sessionId,
      autoRepliesThisSession: 0,
      autoPaused: false,
      lastMessageAt: timestamp,
    };
    conversation.history.push({ role: "owner", text: text || "[Owner sent a non-text message]", at: timestamp, platform, messageId });
    conversation.history = conversation.history.slice(-MAX_HISTORY);
    conversation.lastMessageAt = timestamp;
    conversation.platform = platform;
    if (state.mode.enabled) {
      conversation.busySessionId = state.mode.sessionId;
      conversation.autoPaused = true;
    }
    this.store.saveConversation(conversation);
    this.store.addEvent({
      kind: "owner_message_observed",
      platform,
      senderName: conversation.senderName,
      contactKey,
      profileName: profile.name,
      details: state.mode.enabled ? "You replied manually; automatic replies are now paused for this conversation until the next Busy Mode session." : "Your outgoing message was added to conversation context.",
    });
  }

  private async process(message: InboundMessage): Promise<void> {
    const processedKey = `${message.platform}:${message.id}`;
    if (this.store.isProcessed(processedKey)) return;

    let state = this.store.read();
    if (state.mode.enabled && state.mode.availableAt && Date.now() >= new Date(state.mode.availableAt).getTime()) {
      this.store.setMode({ enabled: false, reason: state.mode.reason, availableAt: state.mode.availableAt, policy: state.mode.policy });
      state = this.store.read();
    }

    if (!state.mode.enabled) {
      this.store.addEvent({ kind: "message_skipped", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, details: "Received while Busy Mode is off; no auto-reply sent." });
      this.store.markProcessed(processedKey);
      return;
    }

    const profile = getProfile(state.profiles, message.contactKey);
    let conversation = makeConversation(message, profile.id, state.conversations[message.contactKey]);
    const isFirstInSession = conversation.busySessionId !== state.mode.sessionId;
    if (isFirstInSession) {
      conversation.busySessionId = state.mode.sessionId;
      conversation.autoRepliesThisSession = 0;
      conversation.autoPaused = false;
    }
    conversation.profileId = profile.id;
    conversation.senderName = message.senderName || conversation.senderName || "Unknown sender";
    conversation.platform = message.platform;
    conversation.history.push({ role: "contact", text: message.text || "[Message without text content]", at: message.timestamp, platform: message.platform, messageId: message.id });
    conversation.history = conversation.history.slice(-MAX_HISTORY);
    conversation.lastMessageAt = message.timestamp;
    this.store.saveConversation(conversation);
    this.store.addEvent({ kind: "message_received", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, profileName: profile.name, details: (message.text || "[non-text message]").slice(0, 500) });

    if (conversation.autoPaused) {
      const existing = this.store.read().issues.find((issue) => issue.contactKey === message.contactKey && issue.status === "open");
      const { issue } = this.store.upsertIssue({ contactKey: message.contactKey, platform: message.platform, senderName: message.senderName || profile.name, profileName: profile.name, summary: "A new message arrived while this conversation is paused for owner takeover.", priority: "high", lastAction: "handoff", nextAction: "Review the latest message and reply manually." });
      this.createAlert("uncertain", `New message from ${message.senderName || profile.name}`, "Automatic replies for this conversation are paused. Please review it manually.", message);
      if (!existing || !existing.lastNotifiedAt) await this.notifyIssueOwner(issue, "The owner has taken over this conversation. A new message arrived while automatic replies were paused.");
      this.store.addEvent({ kind: "message_skipped", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, profileName: profile.name, details: "Auto-replies paused for this conversation." });
      this.store.markProcessed(processedKey);
      return;
    }

    let decision: AiDecision;
    if (profile.priority === "interrupt") {
      decision = {
        action: "urgent", urgency: 1, confidence: 1,
        summary: "The contact profile is configured to interrupt Busy Mode.",
        reply: `This is ${profile.name}'s priority route. Please call ${env.ownerName} directly now so they see your message immediately.`,
        ownerAlert: true, alertReason: `The sender ${profile.name} is configured to interrupt Busy Mode.`,
        resolved: false, nextAction: `Contact ${profile.name} as soon as possible.`,
      };
    } else {
      try {
        decision = await this.decisionEngine({ state, profile, conversation, message, isFirstInSession });
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        console.error(`[AI] ${errorText}`);
        this.store.addEvent({ kind: "error", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, profileName: profile.name, details: `AI decision failed: ${errorText}` });
        decision = fallbackReply(message, profile, state.mode.reason, state.mode.availableAt);
        decision.alertReason = "AI provider failed; a conservative fallback was used.";
      }
    }

    if (decision.memoryUpdate && (decision.memoryUpdate.summary || decision.memoryUpdate.facts?.length)) {
      this.store.mergeContactMemory(message.contactKey, { summary: decision.memoryUpdate.summary, facts: decision.memoryUpdate.facts, sourceMessageId: message.id });
      this.store.addEvent({ kind: "memory", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, profileName: profile.name, details: "Updated persistent contact memory from this conversation." });
    }

    if (isFirstInSession) decision.reply = ensureDisclosure(decision.reply, profile, state.mode.reason, state.mode.availableAt);
    if (decision.action === "urgent") {
      decision.ownerAlert = true;
      const lowerReply = decision.reply.toLowerCase();
      const explicitlyCallsOwner = lowerReply.includes(`call ${env.ownerName.toLowerCase()}`) || lowerReply.includes("call him directly") || lowerReply.includes("call her directly") || lowerReply.includes("call them directly");
      if (!explicitlyCallsOwner) decision.reply = `${decision.reply}\n\nPlease call ${env.ownerName} directly now.`;
    }

    // If the model is not allowed to answer this contact, never let an "answer" decision escape.
    if (!profile.allowAutonomousAnswers && decision.action !== "urgent") {
      decision.action = "handoff";
      decision.ownerAlert = true;
      decision.resolved = false;
      decision.nextAction = "Owner must handle this conversation personally.";
      decision.alertReason = "Autonomous replies are disabled for this contact.";
      decision.reply = `I don't want to guess on ${env.ownerName}'s behalf, so I've left this for them to handle when they're available. If it's time-sensitive, please call ${env.ownerName} directly.`;
    }

    this.store.addEvent({ kind: "decision", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, profileName: profile.name, action: decision.action, details: `${decision.summary} ${decision.ownerAlert ? `Alert: ${decision.alertReason || "owner review requested"}` : ""}`.trim(), dryRun: state.dryRun });

    let issue: OpenIssue | undefined;
    let shouldNotifyIssue = false;
    if (decision.resolved) {
      const resolvedCount = this.store.resolveIssuesForConversation(message.contactKey, decision.summary || "Assistant resolved the request using available context.");
      if (resolvedCount) this.store.addEvent({ kind: "issue", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, details: `Assistant marked ${resolvedCount} issue(s) resolved.` });
    } else if (decision.ownerAlert || ["urgent", "handoff", "wait", "clarify"].includes(decision.action)) {
      const previous = this.store.read().issues.find((candidate) => candidate.contactKey === message.contactKey && candidate.status === "open");
      const priority: IssuePriority = decision.action === "urgent" || decision.urgency >= 0.85 ? "urgent" : decision.ownerAlert || ["handoff", "wait", "clarify"].includes(decision.action) ? "high" : "normal";
      const result = this.store.upsertIssue({
        contactKey: message.contactKey, platform: message.platform, senderName: message.senderName || profile.name, profileName: profile.name,
        summary: decision.summary || "Conversation requires follow-up.", priority, lastAction: decision.action,
        nextAction: decision.nextAction || decision.alertReason || "Review this conversation when available.",
      });
      issue = result.issue;
      shouldNotifyIssue = result.isNew || decision.action === "urgent" || (!previous?.lastNotifiedAt && decision.ownerAlert);
    }

    if (decision.ownerAlert || decision.action === "urgent" || decision.action === "handoff" || profile.priority === "always_alert" || (decision.confidence < 0.45 && profile.alertOnUncertain)) {
      const severity = decision.action === "urgent" ? "urgent" : profile.priority === "always_alert" ? "vip" : "uncertain";
      this.createAlert(severity, `${decision.action === "urgent" ? "Urgent" : "Review needed"}: ${message.senderName || profile.name}`, decision.alertReason || decision.summary, message);
      console.warn(`[ALERT:${severity.toUpperCase()}] ${message.senderName || profile.name} (${formatIdentity(message)}): ${decision.summary}`);
    }
    if (issue && shouldNotifyIssue) await this.notifyIssueOwner(issue, decision.summary);
    if (profile.priority === "always_alert" && !(issue && shouldNotifyIssue)) {
      const status = decision.resolved ? "RESOLVED BY ASSISTANT" : "NEEDS FOLLOW-UP";
      const text = [`PERSONAL GATEKEEPER · VIP CONTACT`, `Contact: ${message.senderName || profile.name}`, `Platform: ${message.platform}`, `Decision: ${decision.action.toUpperCase()}`, `Status: ${status}`, `Summary: ${decision.summary.slice(0, 300)}`, `Next action: ${(decision.nextAction || "Review when available.").slice(0, 240)}`, `Contact key: ${message.contactKey}`, state.dryRun ? "Dry-run is ON; any reply to the contact was only previewed." : "Live sending is enabled; see the local Activity log for the send result."].join("\n");
      await this.deliverOwnerReport(text, "contact_alert", `VIP contact ${message.senderName || profile.name}: ${decision.summary}`, message.contactKey);
    }

    const sendPort = this.runtime[message.platform];
    if (!sendPort) {
      this.store.addEvent({ kind: "error", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, profileName: profile.name, details: `No active ${message.platform} send connector; message was not sent.` });
      this.store.markProcessed(processedKey);
      return;
    }

    if (state.dryRun) {
      this.store.addEvent({ kind: "message_sent", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, profileName: profile.name, action: decision.action, details: `[DRY RUN — not sent] ${decision.reply}`, dryRun: true });
      console.log(`[DRY RUN] ${message.platform} → ${message.senderName}: ${decision.reply}`);
      this.store.markProcessed(processedKey);
      return;
    }

    const latestConversation = this.store.getConversation(message.contactKey) || conversation;
    const repliesInSession = latestConversation.autoRepliesThisSession;
    if (repliesInSession >= MAX_AUTOREPLIES_PER_BUSY_SESSION) {
      latestConversation.autoPaused = true;
      this.store.saveConversation(latestConversation);
      this.createAlert("uncertain", `Auto-replies paused: ${message.senderName || profile.name}`, `This conversation reached the ${MAX_AUTOREPLIES_PER_BUSY_SESSION}-reply safety cap for one Busy Mode session.`, message);
      this.store.addEvent({ kind: "message_skipped", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, profileName: profile.name, details: "Safety cap reached; subsequent messages require manual review." });
      this.store.markProcessed(processedKey);
      return;
    }

    try {
      await sendPort.send(message, decision.reply.slice(0, 3500));
      latestConversation.history.push({ role: "assistant", text: decision.reply.slice(0, 3500), at: new Date().toISOString(), platform: message.platform });
      latestConversation.history = latestConversation.history.slice(-MAX_HISTORY);
      latestConversation.autoRepliesThisSession = repliesInSession + 1;
      latestConversation.lastMessageAt = new Date().toISOString();
      this.store.saveConversation(latestConversation);
      this.store.addEvent({ kind: "message_sent", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, profileName: profile.name, action: decision.action, details: decision.reply.slice(0, 500) });
      console.log(`[SENT] ${message.platform} → ${message.senderName}: ${decision.reply}`);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.store.addEvent({ kind: "error", platform: message.platform, senderName: message.senderName, contactKey: message.contactKey, profileName: profile.name, details: `Message send failed: ${errorText}` });
      this.createAlert("system", `Reply failed for ${message.senderName || profile.name}`, `The assistant could not send its reply: ${errorText}`, message);
      await this.deliverOwnerReport(`PERSONAL GATEKEEPER · REPLY FAILED\nContact: ${message.senderName} (${message.platform})\nError: ${errorText.slice(0, 240)}\nNext action: Check the connector and reply manually if needed.`, "system", `Reply failed for ${message.senderName}`, message.contactKey);
      console.error(`[SEND ERROR] ${errorText}`);
    } finally {
      this.store.markProcessed(processedKey);
    }
  }

  private createAlert(severity: "urgent" | "uncertain" | "vip" | "system", title: string, details: string, message?: InboundMessage): void {
    this.store.addAlert({ severity, title, details, platform: message?.platform, senderName: message?.senderName, contactKey: message?.contactKey });
  }

  private async notifyIssueOwner(issue: OpenIssue, reason: string): Promise<void> {
    const text = [
      `PERSONAL GATEKEEPER · ${issue.priority.toUpperCase()}`,
      `Contact: ${issue.senderName}`, `Platform: ${issue.platform}`, `Relationship: ${issue.profileName}`,
      `Status: UNRESOLVED · ${issue.lastAction.toUpperCase()}`,
      `Summary: ${issue.summary.slice(0, 300)}`, `Why now: ${reason.slice(0, 240)}`,
      `Next action: ${issue.nextAction.slice(0, 240)}`, `Issue ID: ${issue.id}`, `Contact key: ${issue.contactKey}`,
      `Updated: ${new Date(issue.lastActivityAt).toLocaleString()}`,
      "Use /queue, /takeover, /resume, or /resolve in your private owner bot chat.",
    ].join("\n");
    await this.deliverOwnerReport(text, "issue", `${issue.priority}: ${issue.senderName} — ${issue.summary.slice(0, 120)}`, issue.contactKey);
    this.store.markIssueNotified(issue.id);
  }

  private async deliverOwnerReport(text: string, kind: "issue" | "contact_alert" | "busy_mode_ended" | "system", summary: string, contactKey?: string): Promise<boolean> {
    let delivered = false; let errorText: string | undefined;
    try {
      if (!this.runtime.ownerNotifier) throw new Error("Owner notification is not configured. Set TELEGRAM_OWNER_CHAT_ID and start the bot chat; report remains in the local queue.");
      await this.runtime.ownerNotifier.sendOwnerMessage(text.slice(0, 3900));
      delivered = true;
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
      console.warn(`[Owner report] ${errorText}`);
    }
    this.store.addOwnerReport({ kind, summary: summary.slice(0, 500), contactKey, delivered, ...(errorText ? { error: errorText.slice(0, 400) } : {}) });
    return delivered;
  }
}

export function localContactKey(platform: Platform, id: string): string {
  return `${platform}:${id}`;
}
