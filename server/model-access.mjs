// Authentication checks only. Model listing does not test inference, billing,
// quotas, or permission to call the eventual generation endpoint.
import {modelOptions, validateEffort} from './model-options.mjs';
const PROVIDERS = new Set(['openai', 'anthropic']);
const CLAUDE = 'claude-plan';
export const TASKS = ['drafting', 'critique', 'analysis'];
const ERRORS = {
  provider: 'Choose OpenAI or Anthropic.',
  key: 'Enter a valid API key without spaces or line breaks (maximum 4096 characters).',
  network: 'Could not reach the model provider. Check your connection and try again.',
  auth: 'The provider rejected this API key or its permissions. Check the key and try again.',
  rate: 'The provider is rate limiting verification. Please try again later.',
  providerResponse: 'The model provider could not verify access. Please try again later.',
  invalidResponse: 'The model provider returned an invalid model list. Please try again.',
  unavailable: 'No available text model was found for this key. Check model access with your provider.',
  superseded: 'This verification was cancelled or replaced. Enter your key again to connect.',
  model: 'Choose a model from the models available to this connected key.',
  task: 'Choose models for drafting, critique or analysis.',
};

class ModelAccessError extends Error {
  constructor(code) {
    super(ERRORS[code]);
    this.name = 'ModelAccessError';
    this.code = code;
  }
}

function credentialsFrom(input) {
  if (!input || typeof input !== 'object' || !PROVIDERS.has(input.provider)) throw new ModelAccessError('provider');
  const raw = input.apiKey;
  // Reject hidden line breaks even at either end. Ordinary copied outer spaces
  // may be removed; credentials themselves must consist of printable ASCII.
  if (typeof raw !== 'string' || raw.length > 4096 || /[\r\n]/.test(raw)) throw new ModelAccessError('key');
  const apiKey = raw.trim();
  if (!apiKey || /[^\x21-\x7e]/.test(apiKey)) throw new ModelAccessError('key');
  return { provider: input.provider, apiKey };
}

function validModelId(value) {
  return typeof value === 'string' && value.length <= 200 && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value);
}

function textCandidate(model, provider) {
  if (!model || typeof model !== 'object' || !validModelId(model.id)) return false;
  if (model.lifecycle === 'retired') return false;
  if (provider === 'anthropic') {
    // Claude's models endpoint lists Claude text models. Lifecycle, rather than
    // a past scheduled retirement date, is the authoritative retirement signal.
    return model.type === 'model' && model.id.startsWith('claude-');
  }
  if (model.object !== 'model') return false;
  if (model.shutdown_date && Date.parse(model.shutdown_date) <= Date.now()) return false;
  // The OpenAI model catalogue also includes images, embeddings, speech and
  // specialized realtime models. Treat these names only as text candidates,
  // never as proof that a generation request will succeed.
  return /^(gpt-[0-9]|chatgpt-|o[0-9](?:-|$))/.test(model.id)
    && !/(?:^|[-_])(?:audio|realtime|transcribe|tts|image|search|codex)(?:[-_]|$)/i.test(model.id);
}

// A convenience choice among IDs actually returned for this key, not a claim
// about benchmark quality, pricing or inference permissions. The UI can override.
function rankModels(ids, provider) {
  const rank = id => provider === 'anthropic'
    ? (/sonnet/.test(id) ? 3 : /haiku/.test(id) ? 2 : 1)
    : (/^gpt-/.test(id) ? 4 : /^o\d/.test(id) ? 2 : 1)
      + (/(?:^|-)mini(?:-|$)/.test(id) ? 1 : 0)
      - (/(?:^|-)(?:pro|preview)(?:-|$)/.test(id) ? 2 : 0);
  return [...ids].sort((a,b) => rank(b)-rank(a) || b.localeCompare(a, 'en', { numeric: true }));
}

