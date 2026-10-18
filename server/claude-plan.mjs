// Claude plan access through the user's own, unmodified Claude Code CLI.
// Anthropic does not allow third-party apps to run Claude.ai sign-in or to
// store subscription tokens, so this app never sees Claude credentials. It
// only starts `claude -p`, which the user signed in to themselves.
// https://code.claude.com/docs/en/legal-and-compliance
// https://code.claude.com/docs/en/headless
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CLAUDE_PLAN = 'claude-plan';
// Aliases resolve to the newest model of each family for the signed-in plan.
// Fable is left out: on some plans it bills usage credits instead of the plan.
// https://code.claude.com/docs/en/model-config
export const CLAUDE_PLAN_MODELS = [
  {id: 'sonnet', label: 'Claude Sonnet'},
  {id: 'opus', label: 'Claude Opus'},
  {id: 'haiku', label: 'Claude Haiku'},
];
const PLAN_AUTH = new Set(['claude.ai', 'oauth_token']);
const API_KEY_SOURCES = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key']);
// The child gets an allowlisted environment. Inherited API keys, gateway URLs
// or a parent Claude Code session's settings (bare mode ignores the plan
// login) would otherwise switch these requests away from the user's plan.
const PASSED_ENV = /^(?:HOME|USER|LOGNAME|USERNAME|PATH|SHELL|TMPDIR|TEMP|TMP|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|XDG_(?:CONFIG|DATA|CACHE|STATE)_HOME|(?:HTTPS?|NO|ALL)_PROXY|(?:https?|no|all)_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_(?:FILE|DIR)|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|SYSTEMROOT|SystemRoot|WINDIR|COMSPEC|ComSpec|PATHEXT|APPDATA|LOCALAPPDATA|USERPROFILE|HOMEDRIVE|HOMEPATH|PROGRAMDATA|ProgramData)$/;

const MESSAGES = {
  missing: 'Claude Code isn’t installed, or this app can’t find it. Install it, run “claude auth login” with your Claude account, then connect again. If it’s installed somewhere unusual, start Larpmaxxing with CLAUDE_CLI_PATH set to its full path.',
  signed_out: 'Claude Code isn’t signed in to your Claude plan. Run “claude auth login” in Terminal, choose your Claude Pro or Max account, then try again.',
  not_plan: 'Claude Code is set up for API or cloud billing, not your Claude plan. Run “claude auth login” and choose your Claude account to use your plan.',
  unreadable: 'Claude Code didn’t report its sign-in status. Update it with “claude update”, then try again.',
};

export class ClaudePlanError extends Error {
  constructor(code) {
    super(MESSAGES[code] || 'Claude Code could not complete this request.');
    this.name = 'ClaudePlanError';
    this.code = code;
    this.status = 409;
  }
}

/** Failure categories from a `claude -p` run. Never carries CLI output. */
export class ClaudeRunError extends Error {
  constructor(code) {
    super(`Claude Code run failed: ${code}`);
    this.name = 'ClaudeRunError';
    this.code = code;
  }
}

export function planEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => PASSED_ENV.test(key) && typeof value === 'string'));
}

function executable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

/** Finds the CLI on PATH or in the native installer's usual locations. */
export function locateClaude(env = process.env, {isExecutable = executable} = {}) {
  if (env.CLAUDE_CLI_PATH) return path.isAbsolute(env.CLAUDE_CLI_PATH) && isExecutable(env.CLAUDE_CLI_PATH) ? env.CLAUDE_CLI_PATH : null;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = [...String(env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Runs a binary without a shell. Output is capped and never logged. */
export function execute(file, args, {input = '', env, cwd, signal, timeoutMs = 30000, maxBytes = 1024 * 1024, spawnImpl = spawn} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let child;
    try { child = spawnImpl(file, args, {cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true}); }
    catch { return reject(new ClaudeRunError('missing')); }
    const chunks = []; let size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { try { child.kill(); } catch {} reject(error); } else resolve(value);
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new ClaudeRunError('timeout')), timeoutMs);
    signal?.addEventListener('abort', abort, {once: true});
    child.on('error', error => finish(new ClaudeRunError(['ENOENT', 'EACCES', 'ENOEXEC'].includes(error?.code) ? 'missing' : 'failed')));
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) return finish(new ClaudeRunError('invalid_response'));
      chunks.push(chunk);
    });
    child.on('close', code => finish(null, {code, stdout: Buffer.concat(chunks).toString('utf8')}));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const email = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(value) ? value : '';
const PLAN_NAMES = {pro: 'Claude Pro', max: 'Claude Max', team: 'Claude Team', enterprise: 'Claude Enterprise'};

/** Confirms the CLI is installed and signed in to a Claude plan. Sends no prompt. */
export async function checkClaudeCode({env = process.env, locate = locateClaude, exec = execute} = {}) {
  const binary = locate(env);
  if (!binary) throw new ClaudePlanError('missing');
  const options = {env: planEnv(env), cwd: os.tmpdir(), timeoutMs: 20000, maxBytes: 65536};
  let version = '', status;
  try {
    const shown = await exec(binary, ['--version'], options);
    version = shown.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] || '';
    // Exits 1 when signed out, still printing its JSON report.
    status = JSON.parse((await exec(binary, ['auth', 'status'], options)).stdout);
  } catch (error) {
    throw new ClaudePlanError(error?.code === 'missing' ? 'missing' : 'unreadable');
  }
  if (!status || typeof status !== 'object') throw new ClaudePlanError('unreadable');
  if (status.loggedIn !== true) throw new ClaudePlanError('signed_out');
  if (!PLAN_AUTH.has(status.authMethod) || (status.apiProvider && status.apiProvider !== 'firstParty')) throw new ClaudePlanError('not_plan');
  const plan = PLAN_NAMES[status.subscriptionType] || 'Claude plan';
  return {binary, version, plan, accountLabel: email(status.email) || plan, verifiedAt: new Date().toISOString()};
}

