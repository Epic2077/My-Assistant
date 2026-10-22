# Personal Gatekeeper (MVP 0.3.0)

A local-first TypeScript assistant that protects your focus while keeping conversations moving. It can use different tone/behavior profiles for family, your partner, close friends, and everyone else; classify incoming messages; answer straightforward questions; ask clarifying questions; and escalate urgent or sensitive situations.

**Safety defaults:** Busy Mode starts OFF, outbound sending starts in DRY RUN, Telegram and WhatsApp are disabled until configured, and group messages are ignored. The dashboard binds to `127.0.0.1` by default.

## What is included

- Local dashboard at `http://127.0.0.1:4173`.
- Busy Mode reason, availability time, and strict / balanced / flexible interruption policies.
- Per-person tone profiles matched by an exact sender identifier.
- Structured AI decision actions: `answer`, `wait`, `urgent`, `clarify`, or `handoff`.
- A test panel for evaluating example messages without sending them.
- Persistent per-contact memory (summary + stable facts), separate from recent message history.
- An unresolved-issue queue prioritized by urgency, with takeover/resume and resolve controls.
- Private Telegram owner reports for new escalations, reply failures, and Busy Mode handoff, plus `/queue`, `/urgent`, `/unresolved`, `/takeover`, `/resume`, `/resolve`, `/status`, and `/help` commands.
- Safety alerts, an event log, message deduplication, per-contact conversation history, an automatic Busy Mode end time, and a per-session auto-reply cap.
- Telegram Bot API adapter for owner reports, owner commands, standalone bot chats, and eligible Business updates.
- Optional personal Telegram account adapter using MTProto (`teleproto`), gated by explicit per-chat AI consent.
- Per-chat consent records with a fixed disclosure, 90-day renewal, `NO AI` decline, and `STOP AI` revocation/deletion.
- Owner `/consents` command and dashboard consent status list.
- Optional WhatsApp Web adapter, loaded only when you install the additional packages and enable it.

## Requirements

- Node.js 22.6+ recommended (Node 22.16+ for the built-in TypeScript type stripping used by the scripts).
- An AI API key for a hosted provider, or an OpenAI-compatible local model server (for example Ollama).
- For personal Telegram inbox access: a Telegram API ID/hash from `https://my.telegram.org/apps`, a one-time account login, and an explicitly enabled per-chat consent gate. Telegram's current API/AI terms apply; consent is necessary for the documented exception but should not be treated as a guarantee against platform review or restrictions.

## Run locally

### 1. Configure the app

Use Node.js 22.16+ and install project dependencies (the personal Telegram client uses the maintained `teleproto` MTProto package). Copy `.env.example` to `.env`.

PowerShell:

```powershell
Copy-Item .env.example .env
```

macOS / Linux:

```bash
cp .env.example .env
```

Set an AI provider. Example using DeepSeek:

```dotenv
AI_BASE_URL=https://api.deepseek.com/v1
AI_API_KEY=your_key_here
AI_MODEL=deepseek-chat
```

For an OpenAI-compatible local model server, set its base URL and model name. For example, if your Ollama setup exposes OpenAI-compatible endpoints locally:

```dotenv
AI_BASE_URL=http://127.0.0.1:11434/v1
AI_API_KEY=ollama
AI_MODEL=your-local-model-name
```

The local-model example assumes you've installed Ollama, pulled a model, and enabled its compatible API. The assistant sends message context to the AI endpoint you configure; using a hosted provider means some conversation content leaves your laptop.

### 2. Start the app

```bash
npm run dev
```

Open the dashboard URL shown in the terminal (normally `http://127.0.0.1:4173`).

### 3. Test before going live

1. Keep **Dry-run safety lock ON**.
2. Use the test panel with everyday questions, vague requests, VIP messages, and credible emergency scenarios.
3. Configure a few contact profiles and review the reply tone.
4. Enable a connector only after its account setup is complete.
5. Turn Busy Mode on with a short test window and inspect the Activity log.
6. Turn live sending on only after you're comfortable with the behavior.

In dry-run, the app records the decision and intended reply but does **not** send any outgoing message. An alert in the dashboard/terminal still does not mean a phone call was made or an external notification was delivered.

## Contact-specific profiles

The dashboard starts with four presets: Family, Partner / girlfriend, Close friends, and Everyone else. Presets have different tone instructions; they do not match anyone until you enter one or more exact identifiers. Unmatched senders use Everyone else.

Identifiers are shown in the Activity log after a message is received. Use the exact `ID` value shown there, for example:

