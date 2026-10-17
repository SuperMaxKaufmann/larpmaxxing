import test from 'node:test';
import assert from 'node:assert/strict';
import { completeJSON, ModelRequestError, safeModelError, modelErrorDetails } from '../server/providers.mjs';
import { modelOptions, validateEffort, modelRequestLimits } from '../server/model-options.mjs';

const credentials = (provider = 'openai', model = 'gpt-6-astra') => ({ provider, model, apiKey: 'synthetic-session-key' });
const success = (provider = 'openai') => Response.json(provider === 'openai'
  ? { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"observations":[]}' }] }] }
  : { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"observations":[]}' }] });
const request = (options = {}) => completeJSON('openai', 'Return the evidence as JSON.', { content: 'Synthetic evidence' }, { credentials: credentials(), ...options });

test('verified effort choices distinguish models and leave unknown models on provider defaults', () => {
  assert.deepEqual(modelOptions('openai', 'gpt-6-astra').efforts, ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(modelOptions('openai', 'gpt-6.1-sol').efforts.includes('none'), false);
  assert.equal(modelOptions('openai', 'gpt-6-sol').efforts.includes('none'), true);
  assert.deepEqual(modelOptions('openai', 'gpt-5.4-mini-2026-03-17').efforts, ['default', 'none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(modelOptions('anthropic', 'claude-sonnet-4-6').efforts, ['default', 'low', 'medium', 'high', 'max']);
  for (const id of ['gpt-4.1-mini', 'gpt-6-astra-future-snapshot', '__proto__']) assert.deepEqual(modelOptions('openai', id).efforts, ['default']);
  assert.deepEqual(modelOptions('anthropic', 'claude-unverified').efforts, ['default']);
  assert.equal(validateEffort('openai', 'gpt-6-astra'), 'default');
  assert.throws(() => validateEffort('openai', 'gpt-6-astra', 'none'), /supported/);
});

test('Astra effort reaches the Responses API with room for reasoning and without enabling tools', async () => {
  let body;
  const result = await request({ effort: 'high', fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return success(); } });
  assert.deepEqual(result, { observations: [] });
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.max_output_tokens, 25000);
  assert.equal(body.store, false);
  assert.equal(body.tools, undefined);
  assert.equal(body.text.format.type, 'json_object');
});

test('Claude effort uses its own output configuration and default omits provider-specific overrides', async () => {
  for (const [provider, model] of [['anthropic', 'claude-opus-5-5'], ['openai', 'gpt-6-astra']]) {
    for (const effort of ['low', 'default']) {
      let body;
      await completeJSON(provider, 'Return JSON.', {}, { credentials: credentials(provider, model), effort, fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return success(provider); } });
      if (provider === 'anthropic') {
        assert.deepEqual(body.output_config, effort === 'default' ? undefined : { effort });
        assert.equal(body.reasoning, undefined);
      } else {
        assert.deepEqual(body.reasoning, effort === 'default' ? undefined : { effort });
        assert.equal(body.output_config, undefined);
      }
    }
  }
  assert.equal(modelRequestLimits('openai', 'gpt-6-astra').timeoutMs, 300000);
  assert.equal(modelRequestLimits('openai', 'gpt-6-luna', 'none').maxOutputTokens, 6000);
  assert.equal(modelRequestLimits('openai', 'unknown-model').maxOutputTokens, 6000);
});

test('invalid or unverified effort fails before any provider request', async () => {
  for (const [model, effort] of [['gpt-6-astra', 'none'], ['gpt-6-astra', 'ultra'], ['unknown-model', 'high']]) {
    await assert.rejects(request({ credentials: credentials('openai', model), effort, fetchImpl: async () => assert.fail('Must not call a provider') }), error => modelErrorDetails(error)?.code === 'effort');
  }
});

test('HTTP errors preserve safe status and request ID while stripping provider bodies and arbitrary codes', async () => {
  const secret = 'PRIVATE-CONVERSATION-CONTENT';
  await assert.rejects(request({ fetchImpl: async () => Response.json({ error: { code: 'insufficient_quota', message: secret } }, { status: 429, headers: { 'x-request-id': 'req_synthetic1234' } }) }), error => {
    assert.deepEqual(modelErrorDetails(error), { code: 'http', provider: 'openai', httpStatus: 429, providerCode: 'insufficient_quota', requestId: 'req_synthetic1234' });
    assert.match(safeModelError(error), /billing or quota/);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
  await assert.rejects(request({ fetchImpl: async () => Response.json({ error: { code: secret, message: secret } }, { status: 400, headers: { 'x-request-id': secret } }) }), error => {
    assert.deepEqual(modelErrorDetails(error), { code: 'http', provider: 'openai', httpStatus: 400 });
    assert.equal(safeModelError(error).includes(secret), false);
    return true;
  });
});

test('documented quota and spend codes give specific recovery guidance without exposing provider text or retrying', async () => {
  const cases = [
    ['credit_balance_exhausted', /prepaid credits are exhausted/],
    ['organization_spend_limit_exceeded', /organization has reached its spend limit/],
    ['project_spend_limit_exceeded', /project has reached its spend limit/],
    ['organization_usage_limit_exceeded', /provider-assigned usage limit/],
  ];
  for (const [code, message] of cases) {
    let calls = 0;
    await assert.rejects(request({ fetchImpl: async () => {
      calls++;
      return Response.json({ error: { code, type: 'insufficient_quota', message: 'PRIVATE-PROVIDER-TEXT' } }, { status: 429 });
    } }), error => {
      assert.equal(modelErrorDetails(error).providerCode, code, 'The specific code takes precedence over its broader type.');
      assert.match(safeModelError(error), message);
      assert.equal(safeModelError(error).includes('rate limiting'), false);
      assert.equal(JSON.stringify({ message: safeModelError(error), details: modelErrorDetails(error) }).includes('PRIVATE'), false);
      return true;
    });
    assert.equal(calls, 1, 'Billing and quota failures must not retry automatically.');
  }
});

test('unknown provider codes fall back to recognized types without retaining the unknown code', async () => {
  await assert.rejects(request({ fetchImpl: async () => Response.json({ error: { code: 'PRIVATE-UNKNOWN-CODE', type: 'insufficient_quota', message: 'PRIVATE-PROVIDER-TEXT' } }, { status: 429 }) }), error => {
    assert.deepEqual(modelErrorDetails(error), { code: 'http', provider: 'openai', httpStatus: 429, providerCode: 'insufficient_quota' });
    assert.match(safeModelError(error), /billing or quota/);
    assert.equal(JSON.stringify({ message: safeModelError(error), details: modelErrorDetails(error) }).includes('PRIVATE'), false);
    return true;
  });
});

test('known throttling codes differ from unknown HTTP 429 causes', async () => {
  for (const code of ['rate_limit_exceeded', 'rate_limit_error', 'slow_down']) {
    await assert.rejects(request({ fetchImpl: async () => Response.json({ error: { code, type: 'rate_limit_error' } }, { status: 429 }) }), error => {
      assert.equal(modelErrorDetails(error).providerCode, code);
      assert.match(safeModelError(error), /provider is rate limiting requests/);
      return true;
    });
  }
  for (const body of [{}, { error: { code: 'PRIVATE-CODE', type: 'PRIVATE-TYPE', message: 'PRIVATE-TEXT' } }]) {
    await assert.rejects(request({ fetchImpl: async () => Response.json(body, { status: 429 }) }), error => {
      assert.deepEqual(modelErrorDetails(error), { code: 'http', provider: 'openai', httpStatus: 429 });
      assert.match(safeModelError(error), /rate limit or a billing\/quota limit/);
      assert.equal(safeModelError(error).includes('provider is rate limiting'), false);
      assert.equal(JSON.stringify({ message: safeModelError(error), details: modelErrorDetails(error) }).includes('PRIVATE'), false);
      return true;
    });
  }
});

test('request IDs echoed from submitted evidence do not enter diagnostics', async () => {
  await assert.rejects(completeJSON('openai', 'Return JSON.', { content: 'req_private1234' }, { credentials: credentials(), fetchImpl: async () => Response.json({}, { status: 500, headers: { 'x-request-id': 'req_private1234' } }) }), error => {
    assert.equal(modelErrorDetails(error).requestId, undefined);
    return true;
  });
});

test('a failed response envelope retains an allowlisted provider code but never its message', async () => {
  await assert.rejects(request({ fetchImpl: async () => Response.json({ status: 'failed', error: { code: 'server_error', message: 'PRIVATE-FAILURE-TEXT' } }) }), error => {
    assert.equal(modelErrorDetails(error).providerCode, 'server_error');
    assert.equal(safeModelError(error).includes('PRIVATE'), false);
    return true;
  });
});

test('incomplete output is distinguished from refusal and malformed JSON without accepting partial data', async () => {
  const cases = [
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ content: [{ type: 'output_text', text: '{"observations":[]}' }] }] }, 'output_limit'],
    [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] }, 'refusal'],
    [{ status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'PRIVATE-CONTENT' }] }] }, 'refusal'],
    [{ status: 'completed', output: [{ content: [{ type: 'output_text', text: 'PRIVATE-INVALID-JSON' }] }] }, 'invalid_json'],
    [{ status: 'completed', output: 'PRIVATE-INVALID-ENVELOPE' }, 'invalid_response'],
  ];
  for (const [body, code] of cases) {
    let calls = 0;
    await assert.rejects(request({ fetchImpl: async () => { calls++; return Response.json(body); } }), error => modelErrorDetails(error)?.code === code && !error.message.includes('PRIVATE'));
    assert.equal(calls, 1, 'A failed billed request must not retry automatically.');
  }
});

