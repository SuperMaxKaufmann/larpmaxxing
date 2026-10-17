import { createHash } from 'node:crypto';

// This module performs local, conservative extraction. Imported text is data,
// never executable instructions, and no network or model access occurs here.
const hash = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const clean = (value) => String(value ?? '').replace(/\r\n?/g, '\n').normalize('NFC').trim();
const TYPES = new Set(['global', 'language', 'channel', 'audience', 'recipient', 'situation', 'mode']);
const KINDS = new Set(['explicit-preference', 'user-written', 'approved', 'rejected', 'incoming', 'dictation', 'report', 'sent', 'ai-unknown', 'conversation']);
const STYLE = /\b(formal|casual|natural|warm(?:er|th)?|stiff|polished|concise|shorter|longer|hedg(?:e|ing)|tone|wording|greeting|opening|closing|phrase|sign[- ]?off|em[- ]dash(?:es)?|exclamation|slang|jargon|textbook|robotic|friendly|direct|detail(?:ed)?|formulaic|sounds? like ai)\b|förmlich|formell|lockerer|natürlicher|klingt nach ki|kürzer|ausführlicher|wärmer|gedankenstrich|höflich|ansprache|floskel|steif|tonfall|duzen|siezen|du-form|sie-form/i;
const KEYWORDS = [
  /\brepl(?:y|ies)\b/i, /\brespond\b/i, /\bthis email\b/i, /\bwrite an email\b/i,
  /\bdraft (?:a |the )?message\b/i, /\bmake it more casual\b/i, /\btoo formal\b/i,
  /\bsounds like ai\b/i, /\brewrite\b/i, /\bfollow[- ]up\b/i, /\bcold outreach\b/i,
  /\bantwort(?:en)?\b/i, /\be-?mail\b/i, /\bnachricht\b/i, /\bformulieren\b/i,
  /\bumschreiben\b/i, /\blockerer\b/i, /\bzu förmlich\b/i, /\bnatürlicher\b/i, /\bklingt nach ki\b/i,
];

