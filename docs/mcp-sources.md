# Source connections for Larpmaxxing

Checked against official documentation on 17 October 2026. The application uses an **app-owned local MCP adapter over the official Gmail and Slack APIs**. It does not connect to Google's or Slack's hosted MCP endpoint, and does not borrow connectors or login sessions from ChatGPT, Claude, or Codex.

## Why a local adapter

Google now provides a Gmail remote MCP server, but its documentation requires membership in the Google Workspace Developer Preview Program plus a configured Cloud project and OAuth client. That is not a dependable prerequisite for every person cloning this repository. [Google Gmail MCP configuration](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server)

Slack also provides a remote MCP server, with a registered app identity and OAuth. Its documented availability is limited to internal apps and Marketplace apps. The local adapter uses the established Web API with narrowly scoped user access, and enforces the app's 1:1-only restriction before fetching history. [Slack MCP overview](https://docs.slack.dev/ai/slack-mcp-server/)

This is an implementation choice, not a claim that official remote MCP is unavailable. A later release can add those transports without changing evidence storage. Pasting emails remains available without any account connection.

## Gmail

Enable the Gmail API in your own Google Cloud project, configure consent and test users as appropriate, and create a Desktop OAuth client. Configure `GOOGLE_CLIENT_ID` and, where issued, `GOOGLE_CLIENT_SECRET` on the server to enable the app's sign-in flow. The local browser callback uses Google's documented loopback route. An existing OAuth access token can also be supplied in the source connection form. [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)

Request only `https://www.googleapis.com/auth/gmail.readonly`. The app does not need send, compose, or modification permissions. A provider may require additional consent, testing or verification for restricted scopes. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)

The adapter first verifies the mailbox using `users.getProfile`, then imports bounded batches of threads containing sent mail using `in:sent`. Full threads retain incoming context while the initial selection prioritizes evidence of the user's own writing. Optional after/before filters become Gmail search parameters and are checked again on each message, since a matching thread can include messages outside the selected period. Missing dates leave those bounds unrestricted, but do not remove batch limits. [Profile](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile), [thread list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list), [date filtering](https://developers.google.com/workspace/gmail/api/guides/filtering)

Thread imports default to 20 threads, at most 100 requested threads, 40 upstream requests and 1,000 messages. The actual result may be smaller. Warnings identify bounded or incomplete imports. Sent-mail labels and authenticated mailbox identity identify the user's writing. Sent does not mean approved. Draft labels, attachments, and quoted content are excluded from authored evidence where identifiable; cleanup is heuristic and the original remains inspectable.

## Slack, 1:1 only

Create your own internal Slack app, add **user** scopes `im:read` and `im:history`, install it in your workspace, and obtain its authorized user OAuth token. Workspace administrators may need to approve installation. Supply that token through the source connection form; do not use a bot token. This local HTTP app currently does not provide a Slack OAuth redirect flow. [Slack OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/)

The adapter verifies the human identity with `auth.test`, requests `conversations.list` with `types=im`, and presents only 1:1 conversations for selection. Listing DMs verifies identity and read-metadata access; missing history permission is reported when importing. [Identity verification](https://docs.slack.dev/reference/methods/auth.test/), [conversation listing](https://docs.slack.dev/reference/methods/conversations.list/)

Optional `users:read` permission allows the selector to show counterpart names. The adapter uses `users.info` only for people in the returned 1:1 list, with at most 20 unique name lookups per page. It retains only a display name, real name or username and discards the rest of Slack's user object. It does not request `users:read.email`, download avatars, or return contact/profile details. Missing permission, rate limits and unavailable names fall back to user IDs without blocking source selection. The interface lists 20 conversations per page; callers requesting larger pages receive a warning when the name-lookup bound is reached. [Slack user information and scopes](https://docs.slack.dev/reference/methods/users.info/)

Before every import, `conversations.info` must confirm the selected conversation ID and `is_im: true`, without channel, group or multi-party flags. Only then are history and replies requested for that same ID. No search tool, channel import tool, group DM tool, or write tool is exposed. Author attribution requires the authenticated human user ID; bot messages are never their voice evidence. [Conversation validation](https://docs.slack.dev/reference/methods/conversations.info/)

History defaults to 30 root messages per selected DM, with a maximum requested count of 200, 40 upstream calls and 1,000 total messages including replies. API pages request at most 15 messages. Date bounds are optional. Workspace retention and API rate limits can prevent full retrieval; warnings report partial imports and `Retry-After` where available. Importing an earlier date range is safe because source IDs remain stable for deduplication. [History and rate limits](https://docs.slack.dev/reference/methods/conversations.history/), [thread replies](https://docs.slack.dev/reference/methods/conversations.replies/)

## MCP implementation and data boundary

`server/source-mcp.mjs` implements JSON-RPC 2.0 and MCP protocol version `2025-06-18`: `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. The transport is in-process and app-owned, not a public MCP endpoint. The deterministic application client performs the initialization handshake. Tools cannot run before it completes. Unknown tools and arguments fail closed. [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle), [MCP tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)

Exposed tools:

| Tool | Input | Result |
| --- | --- | --- |
| `gmail_status` | none | Authenticated mailbox address, verified status |
| `gmail_import` | Optional `after`, `before`, `maxResults` | Normalized conversations and warnings |
| `slack_list_dms` | Optional `cursor`, `maxResults`, `includeNames` (default true) | Conversation IDs, counterpart user IDs, optional names, next cursor, verified identity |
| `slack_import_dm` | `channelId`, optional `after`, `before`, `maxResults` | Normalized conversations and warnings |

Credentials stay in server memory for the active session and are sent only to their provider in authorization headers. They are not written into source files, returned in status responses, forwarded to a language model, or included in normal logs. Source connection and import do not invoke a generation model. Imported text is untrusted data; it cannot choose tools, change endpoints, expand scopes, or issue instructions to the application. Disconnecting removes session credentials; deleting an imported source is a separate operation.

## Verification and current limits

The tests use synthetic responses and cover the MCP handshake, read-only tool allowlist, argument validation, credential isolation/redaction, Gmail bounds and attribution, Slack user identity, filtering of channels/group DMs, conversation-type verification before history, same-ID history/reply requests, and rate-limit errors. **No live Gmail or Slack import was tested with a real account during implementation.** Each installation must supply its own credentials and access grants.

This stage does not provide unlimited background scraping, a general MCP marketplace, remote-MCP OAuth, automatic sending, or unattended token persistence. It establishes selected, bounded source ingestion for the personal writing harness.
