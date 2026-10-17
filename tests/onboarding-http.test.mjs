import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Store } from '../server/storage.mjs';
import { createApp } from '../server/index.mjs';
import { ModelSession } from '../server/model-access.mjs';

const modelKey = 'synthetic-model-secret';
const gmailToken = 'synthetic-gmail-secret';
const slackToken = 'synthetic-slack-secret';
const syntheticVerification = async ({ provider, apiKey }) => ({ provider, model: '', verified: true, validation: 'models-list', verifiedAt: '2026-10-17T12:00:00Z', availableModelCount: 1, apiKey });

function network(replies = []) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    assert.ok(replies.length, 'Unexpected network request');
    const response = replies.shift();
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : Response.json(response);
  };
  return { fetchImpl, calls };
}

async function app(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'larpmaxxing-onboarding-http-'));
  const store = new Store(dir);
  const session = options.modelSession || new ModelSession({ verifier: syntheticVerification, env: {} });
  const server = createApp({ store, env: {}, modelSession: session, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const first = await (await fetch(`${base}/api/onboarding`)).json();
  const post = (route, input = {}, method = 'POST', extraHeaders = {}) => fetch(`${base}${route}`, { method, headers: { 'Content-Type': 'application/json', 'X-Local-Token': first.csrfToken, ...extraHeaders }, body: JSON.stringify(input) });
  const state = async () => (await fetch(`${base}/api/onboarding`)).json();
  const verify = async () => {
    const response = await post('/api/onboarding/model', { provider: 'openai', apiKey: modelKey });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { base, store, session, post, state, first, verify };
}

test('onboarding requires model verification before source actions, then requires authored source evidence before start', async t => {
  const mock = network();
  const { post, base, verify, state } = await app(t, mock);
  for (const [route, input] of [
    ['/api/onboarding/paste', { text: 'Hello, thanks for checking.', authorship: 'own' }],
    ['/api/onboarding/start', {}], ['/api/onboarding/connect/gmail', { token: gmailToken }],
    ['/api/onboarding/connect/slack', { token: slackToken }], ['/api/onboarding/import/gmail', {}],
  ]) assert.equal((await post(route, input)).status, 409, route);
  assert.equal((await fetch(`${base}/api/onboarding/slack/dms`)).status, 409);
  await verify();
  assert.equal((await post('/api/onboarding/start')).status, 409);
  assert.equal((await post('/api/onboarding/paste', { text: 'From: other@example.test\nSubject: Synthetic incoming\nCould you review the outline?', authorship: 'thread', ownEmail: 'writer@example.test' })).status, 200);
  const incomingOnly = await post('/api/onboarding/start');
  assert.equal(incomingOnly.status, 409);
  assert.match((await incomingOnly.json()).error, /only incoming/);
  assert.equal((await state()).harness.status, 'idle');
  assert.equal(mock.calls.length, 0);
});

test('HTTP onboarding rejects missing CSRF, cross-site reads/writes and rebinding hosts', async t => {
  const { base, post } = await app(t);
  assert.equal((await fetch(`${base}/api/onboarding`, { headers: { Origin: 'https://evil.example.test' } })).status, 403);
  assert.equal((await fetch(`${base}/api/onboarding`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${base}/api/onboarding/model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'openai', apiKey: modelKey }) })).status, 403);
  assert.equal((await post('/api/onboarding/model', { provider: 'openai', apiKey: modelKey }, 'POST', { Origin: 'https://evil.example.test' })).status, 403);
  assert.equal((await post('/api/onboarding/model', {}, 'POST', { 'X-Local-Token': 'wrong' })).status, 403);
  const rebinding = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/onboarding`, { headers: { Host: 'evil.example.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(rebinding, 403);
});

test('complete synthetic verification, paste, deduplication, start and delete flow never exposes credentials', async t => {
  const { post, verify, state, store, base } = await app(t);
  const verified = await verify();
  assert.equal(verified.model.verified, true);
  assert.ok(!JSON.stringify(verified).includes(modelKey));
  const input = { authorship: 'thread', ownEmail: 'writer@example.test', text: 'From: colleague@example.test\nSubject: Synthetic feedback\nKannst du den Entwurf prüfen?\n\nFrom: writer@example.test\nDanke dir, ich schaue mir den Entwurf morgen an.\n> Quoted incoming wording' };
  const response = await post('/api/onboarding/paste', input);
  assert.equal(response.status, 200);
  const pasted = await response.json();
  assert.equal(pasted.addedCount, 1);
  assert.equal(pasted.sources[0].ownMessageCount, 1);
  assert.equal((await (await post('/api/onboarding/paste', input)).json()).addedCount, 0);
  assert.equal((await state()).sources.length, 1);
  const started = await (await post('/api/onboarding/start')).json();
  assert.equal(started.harness.status, 'ready');
  assert.equal(started.harness.messageCount, 2);
  assert.match(started.notice, /no email content has been sent to a model/);
  const stored = store.readState().sources[0];
  assert.deepEqual(stored.messages.map(message => message.role), ['other', 'user']);
  assert.deepEqual(stored.messages.map(message => message.kind), ['incoming', 'user-written']);
  assert.ok(!stored.messages[1].text.includes('Quoted incoming wording'));
  for (const route of ['/api/onboarding', '/api/state']) assert.ok(!(await (await fetch(`${base}${route}`)).text()).includes(modelKey));
  assert.ok(!fs.readFileSync(path.join(store.dir, 'state.json'), 'utf8').includes(modelKey));
  const removed = await post(`/api/onboarding/sources/${encodeURIComponent(pasted.sources[0].id)}`, {}, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal((await state()).sources.length, 0);
  assert.equal((await state()).harness.status, 'idle');
  assert.equal((await post('/api/onboarding/start')).status, 409);
  assert.equal((await post('/api/onboarding/model', {}, 'DELETE')).status, 200);
  assert.equal((await state()).model.verified, false);
});

test('Gmail connection and undated import work end to end through real MCP and mocked official API responses', async t => {
  const mail = { id: 'm1', internalDate: String(Date.parse('2026-06-01')), labelIds: ['SENT'], payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'writer@example.test' }, { name: 'Subject', value: 'Synthetic follow-up' }], body: { data: Buffer.from('Thanks for the context. I will review your outline.').toString('base64url') } } };
  const mock = network([{ emailAddress: 'writer@example.test' }, { emailAddress: 'writer@example.test' }, { threads: [{ id: 't1' }] }, { messages: [mail] }]);
  const { post, state, verify } = await app(t, mock);
  await verify();
  assert.equal((await post('/api/onboarding/connect/gmail', { token: gmailToken })).status, 200);
  const imported = await post('/api/onboarding/import/gmail');
  const result = await imported.json();
  assert.equal(imported.status, 200, result.error);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].ownMessageCount, 1);
  assert.equal(mock.calls.length, 4);
  assert.equal(mock.calls[2].url.searchParams.get('q'), 'in:sent', 'Undated onboarding still searches for sent-writing evidence.');
  assert.ok(mock.calls.every(call => call.options.headers.Authorization === `Bearer ${gmailToken}`));
  assert.ok(!JSON.stringify(await state()).includes(gmailToken));
  assert.equal((await post('/api/onboarding/start')).status, 200);
  assert.equal((await post('/api/onboarding/connect/gmail', {}, 'DELETE')).status, 200);
  assert.equal((await state()).connections.gmail.connected, false);
  assert.equal((await state()).sources.length, 1, 'Disconnecting does not silently delete imported evidence.');
});

test('Slack lists and imports selected 1:1 conversations through real MCP, with no timeframe required', async t => {
  const identity = { ok: true, user_id: 'UME', team_id: 'T123' };
  const list = { ok: true, channels: [{ id: 'D123', is_im: true, user: 'UOTHER' }] };
  const mock = network([identity, list, identity, list, { ok: true, user: { id: 'UOTHER', profile: { display_name: 'Alex Chen', email: 'private@example.test' } } }, identity, { ok: true, channel: { id: 'D123', is_im: true, user: 'UOTHER' } }, { ok: true, messages: [
    { type: 'message', ts: '1780315201.000001', user: 'UME', text: 'Ja, danke dir für die Details.' },
    { type: 'message', ts: '1780315200.000001', user: 'UOTHER', text: 'Kannst du das prüfen?' },
  ] }]);
  const { post, verify, base, state } = await app(t, mock);
  await verify();
  assert.equal((await post('/api/onboarding/connect/slack', { token: slackToken })).status, 200);
  const listed = await (await fetch(`${base}/api/onboarding/slack/dms`)).json();
  assert.equal(listed.conversations[0].id, 'D123');
  assert.equal(listed.conversations[0].name, 'Alex Chen');
  assert.ok(!JSON.stringify(listed).includes('private@example.test'));
  const imported = await post('/api/onboarding/import/slack', { conversationIds: ['D123'] });
  const result = await imported.json();
  assert.equal(imported.status, 200, result.error);
  assert.equal(result.sources[0].messageCount, 2);
  assert.equal(result.sources[0].ownMessageCount, 1);
  assert.equal((await post('/api/onboarding/import/slack', { conversationIds: ['C123'] })).status, 400);
  assert.equal(mock.calls.length, 8, 'A channel ID must fail without reading any channel data.');
  assert.ok(!JSON.stringify(await state()).includes(slackToken));
});

test('provider failures are sanitized through HTTP and failed verification clears readiness', async t => {
  const session = new ModelSession({ verifier: async () => { throw new Error(`Provider accidentally echoed ${modelKey}`); }, env: {} });
  const failed = await app(t, { modelSession: session });
  const response = await failed.post('/api/onboarding/model', { provider: 'openai', apiKey: modelKey });
  assert.equal(response.status, 400);
  assert.ok(!(await response.text()).includes(modelKey));
  assert.equal((await failed.state()).model.verified, false);
  const mock = network([new Error(`Network accidentally echoed ${gmailToken}`)]);
  const sources = await app(t, mock);
  await sources.verify();
  const connection = await sources.post('/api/onboarding/connect/gmail', { token: gmailToken });
  assert.equal(connection.status, 502);
  assert.ok(!(await connection.text()).includes(gmailToken));
  assert.equal((await sources.state()).connections.gmail.connected, false);
});

test('only the exact OAuth callback bypasses cross-site blocking, and a valid state is one-use with PKCE', async t => {
  const mock = network([{ access_token: gmailToken }, { emailAddress: 'writer@example.test' }]);
  const env = { GOOGLE_CLIENT_ID: 'synthetic-client-id', GOOGLE_CLIENT_SECRET: 'synthetic-google-client-secret' };
  const { post, base, verify, state } = await app(t, { ...mock, env });
  await verify();
  const begin = await (await post('/api/onboarding/oauth/gmail')).json();
  const authorization = new URL(begin.url);
  assert.equal(authorization.origin, 'https://accounts.google.com');
  assert.equal(authorization.searchParams.get('scope'), 'https://www.googleapis.com/auth/gmail.readonly');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!begin.url.includes(env.GOOGLE_CLIENT_SECRET));
  const query = new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'synthetic-authorization-code' });
  for (const pathname of ['/api/onboarding', '/oauth/callback/gmail/', '/oauth/callback/slack']) {
    assert.equal((await fetch(`${base}${pathname}?${query}`, { headers: { 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual' })).status, 403);
  }
  const wrongState = await fetch(`${base}/oauth/callback/gmail?state=wrong&code=wrong`, { headers: { 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual' });
  assert.equal(wrongState.headers.get('location'), '/?connection_error=gmail');
  assert.equal(mock.calls.length, 0, 'An invalid state must not reach the provider or consume the legitimate pending flow.');
  const callback = await fetch(`${base}/oauth/callback/gmail?${query}`, { headers: { Origin: 'https://accounts.google.com', 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual' });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/?connected=gmail');
  assert.equal(mock.calls.length, 2);
  const form = new URLSearchParams(mock.calls[0].options.body);
  assert.equal(form.get('redirect_uri'), `${base}/oauth/callback/gmail`);
  assert.equal(form.get('client_secret'), env.GOOGLE_CLIENT_SECRET);
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
  assert.equal((await state()).connections.gmail.connected, true);
  assert.ok(!JSON.stringify(await state()).includes(gmailToken));
  assert.ok(!JSON.stringify(await state()).includes(env.GOOGLE_CLIENT_SECRET));
  const replay = await fetch(`${base}/oauth/callback/gmail?${query}`, { headers: { 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual' });
  assert.equal(replay.headers.get('location'), '/?connection_error=gmail');
  assert.equal(mock.calls.length, 2);
  const invalid = await fetch(`${base}/oauth/callback/gmail?state=wrong&code=wrong`, { headers: { 'Sec-Fetch-Site': 'cross-site' }, redirect: 'manual' });
  assert.equal(invalid.headers.get('location'), '/?connection_error=gmail');
  assert.equal(mock.calls.length, 2);
});
