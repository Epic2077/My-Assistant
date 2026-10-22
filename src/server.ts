import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decideMessage, formatAvailableAt, safeFallbackDecision } from "./ai.ts";
import { ensureDisclosure } from "./handler.ts";
import { env } from "./env.ts";
import { Store } from "./store.ts";
import type { MessageHandler } from "./handler.ts";
import type { ContactProfile, InboundMessage, Relationship, RuntimeStatus } from "./types.ts";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "public");
const indexHtml = readFileSync(resolve(publicDir, "index.html"), "utf8");
const relationships = new Set<Relationship>(["family", "partner", "close_friend", "professional"]);
const priorities = new Set(["normal", "always_alert", "interrupt"]);
const policies = new Set(["strict", "balanced", "flexible"]);

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

function allowedLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/^\[/, "").split("]")[0]?.split(":")[0]?.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("Request body too large.");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

function parseIdentifiers(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).flatMap((v) => v.split(/[\n,]/)).map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(/[\n,]/).map((v) => v.trim()).filter(Boolean);
  return [];
}

function publicState(store: Store, runtime: RuntimeStatus): unknown {
  const state = store.read();
  return {
    mode: state.mode,
    dryRun: state.dryRun,
    profiles: state.profiles,
    events: state.events.slice(0, 60),
    alerts: state.alerts.slice(0, 50),
    issues: state.issues.filter((issue) => issue.status === "open").sort((a, b) => ({ urgent: 0, high: 1, normal: 2 }[a.priority] - { urgent: 0, high: 1, normal: 2 }[b.priority]) || Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)).slice(0, 100),
    ownerReports: state.ownerReports.slice(0, 30),
    memories: Object.entries(state.contactMemories).map(([contactKey, memory]) => ({ contactKey, summary: memory.summary, facts: memory.facts, factsCount: memory.facts.length, updatedAt: memory.updatedAt })),
    conversationControls: Object.values(state.conversations).map((conversation) => ({ contactKey: conversation.contactKey, senderName: conversation.senderName, autoPaused: conversation.autoPaused, lastMessageAt: conversation.lastMessageAt })),
    ownerNotificationsConfigured: Boolean(process.env.TELEGRAM_OWNER_CHAT_ID),
    connections: runtime,
    telegramBusiness: {
      status: state.telegram.connectionStatus,
      canReply: state.telegram.canReply,
      connected: Boolean(state.telegram.businessConnectionId),
    },
    telegramUser: {
      status: state.telegramUser.connectionStatus,
      accountId: state.telegramUser.accountId,
      consents: Object.values(state.telegramUser.consents || {}).map((consent) => ({
        contactKey: consent.contactKey,
        chatId: consent.chatId,
        senderName: consent.senderName,
        status: consent.status,
        grantedAt: consent.grantedAt,
        expiresAt: consent.expiresAt,
        updatedAt: consent.updatedAt,
        scope: consent.scope,
      })).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 100),
    },
    counts: {
      conversations: Object.keys(state.conversations).length,
      unacknowledgedAlerts: state.alerts.filter((a) => !a.acknowledged).length,
    },
  };
}

