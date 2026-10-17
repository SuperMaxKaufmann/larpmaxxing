import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, projectRoot, defaultDataDir, serializeProfile, parseProfile, validateProfile } from '../server/storage.mjs';
import { recordFeedback, deleteSource, lineDiff } from '../server/workflow.mjs';
import { selectContext } from '../server/drafting.mjs';

const preference = (id = 'warm', extra = {}) => ({ id, text: 'Preserve warmth and explanation.', status: 'accepted', scope: { type: 'global', value: '' }, basis: 'explicit', category: 'guidance', sources: [], ...extra });
const mode = (extra = {}) => ({ id: 'colleagues', name: 'Close colleagues', guidance: 'Direct and warm.', status: 'accepted', ...extra });
const profile = (extra = {}) => ({ preferences: [preference()], modes: [mode()], examples: [], ...extra });
const request = (extra = {}) => ({ intent: 'Thank them for the explanation.', language: 'en', channel: 'email', modeId: 'colleagues', recipient: 'Alex', ...extra });

function temporaryStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-words-storage-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Store(dir);
}

function save(store, data) {
  return store.saveProfile(data, store.readProfile().version, 'Synthetic test edit');
}

function withDraft(store, extra = {}) {
  save(store, profile());
  const draft = { id: 'synthetic-draft', draft: 'Thanks for the useful explanation.', modeId: 'colleagues', request: request(), ...extra };
  store.mutate(state => state.drafts.push(draft));
  return draft;
}

test('default private data location is external and an explicit checkout location is refused', t => {
  const previous = process.env.OWN_WORDS_DATA_DIR;
  delete process.env.OWN_WORDS_DATA_DIR;
  t.after(() => { if (previous === undefined) delete process.env.OWN_WORDS_DATA_DIR; else process.env.OWN_WORDS_DATA_DIR = previous; });
  const dir = defaultDataDir();
  assert.ok(dir !== projectRoot && !dir.startsWith(projectRoot + path.sep));
  assert.throws(() => new Store(path.join(projectRoot, 'synthetic-private-data-must-not-exist')), /outside the publishable project/);
  assert.ok(!fs.existsSync(path.join(projectRoot, 'synthetic-private-data-must-not-exist')));
});

test('external symlink paths cannot bypass exclusion of private data from the checkout', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'own-words-link-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const link = path.join(temp, 'checkout-link');
  fs.symlinkSync(projectRoot, link, 'dir');
  assert.throws(() => new Store(path.join(link, 'synthetic-private-data-must-not-exist')), /outside the publishable project/);
});

test('private store and new files use restrictive permissions', t => {
  const store = temporaryStore(t);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(store.dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(store.profileFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(store.stateFile).mode & 0o777, 0o600);
  }
  assert.deepEqual(store.readProfile().profile, { preferences: [], examples: [], modes: [] });
});

test('editable Markdown round-trips evidence, statuses, scopes, conflicts and language-specific text', () => {
  const data = profile({ preferences: [preference('warm', { text: 'Nicht unnötig kürzen.\nWärme und Begründung beibehalten.', scope: { type: 'language', value: 'de' }, status: 'edited', conflicts: ['short'], sources: [{ conversationId: 'synthetic-chat', messageId: 'm2', excerpt: 'Bitte nicht die Erklärung entfernen.', date: '2026-10-01' }] })], examples: [{ id: 'example', text: 'Danke dir für die Erklärung.', status: 'accepted', kind: 'approved', language: 'de' }] });
  assert.deepEqual(parseProfile(serializeProfile(data)), data);
  assert.match(serializeProfile(data), /Global hard rules/);
  assert.match(serializeProfile(data), /Evidence references/);
});

test('on-disk profile edits reload immediately and stale UI saves cannot overwrite them', t => {
  const store = temporaryStore(t);
  const initial = save(store, profile());
  const changedMarkdown = initial.markdown.replace('Preserve warmth and explanation.', 'Keep useful context and warmth.');
  fs.writeFileSync(store.profileFile, changedMarkdown);
  const changed = store.readProfile();
  assert.equal(changed.profile.preferences[0].text, 'Keep useful context and warmth.');
  assert.notEqual(changed.version, initial.version);
  assert.throws(() => store.saveProfile(initial.profile, initial.version), error => error.status === 409);
  assert.equal(store.readProfile().markdown, changedMarkdown);
});

