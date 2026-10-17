// Capability allowlist checked against official documentation on 2026-10-17.
// Unknown models remain usable with provider defaults. Never infer capabilities
// from a shared family prefix (for example Astra does not support `none`).
// OpenAI: https://developers.openai.com/api/docs/models/<model-id>
// Claude: https://platform.claude.com/docs/en/build-with-claude/effort
const OPTIONS = {
  openai: {
    'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6.1-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5.6': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5.6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-5.5': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.4-2026-03-05': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.4-mini': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.4-mini-2026-03-17': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.4-nano': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.4-nano-2026-03-17': ['none', 'low', 'medium', 'high', 'xhigh'],
  },
  anthropic: {
    'claude-fable-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-fable-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-mythos-5-1': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-mythos-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-mythos-preview': ['low', 'medium', 'high', 'max'],
    'claude-opus-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4-8': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4-7': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-opus-4-6': ['low', 'medium', 'high', 'max'],
    'claude-opus-4-5': ['low', 'medium', 'high'],
    'claude-sonnet-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-sonnet-5': ['low', 'medium', 'high', 'xhigh', 'max'],
    'claude-sonnet-4-6': ['low', 'medium', 'high', 'max'],
    'claude-haiku-5-5': ['low', 'medium', 'high', 'xhigh', 'max'],
  },
};

export function modelOptions(provider, modelId) {
  const table = OPTIONS[provider];
  const efforts = table && Object.hasOwn(table, modelId) ? table[modelId] : [];
  return { efforts: ['default', ...efforts], defaultEffort: 'default' };
}

export function validateEffort(provider, modelId, effort = 'default') {
  if (typeof effort !== 'string' || !modelOptions(provider, modelId).efforts.includes(effort)) {
    const error = new Error('Choose an effort supported by this model, or use the provider default.');
    error.status = 400;
    throw error;
  }
  return effort;
}

export function modelRequestLimits(provider, modelId, effort = 'default') {
  const reasoning = modelOptions(provider, modelId).efforts.length > 1 && effort !== 'none';
  // A ceiling, not a target. Reasoning and visible output share it.
  // https://developers.openai.com/api/docs/guides/reasoning#allocating-space-for-reasoning
  return { maxOutputTokens: reasoning ? 25000 : 6000, timeoutMs: 300000 };
}
