# Use your ChatGPT plan

Choose **Continue with ChatGPT** in setup, sign in with your own account, and authorize Larpmaxxing to use your plan. Eligible Plus and Pro users can use plan allowance without a separately funded API key. Availability depends on account, workspace, region and provider policy. Review plan/app limits and any optional credit usage in [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

The existing source, personality and drafting flows are unchanged. OAuth return navigation is allowed only for the public app shell; private APIs retain cross-site protections. Only explicit analysis and drafting send the disclosed excerpts and instructions. Sign-in does not retrieve ChatGPT conversations or memories. Existing imports do not need to be repeated. You can resume an older OpenAI baseline if its model remains in your ChatGPT model list; otherwise create a new baseline with an available model.

## What is saved

The server keeps its own `chatgpt-auth.json` beside the other private application files, outside the repository. It contains a stable random host ID and distinct registrations for each authorized account/workspace, with validated identity, issued client ID, tokens, expiry and scopes. Files are atomically replaced with Unix mode 0600 inside the private directory (0700). On Windows, protect the user data directory using account ACLs. This is not encrypted storage; keep backups private. Never copy this file into GitHub or a support transcript.

The browser receives account labels and sign-in URLs, never access, refresh or ID tokens. No cookies, tokens, or authentication files are read from ChatGPT, Codex or Claude installations. Saved connections restore on startup. Near expiry the server serializes refresh requests and replaces rotating tokens together. Run only one server per private data directory; cross-process token refresh locking is not implemented.

**Sign out** stops using and clears local tokens, attempts to revoke the renewable session, and retains only the account/client mapping and host ID for later sign-in. If remote revocation cannot be confirmed, the app tells you to disconnect it in ChatGPT settings. Temporary network errors preserve saved credentials; terminal refresh errors require sign-in again. Account switching never mixes another registration’s client ID or tokens.

## Protocol and limits

- Official dynamic public-client registration, no client secret or partner API key.
- Loopback callback on `127.0.0.1`, fresh PKCE, state and OIDC nonce; one-use callback state.
- `jose` checks the ID-token signature against OpenAI JWKS, issuer, audience, expiration, nonce and returning account identity.
- Plan use requires the granted `chatgpt.tokens.use.direct` scope. Identity-only sign-in stays visible but cannot perform inference.
- Model catalog comes from `GET https://api.openai.com/v1/models`; only listed slugs are selectable. Catalog access is not a successful inference test.
- Inference uses public `/v1/responses`, `store:false`, `stream:true`, explicit developer/user context and no tools. Unsupported output-token caps are omitted on this route. Completion must reach `response.completed`; partial streams and terminal usage failures cannot be saved as results.
- Effort remains selectable for documented models. Usage can be restricted by the plan or an app-specific limit. The app does not silently switch to API billing.
- No Claude Code bridge or direct Claude subscription login is implemented in this update.

## Verification

Synthetic tests exercise sign-in, PKCE parameters, signature and claim validation, state replay, refusal, client/identity mismatch, missing plan scope, account separation, persistence, refresh rotation and revocation. HTTP tests check CSRF and token exclusion. Streaming tests check the documented request shape and reject partial/failed results. OpenAI’s live discovery endpoint was checked successfully. Live sign-in and model-list access have been observed. Successful subscription inference still needs separate verification; synthetic success is not live inference verification.

Official sources: [overview](https://developers.openai.com/siwc/token-sharing-open-source), [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [accounts and refresh](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [errors](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery).
