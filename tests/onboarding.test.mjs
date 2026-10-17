import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Onboarding, parsePastedEmails } from '../server/onboarding.mjs';
import { ModelSession } from '../server/model-access.mjs';
import { Store } from '../server/storage.mjs';

const modelKey = 'synthetic-onboarding-model-key';
const googleToken = 'synthetic-google-access-token';
const slackToken = 'synthetic-slack-user-token';
const own = { text: 'Thanks for the context. I will review the details before our meeting.', authorship: 'own' };
const emailThread = [
  'Subject: Project update',
  'From: Other Person <other@example.test>',
  'To: Writer <writer@example.test>',
  'Can you review the update?',
  '',
  'From: Writer <writer@example.test>',
  'To: Other Person <other@example.test>',
  'Thanks, I can review the details.',
  '> This is quoted incoming text.',
  '-- ',
  'Synthetic signature',
].join('\n');
const verified = provider => ({ provider, model: '', verified: true, validation: 'models-list', verifiedAt: '2026-10-17T10:00:00.000Z', availableModelCount: 1 });
const imported = (source = 'gmail', suffix = 'one') => ({ conversations: [{ id: `synthetic-${suffix}`, source, title: 'Synthetic email reply', messages: [{ id: `m-${suffix}`, role: 'user', kind: 'sent', text: `Thanks for explaining the ${suffix} detail.` }] }], warnings: [] });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function makeOnboarding(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'larpmaxxing-onboarding-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  const calls = [];
  const sourceTool = options.sourceTool || (async (context, name, args) => {
    calls.push({ context, name, args });
    if (name === 'gmail_status') return { emailAddress: 'writer@example.test', warnings: [] };
    if (name === 'slack_list_dms') return { conversations: [{ id: 'D123', userId: 'UOTHER', name: '' }], warnings: [] };
    return imported(name.startsWith('slack') ? 'slack' : 'gmail');
  });
  const modelSession = options.modelSession || new ModelSession({ verifier: async input => verified(input.provider) });
  const onboarding = new Onboarding(store, { env: {}, fetchImpl: async () => assert.fail('Unexpected network access'), ...options, sourceTool, modelSession });
  return { onboarding, store, calls, modelSession };
}
async function verify(onboarding, provider = 'openai') {
  return onboarding.verifyModel({ provider, apiKey: modelKey });
}
function oauthParams(url, extra = {}) {
  return new URLSearchParams({ state: new URL(url).searchParams.get('state'), code: 'synthetic-authorization-code', ...extra });
}

test('pasted outgoing email preserves authored detail while excluding quotations and signatures', () => {
  const result = parsePastedEmails({ authorship: 'own', text: 'Danke dir für die Erklärung.\nIch brauche die Details, damit ich es gut prüfen kann.\n\nAm Freitag schrieb jemand:\nFremde Formulierung' });
  assert.equal(result.conversations.length, 1);
  const message = result.conversations[0].messages[0];
  assert.equal(message.role, 'user');
  assert.equal(message.kind, 'user-written');
  assert.equal(message.metadata.attribution, 'user-asserted-outgoing');
  assert.equal(message.text, 'Danke dir für die Erklärung.\nIch brauche die Details, damit ich es gut prüfen kann.');
  assert.match(message.rawText, /Fremde Formulierung/);
  assert.equal(message.metadata.excludedFragments[0].kind, 'quoted');
});

test('English and German thread headers attribute only matching sender messages to the user', () => {
  for (const text of [emailThread, emailThread.replaceAll('From:', 'Von:').replaceAll('To:', 'An:').replace('Subject:', 'Betreff:')]) {
    const result = parsePastedEmails({ text, authorship: 'thread', ownEmail: 'WRITER@example.test' });
    const messages = result.conversations[0].messages;
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map(message => message.kind), ['incoming', 'user-written']);
    assert.equal(messages[0].role, 'incoming');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].text, 'Thanks, I can review the details.');
    assert.ok(!messages[1].text.includes('quoted'));
    assert.ok(!messages[1].text.includes('signature'));
    assert.equal(result.conversations[0].title, 'Project update');
  }
});

