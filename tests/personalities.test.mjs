import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../server/storage.mjs';
import {normalizeImport} from '../server/evidence.mjs';
import {PersonalitiesService, PERSONALITY_ANALYSIS_SYSTEM, PERSONALITY_SYNTHESIS_SYSTEM, PERSONALITY_LIMITS} from '../server/personalities.mjs';
import {ModelRequestError, safeModelError} from '../server/providers.mjs';

const model = {provider: 'openai', modelId: 'synthetic-analysis-model'};
const message = (id, text, extra = {}) => ({id, text, role: 'user', kind: 'sent', date: '2026-10-15', ...extra});
const conversation = (id, messages, extra = {}) => ({id, title: 'Synthetic source without drafting keywords', source: 'gmail', messages, ...extra});
const refsOf = payload => payload.conversations.flatMap(source => source.messages.map(item => ({conversationId: source.id, messageId: item.id, excerpt: item.text.slice(0, 100)})));
const baseDetails = {whenToUse: 'Use for thoughtful collaboration with peers.', boundaries: 'Do not assume this fits formal first contact.', tone: 'Plain, warm and thoughtful.', warmth: 'Acknowledge useful contributions.', directness: 'Ask clearly without burying the request.', detailAndStructure: 'Keep the reason behind each request and use readable paragraphs.', languageGuidance: 'English evidence is available; German conventions remain unestablished.', openingsAndClosings: 'Use an acknowledgment appropriate to the exchange.', vocabulary: 'Prefer familiar concrete words.', do: 'Keep useful explanation and context.', avoid: 'Avoid adding commitments that were not requested.', uncertainty: 'Sent messages have not been approved as ideal examples.'};
function fixture(t, input = [conversation('a', [message('a1', 'Thanks for sending this. The explanation helps me understand the choices.'), message('a2', 'Could you keep the tradeoffs visible? That context makes the next step clearer.')])]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'larp-personalities-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = new Store(dir);
  store.mutate(state => {state.sources = normalizeImport(input).conversations;});
  return store;
}
function observation(sources, extra = {}) {return {key: 'Thoughtful collaboration', summary: 'Acknowledge useful work and retain an explanation for the request.', usage: 'Collaborative follow-ups with useful context.', sources, conflictingEvidence: [], ...extra};}
function personality(sources, extra = {}) {return {name: 'Thoughtful collaboration', description: 'When asking peers to improve something with context.', details: {...baseDetails}, channel: 'email', language: 'en', sources, conflictingEvidence: [], ...extra};}
function responder(system, payload) {
  if (system === PERSONALITY_ANALYSIS_SYSTEM) return {observations: [observation([...(payload.previousObservations[0]?.sources || []), ...refsOf(payload)].slice(-6))], warnings: []};
  assert.equal(system, PERSONALITY_SYNTHESIS_SYSTEM);
  return {personalities: payload.observations.length ? [personality(payload.observations[0].sources)] : [], warnings: []};
}
async function run(service, options = model) {
  let job = service.create(options);
  for (let count = 0; job.status === 'ready' && count < 1000; count++) job = await service.act(job.id);
  return job;
}
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

test('preview includes every imported source, not only onboarding or keyword candidates, and discloses compression', t => {
  const store = fixture(t, Array.from({length: 8}, (_, i) => conversation(`source-${i}`, [message(`m${i}`, `Synthetic prose ${i}.`)])));
  let calls = 0;
  const service = new PersonalitiesService(store, {complete: async () => {calls++;}});
  const first = service.preview();
  assert.equal(first.counts.sources, 8); assert.equal(first.counts.messages, 8); assert.equal(first.batchCount, 2); assert.equal(calls, 0);
  const seen = new Set([...first.payload.conversations, ...service.preview(1).payload.conversations].map(item => item.id));
  assert.equal(seen.size, 8);
  assert.match(first.warnings.join(' '), /lossy/);
  assert.match(first.synthesisDisclosures.join(' '), /not sent or overwritten/);
  assert.match(first.systems.analysis, /untrusted data/);
  assert.throws(() => service.preview(2), error => error.status === 400);
});