```text
telegram:123456789
telegram-user:123456789
whatsapp:15551234567@c.us
```

A profile can contain multiple IDs separated by a new line or comma. For example, a family member who messages from two platforms can have both IDs in one profile.

Priority options:

- **Normal:** decide case-by-case.
- **Always alert me:** alert you for each incoming message from that profile, while the AI may still handle safe questions.
- **Interrupt Busy Mode for every message:** immediately alert you and tell the sender to call. Use this sparingly.

Disable autonomous answers for a contact if you want messages handed back to you instead of answered. If you manually reply in a conversation while Busy Mode is active, the assistant records your outgoing message and pauses further auto-replies in that thread until the next Busy Mode session.

## Private owner report/control chat (does not require Telegram Premium)

The owner report channel uses ordinary Bot API direct messages. It is separate from the Telegram Business integration that can receive personal-inbox messages. The same bot can also accept regular private chats from other people as a separate assistant conversation.

1. Create a bot with `@BotFather` and put its token in `.env` as `TELEGRAM_BOT_TOKEN`.
2. Set `TELEGRAM_ENABLED=true` and leave `DRY_RUN=true`.
3. Start the app, open a private chat with your bot, and send `/start`.
4. Check the local console. It prints a line containing `TELEGRAM_OWNER_CHAT_ID=<number>` when it sees `/start`. It does not log the message body.
5. Add that numeric ID to `.env` as `TELEGRAM_OWNER_CHAT_ID=...`, then restart the app.
6. Send `/start` again. The bot should respond with the current Busy Mode and dry-run status. Try `/help`, `/queue`, and `/telegram`.

`/telegram` reports whether a Telegram Business connection and `can_reply` permission have actually been received by this app. If `/help` works but a normal message sent to your personal Telegram account creates no Activity item, that is not a Busy Mode or Dry-run issue: the owner bot chat is working, but the personal inbox has not delivered a `business_message` update to the app. Check the Business connection below. A normal message sent to the **owner control bot chat** is intentionally ignored so the assistant does not talk over you; use a different Telegram account to message the bot for a standalone-bot test. The app now logs update *types* and chat IDs for diagnosis, but deliberately does not print incoming message bodies.

Only messages from the exact configured private chat ID can execute owner commands. Keep the bot token and `.env` private. The app can send owner reports only after the owner has started a chat with the bot and the chat ID is configured.

The private owner bot chat supports `/queue`, `/urgent`, `/unresolved`, `/takeover <issue-id-or-contact-key>`, `/resume <issue-id-or-contact-key>`, `/resolve <issue-id> [resolution]`, `/status`, and `/help`.

## Personal Telegram account client and AI consent gate (new in 0.3.0)

This is a separate integration from the Bot API connector. It signs in as your personal account with Telegram's MTProto client API and listens only to **new one-to-one private-chat messages**. It does not backfill old chat history, process groups/channels, or send chat content to AI before explicit consent.