test('pasted ownership requires an explicit choice, sender headers and an identity for threads', () => {
  for (const input of [undefined, {}, { text: 'A readable email' }, { text: 'A readable email', authorship: 'assistant' },
    { text: emailThread, authorship: 'thread' }, { text: emailThread, authorship: 'thread', ownEmail: 'invalid' },
    { text: 'No author headers', authorship: 'thread', ownEmail: 'writer@example.test' },
    { text: emailThread, authorship: 'own' }, { text: ' '.repeat(10), authorship: 'own' },
    { text: '> Only quoted text', authorship: 'own' }, { text: 'x'.repeat(200001), authorship: 'own' }]) {
    assert.throws(() => parsePastedEmails(input));
  }
});

test('unattributed preamble and unmatched email identities remain outside the user voice', () => {
  const result = parsePastedEmails({ text: 'Unattributed words\n' + emailThread, authorship: 'thread', ownEmail: 'nobody@example.test' });
  assert.ok(result.conversations[0].messages.every(message => message.kind === 'incoming'));
  assert.match(result.warnings.join(' '), /No message matched/);
  assert.match(result.warnings.join(' '), /Unattributed text/);
  assert.ok(!result.conversations[0].messages.some(message => message.text.includes('Unattributed words')));
});

test('an empty From header cannot borrow the recipient address and claim incoming words as the user', () => {
  const text = 'From:\nTo: writer@example.test\nThese words were written by somebody else.';
  let result;
  try { result = parsePastedEmails({ text, authorship: 'thread', ownEmail: 'writer@example.test' }); }
  catch (error) { assert.match(error.message, /From:|author|sender|header/i); return; }
  assert.ok(result.conversations.every(conversation => conversation.messages.every(message => message.role !== 'user')));
});

test('line endings and identity capitalization do not create duplicate pasted conversations', () => {
  const first = parsePastedEmails({ text: emailThread, authorship: 'thread', ownEmail: 'writer@example.test' });
  const duplicate = parsePastedEmails({ text: emailThread.replaceAll('\n', '\r\n'), authorship: 'thread', ownEmail: 'WRITER@example.test' });
  assert.equal(first.conversations[0].id, duplicate.conversations[0].id);
  assert.deepEqual(first.conversations[0].messages.map(m => m.id), duplicate.conversations[0].messages.map(m => m.id));
});

test('all source entry points and harness start require verified model access first', async t => {
  const { onboarding, store, calls } = makeOnboarding(t);
  assert.equal(onboarding.status().model.verified, false);
  assert.throws(() => onboarding.paste(own), /Connect ChatGPT or a model API key first/);
  assert.throws(() => onboarding.start(), /Connect ChatGPT or a model API key first/);
  assert.throws(() => onboarding.beginGoogleOAuth('http://127.0.0.1:3210'), /Connect ChatGPT or a model API key first/);
  assert.throws(() => onboarding.removeSource('missing'), /Connect ChatGPT or a model API key first/);
  await assert.rejects(onboarding.connect('gmail', { token: googleToken }), /Connect ChatGPT or a model API key first/);
  await assert.rejects(onboarding.import('gmail'), /Connect ChatGPT or a model API key first/);
  await assert.rejects(onboarding.listDMs(), /Connect ChatGPT or a model API key first/);
  assert.equal(calls.length, 0);
  assert.equal(store.readState().sources.length, 0);
});

test('at least one authored source is required, incoming-only evidence cannot start the harness', async t => {
  const { onboarding } = makeOnboarding(t);
  await verify(onboarding);
  assert.throws(() => onboarding.start(), error => error.status === 409 && /at least one source/.test(error.message));
  const result = onboarding.paste({ text: 'From: Other <other@example.test>\nCan you review the email?', authorship: 'thread', ownEmail: 'writer@example.test' });
  assert.equal(result.addedCount, 1);
  assert.equal(result.sources[0].ownMessageCount, 0);
  assert.throws(() => onboarding.start(), error => error.status === 409 && /only incoming/.test(error.message));
  assert.equal(onboarding.status().harness.status, 'idle');
});

