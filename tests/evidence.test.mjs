import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeImport, discover, extractEvidence, proposeModes, separateQuotedContent } from '../server/evidence.mjs';

const fixtures = JSON.parse(await readFile(new URL('../fixtures/conversations.json', import.meta.url), 'utf8'));
const conversations = normalizeImport(fixtures).conversations;
const get = (id) => conversations.find((conversation) => conversation.id === id);

test('English revision history keeps rejected, approved and explicit scoped preferences distinct', () => {
  const result = extractEvidence(get('synthetic-en-colleague'));
  assert.equal(result.examples.find((example) => example.sources[0].messageId === 'en-a1').kind, 'rejected');
  assert.equal(result.examples.find((example) => example.sources[0].messageId === 'en-a2').kind, 'approved');
  assert.ok(result.preferences.some((preference) => preference.scope.type === 'audience' && preference.scope.value === 'Close colleagues'));
  assert.ok(result.preferences.some((preference) => preference.category === 'hard' && preference.banned.includes('—')));
  assert.ok(result.preferences.filter((preference) => /this (reply|message)/i.test(preference.text)).every((preference) => preference.scope.type === 'situation'));
  assert.ok(result.preferences.every((preference) => preference.status === 'proposed' && preference.sources[0].excerpt));
});

test('German revisions retain local brevity, Sie wording, and language scope', () => {
  const result = extractEvidence(get('synthetic-de-revisions'));
  assert.equal(result.examples.filter((example) => example.kind === 'rejected').length, 2);
  assert.equal(result.examples.filter((example) => example.kind === 'approved').length, 1);
  assert.ok(result.preferences.some((preference) => /kürzer/.test(preference.text) && preference.scope.type === 'situation'));
  assert.ok(result.preferences.some((preference) => /Sie bleiben/.test(preference.text)));
  assert.ok(result.preferences.some((preference) => preference.scope.type === 'language' && preference.scope.value === 'de'));
});

test('approval follows a parent edge, not export order or the final AI message', () => {
  const result = extractEvidence(get('synthetic-branch'));
  assert.equal(result.examples.find((example) => example.sources[0].messageId === 'branch-a1').kind, 'approved');
  assert.equal(result.examples.find((example) => example.sources[0].messageId === 'branch-a2').kind, 'rejected');
  assert.equal(extractEvidence(get('synthetic-sparse')).examples[0].kind, 'ai-unknown');
});

test('ChatGPT mapping retains branches, skips empty root nodes and merges duplicate exports', () => {
  const exportItem = { id: 'graph', title: 'rewrite', mapping: {
    root: { parent: null, message: null },
    u: { parent: 'root', message: { id: 'u', author: { role: 'user' }, content: { parts: ['Draft a note'] }, create_time: 1700000000 } },
    a: { parent: 'u', message: { id: 'a', author: { role: 'assistant' }, content: { parts: ['Hi Alex, thanks!'] } } },
    b: { parent: 'u', message: { id: 'b', author: { role: 'assistant' }, content: { parts: ['Dear Alex, thank you.'] } } },
    yes: { parent: 'a', message: { id: 'yes', author: { role: 'user' }, content: { parts: ['Perfect!'] } } },
  } };
  const normalized = normalizeImport([exportItem, structuredClone(exportItem)]);
  assert.equal(normalized.conversations.length, 1);
  assert.equal(normalized.conversations[0].messages.length, 4);
  assert.equal(normalized.conversations[0].messages[0].parentId, null);
  const result = extractEvidence(normalized.conversations[0]);
  assert.equal(result.examples.find((example) => example.sources[0].messageId === 'a').kind, 'approved');
  assert.equal(result.examples.find((example) => example.sources[0].messageId === 'b').kind, 'ai-unknown');
  assert.equal(extractEvidence(normalizeImport([exportItem]).conversations[0]).examples[0].id, result.examples[0].id);
});

