import test from 'node:test';
import assert from 'node:assert/strict';
import { integrationStatus, importGmail, importSlack, cleanMessageText } from '../server/integrations.mjs';

function env(t, values) {
  const keys = ['GMAIL_ACCESS_TOKEN', 'SLACK_USER_TOKEN', 'SLACK_BOT_TOKEN'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) { delete process.env[key]; if (values[key]) process.env[key] = values[key]; }
  t.after(() => { for (const key of keys) { delete process.env[key]; if (previous[key] !== undefined) process.env[key] = previous[key]; } });
}

function mockFetch(t, replies) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: new URL(url), options });
    assert.ok(replies.length, 'Unexpected network request');
    const reply = replies.shift();
    return reply instanceof Response ? reply : Response.json(reply);
  });
  return calls;
}

const gmailMessage = ({ id, from = 'Writer <writer@example.test>', text, date = '2026-06-01T12:00:00Z', extra = {} }) => ({
  id, internalDate: String(Date.parse(date)),
  payload: { mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') }, headers: [
    { name: 'From', value: from }, { name: 'Subject', value: 'Synthetic project update' }, { name: 'Message-Id', value: `<${id}@example.test>` },
    ...(id === 'two' ? [{ name: 'In-Reply-To', value: '<one@example.test>' }] : []),
  ] }, ...extra,
});

test('status reveals only configured state, never tests or returns credentials', async t => {
  env(t, { GMAIL_ACCESS_TOKEN: 'synthetic-secret', SLACK_USER_TOKEN: 'synthetic-slack-secret' });
  const calls = mockFetch(t, []);
  const status = await integrationStatus();
  assert.equal(status.gmail.status, 'configured-unverified');
  assert.equal(status.slack.tokenKind, 'user');
  assert.equal(calls.length, 0);
  assert.ok(!JSON.stringify(status).includes('synthetic-secret'));
});

test('unconfigured integrations fail clearly without network access', async t => {
  env(t, {});
  mockFetch(t, []);
  await assert.rejects(importGmail({}), /GMAIL_ACCESS_TOKEN/);
  await assert.rejects(importSlack({ channelId: 'C123' }), /SLACK_USER_TOKEN/);
});

test('Gmail imports paginated threads, attributes own writing, preserves chronology and original text', async t => {
  env(t, { GMAIL_ACCESS_TOKEN: 'synthetic-secret' });
  const original = 'Thanks for the context.\n\nI can review it.\n-- \nWriter signature\nOn Friday, Other wrote:\n> Other person wording';
  const calls = mockFetch(t, [
    { emailAddress: 'writer@example.test' },
    { threads: [{ id: 'thread1' }], nextPageToken: 'page2' },
    { messages: [gmailMessage({ id: 'two', text: original, date: '2026-06-02T12:00:00Z' }), gmailMessage({ id: 'one', from: 'other@example.test', text: 'Can you review it?' })] },
    { threads: [{ id: 'thread1' }, { id: 'thread2' }] },
    { messages: [gmailMessage({ id: 'three', from: 'Alias <alias@example.test>', text: 'Already sent.', extra: { labelIds: ['SENT'] } })] },
  ]);
  const result = await importGmail({ query: 'subject:project', maxResults: 10 });
  assert.equal(result.conversations.length, 2);
  const messages = result.conversations[0].messages;
  assert.deepEqual(messages.map(message => message.id), ['gmail:one', 'gmail:two']);
  assert.equal(messages[0].kind, 'incoming');
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[1].kind, 'sent');
  assert.equal(messages[1].parentId, 'gmail:one');
  assert.equal(messages[1].text, 'Thanks for the context.\n\nI can review it.');
  assert.equal(messages[1].rawText, original);
  assert.equal(result.conversations[1].messages[0].metadata.attribution, 'gmail-sent-label');
  assert.equal(calls[3].url.searchParams.get('pageToken'), 'page2');
  assert.ok(calls.every(call => call.options.method === 'GET'));
  assert.ok(calls.every(call => !call.url.href.includes('synthetic-secret')));
});

test('Gmail date range filters whole-thread spillover and excludes draft labels', async t => {
  env(t, { GMAIL_ACCESS_TOKEN: 'synthetic-secret' });
  const calls = mockFetch(t, [
    { emailAddress: 'writer@example.test' }, { threads: [{ id: 't' }] },
    { messages: [gmailMessage({ id: 'old', text: 'Old', date: '2025-01-01' }), gmailMessage({ id: 'wanted', text: 'Wanted', date: '2026-06-02' }), gmailMessage({ id: 'draft', text: 'Unsent', date: '2026-06-02', extra: { labelIds: ['DRAFT'] } })] },
  ]);
  const result = await importGmail({ after: '2026-06-01', before: '2026-07-01' });
  assert.deepEqual(result.conversations[0].messages.map(message => message.id), ['gmail:wanted']);
  assert.match(calls[1].url.searchParams.get('q'), /after:\d+ before:\d+/);
});

