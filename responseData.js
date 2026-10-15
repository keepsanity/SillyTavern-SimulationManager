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
    for (const field of ['continuations', 'translations', 'partTranslations']) {
        if (sim[field]) sim[field] = removeIndexed(sim[field], index);
    }
    sim.currentIndex = Math.max(0, Math.min(index, sim.responses.length - 1));
}

export function deleteContinuation(sim, responseIndex, partIndex) {
    const key = String(responseIndex);
    const parts = sim.continuations?.[key];
    if (!Number.isInteger(partIndex) || partIndex < 1 || !parts || partIndex > parts.length) return;
    parts.splice(partIndex - 1, 1);
    if (sim.partTranslations?.[key]) sim.partTranslations[key] = removeIndexed(sim.partTranslations[key], partIndex);
    if (sim.translations) delete sim.translations[key];
}

/** Use the existing response navigator for revisions; leave the original untouched. */
export function appendPartRevision(sim, responseIndex, partIndex, text) {
    const oldKey = String(responseIndex);
    const parts = [...(sim.continuations?.[oldKey] || [])];
    if (!sim.responses[responseIndex] || partIndex < 0 || partIndex > parts.length) throw new Error('수정할 파트가 없습니다.');
    const next = sim.responses.length;
    sim.responses.push(partIndex === 0 ? text : sim.responses[responseIndex]);
    if (partIndex > 0) parts[partIndex - 1] = text;
    if (parts.length) {
        sim.continuations ||= {};
        sim.continuations[String(next)] = parts;
    }
    const translations = { ...(sim.partTranslations?.[oldKey] || {}) };
    delete translations[String(partIndex)];
    if (Object.keys(translations).length) {
        sim.partTranslations ||= {};
        sim.partTranslations[String(next)] = translations;
    }
    sim.currentIndex = next;
    return next;
}