const CATEGORIES = {
  authentication_failed: 'signed_out', oauth_org_not_allowed: 'account', account_on_hold: 'account', billing_error: 'account',
  rate_limit: 'limit', model_not_found: 'model', max_output_tokens: 'output_limit',
  overloaded: 'unavailable', server_error: 'unavailable', invalid_request: 'failed',
};

// Reads the stream-json events of one `claude -p` run. Only fixed categories
// leave this function; CLI text can echo the request and is never surfaced.
export function interpretRun(stdout, exitCode) {
  const events = String(stdout).split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(event => event && typeof event === 'object');
  const init = events.find(event => event.type === 'system' && event.subtype === 'init');
  if (init && API_KEY_SOURCES.has(init.apiKeySource)) throw new ClaudeRunError('not_plan');
  const category = events.findLast(event => event.type === 'assistant' && typeof event.error === 'string')?.error
    || events.findLast(event => event.type === 'system' && event.subtype === 'api_retry')?.error;
  const result = events.findLast(event => event.type === 'result');
  if (!result) throw new ClaudeRunError(CATEGORIES[category] || (exitCode === 0 ? 'invalid_response' : 'failed'));
  if (result.is_error || result.subtype !== 'success') {
    if (CATEGORIES[category]) throw new ClaudeRunError(CATEGORIES[category]);
    if (result.subtype === 'error_max_turns') throw new ClaudeRunError('incomplete');
    // Older CLI versions omit categories. Match only the CLI's own short notices.
    const notice = typeof result.result === 'string' && result.result.length <= 500 ? result.result : '';
    if (/not logged in|please run \/login|oauth token (?:has )?expired|invalid api key/i.test(notice)) throw new ClaudeRunError('signed_out');
    if (/usage limit|limit reached|rate limit/i.test(notice)) throw new ClaudeRunError('limit');
    if (/model\b.{0,80}\b(?:not found|not available|unavailable|does not exist)|issue with the selected model/i.test(notice)) throw new ClaudeRunError('model');
    throw new ClaudeRunError('failed');
  }
  if (result.stop_reason === 'max_tokens') throw new ClaudeRunError('output_limit');
  if (result.stop_reason === 'refusal') throw new ClaudeRunError('refusal');
  if (typeof result.result !== 'string') throw new ClaudeRunError('invalid_response');
  return result.result;
}

/**
 * One text completion with no tools, no CLAUDE.md, hooks, plugins, MCP or
 * memory, and no saved transcript. The private content travels on stdin only.
 */
export async function runClaudePlan({binary, env = process.env, system, content, model, effort = 'default', signal, timeoutMs, exec = execute}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'larpmaxxing-claude-'));
  try {
    const promptFile = path.join(dir, 'instructions.md');
    await fs.promises.writeFile(promptFile, system, {mode: 0o600, flag: 'wx'});
    const args = ['-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence',
      '--max-turns', '1', '--model', model, '--system-prompt-file', promptFile, '--output-format', 'stream-json', '--verbose'];
    if (effort !== 'default') args.push('--effort', effort);
    const {code, stdout} = await exec(binary, args, {input: content, env: planEnv(env), cwd: dir, signal, timeoutMs, maxBytes: 16 * 1024 * 1024});
    return interpretRun(stdout, code);
  } finally {
    await fs.promises.rm(dir, {recursive: true, force: true});
  }
}

/** Remembers whether the user connected their Claude plan. Holds no secrets. */
export class ClaudePlanAccess {
  constructor(store, session, {env = process.env, check = checkClaudeCode, run = runClaudePlan} = {}) {
    this.store = store; this.session = session; this.env = env; this.check = check; this.run = run;
    this.sequence = 0; this.restored = false; this.notice = null;
  }
  saved() { return this.store.readState().modelSettings?.claudePlan === true; }
  remember(connected) { this.store.mutate(state => { state.modelSettings = {...state.modelSettings, claudePlan: connected}; }); }
  status() {
    const claude = this.session.status.claude;
    return {connected: !!claude, version: claude?.version || '', accountLabel: claude?.accountLabel || '', plan: claude?.plan || '', notice: this.notice};
  }
  async connect() {
    const sequence = ++this.sequence;
    let found;
    try { found = await this.check({env: this.env}); }
    catch (error) { if (sequence === this.sequence) this.notice = error.message; throw error; }
    if (sequence !== this.sequence) throw Object.assign(new Error('This Claude connection was replaced by a newer attempt.'), {status: 409});
    const {binary, ...status} = found;
    this.session.connectClaude({...status, models: CLAUDE_PLAN_MODELS, run: options => this.run({...options, binary, env: this.env})});
    this.notice = null; this.restored = true; this.remember(true);
    return this.status();
  }
  async restore() {
    if (this.restoring) return this.restoring;
    if (this.restored || this.session.status.claude || !this.saved()) return;
    this.restored = true;
    this.restoring = this.connect().catch(() => {}).finally(() => { this.restoring = null; });
    await this.restoring;
  }
  disconnect() {
    this.sequence++; this.restored = true; this.notice = null;
    this.session.disconnectClaude(); this.remember(false);
    return this.status();
  }
}