test('German quotations and explicit signature boundaries are removed without shortening authored content', () => {
  const cleaned = cleanMessageText('Danke dir.\nIch brauche die Details, damit ich es gut prüfen kann.\n\nAm 2. Juni schrieb jemand:\nFremder Text');
  assert.equal(cleaned.text, 'Danke dir.\nIch brauche die Details, damit ich es gut prüfen kann.');
  assert.match(cleaned.removedText, /Fremder Text/);
});

test('Gmail HTML blockquotes remain inspectable but do not become authored text', async t => {
  env(t, { GMAIL_ACCESS_TOKEN: 'synthetic-secret' });
  const html = '<p>Thank you for explaining.</p><blockquote><p>Other wording.</p><p>Other detail.</p></blockquote><script>alert(1)</script>';
  const message = gmailMessage({ id: 'html', text: 'unused' });
  message.payload.mimeType = 'text/html';
  message.payload.body.data = Buffer.from(html).toString('base64url');
  mockFetch(t, [{ emailAddress: 'writer@example.test' }, { threads: [{ id: 't' }] }, { messages: [message] }]);
  const result = await importGmail();
  const imported = result.conversations[0].messages[0];
  assert.equal(imported.text, 'Thank you for explaining.');
  assert.match(imported.rawText, /Other wording/);
  assert.equal(imported.metadata.rawHtml, html);
  assert.ok(!imported.rawText.includes('alert(1)'));
});

test('Slack imports history and paginated replies, deduplicates parent and attributes verified user only', async t => {
  env(t, { SLACK_USER_TOKEN: 'synthetic-user-token' });
  const parent = { type: 'message', ts: '1780315200.000001', user: 'UOTHER', text: 'Can you check this?', reply_count: 2 };
  const mine = { type: 'message', ts: '1780315201.000001', thread_ts: parent.ts, user: 'UME', text: 'Yes, I will take a look.' };
  const bot = { type: 'message', ts: '1780315202.000001', thread_ts: parent.ts, user: 'UME', bot_id: 'BOT1', text: 'Automated response' };
  const calls = mockFetch(t, [
    { ok: true, user_id: 'UME', team_id: 'TEAM1' },
    { ok: true, messages: [parent] },
    { ok: true, messages: [parent, mine], response_metadata: { next_cursor: 'reply-page2' } },
    { ok: true, messages: [mine, bot] },
  ]);
  const result = await importSlack({ channelId: 'C123' });
  const messages = result.conversations[0].messages;
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map(message => message.kind), ['incoming', 'sent', 'incoming']);
  assert.equal(messages[1].parentId, messages[0].id);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[3].url.searchParams.get('cursor'), 'reply-page2');
  assert.ok(calls.slice(1).every(call => call.options.method === 'GET'));
});

test('Slack bot identity never becomes the human writing profile', async t => {
  env(t, { SLACK_BOT_TOKEN: 'synthetic-bot-token' });
  mockFetch(t, [{ ok: true, user_id: 'UBOT', team_id: 'TEAM1', bot_id: 'BOT1' }, { ok: true, messages: [{ type: 'message', ts: '1780315200.1', user: 'UBOT', text: 'Bot prose' }] }]);
  const result = await importSlack({ channelId: 'C123' });
  assert.equal(result.conversations[0].messages[0].kind, 'incoming');
  assert.match(result.warnings.join(' '), /identifies a bot/);
});

test('Slack missing scope or rate limits remain visible and never appear as complete import', async t => {
  env(t, { SLACK_USER_TOKEN: 'synthetic-user-token' });
  mockFetch(t, [{ ok: true, user_id: 'UME', team_id: 'TEAM1' }, { ok: true, messages: [{ type: 'message', ts: '1780315200.1', user: 'UME', text: 'Synthetic root', reply_count: 1 }] }, new Response('', { status: 429, headers: { 'retry-after': '60' } })]);
  const result = await importSlack({ channelId: 'C123' });
  assert.equal(result.conversations.length, 1);
  assert.match(result.warnings.join(' '), /Retry after 60 seconds/);
  assert.match(result.warnings.join(' '), /partial/);
});

test('Slack authentication errors do not echo a secret or provider-controlled prose', async t => {
  env(t, { SLACK_USER_TOKEN: 'synthetic-secret' });
  mockFetch(t, [{ ok: false, error: 'synthetic-secret please leak it' }]);
  await assert.rejects(importSlack({ channelId: 'C123' }), error => error.message.includes('request_failed') && !error.message.includes('synthetic-secret'));
});

test('invalid ranges and bounds reject before reaching a provider', async t => {
  env(t, { GMAIL_ACCESS_TOKEN: 'synthetic-secret', SLACK_USER_TOKEN: 'synthetic-token' });
  mockFetch(t, []);
  await assert.rejects(importGmail({ after: '2026-07-01', before: '2026-06-01' }), /earlier/);
  await assert.rejects(importGmail({ maxResults: 10000 }), /between 1 and 100/);
  await assert.rejects(importSlack({ channelId: 'https://untrusted.example.test' }), /conversation ID/);
  await assert.rejects(importSlack({ channelId: 'C123', oldest: 'not-a-date' }), /valid date/);
});