/** Verify API authentication with a read-only model-list request, never inference. */
export async function verifyModelAccess(input, { fetchImpl = fetch, env = process.env } = {}) {
  const { provider, apiKey } = credentialsFrom(input);
  const url = provider === 'openai'
    ? 'https://api.openai.com/v1/models'
    : 'https://api.anthropic.com/v1/models?limit=100';
  const headers = provider === 'openai'
    ? { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', Accept: 'application/json' };
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000), redirect: 'error' });
  } catch {
    // Network errors may contain request headers or provider-controlled text.
    throw new ModelAccessError('network');
  }
  if (!response?.ok) {
    if ([401, 403].includes(response?.status)) throw new ModelAccessError('auth');
    if (response?.status === 429) throw new ModelAccessError('rate');
    throw new ModelAccessError('providerResponse');
  }
  let data;
  try { data = await response.json(); }
  catch { throw new ModelAccessError('invalidResponse'); }
  if (!data || !Array.isArray(data.data) || data.data.length > 20000) throw new ModelAccessError('invalidResponse');
  const candidates = rankModels([...new Set(data.data.filter(model => textCandidate(model, provider) && model.id !== apiKey).map(model => model.id))], provider);
  if (!candidates.length) throw new ModelAccessError('unavailable');
  const configuredModel = env?.[provider === 'openai' ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL'];
  return {
    provider,
    model: candidates.includes(configuredModel) ? configuredModel : candidates[0],
    verified: true,
    validation: 'models-list',
    verifiedAt: new Date().toISOString(),
    availableModelCount: candidates.length,
    availableModels: candidates.map(id => ({ id, label: id })),
  };
}

function disconnectedStatus() {
  return { provider: null, model: '', effort: 'default', verified: false, validation: null, verifiedAt: null, availableModelCount: 0, availableModels: [] };
}

function validRoute(route) {
  return route && typeof route === 'object' && [...PROVIDERS, CLAUDE].includes(route.provider) && validModelId(route.model) && typeof route.effort === 'string' && route.effort.length <= 20;
}

/**
 * Credentials live only in this server instance, never in process.env or files.
 * One primary connection (ChatGPT or an API key) and a Claude plan can be
 * connected together. Drafting, critique and analysis each follow a route to a
 * connected model; critique and analysis follow drafting unless chosen.
 */
export class ModelSession {
  #credentials = null;
  #status = disconnectedStatus();
  #claude = null;
  #routes = {drafting: null, critique: null, analysis: null};
  #saveRoutes = null;
  #revision = 0;
  #verifier;
  #options;

  constructor({ verifier = verifyModelAccess, fetchImpl = fetch, env = process.env } = {}) {
    this.#verifier = verifier;
    this.#options = { fetchImpl, env };
  }

