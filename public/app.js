const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const arrow = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M4 12h15m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.5"/></svg>';
const check = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="1.5"/></svg>';
const icons = {
  paste: '<path d="M8 5H5v16h14V5h-3M8 3h8v5H8zM8 12h8M8 16h5"/>',
  gmail: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="m3 6 9 7 9-7"/>',
  slack: '<path d="M8 3v12M3 8h12M16 9v12M9 16h12M4 3v1M20 3v1M20 20v1M3 20h1"/>',
};
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square">${icons[name] || ''}</svg>`;
let state;
const ui = { provider: 'openai', source: 'paste', editingAccess: false, managingSources: window.location.hash === '#sources', text: '', authorship: '', ownEmail: '', after: '', before: '', dms: null, dmCursor: null, selectedDms: new Set(), error: '', pending: '', connection: null, dialogError: '', warnings: [] };
let toastTimer;

async function api(path, body, method) {
  const response = await fetch(path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(state?.csrfToken ? { 'X-Local-Token': state.csrfToken } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `The request failed (${response.status}). Please try again.`);
  return result;
}
async function refresh() {
  state = await api('/api/onboarding');
  state.sources ||= [];
  state.connections ||= {};
  state.harness ||= { status: 'idle' };
  if (['openai','anthropic'].includes(state.model?.provider)) ui.provider = state.model.provider;
  render();
  if(state.chatgpt?.welcomeAccountId) {
    const dialog=$('#connection-dialog');
    dialog.innerHTML=`<div class="dialog-head"><span class="panel-marker mono">CONNECTED</span></div><h2>You're using your ChatGPT plan.</h2><p>Eligible analysis and drafting requests use your ChatGPT plan or credits you authorize in ChatGPT. Your connection stays saved on this computer.</p><p><a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ↗</a></p><button class="button primary" id="ack-chatgpt">Got it</button>`;
    if(!dialog.open)dialog.showModal();
    $('#ack-chatgpt').onclick=async()=>{await api('/api/onboarding/chatgpt/ack',{accountId:state.chatgpt.welcomeAccountId});state.chatgpt.welcomeAccountId=null;dialog.close();};
  }
}
function notify(message) {
  const node = $('#toast');
  node.textContent = message;
  node.className = 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.className = '', 4500);
}
async function run(label, work) {
  if (ui.pending) return;
  ui.pending = label;
  ui.error = '';
  ui.dialogError = '';
  render();
  try { await work(); }
  catch (error) { if (label === 'model') { try { await refresh(); } catch {} } ui.error = error.message; if ($('#connection-dialog').open) { ui.dialogError = error.message; renderConnection(); } }
  finally { ui.pending = ''; render(); }
}
const ownMessageCount = () => state.sources.reduce((total, source) => total + (Number(source.ownMessageCount) || 0), 0);
const disabled = condition => condition || ui.pending ? 'disabled' : '';
const providerName = value => value === 'anthropic' ? 'Anthropic' : 'OpenAI';
const connectedName = () => [state.model?.authMode==='chatgpt'?'ChatGPT plan':['openai','anthropic'].includes(state.model?.provider)?providerName(state.model.provider):'',state.claude?.connected?'Claude plan':''].filter(Boolean).join(' + ');
function renderClaude() {
  const claude=state.claude||{};
  if(claude.connected)return `<div class="saved-account claude-account"><div><strong>Claude plan · ${esc(claude.accountLabel||'Claude account')}</strong><span class="input-hint">Through Claude Code${claude.version?` ${esc(claude.version)}`:''} on this computer</span></div><div><button class="text-button" data-action="disconnect-claude" ${disabled()}>Disconnect</button></div></div>`;
  const steps=`<ol class="claude-steps"><li>Install Claude Code: <code>curl -fsSL https://claude.ai/install.sh | bash</code></li><li>Sign in with your Claude account: <code>claude auth login</code></li><li>Come back here and choose Continue with Claude.</li></ol>`;
  return `<button class="button secondary full claude-connect" data-action="claude" ${disabled()}>${buttonText('Continue with Claude','Checking Claude Code…','claude')}</button><p class="input-hint">For Claude Pro and Max. Uses Claude Code on this computer, signed in with your own Claude account. Larpmaxxing never sees your Claude sign-in, and requests count against your plan’s usage limits. <a href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ↗</a></p>${claude.notice&&claude.notice!==ui.error?`<p class="error-box" role="alert">${esc(claude.notice)}</p>`:''}<details class="claude-setup" ${claude.notice?'open':''}><summary>Set up Claude Code</summary>${steps}</details>`;
}
const buttonText = (label, pendingLabel, current) => ui.pending === current ? `<span class="spinner"></span>${pendingLabel}` : `${label}${arrow}`;