test('all sources over the former 200-source limit are analyzed before a single global synthesis', async t => {
  const store = fixture(t, Array.from({length: 205}, (_, i) => conversation(`s${String(i).padStart(3, '0')}`, [message(`m${i}`, `Thanks for explaining the context in synthetic message ${i}.`)])));
  const seen = new Set(), selectedModels = []; let synthesis = 0;
  const service = new PersonalitiesService(store, {complete: async (system, payload, chosen) => {
    selectedModels.push(chosen);
    if (system === PERSONALITY_ANALYSIS_SYSTEM) {for (const source of payload.conversations) seen.add(source.id); assert.equal(store.readProfile().profile.modes.length, 0);}
    else {synthesis++; assert.equal(seen.size, 205); assert.equal(payload.coverage.processedMessages, 205); assert.deepEqual(payload.targetPersonalities, {min: 3, max: 5});}
    return responder(system, payload);
  }});
  const result = await run(service);
  assert.equal(result.status, 'complete'); assert.equal(result.totalSources, 205); assert.equal(result.processedBatches, 52); assert.equal(synthesis, 1);
  assert.ok(selectedModels.every(value => value.provider === model.provider && value.modelId === model.modelId));
  assert.equal(store.readProfile().profile.modes[0].baseline.sourceIds.length, 205);
  assert.ok(store.readState().personalityJobs.every(job => !('observations' in job) && !('queue' in job)));
});