function iso(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function contentText(content) {
  if (typeof content === 'string') return clean(content);
  if (Array.isArray(content)) return clean(content.map((part) => typeof part === 'string' ? part : part?.text ?? '').join('\n'));
  return clean(content?.parts ? contentText(content.parts) : content?.text ?? '');
}

function roleOf(message, ownIdentifiers = []) {
  const role = message.role ?? message.sender?.role ?? message.author?.role;
  if (['user', 'human', 'me'].includes(role) || message.isOwn === true) return 'user';
  if (['assistant', 'ai', 'bot'].includes(role)) return 'assistant';
  if (role === 'system' || role === 'tool') return role;
  const sender = typeof message.sender === 'string' ? message.sender : message.sender?.email ?? message.author?.email ?? message.author?.id ?? message.sender?.id;
  if (sender === 'human') return 'user';
  if (sender === 'assistant') return 'assistant';
  if (sender && ownIdentifiers.some((id) => String(id).toLowerCase() === String(sender).toLowerCase())) return 'user';
  return 'other';
}

/** Preserve excluded fragments for inspection without learning the user's voice from them. */
export function separateQuotedContent(text) {
  const lines = clean(text).split('\n');
  const kept = [], excludedFragments = [];
  let quoted = false, signature = false, buffer = [], bufferKind = '';
  const flush = () => { if (buffer.length) excludedFragments.push({ kind: bufferKind, text: buffer.join('\n') }); buffer = []; };
  for (const line of lines) {
    if (/^(?:On .+wrote:|Am .+schrieb|[-_]{2,}\s*(?:Forwarded|Original|Weitergeleitete|Ursprüngliche)|Begin forwarded message:|Anfang der weitergeleiteten Nachricht:)/i.test(line.trim())) quoted = true;
    if (/^\s*(?:--\s*$|Sent from my |Von meinem .* gesendet|Gesendet von meinem )/i.test(line)) signature = true;
    const kind = quoted || /^\s*>/.test(line) ? 'quoted' : signature ? 'signature' : '';
    if (kind) { if (kind !== bufferKind) flush(); bufferKind = kind; buffer.push(line); }
    else { flush(); bufferKind = ''; kept.push(line); }
  }
  flush();
  return { text: clean(kept.join('\n')), excludedFragments };
}

function normalizeConversation(record, options) {
  const source = options.source !== 'auto' ? options.source : record.source ?? (record.mapping ? 'chatgpt' : record.chat_messages ? 'claude' : 'manual');
  const title = clean(record.title ?? record.name ?? options.title ?? 'Imported conversation') || 'Imported conversation';
  let entries;
  if (record.mapping && typeof record.mapping === 'object') {
    entries = Object.entries(record.mapping).filter(([, node]) => node?.message).map(([id, node]) => ({ ...node.message, id: node.message.id ?? id, originalParentId: node.parent, _nodeId: id }));
  } else entries = record.chat_messages ?? record.messages ?? [];
  if (!Array.isArray(entries)) throw new TypeError('Conversation messages must be an array.');
  const nativeId = record.id ?? record.uuid ?? record.conversation_id;
  // Without native IDs, two transcripts with the same generic first request
  // are not necessarily the same conversation. Only exact copies deduplicate.
  const fingerprint = nativeId ?? `${title}\n${entries.map((entry) => `${entry.role ?? entry.sender ?? entry.author?.role ?? 'unknown'}:${contentText(entry.text ?? entry.content ?? entry.body ?? '')}:${entry.parentId ?? entry.parent_uuid ?? entry.originalParentId ?? ''}`).join('\n')}`;
  const id = String(nativeId ?? `conversation-${hash(`${source}:${fingerprint}`)}`);
  const nativeMap = new Map();
  const ownIdentifiers = record.ownIdentifiers ?? record.self ?? options.ownIdentifiers ?? [];
  const identities = Array.isArray(ownIdentifiers) ? ownIdentifiers : [ownIdentifiers];
  const occurrences = new Map();
  const messages = entries.map((entry) => {
    const text = contentText(entry.text ?? entry.content ?? entry.body ?? '');
    const role = roleOf(entry, identities);
    const originalId = entry.id ?? entry.uuid ?? entry.message_id ?? entry._nodeId;
    const occurrenceKey = `${role}:${text}`;
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const messageId = originalId ? String(originalId) : `message-${hash(`${source}:${id}:${role}:${text}:${occurrence}`)}`;
    if (originalId) nativeMap.set(String(originalId), messageId);
    if (entry._nodeId) nativeMap.set(String(entry._nodeId), messageId);
    // Manual labels apply to explicitly pasted evidence, not to every message
    // in a historical JSON archive that happens to be imported with that option.
    let kind = KINDS.has(entry.kind) ? entry.kind : role === 'assistant' ? 'ai-unknown' : role === 'other' ? 'incoming' : 'conversation';
    // A label imported from an external account is insufficient to claim ownership.
    if (kind === 'sent' && role !== 'user') kind = 'incoming';
    const shouldSplit = ['gmail', 'email', 'slack'].includes(source) || kind === 'sent' || kind === 'user-written';
    const separated = shouldSplit ? separateQuotedContent(text) : { text, excludedFragments: [] };
    const excludedFragments = [...(Array.isArray(entry.excludedFragments) ? entry.excludedFragments : []), ...separated.excludedFragments];
    return {
      id: messageId, role, text: separated.text, date: iso(entry.date ?? entry.created_at ?? entry.create_time ?? entry.timestamp ?? record.date ?? record.created_at ?? record.create_time),
      parentId: entry.parentId ?? entry.parent_uuid ?? entry.originalParentId ?? null, kind,
      ...(entry.rawText !== undefined ? { rawText: String(entry.rawText) } : separated.excludedFragments.length ? { rawText: text } : {}),
      ...(excludedFragments.length ? { excludedFragments } : {}),
      ...(entry.author !== undefined ? { author: entry.author } : entry.sender !== undefined ? { author: entry.sender } : {}),
      ...(entry.metadata && typeof entry.metadata === 'object' ? { metadata: entry.metadata } : {}),
      ...(entry.isOwn !== undefined ? { isOwn: entry.isOwn === true } : {}),
      ...(entry.report ? { report: entry.report } : {}),
    };
  });
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.parentId !== null) {
      let parent = String(message.parentId);
      // ChatGPT has empty graph nodes, usually a root. Walk only through those nodes.
      const seen = new Set();
      while (record.mapping && !nativeMap.has(parent) && record.mapping[parent] && !seen.has(parent)) {
        seen.add(parent);
        parent = record.mapping[parent].parent;
        if (parent === null || parent === undefined) break;
      }
      message.parentId = parent ? nativeMap.get(String(parent)) ?? String(parent) : null;
    } else if (!record.mapping && !entries.some((entry) => 'parentId' in entry || 'parent_uuid' in entry)) message.parentId = index ? messages[index - 1].id : null;
  }
  const dates = [iso(record.date), iso(record.updated_at ?? record.update_time), iso(record.create_time ?? record.created_at), ...messages.map((message) => message.date)].filter(Boolean).sort();
  return { id, title, source, date: dates.at(-1) ?? null, createdAt: iso(record.create_time ?? record.created_at) ?? dates[0] ?? null, messages: [...new Map(messages.filter((message) => message.text || message.rawText).map((message) => [message.id, message])).values()], synthetic: record.synthetic === true };
}

