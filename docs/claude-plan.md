# Use your Claude plan

Claude Pro and Max include no API access, and Anthropic does not allow third-party apps to run their own Claude.ai sign-in or to store subscription tokens. The supported route is the one this app uses: you sign in to the unmodified Claude Code CLI yourself, and Larpmaxxing runs `claude -p` for the requests you start. Requests count against your plan's usage limits, shared with your Claude chat and Claude Code use. [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [using the Agent SDK and `claude -p` with your plan](https://support.claude.com/en/articles/15036540).

This is for your own use on your own computer. If you share Larpmaxxing, every person signs in to Claude Code with their own account; the app never handles anyone's Claude credentials.

## Set up

1. Install Claude Code:

   ```sh
   curl -fsSL https://claude.ai/install.sh | bash
   ```

2. Sign in and choose your Claude Pro or Max account:

   ```sh
   claude auth login
   ```

3. In Larpmaxxing, choose **Continue with Claude** in setup, or **Add Claude plan** in the model dialog of the workspace.

The app looks for `claude` on `PATH`, then in `~/.local/bin`, `~/.claude/local`, `/opt/homebrew/bin` and `/usr/local/bin`. If it is installed elsewhere, start the server with `CLAUDE_CLI_PATH` set to its absolute path. The Claude Code copy bundled inside the Claude desktop app is not used; it does not share the app's sign-in.

## Choosing models per task

A Claude plan can be connected on its own or beside a ChatGPT plan or an API key. Click the model in the workspace header to choose a model and effort for each task:

- **Drafting:** planning and writing each draft.
- **Critique:** the review of each draft against your intent.
- **Analysis:** learning from selected sources, and the starting choice for baseline personalities. A baseline keeps the model it started with when resumed.

Critique and analysis follow drafting until you choose otherwise. Claude choices are **Claude Sonnet**, **Claude Opus** and **Claude Haiku**, the Claude Code aliases for the newest model of each family on your plan. Fable is not offered because on some plans it bills usage credits instead of your plan. Effort runs from low to max; Claude Code falls back to the highest level a model supports. [Model aliases and effort](https://code.claude.com/docs/en/model-config).

Choices are saved in `state.json` under `modelSettings`, with whether your Claude plan is connected. If a saved choice points to an account that is not connected, that task stops with an error naming it. It never switches to another account or to API billing. Disconnecting an account resets the tasks that used it to follow drafting.

## What happens on a request

Connecting runs only `claude --version` and `claude auth status`. It sends no prompt. It accepts a Claude.ai sign-in or a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, and refuses API-key, Console, Bedrock, Vertex or Foundry setups, which bill outside your plan.

Each model request starts one process:

```sh
claude -p --safe-mode --tools "" --strict-mcp-config --disable-slash-commands \
  --no-session-persistence --max-turns 1 --model <alias> --effort <level> \
  --system-prompt-file <private temp file> --output-format stream-json --verbose
```

- The request content travels on stdin, never in command arguments.
- `--system-prompt-file` replaces Claude Code's coding instructions with the app's writing instructions.
- `--safe-mode` skips CLAUDE.md, hooks, plugins, skills, MCP servers and auto memory but keeps your sign-in. `--bare` is not used because it ignores subscription sign-in.
- `--tools ""` leaves the model with no tools, as with every other provider.
- `--no-session-persistence` keeps these requests out of Claude Code's saved transcripts.
- The process runs in a new private temporary directory, removed afterwards.
- The process gets an allowlisted environment: home, path, locale, proxy and certificate settings, `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN`. Inherited `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, cloud-provider switches and a parent Claude Code session's settings are dropped. If the CLI still reports an API key as its credential source, the result is discarded.
- Timeouts and cancellation stop the process. Output is capped.

Claude Code has no JSON mode, so a reply may wrap its JSON object in a sentence; the app extracts the single object and validates it like any other provider's output.

## Errors

CLI output can echo the request, so it is never shown or logged. Failures map to fixed messages:

- **Not installed or not found:** install Claude Code or set `CLAUDE_CLI_PATH`.
- **Signed out or expired:** run `claude auth login`.
- **API or cloud billing:** sign in with your Claude account instead.
- **Usage limit reached:** wait for your plan to reset. [claude.ai → Settings → Usage](https://claude.ai/settings/usage).
- **Model unavailable on your plan:** choose another Claude model.
- **Account or plan problem, temporary outage, or other CLI failure:** check claude.ai or update with `claude update`, then retry.

Completed analysis batches remain saved after any failure. A failed critique keeps the draft and says why the review is missing.

## Limits

- Every request starts a process, which adds a few seconds. That is fine for drafting but adds up over many analysis batches.
- Responses are not streamed into the page.
- Model availability depends on your plan. Connecting confirms sign-in, not that every model or request will succeed.
- Disconnecting in Larpmaxxing does not sign Claude Code out. Run `claude auth logout` for that.

## Verification

Tests use synthetic CLI output and a fake `claude` executable. They cover locating the CLI, the allowlisted environment, sign-in checks, the exact flags, stdin-only content, temporary directory removal, error mapping, timeouts, per-task routing beside ChatGPT or an API key, saved choices, unavailable accounts and personality jobs. The signed-out output shape was checked against Claude Code 2.1.299. A live request with a signed-in Claude plan has not been verified.
