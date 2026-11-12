/** Preserve indexed storage, including legacy translation caches. */
function removeIndexed(map, index) {
    const next = {};
    for (const [key, value] of Object.entries(map)) {
        const n = Number(key);
        if (n === index) continue;
        next[Number.isInteger(n) && n > index ? String(n - 1) : key] = value;
    }
    return next;
}

export function deleteResponse(sim, index) {
    if (!Number.isInteger(index) || index < 0 || index >= sim.responses.length) return;
    sim.responses.splice(index, 1);
    for (const field of ['continuations', 'continuationDirections', 'partVariants', 'responseAnchors', 'translations', 'partTranslations']) {
        if (sim[field]) sim[field] = removeIndexed(sim[field], index);
    }
    sim.currentIndex = Math.max(0, Math.min(index, sim.responses.length - 1));
}

export function deleteContinuation(sim, responseIndex, partIndex) {
    const key = String(responseIndex);
    const parts = sim.continuations?.[key];
    if (!Number.isInteger(partIndex) || partIndex < 1 || !parts || partIndex > parts.length) return;
    const directions = getContinuationDirections(sim, responseIndex);
    const variants = getPartVariants(sim, responseIndex);
    parts.splice(partIndex - 1, 1);
    directions.splice(partIndex - 1, 1);
    variants.splice(partIndex - 1, 1);
    setContinuationDirections(sim, responseIndex, directions);
    setPartVariants(sim, responseIndex, variants);
    if (sim.partTranslations?.[key]) sim.partTranslations[key] = removeIndexed(sim.partTranslations[key], partIndex);
    if (sim.translations) delete sim.translations[key];
}

/** Use the existing response navigator for revisions; leave the original untouched. */
export function appendPartRevision(sim, responseIndex, partIndex, text) {
    const oldKey = String(responseIndex);
    const parts = [...(sim.continuations?.[oldKey] || [])];
    const directions = getContinuationDirections(sim, responseIndex);
    const variants = JSON.parse(JSON.stringify(getPartVariants(sim, responseIndex)));
    if (!sim.responses[responseIndex] || partIndex < 0 || partIndex > parts.length) throw new Error('수정할 파트가 없습니다.');
    const next = sim.responses.length;
    sim.responses.push(partIndex === 0 ? text : sim.responses[responseIndex]);
    if (partIndex > 0) parts[partIndex - 1] = text;
    if (parts.length) {
        sim.continuations ||= {};
        sim.continuations[String(next)] = parts;
    }
    setContinuationDirections(sim, next, directions);
    const revised = partIndex > 0 ? variants[partIndex - 1] : null;
    if (revised) revised.texts[revised.current] = text;
    setPartVariants(sim, next, variants);
    setResponseAnchor(sim, next, sim.responseAnchors?.[oldKey]);
    const translations = { ...(sim.partTranslations?.[oldKey] || {}) };
    delete translations[String(partIndex)];
    if (Object.keys(translations).length) {
        sim.partTranslations ||= {};
        sim.partTranslations[String(next)] = translations;
    }
    sim.currentIndex = next;
    return next;
}

/** Directions are stored parallel to continuations; '' means a plain continue. */
export function getContinuationDirections(sim, responseIndex) {
    const key = String(responseIndex);
    const count = sim.continuations?.[key]?.length || 0;
    const stored = sim.continuationDirections?.[key] || [];
    return Array.from({ length: count }, (_, i) => stored[i] || '');
}

function setContinuationDirections(sim, responseIndex, directions) {
    const key = String(responseIndex);
    if (directions.some(Boolean)) {
        sim.continuationDirections ||= {};
        sim.continuationDirections[key] = directions;
    } else if (sim.continuationDirections) {
        delete sim.continuationDirections[key];
    }
}

export function appendContinuation(sim, responseIndex, text, direction = '') {
    const key = String(responseIndex);
    const directions = getContinuationDirections(sim, responseIndex);
    sim.continuations ||= {};
    if (!Array.isArray(sim.continuations[key])) sim.continuations[key] = [];
    sim.continuations[key].push(text);
    setContinuationDirections(sim, responseIndex, [...directions, direction]);
    if (sim.translations) delete sim.translations[key];
}