function pillar() {
  return `<div class="relic" aria-hidden="true"><div class="relic-orbit"></div><svg class="pillar" viewBox="0 0 340 320" fill="none"><defs><linearGradient id="stone" x1="100" y1="80" x2="260" y2="300" gradientUnits="userSpaceOnUse"><stop stop-color="#c9c6dc"/><stop offset=".47" stop-color="#68667a"/><stop offset="1" stop-color="#22252e"/></linearGradient><linearGradient id="light" x1="80" y1="0" x2="290" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="#a3a0b4"/><stop offset=".5" stop-color="#555463"/><stop offset="1" stop-color="#252830"/></linearGradient></defs><path d="m48 278 133-31 125 31-132 33z" stroke="#373a46"/><path d="m59 277 120-25 113 25-118 26z" stroke="#252833"/><path d="m91 256 89-20 78 20v15l-82 19-85-18z" fill="url(#light)" stroke="#848193"/><path d="m91 256 85 18 82-18m-82 18v16" stroke="#484959"/><path d="m107 243 71-16 62 16v12l-64 15-69-16z" fill="url(#stone)" stroke="#848193"/><path d="m107 243 69 16 64-16m-64 16v11" stroke="#454453"/><path d="m120 106 60-10 47 9-9 132-42 10-48-11z" fill="url(#stone)" stroke="#a6a2b6"/><path d="m132 110 7 123m7-122 5 124m8-125 3 128m12-130 2 132m13-135-1 132m14-135-3 132m16-135-6 132" stroke="#3d3d4c" stroke-width="5"/><path d="m130 110 7 123m7-122 5 124m8-125 3 128m12-130 2 132m13-135-1 132m14-135-3 132m16-135-6 132" stroke="#b1adc0" stroke-width="1"/><path d="m108 93 71-16 61 15-8 17-57 13-61-14z" fill="url(#stone)" stroke="#a8a4b8"/><path d="m108 93 67 15 65-16m-65 16v14" stroke="#4d4b5c"/><path d="m97 74 82-20 73 18v14l-77 20-78-18z" fill="url(#light)" stroke="#b6b2c6"/><path d="m97 74 78 19 77-21m-77 21v13" stroke="#4d4b5c"/><path d="m106 59 74-18 64 16v14l-69 18-69-17z" fill="url(#stone)" stroke="#b6b2c6"/><path d="m106 59 69 16 69-18m-69 18v14" stroke="#454453"/><path d="m121 88-8 23 24 8m83-30 15 17-24 11" stroke="#b9b5ca" stroke-width="3"/><path d="M58 153h41m144 0h42M171 19v12M171 292v16" stroke="#b9b5a8"/><path d="m282 145 8 8-8 8M61 145l-8 8 8 8" stroke="#b9b5a8"/></svg><div class="relic-index mono">A PRIVATE WRITING HARNESS</div></div>`;
}
let workspaceOpening = false;
async function openReadyWorkspace() {
  if (workspaceOpening) return;
  workspaceOpening = true;
  const stillReady = () => state?.model?.verified && !ui.editingAccess && !ui.managingSources && state.harness.status === 'ready';
  try {
    const {openWorkspace} = await import('/workspace.js');
    if (!stillReady()) return;
    await openWorkspace({api,notify,manageSources:()=>{ui.managingSources=true;render();},changeModel:async()=>{ui.editingAccess=true;try{await refresh();}catch{render();}}});
  } catch {
    if (!stillReady()) return;
    $('#app').innerHTML = `<main id="main" class="loading-screen"><span class="brand">Λ / LARPMAXXING</span><div class="error-box" role="alert"><strong>The workspace update needs a server restart.</strong><p>Restart the local server to load this update, then reload this page. Your saved sources and profile remain on this computer. Session-only API keys and account connections will need to be entered again.</p></div><button class="button secondary" id="retry-workspace">Reload after restart ${arrow}</button><button class="text-button" id="existing-sources">Manage existing sources</button></main>`;
    $('#retry-workspace').onclick = () => window.location.reload();
    $('#existing-sources').onclick = () => { ui.managingSources = true; render(); };
  } finally { workspaceOpening = false; }
}
function render() {
  if (!state) return;
  const access = !state.model?.verified || ui.editingAccess;
  const ready = !access && !ui.managingSources && state.harness.status === 'ready';
  if (ready) {
    openReadyWorkspace();
    return;
  }
  $('#app').innerHTML = `<div class="shell"><header class="topbar"><a href="/" class="brand" aria-label="Larpmaxxing home"><span class="brand-symbol">Λ</span><span>LARPMAXXING<span class="brand-version"> / II</span></span></a><div class="local-badge"><span class="status-dot"></span>LOCAL INSTANCE</div></header><main id="main" class="main ${access ? 'access-view' : 'sources-view'}" tabindex="-1"><section class="identity"><div class="eyebrow"><span class="crosshair">+</span> A PRIVATE WRITING HARNESS</div><h1>LARP<span>MAXXING<span class="title-period">.</span></span></h1><p class="manifesto">Write like Plato.<br><span>Exist like Dionysus.</span></p><p class="identity-note">Your words. Your model. Your rules.</p>${pillar()}<div class="greek-key" aria-hidden="true"></div></section><section class="setup" aria-label="Harness setup"><ol class="steps"><li class="${access ? 'current' : 'complete'}" ${access ? 'aria-current="step"' : ''}><span>${access ? '01' : '✓'}</span>MODEL ACCESS</li><li class="${!access ? 'current' : ''}" ${!access ? 'aria-current="step"' : ''}><span>02</span>YOUR SOURCES</li></ol>${ui.error ? `<div class="error-box" role="alert"><strong>Something needs your attention.</strong><p>${esc(ui.error)}</p></div>` : ''}${access ? renderAccess() : renderSources()}</section></main><footer class="footer mono"><span>WORDS FROM THE RUINS.</span><span>YOUR INSTANCE <span class="footer-plus">+</span></span></footer></div>`;
  bind();
}
function renderAccess() {
  const accounts=state.chatgpt?.accounts||[];
  const saved=accounts.map(account=>`<div class="saved-account"><div><strong>${esc(account.label)}</strong><span class="input-hint">Connection ${esc(account.registration)}${account.planEnabled?'':' · plan access not enabled'}</span></div><div>${account.connected&&account.planEnabled?`<button class="text-button" data-action="use-chatgpt" data-id="${esc(account.id)}" ${disabled()}>Use account</button>`:''}<button class="text-button" data-action="chatgpt" data-id="${esc(account.id)}" ${disabled()}>Continue with ChatGPT</button>${account.connected?`<button class="text-button" data-action="signout-chatgpt" data-id="${esc(account.id)}" ${disabled()}>Sign out</button>`:''}</div></div>`).join('');
  return `<div class="panel access-panel"><div class="panel-marker mono">01 / CONNECT YOUR MIND</div><h2>Use what you already have.</h2><p class="panel-description">Connect your ChatGPT or Claude plan, or both.<br>The voice comes from you.</p>${state.chatgpt?.notice?`<p class="error-box" role="alert">${esc(state.chatgpt.notice)}</p>`:''}${saved}<button class="button primary full chatgpt-connect" data-action="chatgpt" ${disabled()}>${buttonText('Continue with ChatGPT','Opening sign-in…','chatgpt')}</button><p class="input-hint">${accounts.length?'The button above adds another account. ':''}For eligible ChatGPT Plus and Pro accounts. Sign in once and allow Larpmaxxing to use your plan. No API key or separate API balance required.</p><p class="input-hint">Your connection is saved privately on this computer and renewed automatically. Plan and app limits apply. <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage ↗</a></p><div class="plan-divider" aria-hidden="true"><span>and / or</span></div>${renderClaude()}<details class="api-alternative"><summary>Use an API key instead</summary><form id="model-form"><fieldset class="provider-picker"><legend class="visually-hidden">Model provider</legend>${['openai','anthropic'].map(provider => `<label class="provider-option ${ui.provider === provider ? 'selected' : ''}"><input type="radio" name="provider" value="${provider}" ${ui.provider === provider ? 'checked' : ''} ${disabled()}><span class="provider-mark">${provider === 'openai' ? '◎' : 'A'}</span><span>${providerName(provider)}</span><span class="radio-mark"></span></label>`).join('')}</fieldset><label class="field-label" for="api-key">${providerName(ui.provider)} API key</label><input id="api-key" name="apiKey" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste your API key" required aria-describedby="key-info" ${disabled()} /><div class="key-info" id="key-info"><span class="tiny-lock" aria-hidden="true">▣</span><p>Kept on this local server for the session. Never saved in your browser.</p></div><button class="button primary full" type="submit" ${disabled()}>${buttonText('Verify & continue', 'Verifying your key…', 'model')}</button><p class="provider-help">API requests are billed separately from chat subscriptions.<br><a href="${ui.provider === 'openai' ? 'https://platform.openai.com/api-keys' : 'https://console.anthropic.com/settings/keys'}" target="_blank" rel="noopener noreferrer">Get an ${providerName(ui.provider)} API key ↗</a></p>${state.model?.verified ? '<div class="access-key-actions"><button class="text-button" type="button" data-action="cancel-access">Keep current model</button><button class="text-button" type="button" data-action="forget-model">Disconnect model</button></div>' : ''}</form></details>${state.model?.verified?'<button class="text-button" data-action="cancel-access">Back to the harness</button>':''}</div><div class="footnote"><span>↳</span><p>Sign-in checks access only. No writing is sent until you start an analysis or draft. It does not give this app access to your ChatGPT or Claude history.</p></div>`;
}
function renderSources() {
  return `<div class="model-summary"><div><span class="status-dot"></span>${esc(connectedName())}<span class="summary-muted"> / connected</span></div><div class="summary-actions"><button type="button" class="text-button" data-action="change-model" ${disabled()}>Change</button><button type="button" class="text-button" data-action="forget-model" ${disabled()}>Disconnect model</button></div></div><div class="panel source-panel"><div class="panel-marker mono">02 / YOUR WRITING</div><h2>Bring your words.</h2><p class="panel-description">Start with messages you actually wrote.<br>One source is enough.</p><div class="source-tabs" role="tablist" aria-label="Source type">${[['paste','Paste emails'],['gmail','Gmail'],['slack','Slack']].map(([value,label]) => `<button type="button" role="tab" id="tab-${value}" aria-controls="source-content" aria-selected="${ui.source === value}" tabindex="${ui.source === value ? '0' : '-1'}" class="${ui.source === value ? 'active' : ''}" data-source="${value}" ${disabled()}>${icon(value)}${label}</button>`).join('')}</div><div role="tabpanel" id="source-content" aria-labelledby="tab-${ui.source}">${ui.source === 'paste' ? renderPaste() : renderIntegration(ui.source)}</div>${renderWarnings()}${renderSourceList()}</div><div class="launch-row"><div class="launch-info"><span class="status-dot ${ownMessageCount() ? '' : 'off'}"></span><span>${ownMessageCount() ? `${state.sources.length} source${state.sources.length === 1 ? '' : 's'} loaded` : state.sources.length ? 'Add a message you wrote' : 'Waiting for your first source'}</span></div><button class="button primary" data-action="start" ${disabled(!ownMessageCount())}>${buttonText('Start harness', 'Preparing your sources…', 'start')}</button></div><div class="footnote"><span>↳</span><p>Sources stay on this computer. This step prepares evidence locally; no messages are sent to your model.</p></div>`;
}
function renderPaste() {
  return `<form id="paste-form"><label class="field-label" for="source-text">Your email conversations</label><textarea id="source-text" name="text" rows="6" placeholder="Paste your sent emails or a conversation thread here…" required ${disabled()}>${esc(ui.text)}</textarea><fieldset class="authorship"><legend>Whose words are these?</legend><label><input type="radio" name="authorship" value="own" ${ui.authorship === 'own' ? 'checked' : ''} required ${disabled()}>Only my outgoing messages</label><label><input type="radio" name="authorship" value="thread" ${ui.authorship === 'thread' ? 'checked' : ''} required ${disabled()}>A thread with other people</label></fieldset>${ui.authorship === 'thread' ? `<div class="thread-identity"><label class="field-label" for="own-email">Your email address in this thread</label><input type="email" id="own-email" name="ownEmail" value="${esc(ui.ownEmail)}" placeholder="you@example.com" required ${disabled()}><p class="input-hint">Keep From: / To: headers so the harness can separate your words from theirs.</p></div>` : ''}<div class="import-row"><p class="input-hint">Add real examples.<br>Incoming messages are context.</p><button class="button secondary" type="submit" ${disabled()}>${buttonText('Add source', 'Adding…', 'paste')}</button></div></form>`;
}
function renderTimeframe() {
  return `<details class="timeframe" ${ui.after || ui.before ? 'open' : ''}><summary>Limit by date <span>optional</span></summary><div class="date-grid"><div><label class="field-label" for="date-after">From</label><input id="date-after" type="date" value="${esc(ui.after)}" ${disabled()}></div><div><label class="field-label" for="date-before">To</label><input id="date-before" type="date" value="${esc(ui.before)}" ${disabled()}></div></div><p class="input-hint">Includes both dates (UTC).</p></details>`;
}
function renderIntegration(provider) {
  const connection = state.connections[provider] || {};
  const name = provider === 'gmail' ? 'Gmail' : 'Slack';
  return `<div class="integration-intro"><div class="integration-icon">${icon(provider)}</div><div><h3>${provider === 'gmail' ? 'Learn from your sent mail.' : 'Just your one-to-one chats.'}</h3><p>${provider === 'gmail' ? 'Imports your sent messages and their conversation context.' : 'Select direct messages. Channels and group chats stay out.'}</p></div></div>${connection.connected ? `<div class="connection-status"><span class="status-dot"></span>${name} connected${connection.account ? ` <span class="summary-muted">/ ${esc(connection.account)}</span>` : ''}<button class="text-button" data-action="disconnect" data-provider="${provider}" ${disabled()}>Disconnect</button></div>${provider === 'slack' ? renderDms() : ''}${renderTimeframe()}<button class="button secondary full integration-import" data-action="import" data-provider="${provider}" ${disabled(provider === 'slack' && !ui.selectedDms.size)}>${buttonText(provider === 'gmail' ? 'Import Gmail conversations' : 'Import selected chats', 'Importing conversations…', `import-${provider}`)}</button>` : `<div class="connection-note"><span class="mono integration-kind">LOCAL MCP · READ ONLY</span><p>${esc(connection.reason || (connection.configured ? `Connect your own ${name} account to import messages.` : `Connect your own authorized ${name} integration. Setup is required for this local copy.`))}</p></div>${renderTimeframe()}<button class="button secondary full integration-import" data-action="connect" data-provider="${provider}" ${disabled()}>${buttonText(`Connect ${name}`, 'Connecting…', `connect-${provider}`)}</button>`}`;
}
function renderWarnings() {
  return ui.warnings.length ? `<div class="warning-box" role="status">${ui.warnings.map(warning => `<p>${esc(warning)}</p>`).join('')}</div>` : '';
}
function renderDms() {
  if (!ui.dms) return `<button class="button secondary full dm-load" data-action="load-dms" ${disabled()}>${buttonText('Choose one-to-one chats', 'Loading chats…', 'dms')}</button>`;
  if (!ui.dms.length) return '<p class="empty-dms">No accessible one-to-one chats found. Check the account and its permissions, or paste your messages instead.</p>';
  return `<fieldset class="dm-list"><legend>Select conversations</legend>${ui.dms.map(dm => `<label><input type="checkbox" name="dm" value="${esc(dm.id)}" ${ui.selectedDms.has(dm.id) ? 'checked' : ''} ${disabled()}><span class="dm-avatar" aria-hidden="true">${esc((dm.name || '?').slice(0,1).toUpperCase())}</span><span>${esc(dm.name || dm.id)}</span><span class="dm-kind mono">1:1</span></label>`).join('')}</fieldset>${ui.dmCursor ? `<button type="button" class="text-button load-more" data-action="load-more-dms" ${disabled()}>Load more chats</button>` : ''}<p class="input-hint">Select up to 20 chats per import.</p>`;
}
function renderSourceList() {
  if (!state.sources.length) return '';
  return `<section class="loaded-sources" aria-label="Loaded sources"><div class="source-list-heading mono">LOADED / ${String(state.sources.length).padStart(2,'0')}</div><ul>${state.sources.map(source => `<li><span class="loaded-icon">${check}</span><div><strong>${esc(source.title || 'Imported conversation')}</strong><span>${esc(source.source || 'paste')} · ${Number(source.ownMessageCount) || 0} yours / ${Number(source.messageCount) || 0} total</span></div><button class="remove-source" data-action="remove-source" data-id="${esc(source.id)}" aria-label="Remove ${esc(source.title || 'source')}" ${disabled()}>×</button></li>`).join('')}</ul></section>`;
}
function renderConnection() {
  const provider = ui.connection;
  if (!provider) return;
  const connection = state.connections[provider] || {};
  const name = provider === 'gmail' ? 'Gmail' : 'Slack';
  const docs = `/setup#${provider}`;
  $('#connection-dialog').innerHTML = `<div class="dialog-head"><span class="panel-marker mono">CONNECT / ${name.toUpperCase()}</span><button class="text-button dialog-close" type="button" data-close aria-label="Close connection setup">×</button></div><h2 id="dialog-title">Connect your ${name}.</h2><p class="panel-description">${esc(connection.reason || 'This local copy needs access authorized by your own account.')}</p><form id="connection-form"><label class="field-label" for="connection-token">Authorized ${name} access token</label><input id="connection-token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="Paste an authorized access token" ${disabled()}><p class="input-hint">${provider === 'gmail' ? 'Needs Gmail read-only access. Your token must belong to your own account.' : 'Use a user token with im:read and im:history access. Only one-to-one DMs are imported.'}</p>${ui.dialogError ? `<p class="error-box" role="alert">${esc(ui.dialogError)}</p>` : ''}<button type="submit" class="button primary full" ${disabled()}>${buttonText('Verify connection', 'Connecting…', `connect-${provider}`)}</button><a class="setup-link" href="${docs}" target="_blank" rel="noopener noreferrer">${name} setup instructions ↗</a></form><p class="dialog-note">Imports use the app’s local MCP tools backed by official ${name} APIs. Tokens stay server-side for this session.</p>`;
  $('[data-close]', $('#connection-dialog')).addEventListener('click', () => $('#connection-dialog').close());
  $('#connection-form').addEventListener('submit', async event => {
    event.preventDefault();
    let token = $('#connection-token').value.trim();
    $('#connection-token').value = '';
    if (!token) return;
    await run(`connect-${provider}`, async () => {
      renderConnection();
      await api(`/api/onboarding/connect/${provider}`, { token });
      token = '';
      $('#connection-dialog').close();
      ui.dms = null;
      ui.dmCursor = null;
      ui.selectedDms.clear();
      await refresh();
      notify(`${name} connected.`);
    });
    token = '';
    if ($('#connection-dialog').open) renderConnection();
  });
}
async function connect(provider) {
  const connection = state.connections[provider] || {};
  if (connection.authMode === 'oauth' && connection.configured) {
    await run(`connect-${provider}`, async () => {
      const result = await api(`/api/onboarding/oauth/${provider}`, {});
      if (!result.url || !/^https:\/\//.test(result.url)) throw new Error('The connection did not return a valid authorization URL.');
      window.location.assign(result.url);
    });
    return;
  }
  if (connection.authMode === 'token' && connection.configured) {
    await run(`connect-${provider}`, async () => {
      await api(`/api/onboarding/connect/${provider}`, { token: '' });
      ui.dms = null;
      ui.dmCursor = null;
      ui.selectedDms.clear();
      await refresh();
      notify(`${provider === 'gmail' ? 'Gmail' : 'Slack'} connected with the configured server token.`);
    });
    if (state.connections[provider]?.connected) return;
  }
  ui.connection = provider;
  ui.dialogError = ui.error;
  renderConnection();
  $('#connection-dialog').showModal();
}
function bind() {
  $('#model-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    let apiKey = $('#api-key').value.trim();
    $('#api-key').value = '';
    if (!apiKey) return;
    await run('model', async () => {
      await api('/api/onboarding/model', { provider: ui.provider, apiKey });
      apiKey = '';
      ui.editingAccess = false;
      await refresh();
      notify('API access verified. Now bring your words.');
    });
    apiKey = '';
  });
  $$('input[name="provider"]').forEach(input => input.addEventListener('change', () => { ui.provider = input.value; ui.error = ''; render(); }));
  $$('[data-source]').forEach(button => {
    button.addEventListener('click', () => { ui.source = button.dataset.source; ui.error = ''; ui.warnings = []; render(); });
    button.addEventListener('keydown', event => {
      const tabs = ['paste','gmail','slack'];
      const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!direction) return;
      event.preventDefault();
      ui.source = tabs[(tabs.indexOf(ui.source) + direction + tabs.length) % tabs.length];
      render();
      $(`#tab-${ui.source}`).focus();
    });
  });
  $('#source-text')?.addEventListener('input', event => ui.text = event.target.value);
  $('#own-email')?.addEventListener('input', event => ui.ownEmail = event.target.value);
  $$('input[name="authorship"]').forEach(input => input.addEventListener('change', () => { ui.authorship = input.value; render(); }));
  $('#date-after')?.addEventListener('change', event => ui.after = event.target.value);
  $('#date-before')?.addEventListener('change', event => ui.before = event.target.value);
  $$('input[name="dm"]').forEach(input => input.addEventListener('change', () => { input.checked ? ui.selectedDms.add(input.value) : ui.selectedDms.delete(input.value); render(); }));
  $('#paste-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!ui.text.trim()) { ui.error = 'Paste at least one message before adding this source.'; render(); return; }
    if (!ui.authorship) { ui.error = 'Identify which messages are yours before importing.'; render(); return; }
    await run('paste', async () => {
      const result = await api('/api/onboarding/paste', { text: ui.text, authorship: ui.authorship, ...(ui.authorship === 'thread' ? { ownEmail: ui.ownEmail } : {}) });
      ui.text = '';
      ui.warnings = result.warnings || [];
      await refresh();
      notify(result.addedCount === 0 ? 'Already imported. Duplicate evidence was skipped.' : 'Source added.');
    });
  });
  $$('[data-action]').forEach(button => button.addEventListener('click', async () => {
    const action = button.dataset.action;
    if (action === 'chatgpt') { await run('chatgpt',async()=>{const result=await api('/api/onboarding/chatgpt',{accountId:button.dataset.id||null});const url=new URL(result.url);if(url.origin!=='https://auth.openai.com')throw Error('Invalid ChatGPT sign-in address.');window.location.assign(url.href);});return; }
    if (action === 'use-chatgpt') { await run('chatgpt',async()=>{await api('/api/onboarding/chatgpt/use',{accountId:button.dataset.id});ui.editingAccess=false;await refresh();notify('Using your ChatGPT plan.');});return; }
    if (action === 'signout-chatgpt') { await run('chatgpt',async()=>{const result=await api('/api/onboarding/chatgpt',{accountId:button.dataset.id},'DELETE');await refresh();notify(result.notice);});return; }
    if (action === 'claude') { await run('claude',async()=>{try{await api('/api/onboarding/claude',{});}finally{await refresh();}ui.editingAccess=false;render();notify('Using your Claude plan through Claude Code.');});return; }
    if (action === 'disconnect-claude') { await run('claude',async()=>{const result=await api('/api/onboarding/claude',{},'DELETE');await refresh();notify(result.notice);});return; }
    if (action === 'change-model') { ui.editingAccess = true; ui.error = ''; render(); return; }
    if (action === 'forget-model') { await run('forget-model', async () => { const result=await api('/api/onboarding/model', {}, 'DELETE'); ui.editingAccess = false; ui.dms = null; ui.dmCursor = null; ui.selectedDms.clear(); await refresh(); notify(result.notice||'Model disconnected. Imported sources remain saved.'); }); return; }
    if (action === 'disconnect') { const provider = button.dataset.provider; await run('disconnect', async () => { await api(`/api/onboarding/connect/${provider}`, {}, 'DELETE'); if (provider === 'slack') { ui.dms = null; ui.dmCursor = null; ui.selectedDms.clear(); } await refresh(); notify('Account disconnected. Imported sources remain local.'); }); return; }
    if (action === 'cancel-access') { ui.editingAccess = false; ui.provider = state.model.provider; ui.error = ''; render(); return; }
    if (action === 'connect' || action === 'reconnect') { await connect(button.dataset.provider); return; }
    if (action === 'add-more') { ui.managingSources = true; window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}#sources`); render(); return; }
    if (action === 'remove-source') {
      await run('remove', async () => { await api(`/api/onboarding/sources/${encodeURIComponent(button.dataset.id)}`, {}, 'DELETE'); await refresh(); notify('Source removed.'); });
      return;
    }
    if (action === 'load-dms' || action === 'load-more-dms') {
      await run('dms', async () => {
        const cursor = action === 'load-more-dms' ? ui.dmCursor : '';
        const result = await api(`/api/onboarding/slack/dms${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        ui.dms = [...new Map([...(cursor ? ui.dms || [] : []), ...(result.conversations || [])].map(dm => [dm.id, dm])).values()];
        ui.dmCursor = result.nextCursor || null;
        ui.warnings = result.warnings || [];
      });
      return;
    }
    if (action === 'import') {
      const provider = button.dataset.provider;
      if (provider === 'slack' && ui.selectedDms.size > 20) { ui.error = 'Select up to 20 chats per import.'; render(); return; }
      if (ui.after && ui.before && ui.after > ui.before) { ui.error = 'The end date must be on or after the start date.'; render(); return; }
      await run(`import-${provider}`, async () => {
        const result = await api(`/api/onboarding/import/${provider}`, { ...(ui.after ? { after: ui.after } : {}), ...(ui.before ? { before: ui.before } : {}), ...(provider === 'slack' ? { conversationIds: [...ui.selectedDms] } : {}) });
        ui.warnings = result.warnings || [];
        await refresh();
        notify(result.addedCount === 0 ? 'No new conversations found for this selection.' : 'Conversations imported.');
      });
      return;
    }
    if (action === 'start') {
      await run('start', async () => { await api('/api/onboarding/start', {}); await refresh(); ui.managingSources = false; render(); if (window.location.hash === '#sources') window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`); });
    }
  }));
}
const callbackParams = new URLSearchParams(window.location.search);
const connectedProvider = callbackParams.get('connected');
const failedProvider = callbackParams.get('connection_error');
if (connectedProvider || failedProvider) {
  const provider = connectedProvider || failedProvider;
  if (['gmail','slack'].includes(provider)) { ui.source = provider; ui.managingSources = true; }
  if (failedProvider) ui.error = failedProvider==='chatgpt'?'ChatGPT sign-in did not complete. See the connection message below.':'Account authorization did not complete. Try connecting again, or paste your messages.';
  callbackParams.delete('connected');
  callbackParams.delete('connection_error');
  window.history.replaceState({}, '', `${window.location.pathname}${callbackParams.size ? `?${callbackParams}` : ''}${ui.managingSources ? '#sources' : window.location.hash}`);
}
refresh().then(() => { if(connectedProvider==='chatgpt'&&state.model.authMode==='chatgpt')notify('Using your ChatGPT plan. Your imported sources are ready.'); if (connectedProvider && state.connections[connectedProvider]?.connected) notify('Account connected. Choose a timeframe, then import your conversations.'); }).catch(error => {
  $('#app').innerHTML = `<main class="loading-screen"><span class="brand">Λ / LARPMAXXING</span><div class="error-box" role="alert"><strong>Cannot reach the local harness.</strong><p>${esc(error.message)}</p></div><p>Start the local server, then reload this page.</p><button class="button secondary" id="retry">Retry connection ${arrow}</button></main>`;
  $('#retry').addEventListener('click', () => window.location.reload());
});
