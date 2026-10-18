# Verification

Checked on 18 October 2026 with Node 22.23.1.

- `npm test`: 292 tests, covering local HTTP boundaries, source attribution and imports, personalization, drafting, feedback, provider errors, OAuth and streamed responses.
- `npm run check`: syntax and publishable-tree checks. Private data directories inside the checkout are refused; fixtures contain invented examples only.
- Browser walkthroughs used an isolated temporary store and explicitly synthetic model responses. Verified import, outbound batch preview, review of proposed personalities/preferences/examples, drafting, revision, scoped feedback and blinded comparison. Synthetic responses do not establish live inference access or output quality.
- Personality walkthroughs exercised multi-batch analysis, detailed proposals, manual editing, separate analysis/drafting models, preserved effort selection and resuming after a simulated output-limit failure.

## ChatGPT sign-in

OAuth tests exercise PKCE, one-use state, identity signatures and claims, callback replay, denied consent, returning-account mismatch, missing plan scope, account separation, persistence, rotating refresh tokens and sign-out. Status responses exclude credentials. HTTP tests prohibit cross-site access to private API routes and require mutation tokens. Streaming tests reject partial and failed terminal responses and verify the documented subscription request shape.

The OAuth-return regression reproduces the browser's cross-site navigation metadata on the redirect home. Only top-level GET navigation to the public application shell is allowed. Cross-site API reads/writes, iframe requests, programmatic requests, other paths, non-GET methods and rebinding Hosts remain blocked. Both ChatGPT and Gmail redirects are covered.

The official OpenAI discovery endpoint has been verified against the documented issuer, endpoints and RS256 support. Real account authorization and model-list access have been observed. Completed live subscription inference and personalization quality are not established by that check.

## Claude plan

Tests cover locating the CLI, the allowlisted child environment, sign-in checks for missing, signed-out and API-billing setups, the exact `claude -p` flags, content on stdin only, temporary directory removal, error categories from stream-json events, timeouts and cancellation, and per-task routing beside ChatGPT or an API key. End-to-end tests run a fake `claude` executable through the real process path. A browser walkthrough with that fake CLI covered connecting, the per-task model dialog, the baseline model picker, disconnecting and the signed-out message. The signed-out event shape was checked against Claude Code 2.1.299. A live signed-in plan request has not been verified.

## Personalities, routing and the feedback agent

Tests cover German-only and bilingual personalities (German headings, a section per language, no channel split), the five-personality limit with replacement of unreviewed proposals, the "who is this with" note reaching analysis, automatic routing with fixed overrides, the global context in drafting payloads, and the feedback agent's four outcomes, validation and stale-version refusal. A browser walkthrough with a fake Claude CLI covered the two-box Write page, the routing line, an agent personality change with redraft, the global context section and the two-way source screen. Live model quality for routing and the agent is not verified.

## Personalization coverage and limits

Tests cover English/German evidence, revision and approval lineage, branches, duplicate imports, incoming-message attribution, quoted content, explicit versus inferred guidance, global versus situation scope, conflicts, sparse evidence, rejected drafts, source deletion, resumable/cancelled learning, citation validation, Markdown edits and undo, stale profile/model guards, literal rules, required content, historical fact leakage, source search and scoped feedback.

The baseline includes all-source analysis beyond 200 sources, final synthesis, a three-to-five personality target without fabricated distinctions, separate model selection and preserved review decisions. Source data cannot grant model tool permissions. Profile changes and source deletion prevent stale results from being committed.

Tests cannot establish improved personal voice, complete semantic fidelity, arbitrary export compatibility, every signature convention, device dictation behavior or another person's account access. Use the comparison workflow and held-out messages for human review.

Optional API keys and source tokens are session-only. ChatGPT OAuth connections persist in their own protected file outside the repository. All fixtures and signing keys in tests are synthetic; no imported messages, personal profiles, recipients or real credentials belong in this project.
