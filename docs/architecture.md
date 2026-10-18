# Architecture

Larpmaxxing is a local single-user application. Node 22 serves vanilla browser modules and a small JSON API. The `jose` dependency verifies OpenID Connect signatures. No hosted database, agent framework, fine-tuning, or vector store.

## Main path

`onboarding → imported sources → baseline analysis → personality grouping → reviewed profile → plan → draft → validation/review → feedback`

- `server/onboarding.mjs`: model/source gates, Google loopback OAuth with PKCE/state, paste attribution, bounded source imports and readiness.
- `server/chatgpt-auth.mjs`: official dynamic OAuth registration, PKCE/state/nonce, signed ID-token verification, account-scoped private token storage, refresh and revocation. No reading credentials from other apps.
- `server/response-stream.mjs`: bounded SSE parser requiring a terminal completed response before output can be saved.
- `server/model-access.mjs`: official model-list verification, server-memory credentials, available model catalog and generation revision. Holds one primary connection (ChatGPT or an API key) and an optional Claude plan, and resolves the drafting, critique and analysis routes. Changing model, effort, routes or connections invalidates old work.
- `server/claude-plan.mjs`: locates the user's Claude Code CLI, checks its plan sign-in, and runs `claude -p` with no tools, customizations or saved session, an allowlisted environment and content on stdin. Maps CLI events to fixed error categories.
- `server/model-options.mjs`: conservative documented effort capabilities, server-side validation and request limits. Unknown model IDs retain provider defaults.
- `server/source-mcp.mjs`: actual JSON-RPC MCP lifecycle and read-only app-owned in-process tools. Tool selection is deterministic application code, not model output.
- `server/integrations.mjs`: fixed official Gmail/Slack endpoints, identity attribution, date limits, quote/signature exclusion and strict Slack 1:1 validation.
- `server/evidence.mjs`: normalized conversations, branches, local discovery, explicit correction/approval evidence and conservative bilingual rules.
- `server/learning.mjs`: bounded model analysis jobs, exact citation validation, proposed preferences/examples/personalities, deduplication and review-state preservation. Jobs store IDs/hashes, not extra message copies. Cancellation discards late output; resuming continues the next unsaved batch.
- `server/personalities.mjs`: all-source baseline jobs with a fixed analysis model, bounded analysis batches, then a synthesis step grouping the evidence by audience into at most five personalities in total, channel-independent and written per language in that language. Sources carry the user's "who is this with" note. Job state lives in `personalityJobs`; source fingerprints and profile versions protect commits.
- `server/storage.mjs`: atomic external storage, authoritative Markdown profile, version hashes and undo snapshots. JSON metadata stays beside readable record text.
- `server/workspace.mjs`: bridges the verified session to learning and drafting, sends planning and generation to the drafting route, critique to the critique route and learning to the analysis route, allowlists request fields, guards model/profile revisions before each model call and before persistence. Blinded comparison keeps intent fixed and changes only personalization.
- `server/providers.mjs`: fixed OpenAI Responses and Anthropic Messages adapters, structured JSON extraction, timeouts, redirect refusal and sanitized failures. Session credentials never fall back to a different environment account.
- `server/drafting.mjs`: routing (a model picks personality, channel, language and du/Sie when left automatic), scope/example selection, global context, preflight, model planning, drafting with channel-specific form, literal checks and independent subjective critique. Current intent supplies facts; historical examples supply style.
- `server/adjust.mjs`: the feedback agent below each draft. It proposes a personality change, a global context change, another personality or a one-message fix; proposals are validated, shown, and saved only when the user applies them.
- `server/workflow.mjs`: import batching, source deletion, feedback comparisons and proposed updates. Factual edits stay separate from reusable style.
- `public/app.js`: setup and source connection flows. `public/workspace.js`: Write / Your voice / Sources. Private content is escaped, not interpreted as HTML.

## Boundaries

The model provider and historical source provider are independent. Only explicit Create personalities, Analyze, Draft, Revise or Compare actions send content to a model. The browser preview describes that payload. Read-only account imports do not invoke a model. Models receive no tools, credentials or authority from source instructions.

