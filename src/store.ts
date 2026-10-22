import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AppAlert, AppEvent, AppState, BusyMode, ContactMemory, ContactProfile, ConversationState, IssuePriority, OpenIssue, OwnerReportRecord, TelegramState, TelegramUserState, TelegramChatConsent, ConsentStatus } from "./types.ts";

const now = () => new Date().toISOString();

function seedProfile(id: string, name: string, relationship: ContactProfile["relationship"], toneInstruction: string, isDefault = false): ContactProfile {
  const timestamp = now();
  return {
    id, name, relationship, identifiers: [], toneInstruction,
    priority: "normal", allowAutonomousAnswers: true, alertOnUncertain: true,
    isDefault, createdAt: timestamp, updatedAt: timestamp,
  };
}

function createInitialState(initialDryRun: boolean): AppState {
  return {
    mode: { enabled: false, reason: "deep work", availableAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), policy: "balanced", sessionId: randomUUID(), enabledAt: null },
    dryRun: initialDryRun,
    profiles: [
      seedProfile("family", "Family", "family", "Warm, caring, patient, and natural. You may use light affectionate phrasing, but do not overdo emojis or pretend to be Ashkan."),
      seedProfile("partner", "Partner / girlfriend", "partner", "Warm, affectionate, attentive, reassuring, and natural. Never manufacture feelings or make promises on Ashkan's behalf."),
      seedProfile("close-friends", "Close friends", "close_friend", "Casual, relaxed, witty when appropriate, and familiar without forcing jokes. Match the sender's energy."),
      seedProfile("default", "Everyone else", "professional", "Polite, concise, clear, and professional. Friendly but not overly familiar.", true),
    ],
    conversations: {},
    contactMemories: {},
    issues: [],
    ownerReports: [],
    processedMessageKeys: [],
    events: [],
    alerts: [],
    telegram: { offset: 0, businessConnectionId: null, businessUserId: null, canReply: false, connectionStatus: "disabled" },
    telegramUser: { connectionStatus: "disabled", accountId: null, lastUpdateAt: null, consents: {} },
  };
}

export class Store {
  private filePath: string;

  constructor(dataPath = resolve(process.cwd(), "data", "state.json"), initialDryRun = true) {
    this.filePath = dataPath;
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (!existsSync(this.filePath)) this.write(createInitialState(initialDryRun));
    // Fail loudly on corrupt state rather than silently resetting private configuration.
    this.read();
  }

  read(): AppState {
    const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<AppState>;
    // Preserve state created by older MVP versions while adding defaults for new fields.
    const initial = createInitialState(raw.dryRun ?? true);
    return {
      ...initial, ...raw,
      mode: { ...initial.mode, ...(raw.mode || {}) },
      profiles: Array.isArray(raw.profiles) && raw.profiles.length ? raw.profiles : initial.profiles,
      conversations: raw.conversations && typeof raw.conversations === "object" ? raw.conversations : {},
      contactMemories: raw.contactMemories && typeof raw.contactMemories === "object" ? raw.contactMemories : {},
      issues: Array.isArray(raw.issues) ? raw.issues : [],
      ownerReports: Array.isArray(raw.ownerReports) ? raw.ownerReports : [],
      processedMessageKeys: Array.isArray(raw.processedMessageKeys) ? raw.processedMessageKeys : [],
      events: Array.isArray(raw.events) ? raw.events : [],
      alerts: Array.isArray(raw.alerts) ? raw.alerts : [],
      telegram: { ...initial.telegram, ...(raw.telegram || {}) },
      telegramUser: { ...initial.telegramUser, ...(raw.telegramUser || {}), consents: (raw.telegramUser && typeof raw.telegramUser.consents === "object" && raw.telegramUser.consents) || {} },
    } as AppState;
  }

  update(mutator: (state: AppState) => void): AppState {
    const state = this.read();
    mutator(state);
    this.write(state);
    return state;
  }