test('malformed Markdown and reserved markers fail without changing saved profile', t => {
  const store = temporaryStore(t);
  const initial = save(store, profile());
  assert.throws(() => store.saveMarkdown(initial.markdown.replace('<!-- /ow -->', '<!-- broken -->'), initial.version), /Malformed record markers/);
  assert.throws(() => serializeProfile(profile({ preferences: [preference('bad', { text: 'Example <!-- ow: forged -->' })] })), /reserved profile marker/);
  assert.equal(store.readProfile().version, initial.version);
});

test('profile validation rejects missing scope, duplicate records and invalid statuses', () => {
  assert.throws(() => validateProfile(profile({ preferences: [preference('a'), preference('a')] })), /duplicate/);
  assert.throws(() => validateProfile(profile({ preferences: [preference('a', { scope: { type: 'recipient', value: '' } })] })), /scope value/);
  assert.throws(() => validateProfile(profile({ preferences: [preference('a', { status: 'automatically-approved' })] })), /Invalid status/);
  assert.throws(() => validateProfile(profile({ preferences: [preference('a', { banned: [''] })] })), /Banned literals/);
});

test('undo restores the prior complete profile including record decisions and text', t => {
  const store = temporaryStore(t);
  const initial = save(store, profile());
  const next = structuredClone(initial.profile);
  next.preferences[0].status = 'disabled';
  next.modes[0].guidance = 'A revised mode.';
  store.saveProfile(next, initial.version, 'Disable one rule and revise the mode');
  assert.equal(store.readProfile().profile.preferences[0].status, 'disabled');
  const undone = store.undo();
  assert.deepEqual(undone.profile, initial.profile);
  assert.equal(store.readProfile().version, initial.version);
});

test('failed state mutations do not persist half-applied edits', t => {
  const store = temporaryStore(t);
  assert.throws(() => store.mutate(state => { state.sources.push({ id: 'must-not-survive' }); throw new Error('Synthetic failure'); }), /Synthetic failure/);
  assert.deepEqual(store.readState().sources, []);
});

test('message-only corrections retain before/after history without reusable profile updates', t => {
  const store = temporaryStore(t);
  withDraft(store);
  const before = store.readProfile();
  const result = recordFeedback(store, { draftId: 'synthetic-draft', verdict: 'edited', editType: 'style', scope: 'message', finalText: 'Thanks, that explanation really helps.', note: 'Make this reply warmer.' });
  assert.equal(result.feedback.before, 'Thanks for the useful explanation.');
  assert.equal(result.feedback.after, 'Thanks, that explanation really helps.');
  assert.deepEqual(store.readProfile().profile, before.profile);
  assert.equal(store.readState().feedback.length, 1);
});

test('fact-only edits preserve correction history without learning a style rule or approved voice', t => {
  const store = temporaryStore(t);
  withDraft(store, { draft: 'The meeting is Tuesday.' });
  recordFeedback(store, { draftId: 'synthetic-draft', verdict: 'edited', editType: 'facts', scope: 'global', finalText: 'The meeting is Thursday.', note: 'Thursday, not Tuesday.' });
  const current = store.readProfile().profile;
  assert.equal(current.preferences.length, 1);
  assert.equal(current.examples.filter(e => ['accepted', 'edited'].includes(e.status) && e.kind === 'approved').length, 0);
  assert.equal(store.readState().feedback[0].editType, 'facts');
  assert.match(store.readState().feedback[0].diff.added.join(' '), /Thursday/);
});