test('source preparation deduplicates pastes, runs locally and leaves writing preferences untouched', async t => {
  const { onboarding, store, calls } = makeOnboarding(t);
  await verify(onboarding);
  const profileBefore = store.readProfile().markdown;
  const result = onboarding.paste(own);
  assert.equal(result.addedCount, 1);
  assert.equal(onboarding.paste(own).addedCount, 0);
  assert.equal(onboarding.status().sources.length, 1);
  assert.equal(onboarding.status().sources[0].ownMessageCount, 1);
  const started = onboarding.start();
  assert.equal(started.harness.status, 'ready');
  assert.equal(started.harness.messageCount, 1);
  assert.match(started.notice, /no email content has been sent to a model/);
  assert.equal(calls.length, 0);
  assert.equal(store.readProfile().markdown, profileBefore);
  const saved = fs.readFileSync(store.stateFile, 'utf8') + fs.readFileSync(store.profileFile, 'utf8');
  assert.ok(!saved.includes(modelKey));
  assert.ok(!JSON.stringify(onboarding.status()).includes(modelKey));
});

test('old sources do not bypass onboarding and adding or deleting a source invalidates readiness', async t => {
  const { onboarding, store } = makeOnboarding(t);
  await verify(onboarding);
  store.mutate(state => state.sources.push(...imported().conversations));
  assert.equal(onboarding.status().sources.length, 0);
  assert.throws(() => onboarding.start(), /at least one source/);
  onboarding.paste(own);
  onboarding.start();
  assert.equal(onboarding.status().harness.status, 'ready');
  onboarding.paste({ ...own, text: 'Danke für deine Nachricht. Die ausführliche Erklärung hilft mir.' });
  assert.equal(onboarding.status().harness.status, 'idle');
  onboarding.start();
  const sourceId = onboarding.status().sources[0].id;
  onboarding.removeSource(sourceId);
  assert.equal(onboarding.status().harness.status, 'idle');
  assert.ok(!onboarding.status().sources.some(source => source.id === sourceId));
  assert.throws(() => onboarding.removeSource(sourceId), error => error.status === 404);
});

test('connections validate before saving tokens and expose only sanitized connection status', async t => {
  const { onboarding, store, calls } = makeOnboarding(t);
  await verify(onboarding);
  await assert.rejects(onboarding.connect('gmail'), /authorized/);
  await assert.rejects(onboarding.import('gmail'), /Connect gmail first/);
  await onboarding.connect('gmail', { token: googleToken });
  assert.equal(calls[0].name, 'gmail_status');
  assert.equal(calls[0].context.credentials.gmailToken, googleToken);
  assert.equal(onboarding.status().connections.gmail.connected, true);
  assert.ok(!JSON.stringify(onboarding.status()).includes(googleToken));
  assert.ok(!fs.readFileSync(store.stateFile, 'utf8').includes(googleToken));
  await onboarding.import('gmail', { after: '2026-09-01', before: '2026-10-01' });
  assert.deepEqual(calls[1].args, { after: '2026-09-01', before: '2026-10-02T00:00:00.000Z', maxResults: 30 });
  onboarding.disconnect('gmail');
  assert.equal(onboarding.status().connections.gmail.connected, false);
  assert.equal(onboarding.credentials.gmailToken, '');
});

test('Slack imports only selected one-to-one conversations with repeated IDs deduplicated', async t => {
  const { onboarding, calls } = makeOnboarding(t);
  await verify(onboarding);
  await onboarding.connect('slack', { token: slackToken });
  const listed = await onboarding.listDMs();
  assert.equal(listed.conversations[0].name, '1:1 with UOTHER');
  for (const conversationIds of [undefined, [], Array.from({ length: 21 }, () => 'D123'), ['D123', 5]]) {
    await assert.rejects(onboarding.import('slack', { conversationIds }), /between 1 and 20/);
  }
  await onboarding.import('slack', { conversationIds: ['D123', 'D123'], after: '2026-09-01', before: '2026-10-01' });
  const imports = calls.filter(call => call.name === 'slack_import_dm');
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].args, { channelId: 'D123', after: '2026-09-01', before: '2026-10-02T00:00:00.000Z', maxResults: 100 });
});

