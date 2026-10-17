/** Read-only source adapters. Credentials stay in the server process. */
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SLACK = 'https://slack.com/api/';
const MAX_REQUESTS = 40;
const MAX_MESSAGES = 1000;

function problem(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function count(value, fallback, maximum) {
  if (value === undefined || value === '') return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > maximum) {
    throw problem(`maxResults must be an integer between 1 and ${maximum}.`);
  }
  return result;
}

function timestamp(value, label) {
  if (value === undefined || value === null || value === '') return undefined;
  const result = /^\d+(\.\d+)?$/.test(String(value)) ? Number(value) : Date.parse(value) / 1000;
  if (!Number.isFinite(result) || result < 0 || result > 8640000000000) throw problem(`${label} must be a valid date or Unix timestamp in seconds.`);
  return result;
}

function date(seconds) {
  return new Date(seconds * 1000).toISOString();
}

async function requestJSON(url, token, service, method = 'GET', fetchImpl = globalThis.fetch) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
  } catch {
    throw problem(`${service} could not be reached. Check network access and retry.`, 502);
  }
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw problem(`${service} rate limit reached.${Number.isFinite(retryAfter) && retryAfter > 0 ? ` Retry after ${retryAfter} seconds.` : ' Try again later.'}`, 429);
  }
  if (!response.ok) throw problem(`${service} returned HTTP ${response.status}. Check token validity, scopes, and access.`, response.status === 401 || response.status === 403 ? 400 : 502);
  let data;
  try { data = await response.json(); } catch { throw problem(`${service} returned an invalid response.`, 502); }
  if (service === 'Slack' && !data.ok) {
    const code = /^[a-z_]+$/.test(data.error || '') ? data.error : 'request_failed';
    throw problem(`Slack: ${code}. Check token scopes and conversation membership.`, 400);
  }
  return data;
}

function withParams(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  return url;
}

/** Presence only: this deliberately does not claim account access was tested. */
export async function integrationStatus() {
  const gmailConfigured = Boolean(process.env.GMAIL_ACCESS_TOKEN);
  const slackConfigured = Boolean(process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN);
  return {
    gmail: { configured: gmailConfigured, status: gmailConfigured ? 'configured-unverified' : 'not-configured', credential: 'GMAIL_ACCESS_TOKEN', readOnly: true },
    slack: { configured: slackConfigured, status: slackConfigured ? 'configured-unverified' : 'not-configured', credential: 'SLACK_USER_TOKEN or SLACK_BOT_TOKEN', tokenKind: process.env.SLACK_USER_TOKEN ? 'user' : process.env.SLACK_BOT_TOKEN ? 'bot' : null, readOnly: true },
  };
}

function unescapeHTML(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const number = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return number <= 0x10ffff && number >= 0 ? String.fromCodePoint(number) : whole;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity.toLowerCase()];
  });
}

function htmlText(html) {
  return unescapeHTML(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|tr|blockquote)>/gi, '\n').replace(/<[^>]*>/g, ''));
}

function htmlWithQuotationMarkers(html) {
  return htmlText(html.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote\s*>/gi,
    (_, quote) => `\n${htmlText(quote).split('\n').map(line => `> ${line}`).join('\n')}\n`));
}

/** Conservative heuristics; rawText and removedText remain inspectable. */
export function cleanMessageText(rawText) {
  const lines = String(rawText || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [], removed = [];
  let remainder = false;
  for (const line of lines) {
    if (/^\s*(?:On .{2,500}wrote:|Am .{2,500}schrieb.{0,200}:|[-_]{3,}\s*(?:Original Message|Ursprüngliche Nachricht|Forwarded message|Weitergeleitete Nachricht)|Begin forwarded message:|Anfang der weitergeleiteten Nachricht:|--\s*$|Sent from my (?:iPhone|iPad|Android)|Von meinem (?:iPhone|iPad).+gesendet)/i.test(line)) remainder = true;
    if (remainder || /^\s*>/.test(line)) removed.push(line);
    else kept.push(line);
  }
  return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removedText: removed.join('\n').trim(), cleanupApplied: removed.length > 0 };
}

