import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { deleteResponse, deleteContinuation, appendPartRevision } from '../responseData.js';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const source = file => read(file).replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/^export /gm, '');
const clone = value => JSON.parse(JSON.stringify(value));
const quietConsole = { log() {}, error() {}, warn() {} };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('delete first/middle/last response remaps all dependent caches', () => {
    for (const index of [0, 1, 2]) {
        const sim = { responses: ['A', 'B', 'C'], currentIndex: index,
            continuations: { 0: ['A+'], 1: ['B+'], 2: ['C+'] },
            translations: { 0: 'TA', 1: 'TB', 2: 'TC' },
            partTranslations: { 0: { 0: 'TA' }, 1: { 0: 'TB' }, 2: { 0: 'TC' } } };
        deleteResponse(sim, index);
        sim.responses.forEach((text, n) => {
            assert.equal(sim.continuations[n][0], `${text}+`);
            assert.equal(sim.translations[n], `T${text}`);
            assert.equal(sim.partTranslations[n][0], `T${text}`);
        });
        assert.equal(Object.keys(sim.continuations).length, 2);
    }
});

test('delete continuation shifts sparse translations and invalidates whole-response translation', () => {
    const sim = { continuations: { 0: ['P1', 'P2', 'P3'] }, translations: { 0: 'stale' }, partTranslations: { 0: { 0: 'base', 2: 'T2', 3: 'T3' } } };
    deleteContinuation(sim, 0, 1);
    assert.deepEqual(sim.partTranslations[0], { 0: 'base', 1: 'T2', 2: 'T3' });
    assert.deepEqual(sim.continuations[0], ['P2', 'P3']);
    assert.equal(sim.translations[0], undefined);
});

test('part revision preserves original and independently copies its continuations and translations', () => {
    const sim = { responses: ['base'], continuations: { 0: ['p1', 'p2'] }, partTranslations: { 0: { 0: 'tb', 1: 't1', 2: 't2' } } };
    const original = clone(sim);
    appendPartRevision(sim, 0, 1, 'new p1');
    assert.equal(sim.currentIndex, 1);
    assert.deepEqual(sim.continuations[0], original.continuations[0]);
    assert.deepEqual(sim.partTranslations[0], original.partTranslations[0]);
    assert.deepEqual(sim.continuations[1], ['new p1', 'p2']);
    assert.deepEqual(sim.partTranslations[1], { 0: 'tb', 2: 't2' });
    sim.continuations[1][1] = 'edit again';
    assert.equal(sim.continuations[0][1], 'p2');
});

test('full response preserves whitespace and inserts a boundary only where missing', () => {
    const ctx = vm.createContext({});
    vm.runInContext(source('utils.js'), ctx);
    for (const [base, part, expected] of [['End.', 'Next.', 'End.\n\nNext.'], ['End.\n', 'Next.', 'End.\nNext.'], ['End.', '\nNext.', 'End.\nNext.']]) {
        assert.equal(ctx.getFullResponseText({ responses: [base], continuations: { 0: [part] } }, 0), expected);
    }
});

function generationContext() {
    const bus = new EventEmitter();
    let chatKey = 'A';
    const prompts = new Map();
    const ctx = vm.createContext({
        console: quietConsole, eventSource: bus, event_types: { CHAT_CHANGED: 'chat' },
        getCurrentChatKey: () => chatKey,
        applySimulationPreset: async (_a, _b, fn) => fn(),
        stopGeneration() {}, isGenerating: () => false,
        document: { getElementById: () => null, querySelectorAll: () => [] },
        getContext: () => ({}), chat: [{ mes: 'real message' }],
        setExtensionPrompt: (key, content) => prompts.set(key, content),
        extension_prompt_types: { IN_CHAT: 1, IN_PROMPT: 0 }, extension_prompt_roles: { USER: 1, SYSTEM: 0 },
        normalizeSimPosition: p => p, appendPartRevision,
        generateQuietPrompt: async () => 'result', withPromptIntercept: async (_m, fn) => fn(),
    });
    vm.runInContext(source('constants.js') + source('state.js') + source('generation.js') + '\nglobalThis.state = S;', ctx);
    return { ctx, bus, prompts, change: key => { chatKey = key; bus.emit('chat'); } };
}