export function startDashboardServer(store: Store, runtime: RuntimeStatus, handler?: MessageHandler) {
  const server = createServer(async (req, res) => {
    try {
      // The UI is intentionally localhost-only. Reject non-local Host and browser Origin values.
      if (!allowedLocalHost(req.headers.host)) return json(res, 403, { error: "Local access only." });
      const origin = req.headers.origin;
      if (origin) {
        let originHost = "";
        try { originHost = new URL(origin).hostname; } catch { return json(res, 403, { error: "Invalid Origin." }); }
        if (!new Set(["127.0.0.1", "localhost", "::1"]).has(originHost)) return json(res, 403, { error: "Cross-origin requests are not allowed." });
      }

      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
        res.end(indexHtml);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/state") return json(res, 200, publicState(store, runtime));

      if (req.method === "POST" && url.pathname === "/api/mode") {
        const body = await readJson(req);
        if (typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled must be a boolean." });
        const reason = typeof body.reason === "string" ? body.reason.slice(0, 180) : "busy";
        let availableAt: string | null = null;
        if (typeof body.availableAt === "string" && body.availableAt) {
          const parsedAvailableAt = new Date(body.availableAt);
          if (Number.isNaN(parsedAvailableAt.getTime())) return json(res, 400, { error: "availableAt must be a valid date/time." });
          availableAt = parsedAvailableAt.toISOString();
        }
        if (body.enabled && availableAt && Date.parse(availableAt) <= Date.now()) return json(res, 400, { error: "Choose a finish time in the future." });
        const policy = String(body.policy || "balanced");
        if (!policies.has(policy)) return json(res, 400, { error: "Invalid interruption policy." });
        const previousMode = store.read().mode;
        const mode = store.setMode({ enabled: body.enabled, reason, availableAt, policy: policy as "strict" | "balanced" | "flexible" });
        if (previousMode.enabled && !mode.enabled && handler) void handler.notifyBusyModeEnded(previousMode);
        return json(res, 200, { mode });
      }

      if (req.method === "POST" && url.pathname === "/api/dry-run") {
        const body = await readJson(req);
        if (typeof body.enabled !== "boolean") return json(res, 400, { error: "enabled must be a boolean." });
        store.setDryRun(body.enabled);
        return json(res, 200, { dryRun: store.read().dryRun });
      }

      if (req.method === "POST" && url.pathname === "/api/profiles") {
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const relationship = String(body.relationship || "professional") as Relationship;
        if (!name) return json(res, 400, { error: "Profile name is required." });
        if (!relationships.has(relationship)) return json(res, 400, { error: "Invalid relationship profile." });
        const priority = String(body.priority || "normal");
        if (!priorities.has(priority)) return json(res, 400, { error: "Invalid priority." });
        const existingId = typeof body.id === "string" ? body.id : undefined;
        const existing = existingId ? store.read().profiles.find((p) => p.id === existingId) : undefined;
        const profile = store.upsertProfile({
          ...(existing ? { id: existing.id } : {}),
          name,
          relationship,
          identifiers: parseIdentifiers(body.identifiers),
          toneInstruction: typeof body.toneInstruction === "string" ? body.toneInstruction : "Warm, natural, and concise.",
          priority: priority as ContactProfile["priority"],
          allowAutonomousAnswers: body.allowAutonomousAnswers !== false,
          alertOnUncertain: body.alertOnUncertain !== false,
        });
        return json(res, 200, { profile });
      }

      const deleteMatch = url.pathname.match(/^\/api\/profiles\/([^/]+)$/);
      if (req.method === "DELETE" && deleteMatch) {
        const id = decodeURIComponent(deleteMatch[1]!);
        const removed = store.deleteProfile(id);
        return removed ? json(res, 200, { ok: true }) : json(res, 400, { error: "Profile could not be removed. The default profile is protected." });
      }

      const ackMatch = url.pathname.match(/^\/api\/alerts\/([^/]+)\/acknowledge$/);
      if (req.method === "POST" && ackMatch) {
        const ok = store.acknowledgeAlert(decodeURIComponent(ackMatch[1]!));
        return json(res, ok ? 200 : 404, { ok });
      }

      const issueResolveMatch = url.pathname.match(/^\/api\/issues\/([^/]+)\/resolve$/);
      if (req.method === "POST" && issueResolveMatch) {
        const body = await readJson(req);
        const id = decodeURIComponent(issueResolveMatch[1]!);
        const resolution = typeof body.resolution === "string" ? body.resolution : "Reviewed and resolved by owner.";
        const ok = store.resolveIssue(id, resolution);
        return json(res, ok ? 200 : 404, { ok });
      }

      const conversationControlMatch = url.pathname.match(/^\/api\/conversations\/([^/]+)\/(takeover|resume)$/);
      if (req.method === "POST" && conversationControlMatch) {
        const contactKey = decodeURIComponent(conversationControlMatch[1]!);
        const paused = conversationControlMatch[2] === "takeover";
        const ok = store.setConversationPaused(contactKey, paused);
        return json(res, ok ? 200 : 404, { ok, paused });
      }

      const memoryMatch = url.pathname.match(/^\/api\/memories\/(.+)$/);
      if (req.method === "DELETE" && memoryMatch) {
        const contactKey = decodeURIComponent(memoryMatch[1]!);
        const ok = store.deleteContactMemory(contactKey);
        return json(res, ok ? 200 : 404, { ok });
      }

      if (req.method === "POST" && url.pathname === "/api/test-decision") {
        const body = await readJson(req);
        const text = typeof body.message === "string" ? body.message.trim().slice(0, 3000) : "";
        if (!text) return json(res, 400, { error: "Enter a sample message." });
        const state = store.read();
        const profileId = typeof body.profileId === "string" ? body.profileId : "default";
        const profile = state.profiles.find((p) => p.id === profileId) || state.profiles.find((p) => p.isDefault)!;
        const mockMessage: InboundMessage = {
          platform: "telegram", id: `preview-${randomUUID()}`, chatId: "preview", contactKey: "telegram:preview",
          senderName: typeof body.senderName === "string" ? body.senderName.slice(0, 80) : profile.name,
          text, timestamp: new Date().toISOString(),
        };
        const conversation = {
          contactKey: mockMessage.contactKey, platform: "telegram" as const, senderName: mockMessage.senderName, profileId: profile.id,
          history: [{ role: "contact" as const, text, at: mockMessage.timestamp, platform: "telegram" as const }],
          busySessionId: "preview", autoRepliesThisSession: 0, autoPaused: false, lastMessageAt: mockMessage.timestamp,
        };
        const previewState = { ...state, mode: { ...state.mode, enabled: true, reason: state.mode.reason || "deep work", availableAt: state.mode.availableAt || new Date(Date.now() + 60 * 60 * 1000).toISOString() } };
        let decision;
        try {
          decision = await decideMessage({ state: previewState, profile, conversation, message: mockMessage, isFirstInSession: true });
        } catch (error) {
          decision = safeFallbackDecision(error instanceof Error ? error.message : String(error));
          decision.reply = `${profile.relationship === "partner" ? "Hey ❤️ " : profile.relationship === "professional" ? "Hello — " : "Hey! "}I'm ${env.ownerName}'s assistant. ${env.ownerName} is busy with ${previewState.mode.reason} until ${formatAvailableAt(previewState.mode.availableAt)}. Tell me what you need and I'll see whether I can help. If something serious or time-sensitive has happened, please call ${env.ownerName} directly.`;
        }
        decision.reply = ensureDisclosure(decision.reply, profile, previewState.mode.reason, previewState.mode.availableAt);
        if (!profile.allowAutonomousAnswers && decision.action !== "urgent") {
          decision.action = "handoff";
          decision.ownerAlert = true;
          decision.resolved = false;
          decision.nextAction = "Owner must handle this conversation personally.";
          decision.reply = `I don't want to guess on ${env.ownerName}'s behalf, so I've left this for them to handle when they're available. If it's time-sensitive, please call ${env.ownerName} directly.`;
        }
        return json(res, 200, { decision, profile: { id: profile.id, name: profile.name }, sent: false });
      }

      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, time: new Date().toISOString() });
      return json(res, 404, { error: "Not found." });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof SyntaxError) return json(res, 400, { error: "Invalid JSON request body." });
      return json(res, 500, { error: detail });
    }
  });

  server.listen(env.port, env.host, () => {
    runtime.dashboard = `http://${env.host}:${env.port}`;
    console.log(`\nPersonal Gatekeeper dashboard: ${runtime.dashboard}`);
    console.log("Local-only server started. Busy Mode is OFF until you enable it in the dashboard.\n");
  });
  return server;
}