function payloadText(payload) {
  const plain = [], html = [];
  function walk(part) {
    if (!part || part.filename) return; // attachments never become voice evidence
    if (part.body?.data) {
      const body = Buffer.from(part.body.data, 'base64url').toString('utf8');
      if (part.mimeType === 'text/plain') plain.push(body);
      else if (part.mimeType === 'text/html') html.push(body);
    }
    for (const child of part.parts || []) walk(child);
  }
  walk(payload);
  const htmlOnly = !plain.length && html.length > 0;
  const rawText = plain.length ? plain.join('\n') : html.map(htmlText).join('\n');
  return { rawText, candidateText: htmlOnly ? html.map(htmlWithQuotationMarkers).join('\n') : rawText, rawHtml: htmlOnly ? html.join('\n') : undefined, htmlOnly };
}

function headersOf(message) {
  return Object.fromEntries((message.payload?.headers || []).map(header => [header.name.toLowerCase(), header.value]));
}

function mailbox(value) {
  return (String(value || '').match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] || String(value || '').trim()).toLowerCase();
}

export async function importGmail({ query = '', maxResults, after, before } = {}, { token = process.env.GMAIL_ACCESS_TOKEN, fetchImpl = globalThis.fetch } = {}) {
  if (!token) throw problem('Gmail is not configured. Set GMAIL_ACCESS_TOKEN to an authorized OAuth access token with gmail.readonly scope.');
  const limit = count(maxResults, 20, 100);
  const afterSeconds = timestamp(after, 'after'), beforeSeconds = timestamp(before, 'before');
  if (afterSeconds !== undefined && beforeSeconds !== undefined && afterSeconds >= beforeSeconds) throw problem('after must be earlier than before.');
  if (typeof query !== 'string' || query.length > 2000) throw problem('Gmail query must be text of at most 2000 characters.');
  const warnings = ['Sent messages are evidence of authorship, not approved examples. Quotation/signature removal is heuristic; inspect raw text before approving preferences.'];
  let calls = 0, totalMessages = 0;
  const get = async (path, params = {}) => {
    if (++calls > MAX_REQUESTS) throw problem('Gmail import request limit reached. Narrow the query or date range.');
    return requestJSON(withParams(`${GMAIL}${path}`, params), token, 'Gmail', 'GET', fetchImpl);
  };
  const profile = await get('/profile');
  if (!profile.emailAddress) throw problem('Gmail did not return an authenticated mailbox identity.', 502);
  const q = [query, afterSeconds !== undefined ? `after:${Math.floor(afterSeconds)}` : '', beforeSeconds !== undefined ? `before:${Math.floor(beforeSeconds)}` : ''].filter(Boolean).join(' ');
  const conversations = [], seen = new Set();
  let pageToken;
  do {
    if (calls >= MAX_REQUESTS - 1 || totalMessages >= MAX_MESSAGES) break;
    const page = await get('/threads', { q, maxResults: Math.min(20, limit - conversations.length), pageToken, includeSpamTrash: false });
    for (const thread of page.threads || []) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      if (calls >= MAX_REQUESTS || totalMessages >= MAX_MESSAGES || conversations.length >= limit) break;
      const full = await get(`/threads/${encodeURIComponent(thread.id)}`, { format: 'full' });
      const all = [...(full.messages || [])].sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
      const rfcIds = new Map(all.map(message => [headersOf(message)['message-id'], `gmail:${message.id}`]));
      const messages = [];
      for (const message of all) {
        const seconds = Number(message.internalDate) / 1000;
        if (!Number.isFinite(seconds) || (afterSeconds !== undefined && seconds < afterSeconds) || (beforeSeconds !== undefined && seconds >= beforeSeconds)) continue;
        if (totalMessages >= MAX_MESSAGES) break;
        if (message.labelIds?.includes('DRAFT')) continue;
        const headers = headersOf(message);
        const { rawText, candidateText, rawHtml, htmlOnly } = payloadText(message.payload);
        const cleaned = cleanMessageText(candidateText);
        if (!rawText.trim()) continue;
        // SENT handles account aliases without requiring a broader settings scope.
        const sameAddress = mailbox(headers.from) === profile.emailAddress.toLowerCase();
        const sentLabel = Boolean(message.labelIds?.includes('SENT'));
        const own = sameAddress || sentLabel;
        messages.push({ id: `gmail:${message.id}`, role: own ? 'user' : 'incoming', kind: own ? 'sent' : 'incoming', text: cleaned.text, rawText, date: date(seconds), author: headers.from || '', parentId: rfcIds.get(headers['in-reply-to']) || null,
          metadata: { ...cleaned, text: undefined, htmlOnly, rawHtml, attribution: sameAddress ? 'authenticated-mailbox' : sentLabel ? 'gmail-sent-label' : 'other-sender', threadId: thread.id, messageId: message.id } });
        totalMessages++;
      }
      if (messages.length) conversations.push({ id: `gmail:${thread.id}`, title: headersOf(all[0] || {})['subject'] || 'Gmail conversation', source: 'gmail', date: messages.at(-1).date, messages });
    }
    pageToken = page.nextPageToken;
    if (pageToken && !page.threads?.length) { warnings.push('Gmail returned an empty page with a cursor. Import stopped; narrow the query and retry.'); break; }
  } while (pageToken && conversations.length < limit);
  if (pageToken || conversations.length >= limit || calls >= MAX_REQUESTS || totalMessages >= MAX_MESSAGES) warnings.push('This is a bounded import. More matching content may exist; narrow the date range or repeat with an older range. Duplicate source IDs are stable.');
  return { conversations, warnings };
}

