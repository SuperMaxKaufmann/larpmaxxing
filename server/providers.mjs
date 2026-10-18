import { modelRequestLimits, validateEffort } from './model-options.mjs';
import {readResponseStream} from './response-stream.mjs';
import {ClaudeRunError} from './claude-plan.mjs';

const PROVIDERS = new Set(['openai', 'anthropic', 'claude-plan', 'demo']);
const PROVIDER_CODES = new Set(['invalid_api_key', 'authentication_error', 'permission_error', 'model_not_found', 'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'rate_limit_exceeded', 'rate_limit_error', 'slow_down', 'billing_hard_limit_reached', 'context_length_exceeded', 'unsupported_parameter', 'unsupported_value', 'invalid_request_error', 'invalid_value', 'server_error', 'api_error', 'overloaded_error']);
const PROVIDER_PARAMS = new Set(['model', 'service_tier', 'text.format', 'text.format.type', 'max_output_tokens', 'reasoning.effort', 'instructions', 'input', 'store']);
const PROVIDER_REASONS = new Set(['json_context_missing', 'unsupported_parameter', 'unsupported_value', 'model_access', 'service_tier', 'project_access']);
for(const code of ['subscription_sharing_user_not_eligible','subscription_sharing_usage_limit_exceeded','subscription_sharing_usage_unavailable','subscription_sharing_unsupported_capability','subscription_sharing_route_not_supported','subscription_sharing_invalid_user','subscription_sharing_user_unavailable','chatpass_v2_scope_not_authorized','chatpass_v2_invalid_authorization_context'])PROVIDER_CODES.add(code);
const ERROR_MESSAGES = {
  configuration: 'The model provider is not configured. Connect ChatGPT, your Claude plan or an API key and choose an available model.',
  chatgpt_auth: 'Your ChatGPT connection could not be renewed. Open connection settings and continue with your saved ChatGPT account. No API key is required.',
  effort: 'Choose an effort supported by this model, or use the provider default.',
  timeout: 'The model request timed out. Try a lower effort or a smaller request, then resume. The provider may have charged for work already performed.',
  cancelled: 'The model request was cancelled. No response from this request was saved.',
  network: 'Could not reach the model provider. Check your connection, then resume to retry.',
  output_limit: 'The model reached its output limit before finishing. Reasoning shares this limit with the response. Choose a lower effort or a smaller request, then retry.',
  refusal: 'The model declined this request. Review the selected content before trying again.',
  incomplete: 'The model could not complete this response. Try a lower effort, a smaller request, or another available model.',
  invalid_response: 'The model provider returned an invalid response. Please retry.',
  invalid_json: 'The model did not return valid JSON. No result from this request was saved. Try again or choose a JSON-capable model.',
  provider_failure: 'The model provider could not complete this request. Please retry later.',
  claude_missing: 'Claude Code can no longer be found on this computer. Reinstall it, run “claude auth login”, then reconnect your Claude plan. Completed work remains saved.',
  claude_signed_out: 'Claude Code is signed out of your Claude plan. Run “claude auth login” in Terminal, choose your Claude account, then retry. Completed work remains saved.',
  claude_not_plan: 'Claude Code is set up for API or cloud billing, not your Claude plan, so the result was discarded. Run “claude auth login” and choose your Claude account, then retry.',
  claude_account: 'Claude reported a problem with your account or plan. Check your plan at claude.ai, then retry. Completed work remains saved.',
  claude_limit: 'Claude plan usage limit reached. Wait for it to reset (claude.ai → Settings → Usage), then resume. Completed work remains saved.',
  claude_model: 'This Claude model isn’t available on your plan. Choose another Claude model.',
  claude_unavailable: 'Claude is temporarily unavailable. Your connection is saved. Try again later.',
  claude_failed: 'Claude Code could not complete this request. Update it with “claude update”, then retry.',
};
const CLAUDE_CODES = {missing: 'claude_missing', signed_out: 'claude_signed_out', not_plan: 'claude_not_plan', account: 'claude_account', limit: 'claude_limit', model: 'claude_model', unavailable: 'claude_unavailable', failed: 'claude_failed', timeout: 'timeout', output_limit: 'output_limit', refusal: 'refusal', incomplete: 'incomplete', invalid_response: 'invalid_response'};
const diagnostics = new WeakMap();

function sanitizeDetails(code, input = {}) {
  const details = { code };
  if (['openai', 'anthropic', 'claude-plan'].includes(input.provider)) details.provider = input.provider;
  if (Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) details.httpStatus = input.httpStatus;
  if (PROVIDER_CODES.has(input.providerCode)) details.providerCode = input.providerCode;
  if (PROVIDER_PARAMS.has(input.providerParam)) details.providerParam = input.providerParam;
  if (PROVIDER_REASONS.has(input.providerReason)) details.providerReason = input.providerReason;
  if(['chatgpt','claude-plan'].includes(input.authMode))details.authMode=input.authMode;
  if (typeof input.requestId === 'string' && /^req_[a-zA-Z0-9_-]{4,120}$/.test(input.requestId)) details.requestId = input.requestId;
  return details;
}

function publicMessage(details) {
  if (details.code !== 'http') return ERROR_MESSAGES[details.code];
  const status = details.httpStatus;
  const prefix = `Model provider returned HTTP ${status || 'error'}.`;
  if(details.authMode==='chatgpt') {
    if(details.providerCode==='subscription_sharing_usage_limit_exceeded'||status===429)return 'ChatGPT plan or app usage limit reached. Open Manage usage in ChatGPT settings before resuming. Your connection and completed work remain saved.';
    if(details.providerCode==='subscription_sharing_user_not_eligible')return 'ChatGPT plan usage is unavailable for this account or workspace. Check eligibility and app access in ChatGPT settings.';
    if(status===401||details.providerCode==='subscription_sharing_invalid_user')return 'ChatGPT could not authorize this request. Continue with your saved ChatGPT account to review permissions.';
    if(status===403)return 'ChatGPT plan access was restricted. Check this account’s permissions and app access in ChatGPT settings.';
    if(status===503||['subscription_sharing_usage_unavailable','subscription_sharing_user_unavailable'].includes(details.providerCode))return 'ChatGPT plan usage is temporarily unavailable. Your connection is saved. Try again later.';
    if(details.providerCode==='subscription_sharing_unsupported_capability')return 'ChatGPT plan usage does not support a requested model or setting. Choose another model or effort.';
  }
  if (details.providerCode === 'credit_balance_exhausted') return `${prefix} Your API organization's prepaid credits are exhausted. Check its billing balance before resuming.`;
  if (details.providerCode === 'organization_spend_limit_exceeded') return `${prefix} Your API organization has reached its spend limit. Review that limit or wait for it to reset before resuming.`;
  if (details.providerCode === 'project_spend_limit_exceeded') return `${prefix} Your API project has reached its spend limit. Review that project's limit or wait for it to reset before resuming.`;
  if (details.providerCode === 'organization_usage_limit_exceeded') return `${prefix} Your API organization has reached its provider-assigned usage limit. Check the organization's approved usage limits before resuming.`;
  if (['insufficient_quota', 'billing_hard_limit_reached'].includes(details.providerCode)) return `${prefix} API billing or quota is exhausted. Check your provider billing and usage limits, then resume.`;
  if ([401, 403].includes(status)) return `${prefix} The provider rejected the API key or its permissions. Reconnect a key with access to this model.`;
  if (status === 429 && ['rate_limit_exceeded', 'rate_limit_error', 'slow_down'].includes(details.providerCode)) return `${prefix} The provider is rate limiting requests. Check usage limits and retry later.`;
  if (status === 429) return `${prefix} The provider reported a rate limit or a billing/quota limit. Check API credits and usage limits before retrying; the response did not identify a known cause.`;
  if (status === 404 || details.providerCode === 'model_not_found') return `${prefix} This model is unavailable to this key. Choose another available model.`;
  if (status === 400 || status === 422) {
    const setting = details.providerParam ? ` Setting: ${details.providerParam}.` : '';
    if (details.providerReason === 'json_context_missing') return `${prefix} The provider requires an explicit JSON instruction in the request input. This is an application request-format error.${setting}`;
    if (details.providerReason === 'unsupported_parameter') return `${prefix} The provider does not support this request parameter for the selected model.${setting} Choose another model or a supported effort.`;
    if (details.providerReason === 'unsupported_value') return `${prefix} The provider rejected a request setting's value.${setting} Check the model and effort selection, or try the provider default.`;
    if (details.providerReason === 'model_access') return `${prefix} This model is unavailable to this key.${setting} Choose another available model.`;
    if (details.providerReason === 'service_tier') return `${prefix} The provider rejected the service tier.${setting} Check the provider project's access and settings.`;
    if (details.providerReason === 'project_access') return `${prefix} The provider project does not have access to the requested setting.${setting} Check the provider project's access and settings.`;
    return `${prefix} The provider rejected the request settings.${setting} Check the model and effort selection, or try the provider default.`;
  }
  if (status >= 500) return `${prefix} The provider is temporarily unavailable. Resume to retry later.`;
  return `${prefix} Check model access, credentials, billing, and rate limits.`;
}

/** Only fixed application messages and allowlisted metadata may cross the UI boundary. */
export class ModelRequestError extends Error {
  constructor(code, details = {}) {
    const safe = sanitizeDetails(code === 'http' || Object.hasOwn(ERROR_MESSAGES, code) ? code : 'provider_failure', details);
    const message = publicMessage(safe);
    super(message);
    this.name = 'ModelRequestError';
    this.code = safe.code;
    diagnostics.set(this, { message, details: safe });
  }
}

export function safeModelError(error) { return diagnostics.get(error)?.message || null; }
export function modelErrorDetails(error) { const value = diagnostics.get(error)?.details; return value ? { ...value } : null; }

// Provider messages can echo submitted text. Use only narrow patterns to derive
// fixed categories; never retain the message or interpolate it into UI text.
function providerErrorDetails(error) {
  const providerCode = PROVIDER_CODES.has(error?.code) ? error.code : PROVIDER_CODES.has(error?.type) ? error.type : undefined;
  const providerParam = PROVIDER_PARAMS.has(error?.param) ? error.param : undefined;
  const message = typeof error?.message === 'string' && error.message.length <= 16384 ? error.message : '';
  let providerReason;
  if (/(?:input|messages)['"]?\s+must contain the word\s+['"]?json['"]?\s+in some form/i.test(message) && /json_object/i.test(message)) providerReason = 'json_context_missing';
  else if (providerCode === 'unsupported_parameter' || /^Unsupported parameter\s*:/i.test(message)) providerReason = 'unsupported_parameter';
  else if (providerCode === 'unsupported_value' || /^Unsupported value\s*:/i.test(message)) providerReason = 'unsupported_value';
  else if (providerCode === 'model_not_found' || /^The model\s+.{1,200}\s+(?:does not exist|is not available|is unavailable)/i.test(message)) providerReason = 'model_access';
  else if (providerParam === 'service_tier') providerReason = 'service_tier';
  else if (/^Project\s+.{1,200}\s+does not have access to\b/i.test(message)) providerReason = 'project_access';
  return { providerCode, providerParam, providerReason };
}

export function providerStatus(env = process.env) {
  return {
    demo: { configured: true, model: 'offline content echo', description: 'Demonstration only. No model, no network, no personalization quality claim.' },
    openai: { configured: !!(env.OPENAI_API_KEY && env.OPENAI_MODEL), model: env.OPENAI_MODEL || '', description: 'Requires OPENAI_API_KEY and OPENAI_MODEL. API billing is separate from ChatGPT.' },
    anthropic: { configured: !!(env.ANTHROPIC_API_KEY && env.ANTHROPIC_MODEL), model: env.ANTHROPIC_MODEL || '', description: 'Requires ANTHROPIC_API_KEY and ANTHROPIC_MODEL. API access is separate from Claude subscriptions.' },
  };
}

// Covers both waiting for response headers and reading the response body. The
// same AbortSignal reaches fetch, so cancellation also stops network IO.
function withAbort(promise, signal) {
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function completeJSON(provider, system, payload, { fetchImpl = fetch, env = process.env, credentials, signal, effort = 'default', timeoutMs } = {}) {
  if (!PROVIDERS.has(provider) || provider === 'demo') throw new Error('Choose an available model provider.');
  const claudePlan = provider === 'claude-plan';
  // A Claude plan is reachable only through a connected Claude Code CLI, never environment keys.
  const configured = credentials === undefined
    ? (claudePlan ? null : { provider, apiKey: env[provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'], model: env[provider === 'openai' ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL'] })
    : credentials;
  const chatgpt=provider==='openai'&&configured?.authMode==='chatgpt';
  let apiKey=configured?.apiKey;
  if(chatgpt) {try {apiKey=await configured.getAccessToken();}catch {throw new ModelRequestError('chatgpt_auth',{provider,authMode:'chatgpt'});}}
  if (!configured || configured.provider !== provider
    || (claudePlan ? typeof configured.run !== 'function' : typeof apiKey !== 'string' || !apiKey || apiKey.length > (chatgpt?32768:4096) || /[^\x21-\x7e]/.test(apiKey))
    || typeof configured.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(configured.model)) throw new ModelRequestError('configuration', { provider });
  try { effort = validateEffort(provider, configured.model, effort); }
  catch { throw new ModelRequestError('effort', { provider }); }
  if (typeof system !== 'string' || !system.trim()) throw new Error('A model instruction is required.');
  const instructions = `${system}\nReturn a single JSON object only.`;
  let content;
  try { content = JSON.stringify(payload); } catch { throw new Error('The selected content could not be prepared for the model.'); }
  if (!content || content.length > 1500000) throw new Error('The selected content is too large for one model request. Choose a smaller batch.');
  const limits = modelRequestLimits(provider, configured.model, effort);
  const duration = Number.isInteger(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, limits.timeoutMs) : limits.timeoutMs;
  if (claudePlan) return claudePlanJSON(configured, instructions, content, effort, signal, duration);
  let url, headers, body;
  if (provider === 'openai') {
    url = 'https://api.openai.com/v1/responses';
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    // JSON mode requires an explicit JSON instruction in conversation context.
    // Use the documented message form so input validation sees that instruction
    // even when none of the user's evidence contains the word "JSON".
    // Keep application instructions separate from untrusted imported content.
    body = { model: configured.model, store: false, input: [{ role: 'developer', content: instructions }, { role: 'user', content }], max_output_tokens: limits.maxOutputTokens, text: { format: { type: 'json_object' } } };
    if(chatgpt) {delete body.max_output_tokens;body.stream=true;}
    if (effort !== 'default') body.reasoning = { effort };
  } else {
    url = 'https://api.anthropic.com/v1/messages';
    headers = { 'Content-Type': 'application/json', 'x-api-key': configured.apiKey, 'anthropic-version': '2023-06-01' };
    body = { model: configured.model, max_tokens: limits.maxOutputTokens, system: instructions, messages: [{ role: 'user', content }] };
    if (effort !== 'default') body.output_config = { effort };
  }
  const deadline = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), duration);
  let stage = 'network';
  let details = { provider,...(chatgpt?{authMode:'chatgpt'}:{}) };
  try {
    requestSignal.throwIfAborted();
    const response = await withAbort(fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: requestSignal, redirect: 'error' }), requestSignal);
    const requestId = response?.headers?.get?.('x-request-id') || response?.headers?.get?.('request-id');
    // A request identifier echoed from private input must not become diagnostics.
    if (requestId && !content.includes(requestId) && !instructions.includes(requestId) && !apiKey.includes(requestId)) details.requestId = requestId;
    if (!response?.ok) {
      let data;
      try { data = await withAbort(response.json(), requestSignal); } catch { /* Bodies can be non-JSON. Never expose them. */ }
      details = { ...details, httpStatus: response?.status, ...providerErrorDetails(data?.error) };
      throw new ModelRequestError('http', details);
    }
    stage = 'invalid_response';
    const data = await withAbort(chatgpt?readResponseStream(response,requestSignal):response.json(), requestSignal);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ModelRequestError('invalid_response', details);
    if (data.error) details = { ...details, ...providerErrorDetails(data.error) };
    if(chatgpt&&data.error)throw new ModelRequestError('http',details);
    if ((provider === 'openai' && data.incomplete_details?.reason === 'max_output_tokens') || (provider === 'anthropic' && data.stop_reason === 'max_tokens')) throw new ModelRequestError('output_limit', details);
    if ((provider === 'openai' && data.incomplete_details?.reason === 'content_filter') || (provider === 'anthropic' && data.stop_reason === 'refusal')) throw new ModelRequestError('refusal', details);
    if ((provider === 'openai' && data.status && data.status !== 'completed') || (provider === 'anthropic' && data.stop_reason && data.stop_reason !== 'end_turn')) throw new ModelRequestError('incomplete', details);
    const blocks = provider === 'openai' ? data.output?.flatMap(item => item.content || []) : data.content;
    if (!Array.isArray(blocks)) throw new ModelRequestError('invalid_response', details);
    if (blocks.some(block => block.type === 'refusal')) throw new ModelRequestError('refusal', details);
    const text = blocks.filter(block => block.type === (provider === 'openai' ? 'output_text' : 'text')).map(block => {
      if (typeof block.text !== 'string') throw new ModelRequestError('invalid_response', details);
      return block.text;
    }).join('');
    stage = 'invalid_json';
    return jsonObject(text, details);
  } catch (error) {
    if (signal?.aborted) throw new ModelRequestError('cancelled', details);
    if (deadline.signal.aborted) throw new ModelRequestError('timeout', details);
    if (safeModelError(error)) throw error;
    throw new ModelRequestError(stage, details);
  } finally { clearTimeout(timer); }
}

