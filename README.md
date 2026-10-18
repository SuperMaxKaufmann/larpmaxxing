# Larpmaxxing

**Write like Plato. Exist like Dionysus.** A local, single-user writing harness for email, Slack, WhatsApp and outreach. Dark stone, quiet controls, your own voice. The Greek references are branding, not a preset writing persona.

Connect a model, bring your writing, review what it learns, then draft. Personalization is evidence you can inspect and change, not a hidden memory or a universal style checklist. Nothing sends messages automatically.

## Run

Install Node.js 22 or newer:

```sh
npm install
npm start
```

Open [Larpmaxxing](http://127.0.0.1:3210). No frontend build step. The small `jose` dependency verifies ChatGPT sign-in tokens.

**Updating:** run `npm install`, restart the Node server, then reload. ChatGPT and Claude plan connections survive normal restarts; ChatGPT renews automatically. API keys and Gmail/Slack tokens remain session-only. Already imported sources and profiles remain usable without reimport.

## The main loop

1. **Connect:** choose **Continue with ChatGPT** and authorize plan usage with an eligible Plus or Pro account. The app saves its own OAuth connection privately outside the repository and renews it across restarts. Model choices come from the connected account. Plan and app usage limits apply; use **Manage usage** to review them. With Claude Pro or Max, choose **Continue with Claude** instead or as well: sign in to Claude Code yourself with `claude auth login`, and the app runs it for your requests. Larpmaxxing never sees your Claude sign-in. **Use an API key instead** remains optional for separately billed OpenAI or Anthropic API access. Model listing does not verify successful inference. [How ChatGPT sign-in works](docs/chatgpt-sign-in.md), [how Claude plan access works](docs/claude-plan.md).
2. **Bring sources:** paste your outgoing emails or labeled threads, import Gmail, or select Slack 1:1 DMs. At least one source must contain your own writing. Choose date ranges when importing. Account access is separate from model access. [Connection setup](docs/mcp-sources.md).
3. **Create your baseline:** in Your voice, choose **Create baseline personalities**, select the analysis model and reasoning effort, and review what will be sent. The app analyzes all imported sources in manageable batches, then groups the evidence across batches into a target of **3–5 detailed personalities**. Analysis settings are independent of drafting settings. Progress is visible, cancellable and resumable. Resume lets you change effort for the remaining requests without repeating completed batches. A cancelled in-flight request may already have reached the provider; its result is discarded.
4. **Fine-tune your voice:** review the proposed personalities, including when each applies, its detailed guidance, supporting excerpts and uncertainty. Accept the useful baseline, then edit, merge, split or remove personalities as your understanding improves. Preferences and examples remain separately reviewable; sent messages need deliberate approval before reuse as good examples. Sources also retains focused learning for a selected set of conversations. Profile changes can be undone.
5. **Write:** enter what you want to say. Add conversation context if relevant. Choose a personality for a new message; existing context can suggest a personality with a reason, and you can override it. Language, channel and German du/Sie remain separate. Type normally or use your operating system's dictation in the intent field.
6. **Refine:** inspect the selected rules/examples and outbound payload, generate, edit and copy. Targeted revisions make the draft warmer, more direct, less formal, more detailed or shorter. Missing essential information stops drafting for clarification.
7. **Learn from corrections:** save an approved example, reject unsuitable wording or provide your edited final. Mark edits as stylistic, factual or mixed; choose this message, personality, recipient or global scope. Guidance is proposed for review. Factual edits do not silently become voice preferences.

The workspace has three views: **Write, Your voice, Sources**. Less common controls stay collapsed. The interface has no offline generator or simulated account mode.

Click the connected model in the header to choose a model and effort for each task: **drafting** (planning and writing), **critique** (reviewing each draft) and **analysis** (focused learning, and the starting choice for baseline personalities). Critique and analysis follow drafting until you choose otherwise. With ChatGPT and Claude both connected, each task can use either, for example ChatGPT for drafting and Claude Opus for critique. A task whose chosen account is not connected stops with an error instead of switching accounts. Effort choices are shown only for models whose support has been verified in official documentation; other models use the provider default. Higher effort can take longer and cost more. "Model default" omits an explicit effort setting. Analysis records retain the effort used for each completed step.

If analysis fails, its error now distinguishes model access, billing/rate limits, timeouts, output limits and invalid responses where the provider supplies a recognizable cause. Raw provider error text is never shown or logged. Completed batches remain available to resume, and retries are explicit. Older jobs retain their original diagnosis until resumed. Requests never silently switch from ChatGPT or Claude plan usage to API billing.

## Personalization boundaries

Incoming messages, unapproved AI drafts, corrections, user-written examples, sent messages and explicit approvals remain distinct. Requests such as “make this reply shorter” remain local unless the evidence explicitly generalizes them. Dictation supplies intent, not stylistic filler to learn.

Model-generated citations must refer to supplied conversation/message IDs and contain exact excerpts from the selected text. Unsupported references are dropped. Excerpt matching checks attribution, not whether a model's interpretation is correct. Every model-inferred rule and personality remains a proposal. Existing accepted, edited, rejected and disabled decisions are preserved when analyzing again.

The personality baseline scans all imported sources and combines evidence into one overall grouping. Its target is 3–5 personalities, not a requirement to invent distinctions: sparse evidence can produce fewer, with the limitation explained. Analysis uses the first 1,800 characters per message and up to 10 rolling observations with representative citations. These summaries are lossy; full originals remain local. Focused learning uses up to 200 selected sources per job. Job progress survives restart. Source/profile changes during an active call prevent stale output from being committed. Different phrasings of the same idea may still require manual merging.

Add **Never use em dashes** as a configurable hard rule with the banned literal `—` if that is your preference. The app does not impose it on everyone. Literal checks enforce configured punctuation and required phrases; model-assisted review checks content and style subjectively. Neither can guarantee tone or full semantic fidelity.

## Accounts and imports

- **Gmail:** an app-owned read-only local MCP adapter over the official Gmail API. Use your Google Desktop OAuth client or an authorized access token. Searches sent-mail threads and retains their incoming context. Date selections include both dates in UTC, checked per message. Bounded batches import up to 30 threads, subject to request/message limits.
- **Slack:** an app-owned read-only local MCP adapter over the official Web API. Use a human user token with `im:read` and `im:history`; optional `users:read` enables counterpart names. Select 1:1 DMs; channels, groups and bot identities are rejected before history is fetched. Slack browser OAuth is not implemented because its redirect requires HTTPS.
- **Paste:** explicitly identify your outgoing writing or supply `From:` / `Von:` headers and your email address for mixed threads. Quote/signature cleanup is heuristic.
- **Chatbot reports and exports:** advanced import retains the [Ask your existing chatbot](docs/ask-your-chatbot.md) prompt, selected transcripts and extracted export JSON. Reports are proposals, never verified memories. ZIP/attachments are not parsed. Import locally, then choose whether to send selected excerpts for learning.
- **WhatsApp:** pasted context and drafts; no account connection.

These source adapters do not borrow ChatGPT, Claude or Codex connections, and do not connect to hosted Google/Slack MCP services. See [access feasibility](docs/access-feasibility.md) and [source setup](docs/mcp-sources.md) for official documentation.

## Private data and model requests

Private data stays outside the publishable tree, in the existing compatibility directory:

- macOS: `~/Library/Application Support/Own Words`
- Linux: `$XDG_DATA_HOME/own-words` or `~/.local/share/own-words`
- Windows: `%LOCALAPPDATA%/Own Words`

Override with an absolute `OWN_WORDS_DATA_DIR` outside this repository. The old name intentionally preserves previous installations. `profile.md` is the human-readable source of truth; JSON metadata preserves scope, decisions, sources and conflicts. File edits are reloaded, and stale UI saves are rejected. `state.json` stores sources, jobs, drafts, feedback and your per-task model choices. This is local storage, not encryption at rest.

Keys entered in the UI stay only in server memory and authorization headers to their provider. They are not placed in browser storage, logs, source files, source records or model prompts. Restart or Disconnect model clears active API-key credentials. ChatGPT OAuth access, refresh and ID tokens are stored separately in `chatgpt-auth.json`, with owner-only file permissions, outside the source tree. Sign out clears them and attempts remote revocation. Claude plan access stores no credentials in this app: Claude Code keeps its own sign-in, and the app only remembers that you connected it. This file is protected by filesystem permissions, not encryption. Environment-injected tokens remain in the process environment until it exits. `.env.example` lists configuration; `.env` is not loaded automatically.

**Local storage does not mean local inference.** Starting a personality baseline sends bounded excerpts from all imported sources, source titles and attribution to the selected analysis model. Validated summaries are then sent for global grouping. Existing profile decisions stay local and are preserved; they are not sent during baseline creation. Focused learning sends only selected source batches. Drafting sends current intent/context, recipient/relationship, the selected personality, applicable accepted preferences, and a small number of style examples. Planning, generation and critique make up to three model requests. Comparisons make up to six. Historical numeric/contact details are masked in examples, but this is not anonymization. OpenAI requests use `store:false`; provider policies still apply.

Source messages are untrusted data. They cannot choose tools, change endpoints, expand account scopes or override application instructions. Models have no tools. Removing a source deletes its content and derived records and cancels related analysis jobs. Profile undo history is cleared on source deletion so it cannot restore deleted evidence.

The server binds to loopback, checks Host and Origin, requires a session mutation token, and has a public-file allowlist. No third-party frontend assets or analytics. Do not expose this single-user app as a public server.

## Test and evaluate

```sh
npm test
npm run check
```

Tests use synthetic messages and provider responses. They cover bilingual drafting evidence, attribution, branch approvals, rejected drafts, citations, scope/conflicts, repeated imports, batch cancellation/restart, source deletion, profile edits, session changes, hard constraints, intended content, historical fact leakage, feedback, private storage and HTTP boundaries. [Verification details](docs/verification.md).

The comparison action generates the same intent with and without personal guidance, randomizes sides, and reveals labels after your judgment. It does not add comparison drafts to the profile. Use new message scenarios held out from profile creation, judge voice and content separately, and record the reason for your choice. We do not claim a measured reduction in wording corrections without your evaluation.

Automated tests and browser QA use synthetic responses. They verify application behavior, not live model access or personalization quality. Model-list authentication does not establish inference permission or remaining allowance. Provider failures remain visible and completed analysis can be resumed.

## Architecture and roadmap

Vanilla browser JavaScript, Node ESM, and `jose` for signed identity-token verification. Imports/account tools, evidence analysis, Markdown profile storage, provider access, drafting/validation and feedback remain separate. [Architecture](docs/architecture.md).

Next: smoother credential persistence through an OS credential store, broader export compatibility, richer semantic discovery, more robust quoted-content parsing and personal evaluation sets. No agent framework, fine-tuning, hosted multi-user service or vector database is needed for this version.

MIT licensed. Fixtures are synthetic. Keep real archives, recipient details and credentials out of the source tree; inspect staged files before publishing. Each person runs their own copy with their own account and private data directory.