test('default injection never touches real chat and clears injected prompts after success/error', async () => {
    const { ctx, prompts } = generationContext();
    const original = clone(ctx.chat);
    ctx.generateQuietPrompt = async () => { assert.deepEqual(clone(ctx.chat), original); return 'ok'; };
    await ctx.runSimGeneration('directive', 'request', 'last_message');
    assert.ok([...prompts.values()].every(text => text === ''));
    ctx.generateQuietPrompt = async () => { throw Error('network'); };
    await assert.rejects(ctx.runSimGeneration('directive', 'request', 'last_message'));
    assert.deepEqual(clone(ctx.chat), original);
    assert.ok([...prompts.values()].every(text => text === ''));
});

test('chat switch, including switch away and back, rejects late output and releases listener', async () => {
    const { ctx, bus, change } = generationContext();
    const pending = deferred();
    const result = ctx.withGenerationPreset('', '', () => pending.promise);
    change('B'); change('A'); pending.resolve('late result');
    await assert.rejects(result);
    assert.equal(ctx.state.simAborted, true);
    assert.equal(bus.listenerCount('chat'), 0);
});

test('chat switch while applying a preset prevents model call and old-preset restoration', async () => {
    const { ctx, change } = generationContext();
    let sent = false;
    let restore;
    ctx.applySimulationPreset = async (_a, _b, fn, shouldRestore) => { change('B'); restore = shouldRestore(); return fn(); };
    await assert.rejects(ctx.withGenerationPreset('', '', () => { sent = true; return 'ok'; }));
    assert.equal(sent, false); assert.equal(restore, false);
});

test('empty/aborted model output cannot be reported as successful', async () => {
    const { ctx } = generationContext();
    for (const text of ['', '   ', undefined]) await assert.rejects(ctx.withGenerationPreset('', '', async () => text));
    await assert.rejects(ctx.withGenerationPreset('', '', async () => { ctx.state.simAborted = true; return 'partial'; }));
});

test('part revision uses generation lock, retains original, and unlocks after completion', async () => {
    const { ctx } = generationContext();
    const handlers = {};
    const overlay = { querySelector: q => ({ addEventListener: (_event, fn) => { handlers[q] = fn; } }), addEventListener() {}, remove() {} };
    ctx.document = { createElement: () => overlay, body: { appendChild() {} }, getElementById: id => id === 'sim-part-revision-feedback' ? { value: 'revise' } : null, querySelectorAll: () => [] };
    const sim = { id: 'test', responses: ['original'], promptText: 'request' };
    Object.assign(ctx, { getSimulations: () => [sim], getEffectivePromptText: s => s.promptText, saveSimulationsVerified: async () => {}, renderDetailView() {}, toastr: { success() {}, error() {}, info() {} } });
    ctx.generateQuietPrompt = async () => { assert.equal(ctx.state.simGenerating, true); return 'revised'; };
    ctx.showPartRevisionDialog(sim, 0, 0);
    await handlers['#sim-part-revision-send']();
    assert.deepEqual(sim.responses, ['original', 'revised']);
    assert.equal(ctx.state.simGenerating, false);
});

function storeContext() {
    const ext = 'SillyTavern-SimulationManager';
    const sims = [{ id: 's', responses: ['result'] }];
    const settings = { [ext]: { globalIndex: {} } };
    let saved = clone(sims);
    const ctx = vm.createContext({ console: quietConsole, TextEncoder, S: {},
        extension_settings: settings, chat_metadata: { [ext]: { simulations: sims } },
        ensureSettings() {}, saveChatDebounced() {}, saveSettingsDebounced() {}, cancelDebouncedChatSave() {}, getRequestHeaders: () => ({}),
        getContext: () => ({ characterId: 0, characters: [{ name: 'A', avatar: 'A.png', chat: 'chat-a' }], saveChat: async () => {} }),
        fetch: async () => ({ ok: true, json: async () => [{ chat_metadata: { [ext]: { simulations: saved } } }] }),
    });
    vm.runInContext(source('constants.js') + source('store.js'), ctx);
    return { ctx, settings, ext, sims, setSaved: value => { saved = value; } };
}

test('save readback catches swallowed core save errors and allows retry', async () => {
    const { ctx, sims, setSaved } = storeContext();
    setSaved([]);
    await assert.rejects(ctx.saveSimulationsVerified());
    assert.equal(ctx.S.unsavedChatKey, 'A_chat-a');
    setSaved(clone(sims));
    await ctx.saveSimulationsVerified();
    assert.equal(ctx.S.unsavedChatKey, null);
});

test('failed fetch is not cached as empty and next load retries', async () => {
    const { ctx, settings, ext, sims } = storeContext();
    settings[ext].globalIndex.B = { avatar: 'B.png', fileName: 'b', count: 1 };
    let calls = 0;
    ctx.fetch = async () => (++calls === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => [{ chat_metadata: { [ext]: { simulations: sims } } }] });
    assert.equal((await ctx.loadSimsForChat('B')).length, 0);
    assert.equal((await ctx.loadSimsForChat('B')).length, 1);
    assert.equal(calls, 2);
});

