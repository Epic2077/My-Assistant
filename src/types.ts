export type Platform = "telegram" | "telegram_user" | "whatsapp";
export type Relationship = "family" | "partner" | "close_friend" | "professional";
export type InterruptionPolicy = "strict" | "balanced" | "flexible";
export type ContactPriority = "normal" | "always_alert" | "interrupt";
export type DecisionAction = "answer" | "wait" | "urgent" | "clarify" | "handoff";
export type IssueStatus = "open" | "resolved";
export type IssuePriority = "urgent" | "high" | "normal";

export interface BusyMode { enabled: boolean; reason: string; availableAt: string | null; policy: InterruptionPolicy; sessionId: string; enabledAt: string | null; }
export interface ContactProfile {
  id: string; name: string; relationship: Relationship; identifiers: string[]; toneInstruction: string;
  priority: ContactPriority; allowAutonomousAnswers: boolean; alertOnUncertain: boolean; isDefault: boolean; createdAt: string; updatedAt: string;
}
export interface StoredMessage { role: "contact" | "assistant" | "owner"; text: string; at: string; platform: Platform; messageId?: string; }
export interface ContactMemory { summary: string; facts: string[]; updatedAt: string; lastSourceMessageId?: string; }
export interface ConversationState {
  contactKey: string; platform: Platform; senderName: string; profileId: string; history: StoredMessage[];
  busySessionId: string; autoRepliesThisSession: number; autoPaused: boolean; lastMessageAt: string;
}
export interface OpenIssue {
  id: string; contactKey: string; platform: Platform; senderName: string; profileName: string; summary: string;
  status: IssueStatus; priority: IssuePriority; lastAction: DecisionAction; nextAction: string;
  createdAt: string; updatedAt: string; lastActivityAt: string; lastNotifiedAt: string | null; resolution?: string;
}
export interface OwnerReportRecord { id: string; at: string; kind: "issue" | "contact_alert" | "busy_mode_ended" | "system"; summary: string; contactKey?: string; delivered: boolean; error?: string; }
export interface AppEvent {
  id: string; at: string;
  kind: "message_received" | "owner_message_observed" | "decision" | "message_sent" | "message_skipped" | "connector" | "error" | "mode" | "issue" | "owner_report" | "memory";
  platform?: Platform; senderName?: string; contactKey?: string; profileName?: string; action?: DecisionAction; details: string; dryRun?: boolean;
}
export interface AppAlert { id: string; at: string; severity: "urgent" | "uncertain" | "vip" | "system"; title: string; details: string; platform?: Platform; senderName?: string; contactKey?: string; acknowledged: boolean; }
export interface TelegramState { offset: number; businessConnectionId: string | null; businessUserId: number | null; canReply: boolean; connectionStatus: string; }
export type ConsentStatus = "pending" | "granted" | "declined" | "revoked";
export interface TelegramChatConsent {
  contactKey: string;
  chatId: string;
  senderName: string;
  status: ConsentStatus;
  scope: string;
  consentVersion: string;
  requestedAt: string | null;
  grantedAt: string | null;
  expiresAt: string | null;
  updatedAt: string;
  lastPromptAt: string | null;
  revokedAt: string | null;
}
export interface TelegramUserState {
  connectionStatus: string;
  accountId: string | null;
  lastUpdateAt: string | null;
  consents: Record<string, TelegramChatConsent>;
}
export interface AppState {
  mode: BusyMode; dryRun: boolean; profiles: ContactProfile[]; conversations: Record<string, ConversationState>;
  contactMemories: Record<string, ContactMemory>; issues: OpenIssue[]; ownerReports: OwnerReportRecord[];
  processedMessageKeys: string[]; events: AppEvent[]; alerts: AppAlert[]; telegram: TelegramState; telegramUser: TelegramUserState;
}
export interface InboundMessage { platform: Platform; id: string; chatId: string; contactKey: string; senderName: string; text: string; timestamp: string; businessConnectionId?: string; }
export interface AiDecision {
  action: DecisionAction; urgency: number; confidence: number; summary: string; reply: string; ownerAlert: boolean;
  alertReason?: string; resolved: boolean; nextAction: string; memoryUpdate?: { summary?: string; facts?: string[] };
}
export interface RuntimeStatus { dashboard: string; ai: string; telegram: string; telegramUser: string; whatsapp: string; startedAt: string; }