/** Normalize supported export shapes without claiming access to consumer account history. */
export function normalizeImport(input, { source = 'auto', title = '', kind = 'conversation', ownIdentifiers = [] } = {}) {
  if (!KINDS.has(kind)) throw new TypeError(`Unsupported evidence kind: ${kind}`);
  const options = { source, title, kind, ownIdentifiers };
  const warnings = [];
  let parsed = input;
  if (typeof input === 'string') {
    const text = clean(input);
    if (!text) return { conversations: [], warnings: ['No content was supplied.'] };
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (typeof parsed === 'string') {
    const matches = [...parsed.matchAll(/^(User|Assistant|Human|Nutzer|Benutzer|Assistent):\s*/gim)];
    const isTranscript = kind === 'conversation' && matches.length > 0;
    const messages = isTranscript ? matches.map((match, index) => ({ role: /^(user|human|nutzer|benutzer)$/i.test(match[1]) ? 'user' : 'assistant', text: parsed.slice(match.index + match[0].length, matches[index + 1]?.index ?? parsed.length).trim() })) : [{ role: ['explicit-preference', 'user-written', 'approved', 'rejected', 'dictation'].includes(kind) ? 'user' : 'other', kind: kind === 'conversation' ? 'incoming' : kind, text: parsed }];
    if (!isTranscript && kind === 'conversation') warnings.push('Unlabeled pasted text has unknown authorship. It is retained as incoming material, not as your writing. Choose an evidence type to identify it explicitly.');
    if (kind === 'report') warnings.push('A chatbot report contains claims that need review. Source links and recalled impressions are not independently verified.');
    return { conversations: [normalizeConversation({ title: title || (kind === 'report' ? 'Imported chatbot report' : 'Pasted evidence'), messages }, options)], warnings };
  }
  if (!parsed || typeof parsed !== 'object') throw new TypeError('Import a JSON export, selected conversation, report, or plain text.');
  if (Array.isArray(parsed.warnings)) warnings.push(...parsed.warnings.filter((warning) => typeof warning === 'string'));
  if (Array.isArray(parsed.preferences) && !parsed.messages && !parsed.conversations) {
    const report = normalizeConversation({ title: title || 'Imported chatbot report', messages: [{ role: 'other', kind: 'report', text: JSON.stringify(parsed, null, 2), report: parsed }] }, { ...options, kind: 'report' });
    return { conversations: [report], warnings: ['Report preferences are proposals. Claimed source references and retrieval limitations are retained, not verified.'] };
  }
  const records = Array.isArray(parsed) ? parsed : parsed.conversations ?? [parsed];
  const conversations = [];
  for (const record of records) {
    if (!record || typeof record !== 'object' || (!record.mapping && !record.chat_messages && !record.messages)) { warnings.push('Skipped an unsupported record without mapping, chat_messages, or messages.'); continue; }
    conversations.push(normalizeConversation(record, options));
  }
  // Duplicate files can contain the same conversation with different branches.
  const merged = new Map();
  for (const conversation of conversations) {
    const existing = merged.get(`${conversation.source}:${conversation.id}`);
    if (existing) existing.messages = [...new Map([...existing.messages, ...conversation.messages].map((message) => [message.id, message])).values()];
    else merged.set(`${conversation.source}:${conversation.id}`, conversation);
  }
  return { conversations: [...merged.values()], warnings };
}

export function discover(conversation, filters = {}) {
  const fullText = `${conversation.title}\n${conversation.messages.map((message) => message.text).join('\n')}`;
  const reasons = [];
  const date = conversation.date ? new Date(conversation.date).valueOf() : null;
  let excluded = false;
  const exclusions = Array.isArray(filters.exclude) ? filters.exclude : filters.exclude ? [filters.exclude] : [];
  if (exclusions.some((term) => fullText.toLowerCase().includes(String(term).toLowerCase()))) { excluded = true; reasons.push('Matches an exclusion.'); }
  if (date !== null && filters.after && date < new Date(filters.after).valueOf()) { excluded = true; reasons.push('Before selected date range.'); }
  if (date !== null && filters.before) {
    const before = /^\d{4}-\d{2}-\d{2}$/.test(filters.before) ? new Date(`${filters.before}T23:59:59.999Z`).valueOf() : new Date(filters.before).valueOf();
    if (date > before) { excluded = true; reasons.push('After selected date range.'); }
  }
  if (date === null && (filters.after || filters.before)) { excluded = true; reasons.push('No reliable date is available for the selected date range.'); }
  if (filters.query && !fullText.toLowerCase().includes(String(filters.query).toLowerCase())) { excluded = true; reasons.push('Does not match the search query.'); }
  let score = 0;
  const hits = KEYWORDS.filter((pattern) => pattern.test(fullText)).length;
  if (hits) { score += Math.min(6, hits * 2); reasons.push(`Drafting keywords found (${hits}).`); }
  if (conversation.messages.some((message) => ['explicit-preference', 'user-written', 'approved', 'rejected', 'report'].includes(message.kind))) { score += 5; reasons.push('Explicitly supplied writing evidence.'); }
  const draft = conversation.messages.some((message) => message.role === 'assistant' && /(?:^|\n)(?:Hi |Hello |Dear |Hey |Hallo |Liebe[r]? |Sehr geehrte)|(?:Best(?: regards)?|Cheers|Viele Grüße|Beste Grüße|Mit freundlichen Grüßen)/i.test(message.text));
  const correction = conversation.messages.some((message) => message.role === 'user' && STYLE.test(message.text));
  if (draft) { score += 2; reasons.push('A message-shaped assistant draft is present.'); }
  if (correction) { score += 3; reasons.push('User wording or style feedback is present.'); }
  if (draft && conversation.messages.some((message) => message.role === 'user')) score += 1;
  if (score === 0) reasons.push('No local drafting signal found. You can include this conversation manually.');
  return { candidate: !excluded && score >= 2, score, reasons, excluded };
}

function reference(conversation, message, excerpt = message.text) {
  return { conversationId: conversation.id, messageId: message.id, excerpt: clean(excerpt).slice(0, 320), date: message.date ?? conversation.date, source: conversation.source };
}

function languageOf(text) {
  return /\b(ich|du|Sie|und|bitte|danke|gerne|nicht|Grüße|Nachricht|Antwort|für|mit|hallo)\b|[äöüß]/.test(text) ? 'de' : 'en';
}

function scopeOf(text, manual = false) {
  let match;
  // A local request remains local even if it contains an imperative or "always".
  if (/\b(this (?:reply|message|email|one|draft)|for now|in this case|just (?:here|this)|only this)\b|diese[rsmn]? (?:antwort|nachricht|e-?mail)|nur (?:hier|diesmal)|in diesem fall/i.test(text)) return { type: 'situation', value: 'This source conversation' };
  if (/\b(?:in|for) (?:german|deutsch)\b|auf deutsch|deutschsprachig/i.test(text)) return { type: 'language', value: 'de' };
  if (/\b(?:in|for) english\b|auf englisch|englischsprachig/i.test(text)) return { type: 'language', value: 'en' };
  if ((match = text.match(/\b(?:on|in|for|bei|auf)\s+(slack|whatsapp|e-?mails?)\b/i))) return { type: 'channel', value: /e-?mail/i.test(match[1]) ? 'email' : match[1].toLowerCase() };
  if (/close colleagues|close coworkers|enge[nsr]? kolleg|vertraute[nsr]? kolleg/i.test(text)) return { type: 'audience', value: 'Close colleagues' };
  if (/external (?:business )?contacts?|externe[nsr]? (?:geschäfts)?kontakt/i.test(text)) return { type: 'audience', value: 'External business contacts' };
  if (/cold outreach|cold emails?|kaltakquise/i.test(text)) return { type: 'audience', value: 'Cold outreach' };
  if (/formal correspondence|formal letters?|förmliche korrespondenz|behörden/i.test(text)) return { type: 'audience', value: 'Formal correspondence' };
  if ((match = text.match(/(?:when (?:writing|replying) to|for (?:messages|emails) to|bei nachrichten an)\s+([\p{L}][\p{L} .'-]{1,45}?)(?:[,;:]|\s+(?:use|keep|avoid|prefer|please)|$)/iu))) return { type: 'recipient', value: match[1].trim() };
  if (manual || /\b(always|never|generally|all (?:my|future)|my (?:writing|style)|i (?:prefer|like|dislike)|i don['’]t like)\b|\b(immer|niemals|generell|grundsätzlich|ich (?:mag|bevorzuge)|alle zukünftigen)\b/i.test(text)) return { type: 'global', value: '' };
  return { type: 'situation', value: 'This source conversation' };
}

function literalBans(text) {
  const bans = [];
  if (/\b(?:never|avoid|no|don['’]t|do not|stop)\b|\b(?:nie|niemals|keine[nrms]?|vermeide)\b/i.test(text)) {
    if (/em[- ]dash|geviertstrich|—/i.test(text)) bans.push('—');
    const quoted = [...text.matchAll(/["“„]([^"“”„]{1,90})["”]/g)].map((match) => match[1]);
    if (/phrase|wording|say|write|formulierung|ausdruck|schreib|floskel/i.test(text)) bans.push(...quoted);
  }
  return [...new Set(bans)];
}

function createPreference(text, conversation, message, additions = {}) {
  const scoped = additions.scope ?? scopeOf(text, message.kind === 'explicit-preference');
  const scope = scoped.type === 'situation' && scoped.value === 'This source conversation' ? { ...scoped, value: conversation.id } : scoped;
  const banned = literalBans(text);
  return {
    id: `preference-${hash(`${text.toLowerCase()}:${scope.type}:${scope.value}`)}`, text,
    scope, basis: 'explicit', status: 'proposed', strength: scope.type === 'situation' ? 'moderate' : 'strong',
    category: banned.includes('—') ? 'hard' : banned.length ? 'rejected-wording' : 'guidance', banned,
    sources: [reference(conversation, message, text)], conflicts: [], date: message.date ?? conversation.date,
    ...additions, scope,
  };
}

function isApproval(text) {
  if (/\b(but|except|however|change|instead|shorter|longer|too|aber|außer|ändern|statt|noch|zu)\b/i.test(text)) return false;
  return /^(?:(?:yes|ja)[,! .]+)?(?:perfect|looks good|this is good|approved|exactly right|that works|use this|send it|so passt das|passt (?:so|perfekt)|genau so|perfekt|das ist gut|so kann es raus)(?:[!. ,]+(?:send (?:it|that)|use (?:it|that|this)))?(?:[!. ,]+(?:thanks|thank you|danke))?[!. ]*$/i.test(clean(text));
}

function isCorrection(text) {
  return STYLE.test(text) && (/^(?:no\b|nope\b|nein\b)/i.test(text) || /\b(too|less|more|make|keep|avoid|remove|don['’]t|not|shorter|warmer|instead|prefer)\b|\b(bitte|zu|weniger|mehr|nicht|lieber|kürzer|lockerer|natürlicher|wärmer|bevorzuge)\b/i.test(text));
}

function parseReport(conversation, message) {
  let report = message.report;
  try { report ??= JSON.parse(message.text); } catch { /* Prose reports remain explicitly reviewable. */ }
  const warnings = [], preferences = [];
  if (!report || !Array.isArray(report.preferences)) {
    const lines = message.text.split('\n').map((line) => line.replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter((line) => line && STYLE.test(line) && /prefer|avoid|never|always|bitte|vermeide|niemals|keine|bevorzuge/i.test(line));
    for (const text of lines.slice(0, 50)) preferences.push(createPreference(text, conversation, message, { basis: 'inferred', strength: 'weak', scope: scopeOf(text), provenance: 'report-claim', retrieval: 'unspecified', limitations: ['Plain report: source retrieval and excerpts have not been independently verified.'] }));
    warnings.push('Plain report parsing is limited. Only recognizable preference lines were proposed; inspect the complete source and add any missing preferences manually.');
    return { preferences, warnings };
  }
  for (const item of report.preferences.slice(0, 1000)) {
    if (!item || typeof item.text !== 'string' || !clean(item.text)) continue;
    const scope = item.scope && TYPES.has(item.scope.type) ? { type: item.scope.type, value: clean(item.scope.value) } : { type: 'situation', value: 'Imported report; scope needs review' };
    const claimedSources = Array.isArray(item.sources) ? item.sources.map((source) => typeof source === 'string' ? { label: source, claimed: true, verified: false } : { ...source, claimed: true, verified: false }) : [];
    const retrieval = item.retrieval ?? item.evidenceType ?? item.evidence_type ?? 'unspecified';
    const remembered = /impression|remember|memory|unretrieved/i.test(retrieval);
    const hasCitation = claimedSources.some((source) => source.conversationId || source.url || source.title || source.label);
    preferences.push(createPreference(clean(item.text), conversation, message, {
      scope, basis: item.basis === 'explicit' && !remembered ? 'explicit' : 'inferred', strength: remembered || !hasCitation ? 'weak' : 'moderate',
      provenance: 'report-claim', retrieval, reportedSources: claimedSources,
      limitations: [...(Array.isArray(report.limitations) ? report.limitations : report.limitations ? [String(report.limitations)] : []), ...(Array.isArray(item.limitations) ? item.limitations : item.limitations ? [String(item.limitations)] : []), 'Report citations are claims, not independently verified.'],
      conflicts: Array.isArray(item.conflicts) ? item.conflicts : [],
    }));
    if (!hasCitation || remembered) warnings.push(`Weak report evidence: ${clean(item.text).slice(0, 100)}`);
  }
  if (!report.limitations || !report.limitations.length) warnings.push('The report did not disclose search limitations. Ask the source chatbot to describe what it could actually retrieve.');
  return { preferences, warnings };
}

/** Extract proposals, preserving approval status and the conversation graph. */
export function extractEvidence(conversation) {
  const preferences = [], examples = [], warnings = [];
  const byId = new Map(conversation.messages.map((message) => [message.id, message]));
  const judgments = new Map();
  for (const message of conversation.messages) {
    if (message.role !== 'user' || message.kind === 'dictation') continue;
    const parent = byId.get(message.parentId);
    if (parent?.role === 'assistant') {
      const previous = judgments.get(parent.id);
      if (isApproval(message.text)) judgments.set(parent.id, { kind: 'approved', feedback: message, previous });
      else if (isCorrection(message.text)) judgments.set(parent.id, { kind: 'rejected', feedback: message, previous });
    }
  }
  for (const message of conversation.messages) {
    if (message.kind === 'report') {
      const result = parseReport(conversation, message);
      preferences.push(...result.preferences); warnings.push(...result.warnings); continue;
    }
    if (message.kind === 'explicit-preference') {
      for (const text of message.text.split(/\n+/).map(clean).filter(Boolean)) preferences.push(createPreference(text, conversation, message));
    } else if (message.role === 'user' && message.kind === 'conversation') {
      // Full sentences stay intact: conditions must not disappear while extracting.
      const segments = message.text.split(/\n+|(?<=[.!?])\s+(?=[A-ZÄÖÜ])/u).map(clean).filter(Boolean);
      for (const text of segments) {
        if (STYLE.test(text) && (/\b(i (?:prefer|like|dislike)|always|never|generally|please (?:avoid|keep|use)|do not|don['’]t)\b|\b(ich (?:mag|bevorzuge)|immer|niemals|generell|grundsätzlich|bitte|vermeide|keine[nrms]?)\b/i.test(text) || isCorrection(text))) preferences.push(createPreference(text, conversation, message));
      }
    }
    if (['system', 'tool'].includes(message.role) || message.kind === 'explicit-preference') continue;
    let kind = ['user-written', 'approved', 'rejected', 'sent', 'incoming', 'dictation', 'ai-unknown'].includes(message.kind) ? message.kind : null;
    const judgment = judgments.get(message.id);
    const conflictingJudgments = judgment && (() => { let previous = judgment.previous; while (previous) { if (previous.kind !== judgment.kind) return true; previous = previous.previous; } return false; })();
    if (message.role === 'assistant') kind = conflictingJudgments ? 'ai-unknown' : judgment?.kind ?? 'ai-unknown';
    if (!kind && message.role === 'other') kind = 'incoming';
    // User chat instructions are not presumed to be messages written to a recipient.
    const feedbackSources = [];
    for (let decision = judgment; decision; decision = decision.previous) feedbackSources.push(reference(conversation, decision.feedback));
    if (kind && message.text) examples.push({ id: `example-${hash(`${conversation.source}:${message.id}`)}`, text: message.text, kind, status: 'proposed', sources: [reference(conversation, message), ...feedbackSources], language: languageOf(message.text), channel: ['gmail', 'email'].includes(conversation.source) ? 'email' : conversation.source === 'slack' ? 'slack' : '', date: message.date ?? conversation.date, ...(conflictingJudgments ? { approvalConflict: true } : {}) });
    if (conflictingJudgments) warnings.push('Conflicting approval and rejection exist for one draft across branches. It remains an unknown AI example until reviewed.');
  }
  const unique = new Map();
  for (const preference of preferences) {
    if (unique.has(preference.id)) {
      const existing = unique.get(preference.id);
      existing.sources = [...new Map([...existing.sources, ...preference.sources].map((source) => [`${source.conversationId}:${source.messageId}`, source])).values()];
    } else unique.set(preference.id, preference);
  }
  const deduped = [...unique.values()];
  for (let i = 0; i < deduped.length; i++) for (let j = i + 1; j < deduped.length; j++) {
    const a = deduped[i], b = deduped[j];
    if (a.scope.type !== b.scope.type || a.scope.value !== b.scope.value) continue;
    const pairs = [[/short|concise|kürz/i, /long|detail|ausführlich/i], [/casual|less formal|locker/i, /very formal|more formal|sehr formell|förmlich/i]];
    if (pairs.some(([left, right]) => (left.test(a.text) && right.test(b.text)) || (right.test(a.text) && left.test(b.text)))) {
      a.conflicts.push({ preferenceId: b.id, reason: 'Potentially conflicting guidance; inspect context.' });
      b.conflicts.push({ preferenceId: a.id, reason: 'Potentially conflicting guidance; inspect context.' });
    }
  }
  if (!deduped.length && !examples.some((example) => ['approved', 'user-written'].includes(example.kind))) warnings.push('Sparse evidence: no explicit style preferences or approved/user-written examples were found. Add a few relevant examples; unknown AI drafts are not voice evidence.');
  return { preferences: deduped, examples, warnings: [...new Set(warnings)] };
}

/** Mode proposals require at least two independent sources in a useful scope. */
export function proposeModes(preferences, examples) {
  const eligible = preferences.filter((preference) => !['rejected', 'disabled'].includes(preference.status) && ['audience', 'mode', 'recipient'].includes(preference.scope?.type));
  const groups = new Map();
  for (const preference of eligible) {
    const key = `${preference.scope.type}:${preference.scope.value}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(preference);
  }
  const result = [];
  for (const [key, group] of groups) {
    const sourceKeys = new Set(group.flatMap((preference) => preference.sources.map((source) => `${source.conversationId}:${source.messageId}`)));
    const supporting = examples.filter((example) => ['approved', 'user-written'].includes(example.kind) && !['rejected', 'disabled'].includes(example.status) && example.sources.some((source) => group.some((preference) => preference.sources.some((ref) => ref.conversationId === source.conversationId))));
    for (const example of supporting) for (const source of example.sources) sourceKeys.add(`${source.conversationId}:${source.messageId}`);
    if (sourceKeys.size < 2) continue;
    const name = group[0].scope.value;
    const language = supporting.length && supporting.every((example) => example.language === supporting[0].language) ? supporting[0].language : '';
    const channel = supporting.length && supporting.every((example) => example.channel && example.channel === supporting[0].channel) ? supporting[0].channel : '';
    const combined = group.map((preference) => preference.text).join('\n');
    result.push({
      id: `mode-${hash(key)}`, name, description: `Proposed from ${sourceKeys.size} source messages. Use when writing to ${name.toLowerCase()}; review the scope before accepting.`,
      guidance: group.map((preference) => preference.text).join('\n'), language, channel, relationship: name,
      purpose: /cold outreach|kaltakquise/i.test(name) ? 'outreach' : '', formality: /formal correspondence/i.test(name) ? 'formal' : /casual|locker/i.test(combined) ? 'casual' : '',
      sourceIds: [...new Set([...group.map((preference) => preference.id), ...supporting.map((example) => example.id), ...group.flatMap((preference) => preference.sources.map((source) => source.conversationId))])], status: 'proposed',
      sample: language === 'de' ? 'Danke für die Nachricht. Ich würde gern verstehen, welcher nächste Schritt für dich hilfreich wäre.' : 'Thanks for the message. I would like to understand what next step would be useful for you.',
      sampleLabel: 'Generated illustration, not historical evidence',
    });
  }
  return result.slice(0, 8);
}