test('empty remote imports remain usable and never count as a source', async t => {
  const { onboarding } = makeOnboarding(t, { sourceTool: async (_context, name) => name === 'gmail_status' ? {} : { conversations: [], warnings: ['No matches in this range.'] } });
  await verify(onboarding);
  await onboarding.connect('gmail', { token: googleToken });
  const result = await onboarding.import('gmail');
  assert.equal(result.addedCount, 0);
  assert.equal(result.sources.length, 0);
  assert.match(result.notice, /No messages matched/);
  assert.throws(() => onboarding.start(), /at least one source/);
});

test('disconnect during pending connection prevents credentials from reappearing', async t => {
  const pending = deferred();
  const { onboarding } = makeOnboarding(t, { sourceTool: () => pending.promise });
  await verify(onboarding);
  const connecting = onboarding.connect('gmail', { token: googleToken });
  onboarding.disconnect('gmail');
  pending.resolve({});
  await assert.rejects(connecting, error => error.status === 409);
  assert.equal(onboarding.status().connections.gmail.connected, false);
  assert.equal(onboarding.credentials.gmailToken, '');
});

test('disconnect during remote import prevents any messages being saved', async t => {
  const pending = deferred();
  const { onboarding, store } = makeOnboarding(t, { sourceTool: (_context, name) => name === 'gmail_status' ? {} : pending.promise });
  await verify(onboarding);
  await onboarding.connect('gmail', { token: googleToken });
  const importing = onboarding.import('gmail');
  onboarding.disconnect('gmail');
  pending.resolve(imported());
  await assert.rejects(importing, error => error.status === 409);
  assert.equal(store.readState().sources.length, 0);
});

test('disconnecting a Slack batch stops further DM reads after the in-flight result', async t => {
  const pending = deferred();
  const dmCalls = [];
  const { onboarding, store } = makeOnboarding(t, { sourceTool: (_context, name, args) => {
    if (name === 'slack_list_dms') return { conversations: [] };
    dmCalls.push(args.channelId);
    return dmCalls.length === 1 ? pending.promise : imported('slack', 'two');
  } });
  await verify(onboarding);
  await onboarding.connect('slack', { token: slackToken });
  const importing = onboarding.import('slack', { conversationIds: ['D123', 'D456'] });
  onboarding.disconnect('slack');
  pending.resolve(imported('slack'));
  await assert.rejects(importing, error => error.status === 409);
  assert.deepEqual(dmCalls, ['D123']);
  assert.equal(store.readState().sources.length, 0);
});

test('a Slack DM list response is rejected when its source connection changes', async t => {
  const pending = deferred();
  let count = 0;
  const { onboarding } = makeOnboarding(t, { sourceTool: () => ++count === 1 ? { conversations: [] } : pending.promise });
  await verify(onboarding);
  await onboarding.connect('slack', { token: slackToken });
  const listing = onboarding.listDMs();
  onboarding.disconnect('slack');
  pending.resolve({ conversations: [{ id: 'D123', userId: 'UOTHER' }] });
  await assert.rejects(listing, error => error.status === 409);
});

test('model replacement invalidates pending source work even when the new key is already verified', async t => {
  const pending = deferred();
  const { onboarding, store } = makeOnboarding(t, { sourceTool: (_context, name) => name === 'gmail_status' ? {} : pending.promise });
  await verify(onboarding);
  await onboarding.connect('gmail', { token: googleToken });
  const importing = onboarding.import('gmail');
  await verify(onboarding, 'anthropic');
  pending.resolve(imported());
  await assert.rejects(importing, error => error.status === 409);
  assert.equal(store.readState().sources.length, 0);
});

test('forgetting model access removes source credentials, cancels OAuth and returns to the first gate', async t => {
  const { onboarding } = makeOnboarding(t, { env: { GOOGLE_CLIENT_ID: 'synthetic-client-id' } });
  await verify(onboarding);
  await onboarding.connect('gmail', { token: googleToken });
  await onboarding.connect('slack', { token: slackToken });
  onboarding.paste(own);
  onboarding.start();
  onboarding.beginGoogleOAuth('http://127.0.0.1:3210');
  onboarding.forgetModel();
  assert.equal(onboarding.status().model.verified, false);
  assert.equal(onboarding.status().harness.status, 'idle');
  assert.equal(onboarding.credentials.gmailToken, '');
  assert.equal(onboarding.credentials.slackToken, '');
  assert.equal(onboarding.oauth, null);
  assert.throws(() => onboarding.start(), /Connect ChatGPT or a model API key first/);
});

