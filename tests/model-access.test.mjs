import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyModelAccess, ModelSession } from '../server/model-access.mjs';

const key = 'synthetic-api-key-do-not-use';
const openaiList = { object: 'list', data: [{ id: 'gpt-4.1-mini', object: 'model' }] };
const verified = provider => ({ provider, model: '', verified: true, validation: 'models-list', verifiedAt: '2026-10-17T10:00:00.000Z', availableModelCount: 1 });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('OpenAI verifies only through the official read-only model endpoint and exposes no key', async () => {
  const calls = [];
  const result = await verifyModelAccess({ provider: 'openai', apiKey: key, content: 'Private customer text' }, {
    env: {}, fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json(openaiList); },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${key}`);
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.body, undefined);
  assert.ok(!JSON.stringify(calls).includes('Private customer text'));
  assert.equal(result.verified, true);
  assert.equal(result.validation, 'models-list');
  assert.equal(result.model, 'gpt-4.1-mini');
  assert.equal(result.availableModelCount, 1);
  assert.ok(Number.isFinite(Date.parse(result.verifiedAt)));
  assert.ok(!JSON.stringify(result).includes(key));
  assert.equal(result.generationVerified, undefined);
  assert.equal(result.billingVerified, undefined);
});

test('Anthropic uses the documented API key and version headers', async () => {
  let request;
  const result = await verifyModelAccess({ provider: 'anthropic', apiKey: key }, {
    env: { ANTHROPIC_MODEL: 'claude-sonnet-4-5' },
    fetchImpl: async (url, options) => { request = { url, options }; return Response.json({ data: [{ id: 'claude-sonnet-4-5', type: 'model', lifecycle: 'active' }] }); },
  });
  assert.equal(request.url, 'https://api.anthropic.com/v1/models?limit=100');
  assert.equal(request.options.headers['x-api-key'], key);
  assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.options.headers.Authorization, undefined);
  assert.equal(request.options.method, 'GET');
  assert.equal(result.model, 'claude-sonnet-4-5');
});

test('input validation requires a supplied supported provider and key, regardless of environment', async () => {
  const noNetwork = async () => { assert.fail('Invalid input reached the network'); };
  for (const input of [undefined, null, {}, { provider: 'demo', apiKey: key }, { provider: 'https://untrusted.example', apiKey: key },
    { provider: 'openai' }, ...['', '   ', '\nkey', 'key\r', 'two keys', 'key\tvalue', 'x'.repeat(4097), 7].map(apiKey => ({ provider: 'openai', apiKey }))]) {
    await assert.rejects(verifyModelAccess(input, { fetchImpl: noNetwork, env: { OPENAI_API_KEY: key, OPENAI_MODEL: 'gpt-4.1-mini' } }));
  }
});

test('ordinary outer copied spaces are trimmed and a visible configured model is retained', async () => {
  const env = Object.freeze({ OPENAI_MODEL: 'gpt-4.1-mini' });
  const result = await verifyModelAccess({ provider: 'openai', apiKey: `  ${key}  ` }, {
    env, fetchImpl: async (_url, options) => { assert.equal(options.headers.Authorization, `Bearer ${key}`); return Response.json(openaiList); },
  });
  assert.equal(result.model, 'gpt-4.1-mini');
  const absent = await verifyModelAccess({ provider: 'openai', apiKey: key }, { env: { OPENAI_MODEL: 'gpt-not-in-list' }, fetchImpl: async () => Response.json(openaiList) });
  assert.equal(absent.model, 'gpt-4.1-mini');
});

test('malformed, empty, retired, and nontext catalogues cannot fake model access', async () => {
  for (const data of [null, [], {}, { data: {} }, { data: [] }, { data: [{ id: 'gpt-4.1-mini' }] },
    { data: [{ id: 'text-embedding-3-small', object: 'model' }] },
    { data: [{ id: 'gpt-image-1', object: 'model' }, { id: 'gpt-4o-audio-preview', object: 'model' }] },
    { data: [{ id: 'gpt-4.1-mini', object: 'model', shutdown_date: '2001-01-01' }] },
    { data: [{ id: 'gpt-4.1-mini', object: 'model', lifecycle: 'retired' }] }]) {
    await assert.rejects(verifyModelAccess({ provider: 'openai', apiKey: key }, { env: {}, fetchImpl: async () => Response.json(data) }));
  }
  await assert.rejects(verifyModelAccess({ provider: 'anthropic', apiKey: key }, {
    env: {}, fetchImpl: async () => Response.json({ data: [{ id: 'claude-sonnet-4-5', type: 'model', lifecycle: 'retired' }] }),
  }), /No available text model/);
});

test('model counts deduplicate IDs and Anthropic lifecycle overrides an overdue retirement date', async () => {
  const result = await verifyModelAccess({ provider: 'anthropic', apiKey: key }, {
    env: {}, fetchImpl: async () => Response.json({ data: [
      { id: 'claude-sonnet-4-5', type: 'model', lifecycle: 'deprecated', retires_at: '2001-01-01' },
      { id: 'claude-sonnet-4-5', type: 'model', lifecycle: 'deprecated' },
      { id: 'claude-old', type: 'model', lifecycle: 'retired' },
    ] }),
  });
  assert.equal(result.availableModelCount, 1);
});

test('provider HTTP bodies, parse failures and network errors never echo secrets', async () => {
  for (const fetchImpl of [
    async () => { throw new Error(`network ${key}`); },
    async () => ({ ok: true, json: async () => { throw new Error(`parse ${key}`); } }),
    ...[301, 400, 401, 403, 429, 500].map(status => async () => new Response(`provider ${key}`, { status })),
  ]) {
    await assert.rejects(verifyModelAccess({ provider: 'openai', apiKey: key }, { fetchImpl, env: {} }), error => {
      assert.ok(!String(error).includes(key));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('session public state is allowlisted and credentials are isolated from status and environment', async () => {
  const env = Object.freeze({ OPENAI_MODEL: 'gpt-4.1-mini' });
  const session = new ModelSession({ env, verifier: async () => ({ ...verified('openai'), apiKey: key, extra: key }) });
  assert.equal(session.status.verified, false);
  assert.equal(session.getCredentials(), null);
  const status = await session.verify({ provider: 'openai', apiKey: key });
  assert.ok(!JSON.stringify(status).includes(key));
  assert.equal(status.apiKey, undefined);
  assert.deepEqual(session.getCredentials(), { provider: 'openai', apiKey: key, model: '' });
  status.verified = false;
  session.getCredentials().apiKey = 'changed';
  assert.equal(session.status.verified, true);
  assert.equal(session.getCredentials().apiKey, key);
  assert.deepEqual(env, { OPENAI_MODEL: 'gpt-4.1-mini' });
  assert.equal(JSON.stringify(session), '{}');
  const independent = new ModelSession();
  assert.equal(independent.status.verified, false);
  session.clear();
  assert.equal(session.getCredentials(), null);
  assert.equal(session.status.verified, false);
});

test('failed replacement revokes the previous key and suppresses raw adapter errors', async () => {
  let fail = false;
  const session = new ModelSession({ verifier: async () => { if (fail) throw new Error(key); return verified('openai'); } });
  await session.verify({ provider: 'openai', apiKey: key });
  fail = true;
  await assert.rejects(session.verify({ provider: 'openai', apiKey: 'replacement' }), error => !error.message.includes(key));
  assert.equal(session.getCredentials(), null);
  assert.equal(session.status.verified, false);
});

test('invalid replacement input also clears previous access without calling the verifier', async () => {
  let calls = 0;
  const session = new ModelSession({ verifier: async () => { calls++; return verified('openai'); } });
  await session.verify({ provider: 'openai', apiKey: key });
  await assert.rejects(session.verify({ provider: 'openai', apiKey: '' }), /API key/);
  assert.equal(calls, 1);
  assert.equal(session.status.verified, false);
  assert.equal(session.getCredentials(), null);
});

test('unverified or malformed adapter results never save credentials', async () => {
  for (const result of [undefined, { ...verified('openai'), verified: false }, { ...verified('openai'), validation: 'simulated' },
    { ...verified('openai'), availableModelCount: 0 }, { ...verified('anthropic') },
    { ...verified('openai'), model: key }, { ...verified('openai'), model: undefined },
    { ...verified('openai'), verifiedAt: 'invalid' }]) {
    const session = new ModelSession({ verifier: async () => result });
    await assert.rejects(session.verify({ provider: 'openai', apiKey: key }));
    assert.equal(session.getCredentials(), null);
    assert.equal(session.status.verified, false);
  }
});

test('clear invalidates an in-flight successful verification', async () => {
  const pending = deferred();
  const session = new ModelSession({ verifier: () => pending.promise });
  const attempt = session.verify({ provider: 'openai', apiKey: key });
  session.clear();
  pending.resolve(verified('openai'));
  await assert.rejects(attempt, /cancelled or replaced/);
  assert.equal(session.status.verified, false);
  assert.equal(session.getCredentials(), null);
});

test('a slower earlier verification cannot overwrite the newest verified credential', async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const session = new ModelSession({ verifier: () => (++calls === 1 ? first.promise : second.promise) });
  const firstAttempt = session.verify({ provider: 'openai', apiKey: 'first-synthetic-key' });
  const secondAttempt = session.verify({ provider: 'anthropic', apiKey: 'second-synthetic-key' });
  second.resolve(verified('anthropic'));
  await secondAttempt;
  first.resolve(verified('openai'));
  await assert.rejects(firstAttempt, /cancelled or replaced/);
  assert.equal(session.status.provider, 'anthropic');
  assert.equal(session.getCredentials().apiKey, 'second-synthetic-key');
});

test('an old failure does not revoke a newer successful verification', async () => {
  const first = deferred();
  let calls = 0;
  const session = new ModelSession({ verifier: () => ++calls === 1 ? first.promise : verified('openai') });
  const old = session.verify({ provider: 'openai', apiKey: key });
  await session.verify({ provider: 'openai', apiKey: 'new-synthetic-key' });
  first.reject(new Error(key));
  await assert.rejects(old, /cancelled or replaced/);
  assert.equal(session.status.verified, true);
  assert.equal(session.getCredentials().apiKey, 'new-synthetic-key');
});

test('model selection uses returned IDs, never requires the key again, and invalidates generation snapshots', async () => {
  let verifications = 0;
  const session = new ModelSession({ verifier: async () => {
    verifications++;
    return { ...verified('openai'), model: 'gpt-4.1-mini', availableModelCount: 2,
      availableModels: [{ id: 'gpt-4.1-mini', label: key, extra: key }, { id: 'gpt-4.1' }] };
  } });
  await session.verify({ provider: 'openai', apiKey: key });
  const original = session.revision;
  assert.equal(session.isCurrent(original), true);
  const changed = session.selectModel('gpt-4.1');
  assert.equal(changed.model, 'gpt-4.1');
  assert.equal(session.getCredentials().model, 'gpt-4.1');
  assert.equal(session.isCurrent(original), false);
  assert.equal(verifications, 1);
  assert.ok(!JSON.stringify(changed).includes(key));
  assert.deepEqual(changed.availableModels.map(m => m.label), ['gpt-4.1-mini', 'gpt-4.1']);
  changed.availableModels[0].id = 'tampered';
  assert.equal(session.status.availableModels[0].id, 'gpt-4.1-mini');
  const revision = session.revision;
  session.selectModel('gpt-4.1');
  assert.equal(session.revision, revision, 'Selecting current model does not invalidate active work.');
  assert.throws(() => session.selectModel('made-up-model'), /available/);
  assert.equal(session.revision, revision);
  session.clear();
  assert.equal(session.isCurrent(revision), false);
  assert.throws(() => session.selectModel('gpt-4.1'), /available/);
});

test('verification exposes a stable sensible default drawn only from supported returned text candidates', async () => {
  const result = await verifyModelAccess({ provider: 'openai', apiKey: key }, { env: {}, fetchImpl: async () => Response.json({data:[
    { id: 'gpt-4.1', object:'model' }, { id: 'gpt-4.1-mini', object:'model' },
    { id: 'gpt-4o-realtime-preview', object:'model' }, { id: 'text-embedding-3-large', object:'model' },
    { id: 'gpt-4.1-mini', object:'model' },
  ]}) });
  assert.equal(result.model, 'gpt-4.1-mini');
  assert.deepEqual(result.availableModels.map(m => m.id), ['gpt-4.1-mini', 'gpt-4.1']);
  const anthropic = await verifyModelAccess({ provider:'anthropic',apiKey:key }, {env:{},fetchImpl:async()=>Response.json({data:[
    {id:'claude-opus-4-6',type:'model'},{id:'claude-sonnet-4-6',type:'model'},
  ]})});
  assert.equal(anthropic.model,'claude-sonnet-4-6');
});

test('malformed model choices and a selection outside the returned list cannot become public session data', async () => {
  for (const availableModels of [null, {}, [], [{ id:key }], [{id:'invalid name'}], [{id:'different-model'}]]) {
    const session=new ModelSession({verifier:async()=>({...verified('openai'),model:'gpt-4.1-mini',availableModels})});
    await assert.rejects(session.verify({provider:'openai',apiKey:key}),/invalid model list/);
    assert.equal(session.getCredentials(),null);
  }
});

test('effort is validated per model and changes invalidate generation without exposing credentials', async () => {
  const session = new ModelSession({verifier: async () => ({...verified('openai'), model: 'gpt-6-astra', availableModelCount: 2, availableModels: [{id: 'gpt-6-astra'}, {id: 'gpt-4.1'}]})});
  await session.verify({provider: 'openai', apiKey: key});
  assert.deepEqual(session.status.availableModels[0].efforts, ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  const original = session.revision;
  assert.equal(session.selectModel('gpt-6-astra', 'high').effort, 'high');
  assert.equal(session.isCurrent(original), false);
  const changed = session.revision;
  assert.equal(session.selectModel('gpt-6-astra').effort, 'high');
  assert.equal(session.revision, changed);
  assert.throws(() => session.selectModel('gpt-6-astra', 'none'), /effort/i);
  assert.throws(() => session.selectModel('gpt-4.1', 'high'), /effort/i);
  assert.equal(session.revision, changed);
  assert.equal(session.status.model, 'gpt-6-astra');
  const copy = session.status;
  copy.availableModels[0].efforts.push('invented');
  assert.ok(!session.status.availableModels[0].efforts.includes('invented'));
  assert.equal(session.selectModel('gpt-4.1').effort, 'default');
  assert.deepEqual(session.status.availableModels[1].efforts, ['default']);
  assert.ok(!JSON.stringify(session.status).includes(key));
  session.clear();
  assert.equal(session.status.effort, 'default');
});