test('detailed baseline stays proposed, preserves evidence, records all-source provenance and never invents samples', async t => {
  const store = fixture(t);
  const service = new PersonalitiesService(store, {complete: async (system, payload) => {
    const output = responder(system, payload);
    if (system === PERSONALITY_SYNTHESIS_SYSTEM) output.personalities[0] = {...output.personalities[0], status: 'accepted', basis: 'explicit', sample: 'A fabricated historical message.'};
    return output;
  }});
  const result = await run(service), record = store.readProfile().profile.modes[0];
  assert.equal(result.status, 'complete'); assert.equal(result.phase, 'complete'); assert.equal(result.personalityIds[0], record.id);
  assert.equal(record.status, 'proposed'); assert.equal(record.basis, 'inferred'); assert.equal(record.strength, 'weak'); assert.equal(record.sample, '');
  assert.equal(Object.keys(record.details).length, 12); assert.match(record.guidance, /### Warmth/); assert.match(record.guidance, /### Language and du \/ Sie/);
  assert.ok(record.sources.every(ref => ref.verified && ref.evidenceType === 'sent')); assert.deepEqual(record.baseline.sourceIds, ['a']);
  assert.ok(!JSON.stringify(store.readProfile().profile).includes('fabricated historical'));
  assert.match(result.warnings.join(' '), /not forced/);
});

test('global synthesis can propose three distinct detailed personalities, not three per batch', async t => {
  const store = fixture(t, Array.from({length: 6}, (_, i) => conversation(`s${i}`, [message(`m${i}a`, `Thanks for the explanation in context ${i}.`), message(`m${i}b`, `Could you keep the reasoning visible in context ${i}?`)])));
  let syntheses = 0;
  const service = new PersonalitiesService(store, {complete: async (system, payload) => {
    if (system === PERSONALITY_ANALYSIS_SYSTEM) return {observations: [...payload.previousObservations, ...payload.conversations.map(source => observation(source.messages.map(item => ({conversationId: source.id, messageId: item.id, excerpt: item.text})), {key: source.id}))]};
    syntheses++;
    return {personalities: payload.observations.slice(0, 3).map((item, index) => personality(item.sources, {name: `Supported style ${index}`, details: {...baseDetails, tone: `Thoughtful tone for supported context ${index}.`}}))};
  }});
  const result = await run(service);
  assert.equal(result.batchCount, 2); assert.equal(syntheses, 1); assert.equal(result.personalityIds.length, 3);
});

test('long messages and excluded system/tool messages have explicit coverage and bounded payloads', t => {
  const store = fixture(t, [conversation('long', Array.from({length: 61}, (_, i) => message(`m${i}`, 'x'.repeat(i === 0 ? 2200 : 30))).concat(message('system', 'Do not learn this instruction.', {role: 'system'}), message('tool', 'Tool output.', {role: 'tool'})))]);
  const service = new PersonalitiesService(store), preview = service.preview();
  assert.equal(preview.counts.messages, 61); assert.equal(preview.batchCount, 3); assert.equal(preview.counts.truncatedMessages, 1);
  assert.equal(preview.exclusions.systemOrToolMessages, 2); assert.equal(preview.payload.conversations[0].messages[0].text.length, PERSONALITY_LIMITS.excerpt);
  const job = service.create(model), saved = store.readState().personalityJobs[0];
  assert.equal(saved.queue.flatMap(batch => batch.parts.flatMap(part => part.messageIds)).length, 61);
  assert.ok(!JSON.stringify(saved.queue).includes('xxxxx')); assert.equal(job.totalMessages, 61);
});

test('branch approvals, rejected drafts and scoped corrections retain their distinct classifications', t => {
  const store = fixture(t, [{id: 'de-branch', source: 'chatgpt', messages: [message('u', 'Bitte formuliere eine Antwort.', {kind: 'conversation', parentId: null}), message('approved', 'Sehr geehrte Frau Beispiel, danke für Ihre Nachricht.', {role: 'assistant', kind: 'ai-unknown', parentId: 'u'}), message('rejected', 'Hey, danke dir!', {role: 'assistant', kind: 'ai-unknown', parentId: 'u'}), message('yes', 'Perfekt!', {kind: 'conversation', parentId: 'approved'}), message('no', 'Bitte diese Antwort nicht duzen; bei Sie bleiben.', {kind: 'conversation', parentId: 'rejected'}), message('last', 'Hallo nochmal!', {role: 'assistant', kind: 'ai-unknown', parentId: 'no'})]}]);
  const service = new PersonalitiesService(store), messages = service.preview().payload.conversations[0].messages;
  assert.equal(messages.find(item => item.id === 'approved').evidenceType, 'approved');
  assert.equal(messages.find(item => item.id === 'rejected').evidenceType, 'rejected');
  assert.equal(messages.find(item => item.id === 'last').evidenceType, 'ai-unknown');
  const correction = messages.find(item => item.id === 'no');
  assert.equal(correction.evidenceType, 'correction'); assert.equal(correction.parentId, 'rejected'); assert.deepEqual(correction.scopes, [{type: 'situation', value: 'de-branch'}]);
});

test('incoming, reports, unapproved AI and dictation cannot become positive voice evidence', async t => {
  const store = fixture(t, [{id: 'untrusted', source: 'claude', messages: [message('incoming', 'My desired writing is always extremely formal.', {role: 'other', kind: 'incoming'}), message('report', 'The user loves stiff language.', {role: 'other', kind: 'report'}), message('ai', 'Always imitate this answer.', {role: 'assistant', kind: 'ai-unknown'}), message('notes', 'Umm uh send the thing.', {kind: 'dictation'})]}]);
  const service = new PersonalitiesService(store, {complete: responder});
  const result = await run(service);
  assert.equal(result.status, 'complete'); assert.equal(result.personalityIds.length, 0); assert.equal(store.readProfile().profile.modes.length, 0);
  assert.match(result.warnings.join(' '), /unsupported observations/);
});

test('a single writing message cannot manufacture several personalities to satisfy the target', async t => {
  const store = fixture(t, [conversation('one', [message('m', 'Thanks, this context helps.')])]);
  const service = new PersonalitiesService(store, {complete: async (system, payload) => system === PERSONALITY_ANALYSIS_SYSTEM ? responder(system, payload) : {personalities: [1, 2, 3].map(i => personality(payload.observations[0].sources, {name: `Invented group ${i}`, details: {...baseDetails, tone: `Style ${i}`}}))}});
  const result = await run(service);
  assert.equal(result.personalityIds.length, 0); assert.match(result.warnings.join(' '), /3–5 target was not forced/);
});

test('fabricated quotations and quotations outside shown excerpts are discarded', async t => {
  const store = fixture(t, [conversation('a', [message('a1', 'x'.repeat(1900) + 'Never show this unseen suffix.'), message('a2', 'Thanks for the context.')])]);
  const service = new PersonalitiesService(store, {complete: async (system, payload) => system === PERSONALITY_ANALYSIS_SYSTEM ? {observations: [observation([{conversationId: 'a', messageId: 'a1', excerpt: 'Never show this unseen suffix.'}, {conversationId: 'a', messageId: 'a2', excerpt: 'An invented quotation.'}])]} : {personalities: []}});
  const result = await run(service); assert.equal(result.personalityIds.length, 0); assert.match(result.warnings.join(' '), /unsupported observations/);
});

test('synthesis may cite only verified excerpts carried into its actual payload', async t => {
  const store = fixture(t);
  const service = new PersonalitiesService(store, {complete: async (system, payload) => {
    if (system === PERSONALITY_ANALYSIS_SYSTEM) return {observations: [observation(refsOf(payload).map(ref => ({...ref, excerpt: ref.excerpt.slice(0, 12)})))]};
    return {personalities: [personality([{conversationId: 'a', messageId: 'a1', excerpt: 'The explanation helps me understand the choices.'}, {conversationId: 'a', messageId: 'a2', excerpt: 'That context makes the next step clearer.'}])]};
  }});
  assert.equal((await run(service)).personalityIds.length, 0);
});

test('conflicts are kept as verified references rather than resolving away contrary evidence', async t => {
  const store = fixture(t);
  const service = new PersonalitiesService(store, {complete: async (system, payload) => {
    if (system === PERSONALITY_ANALYSIS_SYSTEM) return {observations: [observation(refsOf(payload), {conflictingEvidence: [refsOf(payload)[1]], uncertainty: 'Context may change the desired level of detail.'})]};
    return {personalities: [personality(payload.observations[0].sources, {conflictingEvidence: payload.observations[0].conflictingEvidence})]};
  }});
  await run(service); assert.equal(store.readProfile().profile.modes[0].conflictingEvidence[0].messageId, 'a2');
});

test('reusable personality guidance cannot retain historical contact details, dates or prices', async t => {
  const store = fixture(t);
  const service = new PersonalitiesService(store, {complete: async (system, payload) => {
    if (system === PERSONALITY_ANALYSIS_SYSTEM) return responder(system, payload);
    return {personalities: [personality(payload.observations[0].sources, {details: {...baseDetails, do: 'Always offer €500 and email synthetic@example.test on 2026-11-01.'}})]};
  }});
  assert.equal((await run(service)).personalityIds.length, 0); assert.equal(store.readProfile().profile.modes.length, 0);
});

test('existing accepted, edited, rejected, disabled and proposed personalities are never overwritten', async t => {
  const store = fixture(t), current = store.readProfile();
  current.profile.modes = ['accepted', 'edited', 'rejected', 'disabled', 'proposed'].map((status, i) => ({id: `existing-${i}`, name: `Existing ${status}`, guidance: `User-owned wording ${i}`, status}));
  current.profile.preferences.push({id: 'hard', text: 'Never use em dashes.', scope: {type: 'global', value: ''}, status: 'accepted', category: 'hard', banned: ['—']});
  store.saveProfile(current.profile, current.version); const before = store.readProfile().profile;
  const service = new PersonalitiesService(store, {complete: async (system, payload) => system === PERSONALITY_ANALYSIS_SYSTEM ? responder(system, payload) : {personalities: before.modes.map(item => personality(payload.observations[0].sources, {name: item.name}))}});
  const result = await run(service); assert.deepEqual(store.readProfile().profile, before); assert.equal(result.personalityIds.length, 0); assert.match(result.warnings.join(' '), /preserved without modification/);
});

test('incomplete requests reuse their job; completed baseline can be recreated after undo', async t => {
  const store = fixture(t); let calls = 0;
  const service = new PersonalitiesService(store, {complete: async (...args) => {calls++; return responder(...args);}});
  const initial = service.create(model), duplicate = service.create(model);
  assert.equal(initial.id, duplicate.id); assert.equal(calls, 0);
  const first = await run(service);
  store.undo(); assert.equal(store.readProfile().profile.modes.length, 0);
  const recreated = await run(service);
  assert.notEqual(first.id, recreated.id); assert.equal(calls, 4); assert.equal(recreated.personalityIds.length, 1);
  const different = service.create({provider: 'openai', modelId: 'another-model'}); assert.notEqual(different.id, first.id);
});

test('cancel during a request discards output and resume retries the unsaved batch', async t => {
  const store = fixture(t), wait = deferred(); let calls = 0;
  const service = new PersonalitiesService(store, {complete: async (...args) => {if (++calls === 1) await wait.promise; return responder(...args);}});
  const created = service.create(model), pending = service.act(created.id);
  assert.equal((await service.act(created.id, 'cancel')).status, 'cancelled'); wait.resolve();
  assert.equal((await pending).status, 'cancelled'); assert.equal(service.list()[0].processedBatches, 0);
  await service.act(created.id, 'resume'); assert.equal((await service.act(created.id)).phase, 'synthesize'); assert.equal((await service.act(created.id)).status, 'complete');
  assert.equal(calls, 3);
});

test('profile edits while a request runs produce a conflict, then resume binds the reviewed profile', async t => {
  const store = fixture(t), wait = deferred(); let first = true;
  const service = new PersonalitiesService(store, {complete: async (...args) => {if (first) {first = false; await wait.promise;} return responder(...args);}});
  const created = service.create(model), pending = service.act(created.id), current = store.readProfile();
  current.profile.preferences.push({id: 'manual', text: 'Keep useful explanations.', scope: {type: 'global', value: ''}, status: 'accepted'}); store.saveProfile(current.profile, current.version);
  wait.resolve(); assert.equal((await pending).status, 'conflict'); assert.equal(service.list()[0].processedBatches, 0);
  await service.act(created.id, 'resume'); await service.act(created.id); assert.equal((await service.act(created.id)).status, 'complete');
  assert.equal(store.readProfile().profile.preferences[0].status, 'accepted');
});

test('new or modified sources make a whole-archive analysis stale before another model call', async t => {
  const store = fixture(t); let calls = 0;
  const service = new PersonalitiesService(store, {complete: async (...args) => {calls++; return responder(...args);}}), created = service.create(model);
  await service.act(created.id);
  store.mutate(state => {state.sources.push(...normalizeImport([conversation('new', [message('new1', 'Additional source.')])]).conversations);});
  const result = await service.act(created.id); assert.equal(result.status, 'stale'); assert.equal(calls, 1); assert.equal(store.readProfile().profile.modes.length, 0);
  assert.equal((await service.act(created.id, 'resume')).status, 'stale'); assert.notEqual(service.create(model).id, created.id);
});

test('deleting a source and its persisted job during a request returns a safe stale result', async t => {
  const store = fixture(t), wait = deferred();
  const service = new PersonalitiesService(store, {complete: async (...args) => {await wait.promise; return responder(...args);}}), created = service.create(model), pending = service.act(created.id);
  store.mutate(state => {state.sources = []; state.personalityJobs = [];}); wait.resolve();
  const result = await pending; assert.equal(result.status, 'stale'); assert.match(result.error, /source was deleted/); assert.equal(store.readProfile().profile.modes.length, 0);
});

test('profile edits during synthesis discard all personalities instead of partly committing', async t => {
  const store = fixture(t), wait = deferred();
  const service = new PersonalitiesService(store, {complete: async (system, payload) => {if (system === PERSONALITY_SYNTHESIS_SYSTEM) await wait.promise; return responder(system, payload);}}), created = service.create(model);
  await service.act(created.id); const pending = service.act(created.id), current = store.readProfile();
  current.profile.modes.push({id: 'manual', name: 'User-created personality', guidance: 'Keep this.', status: 'edited'}); store.saveProfile(current.profile, current.version); wait.resolve();
  assert.equal((await pending).status, 'conflict'); assert.equal(store.readProfile().profile.modes.length, 1);
});

test('process restart recovers running work and keeps previously saved analysis progress', async t => {
  const store = fixture(t), service = new PersonalitiesService(store, {complete: responder}), created = service.create(model);
  await service.act(created.id);
  store.mutate(state => {state.personalityJobs[0].status = 'running'; state.personalityJobs[0].runId = 'interrupted';});
  const restarted = new PersonalitiesService(store, {complete: responder});
  assert.equal(restarted.list()[0].status, 'ready'); assert.equal(restarted.list()[0].phase, 'synthesize'); assert.equal(restarted.list()[0].processedBatches, 1);
  assert.equal((await restarted.act(created.id)).status, 'complete');
});

test('provider errors and malformed unbounded output expose no raw error or partial profile', async t => {
  const store = fixture(t), service = new PersonalitiesService(store, {complete: async () => {throw Error('secret-token and private source text');}}), created = service.create(model);
  const failed = await service.act(created.id); assert.equal(failed.status, 'error'); assert.ok(!JSON.stringify(failed).includes('secret-token')); assert.equal(failed.processedBatches, 0);
  await service.act(created.id, 'resume'); service.complete = async () => ({observations: Array.from({length: 11}, () => observation([]))});
  assert.equal((await service.act(created.id)).status, 'error'); assert.equal(store.readProfile().profile.modes.length, 0);
});

test('empty new observations do not erase earlier verified patterns', async t => {
  const store = fixture(t, Array.from({length: 5}, (_, i) => conversation(`s${i}`, [message(`m${i}`, `Thanks for the context ${i}.`)]))); let batch = 0;
  const service = new PersonalitiesService(store, {complete: async (system, payload) => {
    if (system === PERSONALITY_ANALYSIS_SYSTEM && ++batch === 2) return {observations: []};
    return responder(system, payload);
  }});
  const result = await run(service); assert.equal(result.personalityIds.length, 1); assert.match(result.warnings.join(' '), /Earlier verified observations were retained/);
});

test('missing detail dimensions are explicitly unknown rather than invented', async t => {
  const store = fixture(t), service = new PersonalitiesService(store, {complete: async (system, payload) => system === PERSONALITY_ANALYSIS_SYSTEM ? responder(system, payload) : {personalities: [personality(payload.observations[0].sources, {details: {whenToUse: 'Collaboration.', tone: 'Warm.', warmth: 'Acknowledge useful work.', detailAndStructure: 'Keep the explanation.'}})]}});
  await run(service); assert.match(store.readProfile().profile.modes[0].details.languageGuidance, /Not established/);
});

test('model settings are explicit and no credentials or arbitrary caller fields enter job state', t => {
  const store = fixture(t), service = new PersonalitiesService(store);
  assert.throws(() => service.create({provider: 'fake', modelId: 'fake'}), error => error.status === 400);
  assert.throws(() => service.create({provider: 'openai'}), error => error.status === 400);
  service.create({...model, apiKey: 'must-never-persist'});
  assert.ok(!JSON.stringify(store.readState()).includes('must-never-persist'));
});


test('safe provider diagnostics explain the failed step without retaining raw provider data', async t => {
  const store = fixture(t), error = new ModelRequestError('http', {provider: 'openai', httpStatus: 429, providerCode: 'rate_limit_exceeded', requestId: 'req_synthetic1234', message: 'private-input-and-key'});
  const service = new PersonalitiesService(store, {complete: async () => {throw error;}}), created = service.create(model);
  const result = await service.act(created.id);
  assert.equal(result.status, 'error'); assert.ok(result.error.includes(safeModelError(error)));
  assert.equal(result.errorDetails.httpStatus, 429); assert.equal(result.errorDetails.providerCode, 'rate_limit_exceeded');
  assert.ok(!JSON.stringify(store.readState()).includes('private-input-and-key'));
  const resumed = await service.act(created.id, 'resume');
  assert.equal(resumed.error, null); assert.equal(resumed.errorDetails, null);
});

test('local model-output validation failures retain their specific, trusted explanation', async t => {
  const store = fixture(t), service = new PersonalitiesService(store, {complete: async () => ({observations: Array.from({length: 11}, () => observation([]))})}), created = service.create(model);
  const result = await service.act(created.id);
  assert.match(result.error, /did not return bounded observations/); assert.equal(result.errorDetails, null);
  await service.act(created.id, 'resume');
  service.complete = async (system, payload) => ({observations: [observation(Array.from({length: 7}, () => refsOf(payload)[0]))]});
  const citations = await service.act(created.id);
  assert.match(citations.error, /exceeded the citation limit/); assert.equal(citations.processedBatches, 0);
  assert.equal(store.readProfile().profile.modes.length, 0);
});

test('selected effort reaches analysis and synthesis and is retained with the resulting baseline', async t => {
  const store = fixture(t), chosen = [];
  const service = new PersonalitiesService(store, {complete: async (system, payload, selection) => {chosen.push(selection); return responder(system, payload);}});
  const result = await run(service, {provider: 'openai', modelId: 'gpt-6-astra', effort: 'low'});
  assert.equal(result.status, 'complete'); assert.equal(result.effort, 'low');
  assert.deepEqual(chosen.map(item => item.effort), ['low', 'low']);
  const baseline = store.readProfile().profile.modes[0].baseline;
  assert.equal(baseline.effort, 'low'); assert.deepEqual(baseline.effortHistory.map(item => item.phase), ['analyze', 'synthesize']);
  assert.ok(baseline.effortHistory.every(item => item.effort === 'low'));
});

test('effort is part of job identity and legacy jobs retain provider default', t => {
  const store = fixture(t), service = new PersonalitiesService(store);
  const initial = service.create({provider: 'openai', modelId: 'gpt-6-astra', effort: 'low'});
  assert.equal(service.create({provider: 'openai', modelId: 'gpt-6-astra', effort: 'low'}).id, initial.id);
  const high = service.create({provider: 'openai', modelId: 'gpt-6-astra', effort: 'high'});
  assert.notEqual(high.id, initial.id);
  store.mutate(state => {delete state.personalityJobs[0].effort;});
  assert.equal(service.list()[0].effort, 'default');
  assert.equal(service.create({provider: 'openai', modelId: 'gpt-6-astra'}).id, initial.id);
});

test('resume can change effort without losing completed evidence and records each step accurately', async t => {
  const store = fixture(t), chosen = []; let failSynthesis = true;
  const service = new PersonalitiesService(store, {complete: async (system, payload, selection) => {
    chosen.push(selection.effort);
    if (system === PERSONALITY_SYNTHESIS_SYSTEM && failSynthesis) {failSynthesis = false; throw new ModelRequestError('output_limit', {provider: 'openai'});}
    return responder(system, payload);
  }});
  const created = service.create({provider: 'openai', modelId: 'gpt-6-astra', effort: 'high'});
  await service.act(created.id); const failed = await service.act(created.id);
  assert.equal(failed.status, 'error'); assert.equal(failed.processedBatches, 1); assert.equal(failed.effortHistory.length, 1);
  const observations = structuredClone(store.readState().personalityJobs[0].observations);
  const resumed = await service.act(created.id, 'resume', {effort: 'low'});
  assert.equal(resumed.effort, 'low'); assert.equal(resumed.processedBatches, 1);
  assert.deepEqual(store.readState().personalityJobs[0].observations, observations);
  const completed = await service.act(created.id);
  assert.equal(completed.status, 'complete'); assert.deepEqual(chosen, ['high', 'high', 'low']);
  assert.deepEqual(completed.effortHistory.map(item => item.effort), ['high', 'low']);
  assert.deepEqual(store.readProfile().profile.modes[0].baseline.effortHistory.map(item => item.effort), ['high', 'low']);
});

test('invalid effort and attempts to change effort through step leave jobs untouched', async t => {
  const store = fixture(t), service = new PersonalitiesService(store, {complete: responder}), initial = store.readState();
  assert.throws(() => service.create({provider: 'openai', modelId: 'gpt-6-astra', effort: 'invalid'}));
  assert.deepEqual(store.readState(), initial);
  const created = service.create({provider: 'openai', modelId: 'gpt-6-astra', effort: 'low'}), before = store.readState();
  await assert.rejects(service.act(created.id, 'resume', {effort: 'invalid'}));
  await assert.rejects(service.act(created.id, 'step', {effort: 'high'}), /when resuming/);
  await assert.rejects(service.act(created.id, 'cancel', {effort: 'high'}), /when resuming/);
  assert.deepEqual(store.readState(), before);
});

test('effort cannot be changed while a model request is running or after completion', async t => {
  const store = fixture(t), wait = deferred(); let calls = 0;
  const service = new PersonalitiesService(store, {complete: async (...args) => {if (++calls === 1) await wait.promise; return responder(...args);}});
  const created = service.create({provider: 'openai', modelId: 'gpt-6-astra', effort: 'low'}), pending = service.act(created.id), running = store.readState();
  await assert.rejects(service.act(created.id, 'resume', {effort: 'high'}), error => error.status === 409);
  assert.deepEqual(store.readState(), running); wait.resolve(); await pending; await service.act(created.id);
  const completed = store.readState();
  await assert.rejects(service.act(created.id, 'resume', {effort: 'high'}), error => error.status === 409);
  assert.deepEqual(store.readState(), completed);
});

test('resuming legacy completed batches records provider default before a new explicit effort', async t => {
  const store = fixture(t), service = new PersonalitiesService(store, {complete: responder});
  const created = service.create({provider: 'openai', modelId: 'gpt-6-astra'}); await service.act(created.id);
  store.mutate(state => {const job = state.personalityJobs[0]; delete job.effort; delete job.effortHistory; job.status = 'error';});
  await service.act(created.id, 'resume', {effort: 'low'}); await service.act(created.id);
  const history = store.readProfile().profile.modes[0].baseline.effortHistory;
  assert.deepEqual(history.map(item => item.effort), ['default', 'low']); assert.equal(history[0].completedAt, null);
});