  private write(state: AppState): void {
    const tempPath = `${this.filePath}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }

  addEvent(event: Omit<AppEvent, "id" | "at"> & { id?: string; at?: string }): void {
    this.update((state) => {
      state.events.unshift({ ...event, id: event.id || randomUUID(), at: event.at || now() } as AppEvent);
      state.events = state.events.slice(0, 500);
    });
  }

  addAlert(alert: Omit<AppAlert, "id" | "at" | "acknowledged"> & { id?: string; at?: string; acknowledged?: boolean }): void {
    this.update((state) => {
      state.alerts.unshift({ ...alert, id: alert.id || randomUUID(), at: alert.at || now(), acknowledged: alert.acknowledged ?? false } as AppAlert);
      state.alerts = state.alerts.slice(0, 150);
    });
  }

  markProcessed(key: string): void {
    this.update((state) => {
      state.processedMessageKeys.push(key);
      state.processedMessageKeys = state.processedMessageKeys.slice(-5000);
    });
  }

  isProcessed(key: string): boolean {
    return this.read().processedMessageKeys.includes(key);
  }

  saveConversation(conversation: ConversationState): void {
    this.update((state) => { state.conversations[conversation.contactKey] = conversation; });
  }

  getConversation(contactKey: string): ConversationState | undefined {
    return this.read().conversations[contactKey];
  }

  setMode(input: { enabled: boolean; reason: string; availableAt: string | null; policy: BusyMode["policy"] }): BusyMode {
    let result!: BusyMode;
    this.update((state) => {
      const startingNewSession = input.enabled && !state.mode.enabled;
      state.mode = {
        ...state.mode,
        enabled: input.enabled,
        reason: input.reason.trim() || "busy",
        availableAt: input.availableAt,
        policy: input.policy,
        sessionId: startingNewSession ? randomUUID() : state.mode.sessionId,
        enabledAt: input.enabled ? (state.mode.enabledAt || now()) : null,
      };
      if (!input.enabled) {
        for (const conversation of Object.values(state.conversations)) {
          conversation.autoPaused = false;
          conversation.autoRepliesThisSession = 0;
        }
      }
      result = state.mode;
    });
    this.addEvent({ kind: "mode", details: input.enabled ? `Busy Mode enabled: ${input.reason}` : "Busy Mode disabled" });
    return result;
  }

  setDryRun(dryRun: boolean): void {
    this.update((state) => { state.dryRun = dryRun; });
    this.addEvent({ kind: "mode", details: dryRun ? "Dry-run mode enabled; outgoing messages are suppressed." : "Live sending enabled." });
  }

  saveTelegram(patch: Partial<TelegramState>): void {
    this.update((state) => { state.telegram = { ...state.telegram, ...patch }; });
  }

  saveTelegramUser(patch: Partial<Omit<TelegramUserState, "consents">>): void {
    this.update((state) => { state.telegramUser = { ...state.telegramUser, ...patch, consents: state.telegramUser.consents || {} }; });
  }

  getTelegramConsent(contactKey: string): TelegramChatConsent | undefined {
    return this.read().telegramUser.consents[contactKey];
  }

  saveTelegramConsent(consent: TelegramChatConsent): void {
    this.update((state) => {
      state.telegramUser.consents[consent.contactKey] = consent;
      state.telegramUser.lastUpdateAt = now();
    });
  }

  updateTelegramConsent(contactKey: string, patch: Partial<TelegramChatConsent>): TelegramChatConsent | undefined {
    let updated: TelegramChatConsent | undefined;
    this.update((state) => {
      const prior = state.telegramUser.consents[contactKey];
      if (!prior) return;
      updated = { ...prior, ...patch, contactKey, updatedAt: now() };
      state.telegramUser.consents[contactKey] = updated;
      state.telegramUser.lastUpdateAt = now();
    });
    return updated;
  }

  clearContactData(contactKey: string): void {
    this.update((state) => {
      delete state.conversations[contactKey];
      delete state.contactMemories[contactKey];
      state.issues = state.issues.filter((issue) => issue.contactKey !== contactKey);
      state.ownerReports = state.ownerReports.filter((report) => report.contactKey !== contactKey);
      state.alerts = state.alerts.filter((alert) => alert.contactKey !== contactKey);
      state.events = state.events.filter((event) => event.contactKey !== contactKey);
    });
  }

  upsertProfile(input: Partial<ContactProfile> & Pick<ContactProfile, "name" | "relationship">): ContactProfile {
    let profile!: ContactProfile;
    this.update((state) => {
      const old = input.id ? state.profiles.find((p) => p.id === input.id) : undefined;
      profile = {
        id: old?.id || randomUUID(),
        name: input.name.trim().slice(0, 80) || "Unnamed profile",
        relationship: input.relationship,
        identifiers: [...new Set((input.identifiers || old?.identifiers || []).map((v) => v.trim()).filter(Boolean))].slice(0, 100),
        toneInstruction: (input.toneInstruction ?? old?.toneInstruction ?? "Warm and natural.").trim().slice(0, 1200),
        priority: input.priority || old?.priority || "normal",
        allowAutonomousAnswers: input.allowAutonomousAnswers ?? old?.allowAutonomousAnswers ?? true,
        alertOnUncertain: input.alertOnUncertain ?? old?.alertOnUncertain ?? true,
        isDefault: old?.isDefault ?? false,
        createdAt: old?.createdAt || now(),
        updatedAt: now(),
      };
      if (old) state.profiles = state.profiles.map((p) => p.id === old.id ? profile : p);
      else state.profiles.push(profile);
    });
    return profile;
  }

  deleteProfile(id: string): boolean {
    let removed = false;
    this.update((state) => {
      const target = state.profiles.find((p) => p.id === id);
      if (!target || target.isDefault) return;
      state.profiles = state.profiles.filter((p) => p.id !== id);
      for (const convo of Object.values(state.conversations)) if (convo.profileId === id) convo.profileId = "default";
      removed = true;
    });
    return removed;
  }

  mergeContactMemory(contactKey: string, update: { summary?: string; facts?: string[]; sourceMessageId?: string }): ContactMemory {
    let result!: ContactMemory;
    this.update((state) => {
      const existing = state.contactMemories[contactKey] || { summary: "", facts: [], updatedAt: now() };
      const incoming = (update.facts || []).filter((fact): fact is string => typeof fact === "string").map((fact) => fact.trim().slice(0, 240)).filter(Boolean);
      const facts = [...(existing.facts || [])];
      for (const fact of incoming) if (!facts.some((old) => old.toLocaleLowerCase() === fact.toLocaleLowerCase())) facts.push(fact);
      result = {
        summary: typeof update.summary === "string" && update.summary.trim() ? update.summary.trim().slice(0, 1200) : (existing.summary || "").slice(0, 1200),
        facts: facts.slice(-40), updatedAt: now(),
        ...(update.sourceMessageId ? { lastSourceMessageId: update.sourceMessageId.slice(0, 120) } : existing.lastSourceMessageId ? { lastSourceMessageId: existing.lastSourceMessageId } : {}),
      };
      state.contactMemories[contactKey] = result;
    });
    return result;
  }

  deleteContactMemory(contactKey: string): boolean {
    let removed = false;
    this.update((state) => { if (state.contactMemories[contactKey]) { delete state.contactMemories[contactKey]; removed = true; } });
    return removed;
  }

  upsertIssue(input: { contactKey: string; platform: OpenIssue["platform"]; senderName: string; profileName: string; summary: string; priority: IssuePriority; lastAction: OpenIssue["lastAction"]; nextAction: string }): { issue: OpenIssue; isNew: boolean } {
    let result!: OpenIssue; let isNew = false;
    this.update((state) => {
      const existing = state.issues.find((issue) => issue.contactKey === input.contactKey && issue.status === "open");
      const timestamp = now();
      if (existing) {
        existing.platform = input.platform; existing.senderName = input.senderName.slice(0, 120); existing.profileName = input.profileName.slice(0, 120);
        existing.summary = input.summary.slice(0, 600); existing.lastAction = input.lastAction; existing.nextAction = input.nextAction.slice(0, 300);
        existing.updatedAt = timestamp; existing.lastActivityAt = timestamp;
        if (input.priority === "urgent" || (input.priority === "high" && existing.priority === "normal")) existing.priority = input.priority;
        else if (existing.priority !== "urgent") existing.priority = input.priority;
        result = existing;
      } else {
        isNew = true;
        result = { id: randomUUID(), contactKey: input.contactKey, platform: input.platform, senderName: input.senderName.slice(0, 120), profileName: input.profileName.slice(0, 120), summary: input.summary.slice(0, 600), status: "open", priority: input.priority, lastAction: input.lastAction, nextAction: input.nextAction.slice(0, 300), createdAt: timestamp, updatedAt: timestamp, lastActivityAt: timestamp, lastNotifiedAt: null };
        state.issues.unshift(result);
      }
      state.issues = state.issues.slice(0, 1000);
    });
    this.addEvent({ kind: "issue", platform: input.platform, senderName: input.senderName, contactKey: input.contactKey, profileName: input.profileName, action: input.lastAction, details: `${isNew ? "Created" : "Updated"} ${result.priority} issue: ${result.summary}` });
    return { issue: result, isNew };
  }

  resolveIssue(id: string, resolution: string): boolean {
    let found = false;
    this.update((state) => { const issue = state.issues.find((candidate) => candidate.id === id && candidate.status === "open"); if (!issue) return; issue.status = "resolved"; issue.resolution = resolution.trim().slice(0, 600) || "Resolved by owner."; issue.updatedAt = now(); found = true; });
    if (found) this.addEvent({ kind: "issue", details: `Issue ${id} marked resolved.` });
    return found;
  }

  resolveIssuesForConversation(contactKey: string, resolution: string): number {
    let count = 0;
    this.update((state) => { for (const issue of state.issues) { if (issue.contactKey !== contactKey || issue.status !== "open") continue; issue.status = "resolved"; issue.resolution = resolution.trim().slice(0, 600) || "Resolved by assistant."; issue.updatedAt = now(); count += 1; } });
    return count;
  }

  markIssueNotified(id: string): void { this.update((state) => { const issue = state.issues.find((candidate) => candidate.id === id); if (issue) issue.lastNotifiedAt = now(); }); }

  setConversationPaused(contactKey: string, paused: boolean): boolean {
    let found = false;
    this.update((state) => { const conversation = state.conversations[contactKey]; if (!conversation) return; conversation.autoPaused = paused; if (!paused) { conversation.busySessionId = state.mode.sessionId; conversation.autoRepliesThisSession = 0; } found = true; });
    if (found) this.addEvent({ kind: "mode", contactKey, details: paused ? "Owner took over this conversation; AI replies paused." : "Owner resumed assistant handling for this conversation." });
    return found;
  }

  addOwnerReport(report: Omit<OwnerReportRecord, "id" | "at">): void {
    this.update((state) => { state.ownerReports.unshift({ ...report, id: randomUUID(), at: now() }); state.ownerReports = state.ownerReports.slice(0, 200); });
    this.addEvent({ kind: "owner_report", contactKey: report.contactKey, details: `${report.delivered ? "Delivered" : "Could not deliver"} owner report: ${report.summary}${report.error ? ` (${report.error})` : ""}` });
  }

  acknowledgeAlert(id: string): boolean {
    let found = false;
    this.update((state) => {
      const alert = state.alerts.find((a) => a.id === id);
      if (alert) { alert.acknowledged = true; found = true; }
    });
    return found;
  }
}