test('the deadline covers both response headers and a stalled body without blind retries', async () => {
  for (const bodyStalled of [false, true]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return bodyStalled ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
    };
    await assert.rejects(request({ timeoutMs: 5, fetchImpl }), error => modelErrorDetails(error)?.code === 'timeout');
    assert.equal(calls, 1);
  }
});

test('explicit cancellation is distinguishable from a timeout or a network failure', async () => {
  const controller = new AbortController();
  controller.abort(new Error('PRIVATE-CANCEL-REASON'));
  await assert.rejects(request({ signal: controller.signal, fetchImpl: async () => assert.fail('Cancelled before sending') }), error => modelErrorDetails(error)?.code === 'cancelled' && !error.message.includes('PRIVATE'));
  await assert.rejects(request({ fetchImpl: async () => { throw new Error('PRIVATE-REQUEST-HEADERS'); } }), error => modelErrorDetails(error)?.code === 'network' && !error.message.includes('PRIVATE'));
});

test('only application-created typed diagnostics are public, even when error messages are modified', () => {
  const error = new ModelRequestError('output_limit', { provider: 'openai', providerCode: 'PRIVATE-SECRET', requestId: 'not-a-provider-id' });
  error.message = 'PRIVATE-RAW-PROVIDER-MESSAGE';
  assert.match(safeModelError(error), /output limit/);
  assert.deepEqual(modelErrorDetails(error), { code: 'output_limit', provider: 'openai' });
  assert.equal(safeModelError(new Error('PRIVATE-SECRET')), null);
  assert.equal(modelErrorDetails({ name: 'ModelRequestError', code: 'output_limit' }), null);
});