test('Claude exports preserve human/assistant sequence and text content blocks', () => {
  const [conversation] = normalizeImport([{ uuid: 'claude-1', name: 'Nachricht', created_at: '2026-09-01T00:00:00Z', chat_messages: [
    { uuid: 'cu', sender: 'human', text: 'Bitte diese Nachricht lockerer formulieren.' },
    { uuid: 'ca', sender: 'assistant', content: [{ type: 'text', text: 'Hallo Kim, danke für deinen Vorschlag.' }] },
    { uuid: 'cu2', sender: 'human', text: 'Perfekt!' },
  ] }]).conversations;
  assert.equal(conversation.source, 'claude');
  assert.equal(conversation.messages[1].parentId, 'cu');
  assert.equal(extractEvidence(conversation).examples[0].kind, 'approved');
});

test('plain unlabelled text never becomes user writing; chosen manual kinds are deliberate', () => {
  const plain = normalizeImport('Always write concise replies.');
  assert.equal(plain.conversations[0].messages[0].role, 'other');
  assert.equal(extractEvidence(plain.conversations[0]).preferences.length, 0);
  const explicit = normalizeImport('Never use em dashes.', { kind: 'explicit-preference' });
  assert.equal(extractEvidence(explicit.conversations[0]).preferences[0].scope.type, 'global');
  const dictated = normalizeImport('Um, please always use very formal wording, uh.', { kind: 'dictation' });
  assert.equal(extractEvidence(dictated.conversations[0]).preferences.length, 0);
  assert.equal(extractEvidence(dictated.conversations[0]).examples[0].kind, 'dictation');
});

test('a manual import selector does not relabel all authors in a historical JSON archive', () => {
  const imported = normalizeImport({ id: 'historical', messages: [
    { role: 'user', text: 'Please write a reply.' },
    { role: 'assistant', text: 'Dear Alex, thank you.' },
    { role: 'other', text: 'Someone else wrote this.' },
  ] }, { kind: 'approved' });
  const result = extractEvidence(imported.conversations[0]);
  assert.equal(result.examples.find((example) => example.text === 'Dear Alex, thank you.').kind, 'ai-unknown');
  assert.equal(result.examples.find((example) => example.text === 'Someone else wrote this.').kind, 'incoming');
  assert.ok(!result.examples.some((example) => example.kind === 'approved'));
});

test('selected transcripts preserve multiple rounds and stable IDs across repeated imports', () => {
  const text = 'User: Draft a message.\nAssistant: Dear Pat, thank you.\nUser: Too formal, please make this reply warmer.\nAssistant: Hi Pat, thanks for taking a look!';
  const a = normalizeImport(text), b = normalizeImport(text);
  assert.deepEqual(a, b);
  assert.equal(a.conversations[0].messages.length, 4);
  const result = extractEvidence(a.conversations[0]);
  assert.equal(result.examples[0].kind, 'rejected');
  assert.equal(result.examples[1].kind, 'ai-unknown');
  assert.equal(result.preferences[0].scope.type, 'situation');
});

test('different selected conversations with the same generic opener do not merge accidentally', () => {
  const first = normalizeImport('User: Draft a reply.\nAssistant: Hi Alex, thanks for visiting.').conversations[0];
  const second = normalizeImport('User: Draft a reply.\nAssistant: Dear Sam, your proposal sounds interesting.').conversations[0];
  assert.notEqual(first.id, second.id);
});

test('repeated identical corrections retain distinct positions; separate situations never merge scope', () => {
  const repeated = normalizeImport('User: Please draft.\nAssistant: Dear Pat, thank you.\nUser: Please make it shorter.\nAssistant: Hi Pat, thanks.\nUser: Please make it shorter.').conversations[0];
  assert.equal(repeated.messages.length, 5);
  assert.notEqual(repeated.messages[2].id, repeated.messages[4].id);
  const other = normalizeImport({ id: 'different-situation', messages: [{ role: 'user', text: 'Please make it shorter.' }] }).conversations[0];
  const a = extractEvidence(repeated), b = extractEvidence(other);
  assert.equal(a.preferences[0].sources.length, 2);
  assert.notEqual(a.preferences[0].scope.value, b.preferences[0].scope.value);
  assert.notEqual(a.preferences[0].id, b.preferences[0].id);
});