test('backup rejects an unreadable indexed chat instead of dropping it', async () => {
    const { ctx, settings, ext } = storeContext();
    settings[ext].globalIndex.B = { avatar: 'B.png', fileName: 'b', count: 1 };
    ctx.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(ctx.buildBackupPayload());
});

test('pending new simulation is absent from metadata; chat cancellation saves nothing', async () => {
    const { ctx, change } = generationContext();
    const pending = deferred();
    const rooms = { A: [], B: [] };
    let current = 'A'; let saves = 0;
    Object.assign(ctx, { extension_settings: { 'SillyTavern-SimulationManager': { savedPrompts: [] } }, ensureSettings() {},
        substituteParams: x => x, applySwap: x => x, uuidv4: () => 'new', getSimulations: () => rooms[current],
        saveSimulationsVerified: async () => { saves++; }, toastr: { info() {}, error() {} },
        generateQuietPrompt: () => pending.promise,
    });
    const result = ctx.sendSimulation({ rawPrompt: 'request', noSavePrompt: true, chosenPosition: 'last_message', ui: false, notify: false });
    assert.equal(rooms.A.length, 0);
    current = 'B'; change('B'); pending.resolve('late');
    assert.equal(await result, null);
    assert.equal(saves, 0); assert.equal(rooms.B.length, 0); assert.equal(rooms.A.length, 0);
});

function multiContext() {
    const g = generationContext();
    const { ctx } = g;
    vm.runInContext(source('multiSend.js'), ctx);
    let current = 0;
    const rooms = [[], []];
    const chars = [{ name: 'A', avatar: 'A.png', chat: 'a' }, { name: 'B', avatar: 'B.png', chat: 'b' }];
    const notices = []; const intercepts = [];
    Object.assign(ctx, { getContext: () => ({ characterId: current, characters: chars, chatId: chars[current].chat }),
        getSimulations: () => rooms[current], substituteParams: x => x, applySwap: x => x, uuidv4: () => `s${current}`,
        closePopup() {}, openPopupToSim() {}, showMultiSendPanel() {}, hideMultiSendPanel() {}, updateMultiSendPanel() {},
        switchToTargetChat: async target => { current = target.id; }, sleep: async () => {},
        withPromptIntercept: async (meta, fn) => { intercepts.push(meta.kind); return fn(); },
        saveSimulationsVerified: async () => {}, toastr: Object.fromEntries(['info', 'success', 'error', 'warning'].map(k => [k, text => notices.push([k, text])])),
    });
    return { ...g, rooms, notices, intercepts, current: () => current, targets: chars.map((c, id) => ({ type: 'char', id, name: c.name, avatar: c.avatar, chatId: c.chat })),
        opts: { noSavePrompt: true, rawPrompt: 'request', chosenPosition: 'last_message' } };
}

test('multi-send applies intercept to every request and reports only verified saves', async () => {
    const { ctx, targets, opts, rooms, intercepts, notices } = multiContext();
    await ctx.handleMultiSendSimulation(targets, opts);
    assert.equal(intercepts.length, 2);
    assert.deepEqual(rooms.map(r => r.length), [1, 1]);
    assert.equal(notices.at(-1)[0], 'success');
    assert.equal(ctx.state.multiSendRunning, false);
});

test('multi-send save failure stops before next chat and keeps result available', async () => {
    const { ctx, targets, opts, rooms, current, notices } = multiContext();
    ctx.saveSimulationsVerified = async () => { throw Error('disk failure'); };
    await ctx.handleMultiSendSimulation(targets, opts);
    assert.deepEqual(rooms.map(r => r.length), [1, 0]);
    assert.equal(current(), 0); assert.equal(notices.at(-1)[0], 'error');
    assert.equal(ctx.state.multiSendRunning, false);
});

test('multi-send cancelled partial response is never counted as success', async () => {
    const { ctx, targets, opts, rooms, notices } = multiContext();
    ctx.generateQuietPrompt = async () => { ctx.state.simAborted = true; return 'partial'; };
    await ctx.handleMultiSendSimulation(targets, opts);
    assert.deepEqual(rooms.map(r => r.length), [0, 0]);
    assert.equal(notices.at(-1)[0], 'info');
    assert.equal(ctx.state.simGenerating, false);
});

