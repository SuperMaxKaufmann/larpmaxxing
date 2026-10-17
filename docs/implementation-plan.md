# Main harness completion

17 October 2026. Extend the working onboarding into a lean daily loop, keeping existing private sources and connections separate from publishable code.

1. Retain API-key and source onboarding. Select a usable model only from the authenticated catalog and use that same session for inference.
2. Add a three-view workspace: Write, Your voice, Sources. Remove neon accents and CRT effects; use charcoal, ash and subtle dark marble with restrained Greek references.
3. Analyze selected source excerpts in small cancellable/resumable batches. Preserve sequence, attribution, exact citations, conflicts and sparse evidence. Every inferred change is proposed, never automatically accepted.
4. In Your voice, choose an analysis model and create a baseline of 3–5 detailed personalities from all imported sources. Analyze bounded batches into accumulated evidence, then synthesize one coherent set. Review and fine-tune proposals; preserve existing decisions. Explicit user decisions win; scoped corrections remain scoped. Keep file/UI edits consistent and support undo.
5. Draft from mandatory intent and optional context. Load applicable rules/examples each time, plan for missing information, generate, validate hard rules and review meaning/style. Provide edits, copying and targeted revisions.
6. Record approvals, unsuitable drafts and edited finals, with factual/style classification and deliberate scope. Compare personalized drafts against a blinded generic baseline using new scenarios.
7. Test synthetic full flows and failure boundaries. Preserve connected sources; explain that the existing memory-only credentials require re-entry after the backend restart. Do not use real private messages as fixtures or perform unrequested live inference.

Remaining roadmap: OS credential storage, better import compatibility and quoted-content parsing, richer archive summaries, configurable personal evaluation sets. Automatic sending remains outside scope.


## Subscription-first access update

Make official ChatGPT plan OAuth the primary connection, retain API-key access as optional, persist only app-owned credentials outside the repository, and keep generation provider independent of imported evidence. Validate identity, consent scopes, callback state and refresh rotation; use public Responses streaming and reject partial completion. Test with synthetic credentials before asking the owner to authorize the live app. Do not borrow tokens from desktop apps or silently fall back to API billing. See [implementation and verification](chatgpt-sign-in.md).