test('contrary feedback on the same draft does not silently turn one branch into approval', () => {
  const conversation = normalizeImport({ id: 'conflicting-branches', messages: [
    { id: 'cb-a', role: 'assistant', parentId: null, text: 'Dear Sam, thank you for your response.' },
    { id: 'cb-no', role: 'user', parentId: 'cb-a', text: 'No, this is too formal.' },
    { id: 'cb-yes', role: 'user', parentId: 'cb-a', text: 'Perfect!' },
  ] }).conversations[0];
  const result = extractEvidence(conversation);
  assert.equal(result.examples[0].kind, 'ai-unknown');
  assert.equal(result.examples[0].approvalConflict, true);
  assert.equal(result.examples[0].sources.length, 3);
  assert.ok(result.warnings.some((warning) => /Conflicting approval/.test(warning)));
});

test('example identities remain stable when a later export adds an approval branch', () => {
  const record = { id: 'later-approval', messages: [{ id: 'later-a', role: 'assistant', parentId: null, text: 'Hi Jamie, thanks for the introduction.' }] };
  const earlier = extractEvidence(normalizeImport(record).conversations[0]).examples[0];
  record.messages.push({ id: 'later-u', role: 'user', parentId: 'later-a', text: 'Looks good!' });
  const later = extractEvidence(normalizeImport(record).conversations[0]).examples[0];
  assert.equal(earlier.kind, 'ai-unknown');
  assert.equal(later.kind, 'approved');
  assert.equal(earlier.id, later.id);
});

test('sent email attribution excludes other authors, quoted history, and signatures', () => {
  const conversation = get('synthetic-email-attribution');
  assert.equal(conversation.messages[0].role, 'user');
  assert.equal(conversation.messages[1].kind, 'incoming');
  assert.ok(!conversation.messages[0].text.includes('Avery Example'));
  assert.ok(!conversation.messages[0].text.includes('extremely formal'));
  assert.ok(conversation.messages[0].excludedFragments.some((fragment) => fragment.kind === 'quoted'));
  const result = extractEvidence(conversation);
  assert.equal(result.examples[0].kind, 'sent');
  assert.equal(result.examples[1].kind, 'incoming');
  assert.equal(result.preferences.length, 0);
});

test('normalized account imports retain original text, identity, cleanup metadata and warnings', () => {
  const rawText = 'My answer.\n-- \nSignature\n> Quoted words';
  const imported = normalizeImport({ warnings: ['Read-only import was bounded.'], conversations: [{ id: 'account-1', source: 'gmail', date: '2026-09-01', messages: [
    { id: 'account-message', role: 'user', kind: 'sent', text: 'My answer.', rawText, author: 'Author <author@example.invalid>', metadata: { attribution: 'authenticated-mailbox', removedText: '--\nSignature\n> Quoted words', cleanupApplied: true }, date: '2026-09-01' },
  ] }] });
  const message = imported.conversations[0].messages[0];
  assert.equal(message.rawText, rawText);
  assert.equal(message.author, 'Author <author@example.invalid>');
  assert.equal(message.metadata.attribution, 'authenticated-mailbox');
  assert.equal(message.metadata.cleanupApplied, true);
  assert.deepEqual(imported.warnings, ['Read-only import was bounded.']);
});

test('discovery uses the most recent activity while evidence retains older explicit dates', () => {
  const conversation = normalizeImport({ id: 'long-lived', create_time: 1577836800, update_time: 1791590400, messages: [
    { role: 'user', text: 'Never use em dashes.', date: '2020-01-01T00:00:00Z' },
    { role: 'user', text: 'Please make this reply warmer.', date: '2026-10-10T00:00:00Z' },
  ] }).conversations[0];
  assert.equal(conversation.date, '2026-10-10T00:00:00.000Z');
  assert.equal(conversation.createdAt, '2020-01-01T00:00:00.000Z');
  assert.equal(discover(conversation, { after: '2026-01-01' }).excluded, false);
  assert.equal(extractEvidence(conversation).preferences.find((preference) => preference.category === 'hard').date, '2020-01-01T00:00:00.000Z');
});

test('inline quoted lines are removed without discarding the user response below them', () => {
  assert.deepEqual(separateQuotedContent('> Incoming question\nMy answer.').text, 'My answer.');
});