test('draft restores text and options on revisiting create view, independently per chat', () => {
    const elements = new Map();
    const element = () => ({ value: '', checked: false, style: {}, dataset: {}, listeners: {}, classList: { add() {}, remove() {} },
        addEventListener(name, fn) { this.listeners[name] = fn; }, querySelector() { return element(); }, querySelectorAll() { return []; } });
    const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const form = element(); get('sim-content').querySelector = () => form;
    let chatKey = 'A';
    const ctx = vm.createContext({ document: { getElementById: get }, extension_settings: { 'SillyTavern-SimulationManager': { savedPrompts: [] } },
        ensureSettings() {}, escapeHtml: s => s, maybeResetContentScroll() {}, getCurrentChatKey: () => chatKey,
        getCurrentPresetName: () => '', getAvailablePresetNames: () => [], isCustomPresetTogglesEnabled: () => false,
        getDefaultInjectPosition: () => 'last_message', getTogglePresetNames: () => [], getCurrentActiveTogglePresetName: () => '',
        goToList() {}, handleSendSimulation() {}, setupMultiSendDrawer() {}, saveSettingsDebounced() {}, PROMPT_SORT_ORDERS: ['newest'],
    });
    vm.runInContext(source('constants.js') + source('state.js') + source('views/list.js') + '\nglobalThis.state = S;', ctx);
    ctx.renderCreateView();
    get('sim-prompt-input').value = 'keep this draft'; get('sim-swap-charuser').checked = true;
    form.listeners.input();
    get('sim-prompt-input').value = ''; get('sim-swap-charuser').checked = false;
    ctx.renderCreateView();
    assert.equal(get('sim-prompt-input').value, 'keep this draft'); assert.equal(get('sim-swap-charuser').checked, true);
    chatKey = 'B'; get('sim-prompt-input').value = 'other draft'; form.listeners = {};
    ctx.renderCreateView(); form.listeners.input();
    assert.equal(ctx.state.createDrafts.A.rawPrompt, 'keep this draft');
    assert.equal(ctx.state.createDrafts.B.rawPrompt, 'other draft');
});

test('incomplete backup scan never triggers a download', async () => {
    const { ctx } = storeContext();
    let downloads = 0;
    ctx.scanAllChatsForSimulations = async () => ({ total: 1, complete: false });
    ctx.document = { createElement: () => { downloads++; } };
    ctx.toastr = { error() {} };
    assert.equal(await ctx.exportSimBackup(), -1);
    assert.equal(downloads, 0);
});

test('generation buttons preserve disabled state across refresh and unlock', () => {
    const { ctx } = generationContext();
    const make = (id, disabled) => ({ id, disabled, dataset: {}, classList: { add() {}, remove() {} } });
    const nodes = [make('sim-close', false), make('sim-prev-response', true), make('sim-edit', false), make('sim-regenerate', false)];
    ctx.document = { getElementById: id => id === 'sim-manager-popup' ? { querySelectorAll: () => nodes } : nodes.find(n => n.id === id),
        querySelectorAll: () => nodes.filter(n => n.dataset.simDisabledWas !== undefined) };
    ctx.enterSimGeneratingMode('sim-regenerate'); ctx.refreshSimGeneratingButtons();
    assert.equal(nodes[2].disabled, true); assert.equal(nodes[3].disabled, false);
    ctx.exitSimGeneratingMode();
    assert.equal(nodes[1].disabled, true); assert.equal(nodes[2].disabled, false); assert.equal(nodes[3].disabled, false);
});

test('late translation cannot modify another chat or save stale part text', async () => {
    for (const changed of ['chat', 'text']) {
        const pending = deferred();
        const sim = { id: 's', responses: ['original'] };
        let key = 'A'; let saves = 0;
        const ctx = vm.createContext({ console: quietConsole, S: { currentView: 'detail', currentSimId: 's' },
            extension_settings: { 'SillyTavern-SimulationManager': { translationProfileId: 'fake' } }, ensureSettings() {},
            getCurrentChatKey: () => key, getSimulations: () => [sim], saveSimulationsVerified: async () => { saves++; },
            getContext: () => ({ ConnectionManagerRequestService: { sendRequest: () => pending.promise } }),
            toastr: { success() {}, error() {}, warning() {} },
        });
        vm.runInContext(source('constants.js') + source('translate.js'), ctx);
        const result = ctx.translatePart(sim, 0, 0, () => {});
        if (changed === 'chat') key = 'B'; else sim.responses[0] = 'edited';
        pending.resolve('translation'); await result;
        assert.equal(saves, 0); assert.equal(sim.partTranslations[0][0], undefined); assert.equal(ctx.S.isTranslating, false);
    }
});