Creating personalities is a two-stage baseline: analyze every imported source, then synthesize the verified observations into one overall set. The analysis model and effort are selected independently of drafting. Resuming can change effort for subsequent steps; successful-step history retains the settings actually used. The count target must not manufacture distinct voices from sparse evidence. Detailed guidance, applicability, evidence and uncertainty remain reviewable; users can accept, edit, merge or split personalities afterward.

Learning model output is not a profile decision. Source IDs and exact excerpts are validated locally. Sent samples remain sent until the user explicitly approves them. Contradictions and weak evidence remain visible. Explicit decisions survive later analysis; situation corrections do not silently become global style.

The UI edits the same profile read from `profile.md`. Version conflicts require reload. Source deletion removes derived records and clears undo snapshots, preventing resurrection. Independent feedback remains a separate user-supplied source of evidence. Personality jobs containing a deleted source are removed with their intermediate summaries. Internal `modes`, `modeId` and `scope.type: mode` fields remain for compatibility with existing profiles; the interface calls them personalities. Detailed personality guidance is explicitly loaded on every draft and remains subordinate to current instructions and explicit preferences.

The HTTP layer checks loopback Host and Origin, disallows cross-site API reads/writes, requires a per-process token for mutations, serves an asset allowlist, and sets a strict CSP. The Gmail and ChatGPT cross-site callback paths use one-use OAuth state and PKCE; ChatGPT also verifies the ID-token signature, issuer, audience, expiry and nonce. Legacy draft/compare routes use the same verified-session workflow, so they cannot bypass new credential guards.

## Credentials and restart

Optional API keys and source tokens remain memory-only. ChatGPT connection records persist in a separate owner-only credential file and are refreshed automatically. Restart preserves sources, profiles and jobs; only API-key connections need key re-entry. Already imported sources do not require reconnecting their account to analyze or draft. Ongoing learning jobs recover as ready for explicit resume; an interrupted generation is not saved as completed.

Google Desktop OAuth is available with each user's own client configuration. Slack uses installed-app user tokens, not a fictitious local HTTP OAuth redirect. [Source setup](mcp-sources.md).

## Model protocols

API-key OpenAI uses Responses with application instructions in a developer input message, the serialized evidence in a separate user message, JSON text format, `max_output_tokens`, and `store:false`. The explicit JSON instruction therefore appears in conversation input even when the evidence never mentions JSON, following the documented JSON-mode example. Anthropic uses Messages with top-level `system`, user content and `max_tokens`. Parsed output must then pass domain schema checks; truncated/incomplete responses do not count as successful output. Provider access, token limits and JSON support may still vary per selected model.

ChatGPT plan requests use the same public Responses endpoint with OAuth, `stream:true`, `store:false`, and no unsupported `max_output_tokens`. A stream that ends early or reports failure cannot save a draft. Plan eligibility and usage errors direct users to ChatGPT settings; no automatic switch to separately billed API access occurs.

Claude plan requests run the user's signed-in Claude Code CLI once per request, with the instructions in a private temporary file and the serialized evidence on stdin. Claude Code has no JSON mode, so the reply's single JSON object is extracted and validated as usual. Effort maps to `--effort`. [Claude plan details](claude-plan.md).

Explicit effort maps to OpenAI `reasoning.effort` or Anthropic `output_config.effort` only for documented model IDs. Provider-default selection omits the field. Known reasoning models receive an output ceiling that accounts for reasoning as well as visible JSON; requests have a finite timeout and are not automatically retried. The capability table is intentionally conservative and needs updates when providers add models.

Provider failures become typed errors with application-authored explanations and allowlisted diagnostic fields, never raw provider messages or response bodies. Personality validation errors also use trusted application-authored messages. Unexpected exceptions retain a generic fallback. Jobs preserve prior successful steps on failure; the UI displays the cause and an explicit resume action.

Official references: [OpenAI Responses migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create).

Effort and budgeting: [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Anthropic effort](https://platform.claude.com/docs/en/build-with-claude/effort).

## Known limits

Discovery is conservative local keyword/evidence matching, not a universal semantic search. Excerpts can omit nuance, intermediate summaries can lose details during global grouping, and exact matching cannot prove a proposed interpretation. Duplicate paraphrases may require manual merging. Quote cleanup is heuristic. Hard constraints are mechanically checkable; voice and full factual completeness need human review. Comparison quality has not been measured on the owner's real voice.