function jsonObject(text, details, {lenient = false} = {}) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch (error) {
    // Claude Code has no JSON mode; accept one object surrounded by a stray sentence.
    const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
    if (!lenient || start < 0 || end <= start) throw error;
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ModelRequestError('invalid_json', details);
  return parsed;
}

async function claudePlanJSON(configured, instructions, content, effort, signal, duration) {
  const details = { provider: 'claude-plan', authMode: 'claude-plan' };
  const deadline = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), duration);
  let stage = 'claude_failed';
  try {
    requestSignal.throwIfAborted();
    const text = await withAbort(configured.run({ system: instructions, content, model: configured.model, effort, signal: requestSignal, timeoutMs: duration }), requestSignal);
    if (typeof text !== 'string') throw new ModelRequestError('invalid_response', details);
    stage = 'invalid_json';
    return jsonObject(text, details, { lenient: true });
  } catch (error) {
    if (signal?.aborted) throw new ModelRequestError('cancelled', details);
    if (deadline.signal.aborted) throw new ModelRequestError('timeout', details);
    if (safeModelError(error)) throw error;
    if (error instanceof ClaudeRunError) throw new ModelRequestError(CLAUDE_CODES[error.code] || 'claude_failed', details);
    throw new ModelRequestError(stage, details);
  } finally { clearTimeout(timer); }
}