/** Variants of each continuation part, parallel to continuations: { texts, directions, current } or empty. */
function getPartVariants(sim, responseIndex) {
    const key = String(responseIndex);
    const count = sim.continuations?.[key]?.length || 0;
    const stored = sim.partVariants?.[key] || [];
    return Array.from({ length: count }, (_, i) => stored[i] || null);
}

function setPartVariants(sim, responseIndex, variants) {
    const key = String(responseIndex);
    if (variants.some(Boolean)) {
        sim.partVariants ||= {};
        sim.partVariants[key] = variants;
    } else if (sim.partVariants) {
        delete sim.partVariants[key];
    }
}

/** @returns {{count: number, current: number}} how many versions a continuation part has */
export function getPartVariantInfo(sim, responseIndex, partIndex) {
    const variant = getPartVariants(sim, responseIndex)[partIndex - 1];
    return variant ? { count: variant.texts.length, current: variant.current } : { count: 1, current: 0 };
}

function showPartVariant(sim, responseIndex, partIndex, variant) {
    const key = String(responseIndex);
    sim.continuations[key][partIndex - 1] = variant.texts[variant.current];
    const directions = getContinuationDirections(sim, responseIndex);
    directions[partIndex - 1] = variant.directions[variant.current] || '';
    setContinuationDirections(sim, responseIndex, directions);
    if (sim.partTranslations?.[key]) delete sim.partTranslations[key][String(partIndex)];
    if (sim.translations) delete sim.translations[key];
}

/** Regenerating the last continuation keeps the old text as another version of that same part. */
export function appendContinuationRegeneration(sim, responseIndex, text, direction = '') {
    const key = String(responseIndex);
    const count = sim.continuations?.[key]?.length || 0;
    if (!count) throw new Error('재생성할 이어쓰기 파트가 없습니다.');
    const variants = getPartVariants(sim, responseIndex);
    const variant = variants[count - 1] || {
        texts: [sim.continuations[key][count - 1]],
        directions: [getContinuationDirections(sim, responseIndex)[count - 1]],
        current: 0,
    };
    variant.texts.push(text);
    variant.directions.push(direction);
    variant.current = variant.texts.length - 1;
    variants[count - 1] = variant;
    setPartVariants(sim, responseIndex, variants);
    showPartVariant(sim, responseIndex, count, variant);
}

export function selectPartVariant(sim, responseIndex, partIndex, variantIndex) {
    const variant = getPartVariants(sim, responseIndex)[partIndex - 1];
    if (!variant || variantIndex < 0 || variantIndex >= variant.texts.length) return;
    variant.current = variantIndex;
    showPartVariant(sim, responseIndex, partIndex, variant);
}

const anchorSnippet = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

/** Where the chat stood when a response was made: its last message at that moment. */
export function makeChatAnchor(chat, index = chat.length - 1) {
    const message = chat?.[index];
    if (!message) return null;
    return {
        index,
        name: message.name || '',
        sendDate: message.send_date ? String(message.send_date) : '',
        snippet: anchorSnippet(message.mes),
    };
}

export function setResponseAnchor(sim, responseIndex, anchor) {
    if (!anchor) return;
    sim.responseAnchors ||= {};
    sim.responseAnchors[String(responseIndex)] = { ...anchor };
}

/**
 * Find the anchored message again after deletions or insertions shifted indices.
 * @returns {{index: number, moved: boolean}|null} null when the message is gone
 */
export function resolveChatAnchor(chat, anchor) {
    if (!anchor || !Array.isArray(chat)) return null;
    const score = message => {
        if (!message) return 0;
        const sameDate = !!anchor.sendDate && String(message.send_date ?? '') === anchor.sendDate && (message.name || '') === anchor.name;
        const sameText = !!anchor.snippet && anchorSnippet(message.mes) === anchor.snippet;
        return (sameDate ? 2 : 0) + (sameText ? 1 : 0);
    };
    let best = -1;
    let bestScore = 0;
    for (let i = 0; i < chat.length; i++) {
        const s = score(chat[i]);
        if (s > bestScore || (s && s === bestScore && Math.abs(i - anchor.index) < Math.abs(best - anchor.index))) {
            best = i;
            bestScore = s;
        }
    }
    return best === -1 ? null : { index: best, moved: best !== anchor.index };
}