> Important: Telegram's [API Terms](https://core.telegram.org/api/terms) and [Content Licensing / AI terms](https://telegram.org/tos/content-licensing) apply. The latter says the AI-use restriction has a limited exception when all relevant users provide explicit, informed, affirmative, continuing consent strictly scoped to the requested chat/context. This implementation asks in each private chat and records consent, but it cannot guarantee Telegram will view every deployment as compliant or eliminate account/API-access risk. Recheck the terms before enabling the client.

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Open [my.telegram.org/apps](https://my.telegram.org/apps) while signed into the account you want the assistant to use. Create an application and put its API ID/hash in `.env`:

   ```dotenv
   TELEGRAM_USER_ENABLED=true
   TELEGRAM_API_ID=your_numeric_api_id
   TELEGRAM_API_HASH=your_api_hash
   TELEGRAM_USER_SESSION_PATH=data/telegram-user.session
   TELEGRAM_USER_CONSENT_MESSAGES_ENABLED=true
   DRY_RUN=true
   ```

   Keep your API hash private. The personal-account session is a full account credential; anyone holding the session file may be able to use your account. Do not share it or commit it.

3. Run the one-time local login flow:

   ```bash
   npm run telegram:user-login
   ```

   Enter your phone number, Telegram login code, and two-step verification password if requested. The script writes the session to `data/telegram-user.session` with restrictive file permissions. Never paste the session string or login code into chat or source control.

4. Start the app:

   ```bash
   npm run dev
   ```

   Confirm the dashboard shows the personal Telegram connector connected. If it fails, check the console; common causes are missing API credentials, no session file, or either user-client setting being disabled.

### How consent works

- `TELEGRAM_USER_CONSENT_MESSAGES_ENABLED=true` enables **only fixed consent/decline/revocation notices**. These control messages may be sent while `DRY_RUN=true`; this is an explicit exception so contacts can actually opt in. It does not enable AI replies. Keep `DRY_RUN=true` for initial testing.
- On the first new message from a private contact while Busy Mode is active, the assistant sends a disclosure explaining which configured AI endpoint may receive messages, local memory/history, automatic replies during Busy Mode, private owner summaries, and how to decline/withdraw. The original pre-consent message body is not stored or sent to the AI.
- The person must reply exactly `I CONSENT TO PERSONAL GATEKEEPER` **after that disclosure was sent in the same chat**. Sending the phrase without a recorded disclosure is not sufficient; the app asks again and does not grant permission.
- `NO AI` declines. `STOP AI` or `REVOKE AI CONSENT` withdraws previously granted permission. Revocation stops future AI processing and deletes locally stored history, contact memory, issue/report content, and events for that chat. It cannot recall data already processed by a provider.
- Consent is scoped to one private chat and expires after 90 days. After expiry, processing pauses, saved chat data is cleared, and the app requests renewed consent on a later message. If someone previously declined or revoked consent, a fresh disclosure must be delivered before a later opt-in can be accepted; an old disclosure is not reused.
- Group and channel chats are ignored. New consent prompts are only sent while Busy Mode is active; messages received while idle are ignored without retaining their text. The assistant handles consented messages with AI only when Busy Mode is enabled; live replies also require `DRY_RUN=false`. Manual replies from your account pause AI replies for that contact during the active busy session.
- `/consents` in your private owner bot chat lists contact consent status and expiry. The dashboard also shows recorded consent status. Message bodies are not logged for unconsented chats.

### Safe first run

Enable only the personal connector and consent notice flag, retain `DRY_RUN=true`, turn Busy Mode on for a short test window, then ask a trusted contact to send a harmless private message. Verify that the disclosure appears, reply with the exact consent phrase, and send a second harmless message. The second message should reach the AI decision pipeline and show a `[DRY RUN]` response in the terminal without delivering an AI reply. Finally, send `STOP AI` and verify the consent shows revoked and the local conversation data is cleared. Only after reviewing behavior should you consider setting `DRY_RUN=false`.

The personal Telegram client uses `teleproto`, a maintained MTProto client library. The API login is through Telegram's official client API, but this is still an unofficial client application. Telegram may change policies, challenge sessions, or restrict API access; no implementation can promise zero risk.

## Telegram Business setup

The connector supports two distinct Telegram paths:

- **Standalone bot chats:** people can message the bot directly and, while Busy Mode is enabled, the assistant processes the chat using the common AI/memory/queue pipeline. This is the free option for testing or asking people to contact the assistant bot. It does **not** read messages they send to your personal account.
- **Personal inbox via Telegram Business:** the connector handles `business_message` updates only when the account is connected to an eligible Business bot setup and the relevant chat permissions are granted. A normal bot cannot read your personal inbox.

Your configured owner control chat is reserved for slash commands and reports. To test AI handling through the standalone bot, send a normal text message to the bot **from a different Telegram account**, not from the owner control chat. Busy Mode must be ON; keep Dry-run ON initially so the assistant's reply is logged but not sent. The sender must message the bot directly; this will not make the bot see conversations the sender has with your personal account.

At startup, the console warns if no Business connection has been recorded. When Telegram sends an update, the app logs the update type and ID without the message body. Normal text sent to the bot's own private chat is explicitly logged as ignored unless it is a supported owner command. Use `/telegram` in the owner bot chat to view the stored connection status and `can_reply` permission. These diagnostics cannot make Telegram deliver personal-inbox messages if the account is not connected to a supported Business bot integration.

1. In BotFather, enable the Business/Secretary capability for the bot as described in Telegram's current docs.
2. In Telegram Business settings, connect the bot to your account and select only the private chats it is allowed to manage. Grant reply permission (`can_reply`).
3. Send a test message from an allowed private chat while Busy Mode is enabled and Dry-run is on. The message ID should appear in Activity.
4. If the account connection is not detected, check connector status and bot permissions. The Bot API's long-polling mode may not work while a webhook is configured for the same bot; use a dedicated bot or remove the webhook before testing this app.

Official references:

- [Telegram Bot Features — Business Bots](https://core.telegram.org/bots/features)
- [Telegram API — Connected Business Bots](https://core.telegram.org/api/bots/connected-business-bots)

Telegram's business-bot capabilities and eligible chat scope are controlled by Telegram and the rights you grant. This app does not bypass those permissions.

## Optional WhatsApp integration (unofficial)

**Caution:** `whatsapp-web.js` automates WhatsApp Web through an unofficial interface. Its maintainers warn that WhatsApp may restrict/block accounts using unofficial clients. Do **not** connect your primary number unless you accept that risk; preferably use a dedicated number you can afford to lose. The most supported alternative is Meta's official business platform, but that is not a drop-in API for a personal WhatsApp inbox.

To install the optional packages (from this folder):

```bash
npm install whatsapp-web.js qrcode-terminal
```

Then add to `.env`:

```dotenv
WHATSAPP_ENABLED=true
```

Restart the app and scan the QR code using WhatsApp → Linked devices. The local authentication session is stored in `.wwebjs_auth/`; do not upload or commit it. This connector ignores groups, status updates, and messages sent by your own account. It is disabled by default.

Reference: [whatsapp-web.js project and its account-risk disclaimer](https://github.com/wwebjs/whatsapp-web.js)

## Persistent memory, queue, and owner handoff

- Recent history is stored per conversation and bounded to the latest 30 messages.
- The AI may propose a short memory summary and stable, non-sensitive facts. These are saved separately and added to future prompts for that exact contact only. You can delete saved contact memory in the dashboard; this does not delete recent conversation history.
- `wait`, `clarify`, `urgent`, `handoff`, and other owner-alert cases can create or update a persistent open issue. The dashboard sorts open issues by priority and latest activity.
- New unresolved issues are reported to the private owner bot chat. Repeated non-urgent updates are rate-limited by issue state to reduce notification spam. Failed notifications are visible in Owner report delivery.
- At Busy Mode end, the app disables auto-replies and sends a queue summary to the owner chat if configured. While offline, the process cannot receive or handle messages; it does not claim otherwise.
- `/takeover` pauses AI replies for one conversation. `/resume` permits AI handling again, subject to Busy Mode. The dashboard provides the same controls.
- Marking an issue resolved closes the tracked item; it does not delete message history or contact memory.

The persistent state is still a local JSON file, not SQLite. The write operation is atomic for normal single-process use, but this MVP is not intended for multiple concurrently running instances. Back up `data/state.json` before testing important workflows.

## How urgency works

The AI is asked to consider consequences and time sensitivity, not just keywords like "urgent". Examples that should be escalated include immediate danger, serious time-sensitive health/safety concerns, active fraud/account compromise, a critical production outage, or a deadline before you're available. Ambiguous messages should result in a clarifying question or human handoff. You can customize interruption behavior per contact.

This is still an MVP, not a reliable emergency-dispatch service. Keep real notifications enabled on your messaging apps and never rely on this assistant as the only path for emergencies.

## Local data and privacy

- Runtime state, consent records, recent message history, contact memory, issues, and owner-report delivery records are saved in `data/state.json`.
- `.env` contains secrets and is git-ignored.
- The personal Telegram session is stored in `data/telegram-user.session` and git-ignored; treat it like a password.
- WhatsApp auth material is stored in `.wwebjs_auth/` and is git-ignored.
- Keep the dashboard bound to localhost; do not expose its port to the network.
- Message text is sent to your configured AI provider for classification and reply generation. Choose a provider whose privacy practices you accept, or configure a supported local model server.
- This MVP does not upload your local state to an app server.

To reset local state, stop the app and remove `data/state.json`. This permanently deletes locally saved profiles, alert history, deduplication state, and conversation history.

## Known limitations / next steps

- Browser desktop notifications only appear while the dashboard is open and permission is granted; alerts are also written to the dashboard and terminal. A native OS notification adapter can be added next.
- The WhatsApp adapter is unofficial and may break when WhatsApp Web changes.
- Telegram connection must explicitly allow the private chats you want managed.
- Photos, voice notes, and other non-text messages are not interpreted yet; the assistant asks what the sender needs rather than pretending to understand unseen media.
- There's no sender directory sync yet. For now, use the contact IDs listed in Activity to bind profiles.
- The owner notification adapter currently uses Telegram; WhatsApp owner reporting is not implemented as a second independent channel.
- The owner bot receives management commands through a configured private Telegram chat. Group control commands are deliberately not enabled.
- The test suite runs with `npm test`. Type checking requires the development dependencies from `npm install`.
- For production use, add encryption-at-rest for stored conversation history, stronger approval controls, integration health checks, and native notifications before relying on it for sensitive conversations.