test('discovery uses bilingual keywords, structural drafting cues, and visible filtering', () => {
  assert.equal(discover(get('synthetic-en-colleague')).candidate, true);
  assert.equal(discover(get('synthetic-de-revisions')).candidate, true);
  assert.equal(discover(get('synthetic-sparse')).candidate, false);
  const unusual = normalizeImport({ title: 'a thought', messages: [{ role: 'user', text: 'Can you help me with this?' }, { role: 'assistant', text: 'Hi Dana, thanks for helping yesterday. Best regards' }] }).conversations[0];
  assert.equal(discover(unusual).candidate, true);
  assert.equal(discover(get('synthetic-en-colleague'), { after: '2026-09-06' }).excluded, true);
  assert.equal(discover(get('synthetic-en-colleague'), { before: '2026-09-05' }).excluded, false);
  assert.equal(discover(get('synthetic-en-colleague'), { exclude: ['mockup'] }).excluded, true);
  assert.equal(discover(get('synthetic-en-colleague'), { query: 'not present' }).excluded, true);
});

test('report proposals disclose remembered impressions and retain claimed sources separately', () => {
  const report = { limitations: ['Only three selected conversations were searchable.'], preferences: [
    { text: 'I prefer warm greetings.', scope: { type: 'global', value: '' }, basis: 'explicit', retrieval: 'retrieved', sources: [{ title: 'Actual cited title', excerpt: 'I prefer warm greetings.' }] },
    { text: 'Always be concise.', scope: { type: 'global', value: '' }, basis: 'explicit', retrieval: 'remembered-impression', sources: [] },
  ] };
  const result = extractEvidence(normalizeImport(report).conversations[0]);
  assert.equal(result.preferences.length, 2);
  assert.equal(result.preferences[0].reportedSources[0].verified, false);
  assert.equal(result.preferences[0].sources[0].conversationId, normalizeImport(report).conversations[0].id);
  assert.equal(result.preferences[1].basis, 'inferred');
  assert.equal(result.preferences[1].strength, 'weak');
  assert.ok(result.preferences.every((preference) => preference.status === 'proposed'));
});

test('plain reports remain available and create only weak reviewable proposals', () => {
  const imported = normalizeImport('Limitations: I cannot search all chats.\n- Never use em dashes.\n- An unverifiable example about a flight.', { kind: 'report' });
  const result = extractEvidence(imported.conversations[0]);
  assert.equal(result.preferences.length, 1);
  assert.equal(result.preferences[0].strength, 'weak');
  assert.equal(result.examples.length, 0);
  assert.match(result.warnings[0], /limited/);
});

test('conflicts are reviewable and dates stay attached to older explicit evidence', () => {
  const result = extractEvidence(get('synthetic-conflict'));
  assert.equal(result.preferences.length, 2);
  assert.equal(result.preferences[0].conflicts[0].preferenceId, result.preferences[1].id);
  assert.match(result.preferences[0].date, /^2025/);
  assert.match(result.preferences[1].date, /^2026/);
});

test('mode proposals are grounded, sparse evidence creates no invented profile', () => {
  const sparse = extractEvidence(get('synthetic-sparse'));
  assert.deepEqual(proposeModes(sparse.preferences, sparse.examples), []);
  assert.ok(sparse.warnings.some((warning) => /Sparse/.test(warning)));
  const rich = extractEvidence(get('synthetic-en-colleague'));
  const modes = proposeModes(rich.preferences, rich.examples);
  assert.equal(modes.length, 1);
  assert.equal(modes[0].name, 'Close colleagues');
  assert.ok(modes[0].sourceIds.length >= 2);
  assert.equal(modes[0].sampleLabel, 'Generated illustration, not historical evidence');
  assert.deepEqual(proposeModes(rich.preferences.filter((preference) => preference.scope.type === 'audience'), []), []);
});

test('held-out evaluations are separate, visibly synthetic, and not importable as profile evidence', async () => {
  const heldout = JSON.parse(await readFile(new URL('../fixtures/heldout.json', import.meta.url), 'utf8'));
  assert.equal(heldout.synthetic, true);
  assert.equal(heldout.heldOut, true);
  assert.ok(heldout.cases.some((item) => item.language === 'en'));
  assert.ok(heldout.cases.some((item) => item.language === 'de'));
  assert.equal(normalizeImport(heldout).conversations.length, 0);
  assert.ok(conversations.every((conversation) => conversation.synthetic));
});