export async function importSlack({ channelId, oldest, latest, maxResults } = {}, options = {}) {
  const token = options.token ?? (process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN);
  const { fetchImpl = globalThis.fetch, requireDirectMessage = false } = options;
  if (!token) throw problem('Slack is not configured. Set SLACK_USER_TOKEN (preferred) or SLACK_BOT_TOKEN with the relevant history scopes.');
  if (typeof channelId !== 'string' || !/^[CDG][A-Z0-9]{2,}$/.test(channelId)) throw problem('Enter a Slack channel or conversation ID, such as C0123456789.');
  if (requireDirectMessage && !/^D[A-Z0-9]{2,}$/.test(channelId)) throw problem('Only 1:1 Slack direct messages can be imported.');
  const limit = count(maxResults, 30, 200);
  const oldestSeconds = timestamp(oldest, 'oldest'), latestSeconds = timestamp(latest, 'latest');
  if (oldestSeconds !== undefined && latestSeconds !== undefined && oldestSeconds >= latestSeconds) throw problem('oldest must be earlier than latest.');
  let calls = 0;
  const get = async (method, params = {}) => {
    if (++calls > MAX_REQUESTS) throw problem('Slack import request limit reached. Narrow the date range.');
    return requestJSON(withParams(`${SLACK}${method}`, params), token, 'Slack', method === 'auth.test' ? 'POST' : 'GET', fetchImpl);
  };
  const identity = await get('auth.test');
  const isBot = Boolean(identity.bot_id) || /^xoxb-/.test(token) || (options.token === undefined && !process.env.SLACK_USER_TOKEN && Boolean(process.env.SLACK_BOT_TOKEN));
  const ownUser = isBot ? null : identity.user_id;
  if (!identity.team_id || (!isBot && !ownUser)) throw problem('Slack did not return a usable authenticated identity.', 502);
  if (requireDirectMessage) {
    if (isBot) throw problem('Connect a Slack user token with im:read and im:history. A bot token cannot identify your writing.');
    const { channel } = await get('conversations.info', { channel: channelId });
    if (channel?.id !== channelId || channel.is_im !== true || channel.is_mpim === true || channel.is_channel === true || channel.is_group === true) {
      throw problem('Slack did not verify this conversation as a 1:1 direct message. No message history was read.');
    }
  }
  const warnings = ['Slack sent messages are not automatically approved examples. Imported attachments, linked pages and files are not downloaded.'];
  if (isBot) warnings.push('The token identifies a bot, not you. All imported messages are classified as incoming. Use a human user token to attribute your own writing.');
  const roots = new Map();
  let cursor, partial = false;
  try {
    do {
      const page = await get('conversations.history', { channel: channelId, oldest: oldestSeconds, latest: latestSeconds, limit: Math.min(15, limit - roots.size), cursor, inclusive: false });
      for (const message of page.messages || []) {
        if (roots.size >= limit) break;
        if (message.type === 'message' && message.ts && typeof message.text === 'string') roots.set(message.ts, message);
      }
      if (page.is_limited) warnings.push('Slack retention or plan limits hide older messages.');
      cursor = page.response_metadata?.next_cursor?.trim();
      if (page.has_more && !cursor) { partial = true; break; }
    } while (cursor && roots.size < limit && calls < MAX_REQUESTS - 1);
  } catch (error) {
    if (!roots.size) throw error;
    warnings.push(error.message); partial = true;
  }
  if (cursor || roots.size >= limit) partial = true;
  const groups = new Map();
  for (const root of roots.values()) {
    const rootTs = root.thread_ts || root.ts;
    if (!groups.has(rootTs)) groups.set(rootTs, new Map());
    groups.get(rootTs).set(root.ts, root);
  }
  let total = roots.size;
  for (const [rootTs, group] of groups) {
    const root = roots.get(rootTs);
    if (!root?.reply_count || calls >= MAX_REQUESTS || total >= MAX_MESSAGES) { if (root?.reply_count) partial = true; continue; }
    let replyCursor;
    try {
      do {
        const page = await get('conversations.replies', { channel: channelId, ts: rootTs, oldest: oldestSeconds, latest: latestSeconds, limit: 15, cursor: replyCursor, inclusive: false });
        for (const reply of page.messages || []) {
          if (total >= MAX_MESSAGES) break;
          if (reply.type === 'message' && reply.ts && typeof reply.text === 'string') {
            if (!group.has(reply.ts)) total++;
            group.set(reply.ts, reply);
          }
        }
        replyCursor = page.response_metadata?.next_cursor?.trim();
        if (page.has_more && !replyCursor) { partial = true; break; }
      } while (replyCursor && calls < MAX_REQUESTS && total < MAX_MESSAGES);
      if (replyCursor) partial = true;
    } catch (error) { warnings.push(`Some thread replies were not imported: ${error.message}`); partial = true; break; }
  }
  const conversations = [];
  for (const [rootTs, group] of groups) {
    const messages = [...group.values()].sort((a, b) => Number(a.ts) - Number(b.ts)).filter(message => {
      const seconds = Number(message.ts);
      return Number.isFinite(seconds) && (oldestSeconds === undefined || seconds > oldestSeconds) && (latestSeconds === undefined || seconds < latestSeconds);
    }).map(message => {
      const own = Boolean(ownUser && message.user === ownUser && !message.bot_id && !message.app_id && message.subtype !== 'bot_message');
      const rawText = message.text;
      const cleaned = cleanMessageText(unescapeHTML(rawText));
      return { id: `slack:${identity.team_id}:${channelId}:${message.ts}`, role: own ? 'user' : 'incoming', kind: own ? 'sent' : 'incoming', text: cleaned.text, rawText, date: date(Number(message.ts)), author: message.user || message.bot_id || 'unknown', parentId: message.ts !== rootTs ? `slack:${identity.team_id}:${channelId}:${rootTs}` : null,
        metadata: { ...cleaned, text: undefined, attribution: own ? 'authenticated-slack-user' : isBot ? 'human-identity-unverified' : 'other-author', channelId, teamId: identity.team_id, ts: message.ts, subtype: message.subtype || null } };
    });
    if (messages.length) conversations.push({ id: `slack:${identity.team_id}:${channelId}:${rootTs}`, title: `Slack ${channelId}: ${messages[0].text.slice(0, 80) || 'conversation'}`, source: 'slack', date: messages.at(-1).date, messages });
  }
  if (partial) warnings.push('This is a partial, bounded import. More history or replies may exist. Narrow the date range and retry; source IDs remain stable for deduplication.');
  if (requireDirectMessage && conversations.length) {
    // Ordinary DMs are chronological exchanges, often without Slack threads.
    // Preserve that context instead of treating every unthreaded line as a chat.
    const messages = [...new Map(conversations.flatMap(conversation => conversation.messages).map(message => [message.id, message])).values()]
      .sort((a, b) => Number(a.metadata.ts) - Number(b.metadata.ts));
    return { conversations: [{ id: `slack:${identity.team_id}:${channelId}`, title: `Slack 1:1 ${channelId}`, source: 'slack', date: messages.at(-1).date, messages }], warnings: [...new Set(warnings)] };
  }
  return { conversations, warnings: [...new Set(warnings)] };
}