  get status() {
    const primary = this.#status.verified, claude = this.#claude;
    const connection = this.#status.authMode === 'chatgpt' ? 'ChatGPT plan' : this.#status.provider === 'anthropic' ? 'Anthropic API' : 'OpenAI API';
    const availableModels = [
      ...(primary ? this.#status.availableModels.map(model => ({ ...model, provider: this.#status.provider, connection, ...modelOptions(this.#status.provider, model.id) })) : []),
      ...(claude ? claude.models.map(model => ({ ...model, provider: CLAUDE, connection: 'Claude plan', ...modelOptions(CLAUDE, model.id) })) : []),
    ];
    const drafting = this.route('drafting');
    // With only a Claude plan connected, it stands in as the primary connection.
    const base = primary || !claude ? this.#status : { provider: CLAUDE, model: drafting.model, effort: drafting.effort, authMode: CLAUDE, accountLabel: claude.status.accountLabel, verified: true, validation: 'claude-code-auth-status', verifiedAt: claude.status.verifiedAt, availableModelCount: claude.models.length };
    return { ...base, availableModels, claude: claude ? { ...claude.status } : null, tasks: drafting ? Object.fromEntries(TASKS.map(task => [task, this.route(task)])) : null };
  }

  get revision() { return this.#revision; }
  isCurrent(revision) { return revision === this.#revision && (this.#status.verified || !!this.#claude); }

  // Server-internal only: never serialize these results into an HTTP response.
  getCredentials() { return this.#credentials ? { ...this.#credentials } : null; }
  credentialsFor(provider) {
    if (provider === CLAUDE) return this.#claude ? { provider: CLAUDE, authMode: CLAUDE, run: this.#claude.run } : null;
    return this.#status.verified && this.#status.provider === provider ? this.getCredentials() : null;
  }
  hasModel(provider, id) {
    const models = provider === CLAUDE ? this.#claude?.models : this.#status.verified && this.#status.provider === provider ? this.#status.availableModels : null;
    return !!models?.some(model => model.id === id);
  }

  /** The connected model a task uses. `available` is false when its account is missing. */
  route(task = 'drafting') {
    if (!TASKS.includes(task)) throw new ModelAccessError('task');
    const chosen = this.#routes[task];
    if (chosen) return { ...chosen, inherited: false, available: this.hasModel(chosen.provider, chosen.model) };
    if (task !== 'drafting') { const drafting = this.route('drafting'); return drafting && { ...drafting, inherited: true }; }
    const fallback = this.#status.verified ? { provider: this.#status.provider, model: this.#status.model, effort: this.#status.effort }
      : this.#claude ? { provider: CLAUDE, model: this.#claude.models[0].id, effort: 'default' } : null;
    return fallback && { ...fallback, inherited: false, available: this.hasModel(fallback.provider, fallback.model) };
  }

  /** Restores saved task routes. Routes to accounts not yet connected stay unavailable, never rerouted. */
  useRouteStorage(saved, save) {
    for (const task of TASKS) this.#routes[task] = validRoute(saved?.[task]) ? { provider: saved[task].provider, model: saved[task].model, effort: saved[task].effort } : null;
    this.#saveRoutes = typeof save === 'function' ? save : null;
  }

  #dropRoutes(provider) {
    let changed = false;
    for (const task of TASKS) if (this.#routes[task]?.provider === provider) { this.#routes[task] = null; changed = true; }
    if (changed) this.#saveRoutes?.({ ...this.#routes });
  }

  /**
   * Sets routes for the tasks named in `choices`. `null` makes critique or
   * analysis follow drafting again. A primary drafting choice becomes that
   * connection's default model, as selectModel does.
   */
  setRoutes(choices) {
    if (!this.status.verified) throw new ModelAccessError('model');
    if (!choices || typeof choices !== 'object' || Array.isArray(choices) || !Object.keys(choices).length || Object.keys(choices).some(task => !TASKS.includes(task))) throw new ModelAccessError('task');
    const routes = { ...this.#routes };
    let primary = null;
    for (const [task, choice] of Object.entries(choices)) {
      if (choice === null && task !== 'drafting') { routes[task] = null; continue; }
      if (!choice || typeof choice !== 'object' || !this.hasModel(choice.provider, choice.model)) throw new ModelAccessError('model');
      const route = { provider: choice.provider, model: choice.model, effort: validateEffort(choice.provider, choice.model, choice.effort ?? 'default') };
      if (task === 'drafting' && route.provider !== CLAUDE) { primary = route; routes.drafting = null; }
      else routes[task] = route;
    }
    const primaryChanged = primary && (primary.model !== this.#status.model || primary.effort !== this.#status.effort);
    if (primaryChanged || JSON.stringify(routes) !== JSON.stringify(this.#routes)) {
      this.#revision++;
      if (primaryChanged) {
        this.#credentials = { ...this.#credentials, model: primary.model };
        this.#status = { ...this.#status, model: primary.model, effort: primary.effort };
        this.#credentials.saveSelection?.(primary.model, primary.effort);
      }
      if (JSON.stringify(routes) !== JSON.stringify(this.#routes)) { this.#routes = routes; this.#saveRoutes?.({ ...routes }); }
    }
    return this.status;
  }

  connectClaude({ models, run, version = '', plan = '', accountLabel = '', verifiedAt = new Date().toISOString() }) {
    if (!Array.isArray(models) || !models.length || models.some(model => !validModelId(model?.id)) || typeof run !== 'function') throw new ModelAccessError('invalidResponse');
    this.#revision++;
    this.#claude = { models: models.map(({ id, label }) => ({ id, label: typeof label === 'string' ? label : id })), run, status: { version, plan, accountLabel, verifiedAt } };
    return this.status;
  }

  disconnectClaude() {
    this.#revision++;
    this.#claude = null;
    this.#dropRoutes(CLAUDE);
    return this.status;
  }

  connectChatGPT({models, model, effort, accountLabel, getAccessToken, saveSelection}) {
    if(!Array.isArray(models)||!models.length||models.some(m=>!validModelId(m.id))||typeof getAccessToken!=='function')throw new ModelAccessError('invalidResponse');
    const selected=models.some(m=>m.id===model)?model:models[0].id;
    let selectedEffort='default';try{selectedEffort=validateEffort('openai',selected,effort);}catch{}
    this.#revision++;
    this.#credentials={provider:'openai',model:selected,authMode:'chatgpt',getAccessToken,saveSelection};
    this.#status={provider:'openai',model:selected,effort:selectedEffort,authMode:'chatgpt',accountLabel,verified:true,validation:'chatgpt-models-list',verifiedAt:new Date().toISOString(),availableModelCount:models.length,availableModels:models};
    return this.status;
  }

  selectModel(id, effort) {
    const provider = this.#status.verified ? this.#status.provider : this.#claude ? CLAUDE : null;
    if (!provider || !this.hasModel(provider, id)) throw new ModelAccessError('model');
    const current = this.route('drafting');
    return this.setRoutes({ drafting: { provider, model: id, effort: effort === undefined ? (id === current.model && provider === current.provider ? current.effort : 'default') : effort } });
  }

  /** Disconnects the primary connection. A connected Claude plan stays connected. */
  clear() {
    this.#revision++;
    const provider = this.#status.provider;
    this.#credentials = null;
    this.#status = disconnectedStatus();
    if (provider) this.#dropRoutes(provider);
    return this.status;
  }
  async verify(input) {
    this.clear();
    const revision = this.#revision;
    const credentials = credentialsFrom(input);
    let result;
    try {
      result = await this.#verifier(credentials, this.#options);
    } catch (error) {
      if (revision !== this.#revision) throw new ModelAccessError('superseded');
      if (error instanceof ModelAccessError) throw error;
      // Even an injected provider adapter cannot expose raw error contents.
      throw new ModelAccessError('providerResponse');
    }
    if (revision !== this.#revision) throw new ModelAccessError('superseded');
    if (!result || result.verified !== true || result.validation !== 'models-list'
      || result.provider !== credentials.provider || !Number.isInteger(result.availableModelCount)
      || result.availableModelCount < 1 || !Number.isFinite(Date.parse(result.verifiedAt))
      || typeof result.model !== 'string' || (result.model && !validModelId(result.model))
      || result.model === credentials.apiKey) throw new ModelAccessError('invalidResponse');
    // Older injected adapters may provide only their selected model. They do
    // not acquire permission to select arbitrary names via that compatibility.
    const listed = result.availableModels === undefined
      ? (result.model ? [{ id: result.model }] : []) : result.availableModels;
    if (!Array.isArray(listed) || listed.length > 20000 || listed.some(model => !model || !validModelId(model.id) || model.id === credentials.apiKey)
      || (result.availableModels !== undefined && (!listed.length || !listed.some(model => model.id === result.model)))) throw new ModelAccessError('invalidResponse');
    const availableModels = [...new Set(listed.map(model => model.id))].map(id => ({ id, label: id }));
    // Allowlist public fields so a provider adapter cannot accidentally expose
    // extra credential fields through the session's status.
    this.#status = {
      provider: result.provider, model: result.model, effort: 'default', verified: true,
      validation: 'models-list', verifiedAt: new Date(result.verifiedAt).toISOString(),
      availableModelCount: result.availableModelCount,
      availableModels,
    };
    this.#credentials = { ...credentials, model: result.model };
    return this.status;
  }
}