test('request-setting errors retain allowlisted parameters and fixed diagnoses without raw provider text', async () => {
  const cases = [
    ['input', 'invalid_request_error', "'input' must contain the word 'json' in some form, to use 'text.format' of type 'json_object'. PRIVATE-CONTENT", 'json_context_missing', /application request-format error/],
    ['reasoning.effort', 'unsupported_value', 'Unsupported value: PRIVATE-CONTENT', 'unsupported_value', /setting's value/],
    ['text.format.type', 'invalid_request_error', 'Unsupported parameter: PRIVATE-CONTENT', 'unsupported_parameter', /does not support this request parameter/],
    ['model', 'invalid_request_error', 'The model PRIVATE-CONTENT does not exist or you do not have access to it.', 'model_access', /unavailable to this key/],
    ['service_tier', 'invalid_request_error', 'PRIVATE-CONTENT', 'service_tier', /rejected the service tier/],
    ['store', 'invalid_request_error', 'Project PRIVATE-CONTENT does not have access to this feature.', 'project_access', /project does not have access/],
  ];
  for (const [param, code, message, reason, expectedMessage] of cases) {
    let calls = 0;
    await assert.rejects(request({ fetchImpl: async () => { calls++; return Response.json({ error: { param, code, message } }, { status: 400 }); } }), error => {
      assert.deepEqual(modelErrorDetails(error), { code: 'http', provider: 'openai', httpStatus: 400, providerCode: code, providerParam: param, providerReason: reason });
      assert.match(safeModelError(error), expectedMessage);
      assert.ok(safeModelError(error).includes(`Setting: ${param}.`));
      assert.equal(JSON.stringify({ message: safeModelError(error), details: modelErrorDetails(error) }).includes('PRIVATE-CONTENT'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('diagnostic parameters are allowlisted and arbitrary messages cannot become diagnoses or UI content', async () => {
  for (const param of ['model', 'service_tier', 'text.format', 'text.format.type', 'max_output_tokens', 'reasoning.effort', 'instructions', 'input', 'store']) {
    const error = new ModelRequestError('http', { httpStatus: 400, providerParam: param });
    assert.equal(modelErrorDetails(error).providerParam, param);
  }
  for (const param of ['input.PRIVATE-CONTENT', '<script>PRIVATE-CONTENT</script>', '__proto__', { toString: 'PRIVATE-CONTENT' }]) {
    await assert.rejects(request({ fetchImpl: async () => Response.json({ error: { code: 'invalid_request_error', param, message: 'PRIVATE-CONTENT json unsupported parameter model project' } }, { status: 400 }) }), error => {
      assert.deepEqual(modelErrorDetails(error), { code: 'http', provider: 'openai', httpStatus: 400, providerCode: 'invalid_request_error' });
      assert.equal(error.message.includes('PRIVATE-CONTENT'), false);
      return true;
    });
  }
  const forged = new ModelRequestError('http', { httpStatus: 400, providerParam: 'PRIVATE-CONTENT', providerReason: 'PRIVATE-CONTENT' });
  assert.deepEqual(modelErrorDetails(forged), { code: 'http', httpStatus: 400 });
  assert.equal(forged.message.includes('PRIVATE-CONTENT'), false);
});