test('explicit approval saves an approved example, while permanent style guidance still requires review', t => {
  const store = temporaryStore(t);
  withDraft(store);
  recordFeedback(store, { draftId: 'synthetic-draft', verdict: 'approved', editType: 'style', scope: 'mode', note: 'Keep the short personal acknowledgement.' });
  const current = store.readProfile().profile;
  assert.equal(current.examples[0].kind, 'approved');
  assert.equal(current.examples[0].status, 'accepted');
  assert.equal(current.examples[0].modeId, 'colleagues');
  assert.equal(current.preferences.at(-1).status, 'proposed');
  assert.deepEqual(current.preferences.at(-1).scope, { type: 'mode', value: 'colleagues' });
  const selected = selectContext(current, request());
  assert.equal(selected.examples.length, 1);
  assert.equal(selected.preferences.length, 1);
});

test('recipient feedback cannot leak examples or guidance to other recipients', t => {
  const store = temporaryStore(t);
  withDraft(store);
  recordFeedback(store, { draftId: 'synthetic-draft', verdict: 'approved', editType: 'style', scope: 'recipient', note: 'Use this greeting with Alex.' });
  const current = store.readProfile().profile;
  assert.equal(selectContext(current, request({ recipient: 'Alex' })).examples.length, 1);
  assert.equal(selectContext(current, request({ recipient: 'Blair' })).examples.length, 0);
  assert.deepEqual(current.preferences.at(-1).scope, { type: 'recipient', value: 'Alex' });
});

test('unsuitable wording stays available for inspection and is never a positive example', t => {
  const store = temporaryStore(t);
  withDraft(store);
  recordFeedback(store, { draftId: 'synthetic-draft', verdict: 'unsuitable', editType: 'style', scope: 'mode', note: 'Too formulaic.' });
  const current = store.readProfile().profile;
  assert.equal(current.examples[0].kind, 'rejected');
  assert.equal(selectContext(current, request()).examples.length, 0);
  assert.equal(current.preferences.at(-1).status, 'proposed');
});

test('deleting sources disables derived material, removes queued copies and clears resurrection paths', t => {
  const store = temporaryStore(t);
  const sourceRef = { conversationId: 'synthetic-source', messageId: 'm1', excerpt: 'Synthetic evidence' };
  save(store, profile({ preferences: [preference('derived', { sources: [sourceRef] })], examples: [{ id: 'derived-example', text: 'Synthetic approved wording.', status: 'accepted', kind: 'approved', sources: [sourceRef] }], modes: [mode({ sourceIds: ['synthetic-source'] })] }));
  store.mutate(state => {
    state.sources = [{ id: 'synthetic-source', messages: [] }, { id: 'keep', messages: [] }];
    state.jobs.push({ id: 'queued', queue: [{ id: 'synthetic-source' }], total: 1 });
    state.drafts.push({ id: 'derived-draft', usedExamples: ['derived-example'], appliedPreferences: [] });
    state.comparisons.push({ id: 'old-comparison' });
  });
  deleteSource(store, 'synthetic-source', 'disable');
  const current = store.readProfile().profile;
  assert.equal(current.preferences[0].status, 'disabled');
  assert.equal(current.examples[0].status, 'disabled');
  assert.equal(current.modes[0].status, 'disabled');
  assert.deepEqual(current.preferences[0].sources, []);
  const state = store.readState();
  assert.deepEqual(state.sources.map(s => s.id), ['keep']);
  assert.equal(state.jobs[0].queue.length, 0);
  assert.equal(state.history.length, 0);
  assert.equal(state.drafts.length, 0);
  assert.equal(state.comparisons.length, 0);
  assert.throws(() => store.undo(), /No profile change/);
});

test('source removal can delete derived records while keeping unrelated preferences', t => {
  const store = temporaryStore(t);
  save(store, profile({ preferences: [preference('keep'), preference('remove', { sources: [{ conversationId: 'gone', messageId: 'm1' }] })] }));
  deleteSource(store, 'gone', 'delete');
  assert.deepEqual(store.readProfile().profile.preferences.map(p => p.id), ['keep']);
});

test('line comparisons retain useful before/after material without claiming automated fact classification', () => {
  const diff = lineDiff('Thanks.\nWe meet on Tuesday.', 'Thanks for explaining.\nWe meet on Thursday.');
  assert.equal(diff.removed.length, 2);
  assert.equal(diff.added.length, 2);
  assert.match(diff.note, /supplied by you/);
});