test('Google authorization requires configured client and loopback callback, and uses read-only scope plus PKCE', async t => {
  const { onboarding } = makeOnboarding(t);
  await verify(onboarding);
  assert.throws(() => onboarding.beginGoogleOAuth('http://127.0.0.1:3210'), /GOOGLE_CLIENT_ID/);
  onboarding.env.GOOGLE_CLIENT_ID = 'synthetic-client-id';
  for (const origin of ['https://example.test', 'http://127.0.0.1.evil.test:3210', 'http://127.0.0.1:3210/path', 'http://localhost', 'http://localhost:3210@evil.test']) {
    assert.throws(() => onboarding.beginGoogleOAuth(origin), /loopback origin/);
  }
  const { url } = onboarding.beginGoogleOAuth('http://127.0.0.1:3210');
  const authorization = new URL(url);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.pathname, '/o/oauth2/v2/auth');
  assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('code_challenge'), createHash('sha256').update(onboarding.oauth.verifier).digest('base64url'));
  assert.equal(authorization.searchParams.get('redirect_uri'), 'http://127.0.0.1:3210/oauth/callback/gmail');
  assert.equal(authorization.searchParams.get('response_type'), 'code');
  assert.equal(authorization.searchParams.get('access_type'), 'online');
  assert.ok(authorization.searchParams.get('state').length >= 32);
  assert.ok(!url.includes(onboarding.oauth.verifier));
});

test('Google callback rejects missing, mismatched, expired, reused and declined state before network access', async t => {
  const { onboarding } = makeOnboarding(t, { env: { GOOGLE_CLIENT_ID: 'synthetic-client-id' } });
  await verify(onboarding);
  await assert.rejects(onboarding.finishGoogleOAuth(new URLSearchParams()), /state/);
  const wrong = onboarding.beginGoogleOAuth('http://localhost:3210');
  await assert.rejects(onboarding.finishGoogleOAuth(oauthParams(wrong.url, { state: 'wrong-state' })), /state/);
  const expired = onboarding.beginGoogleOAuth('http://localhost:3210');
  onboarding.oauth.expiresAt = Date.now() - 1000;
  await assert.rejects(onboarding.finishGoogleOAuth(oauthParams(expired.url)), /state/);
  const declined = onboarding.beginGoogleOAuth('http://localhost:3210');
  await assert.rejects(onboarding.finishGoogleOAuth(oauthParams(declined.url, { error: `denied-${googleToken}` })), error => /declined/.test(error.message) && !error.message.includes(googleToken));
  await assert.rejects(onboarding.finishGoogleOAuth(oauthParams(declined.url)), /state/);
  const missingCode = onboarding.beginGoogleOAuth('http://localhost:3210');
  await assert.rejects(onboarding.finishGoogleOAuth(oauthParams(missingCode.url, { code: '' })), /authorization code/);
});

test('Google token exchange sends matching PKCE verifier only to the official token endpoint and verifies Gmail access', async t => {
  const requests = [];
  const env = { GOOGLE_CLIENT_ID: 'synthetic-client-id', GOOGLE_CLIENT_SECRET: 'synthetic-client-secret' };
  const { onboarding, store, calls } = makeOnboarding(t, { env, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json({ access_token: googleToken, refresh_token: 'synthetic-refresh-token', expires_in: 3600 });
  } });
  await verify(onboarding);
  const { url } = onboarding.beginGoogleOAuth('http://127.0.0.1:3210');
  const verifier = onboarding.oauth.verifier;
  const connected = await onboarding.finishGoogleOAuth(oauthParams(url));
  assert.equal(connected.connected, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.redirect, 'error');
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  const form = new URLSearchParams(requests[0].options.body);
  assert.equal(form.get('code_verifier'), verifier);
  assert.equal(form.get('client_id'), env.GOOGLE_CLIENT_ID);
  assert.equal(form.get('client_secret'), env.GOOGLE_CLIENT_SECRET);
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(calls[0].name, 'gmail_status');
  assert.equal(calls[0].context.credentials.gmailToken, googleToken);
  assert.equal(onboarding.oauth, null);
  assert.ok(!JSON.stringify(connected).includes(googleToken));
  assert.ok(!fs.readFileSync(store.stateFile, 'utf8').includes('synthetic-refresh-token'));
  await assert.rejects(onboarding.finishGoogleOAuth(oauthParams(url)), /state/);
});

test('Google exchange failures suppress provider bodies, network errors and missing access tokens', async t => {
  for (const fetchImpl of [
    async () => new Response(`private-${googleToken}`, { status: 400 }),
    async () => { throw new Error(`network-${googleToken}`); },
    async () => Response.json({ error: googleToken }),
    async () => new Response('{invalid json'),
  ]) {
    const { onboarding, calls } = makeOnboarding(t, { env: { GOOGLE_CLIENT_ID: 'synthetic-client-id' }, fetchImpl });
    await verify(onboarding);
    const { url } = onboarding.beginGoogleOAuth('http://localhost:3210');
    await assert.rejects(onboarding.finishGoogleOAuth(oauthParams(url)), error => /could not be completed/.test(error.message) && !error.message.includes(googleToken));
    assert.equal(calls.length, 0);
    assert.equal(onboarding.credentials.gmailToken, '');
    assert.equal(onboarding.status().connections.gmail.connected, false);
  }
});

test('disconnect during Google token exchange prevents a late token from reconnecting', async t => {
  const pending = deferred();
  const { onboarding, calls } = makeOnboarding(t, { env: { GOOGLE_CLIENT_ID: 'synthetic-client-id' }, fetchImpl: () => pending.promise });
  await verify(onboarding);
  const { url } = onboarding.beginGoogleOAuth('http://localhost:3210');
  const exchanging = onboarding.finishGoogleOAuth(oauthParams(url));
  onboarding.disconnect('gmail');
  pending.resolve(Response.json({ access_token: googleToken }));
  await assert.rejects(exchanging, error => error.status === 409);
  assert.equal(calls.length, 0);
  assert.equal(onboarding.credentials.gmailToken, '');
});

test('a newer Google authorization attempt invalidates an older in-flight token exchange', async t => {
  const pending = deferred();
  const { onboarding, calls } = makeOnboarding(t, { env: { GOOGLE_CLIENT_ID: 'synthetic-client-id' }, fetchImpl: () => pending.promise });
  await verify(onboarding);
  const first = onboarding.beginGoogleOAuth('http://localhost:3210');
  const exchanging = onboarding.finishGoogleOAuth(oauthParams(first.url));
  const second = onboarding.beginGoogleOAuth('http://localhost:3210');
  assert.notEqual(new URL(first.url).searchParams.get('state'), new URL(second.url).searchParams.get('state'));
  pending.resolve(Response.json({ access_token: googleToken }));
  await assert.rejects(exchanging, error => error.status === 409);
  assert.equal(calls.length, 0);
  assert.equal(onboarding.status().connections.gmail.connected, false);
});


test('calendar ranges include the whole end day and reject impossible or reversed dates before source reads', async t => {
  const {onboarding,calls} = makeOnboarding(t);
  await verify(onboarding);
  await onboarding.connect('gmail', {token:googleToken});
  await onboarding.import('gmail', {after:'2026-10-17',before:'2026-10-17'});
  assert.equal(calls.at(-1).args.after,'2026-10-17');
  assert.equal(calls.at(-1).args.before,'2026-10-18T00:00:00.000Z');
  const count=calls.length;
  await assert.rejects(onboarding.import('gmail',{after:'2026-02-30'}),/valid calendar date/);
  await assert.rejects(onboarding.import('gmail',{after:'2026-10-17',before:'2026-10-16'}),/end date/);
  assert.equal(calls.length,count);
});
