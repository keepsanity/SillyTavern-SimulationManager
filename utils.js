/**
 * SillyTavern - Simulation Manager
 * 순수 유틸리티 (공유 상태 의존 없음)
 */

import { getContext } from '../../../extensions.js';
import {
    DEBUG_PREFIX,
    PRONOUN_MAP,
    PRONOUN_REGEX,
    SIM_POSITIONS,
} from './constants.js';

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeSimPosition(v) {
    return Object.values(SIM_POSITIONS).includes(v) ? v : SIM_POSITIONS.LAST_MESSAGE;
}

// ============================================
// Char/User Swap & Pronoun Swap
// ============================================
function preserveCase(sourceWord, targetWord) {
    if (!sourceWord) return targetWord;
    if (sourceWord === sourceWord.toUpperCase() && sourceWord !== sourceWord.toLowerCase()) {
        return targetWord.toUpperCase();
    }
    if (sourceWord[0] === sourceWord[0].toUpperCase() && sourceWord[0] !== sourceWord[0].toLowerCase()) {
        return targetWord[0].toUpperCase() + targetWord.slice(1).toLowerCase();
    }
    return targetWord.toLowerCase();
}

export function applySwap(text, swapCharUser, swapPronouns) {
    if (!text) return text;
    let out = text;
    if (swapCharUser) {
        // {{char}} ↔ {{user}} 동시 교체
        out = out.replace(/\{\{(char|user)\}\}/g, (_, name) => (name === 'char' ? '{{user}}' : '{{char}}'));
    }
    if (swapPronouns) {
        out = out.replace(PRONOUN_REGEX, (match) => {
            const lower = match.toLowerCase();
            const replacement = PRONOUN_MAP[lower];
            return replacement ? preserveCase(match, replacement) : match;
        });
    }
    return out;
}

// ============================================
// Text Helpers
// ============================================
export function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 외부에서 복붙된 nbsp 류를 일반 공백으로 정리 (시뮬 요청 텍스트에만 적용)
export function normalizePromptText(text) {
    if (typeof text !== 'string') return text;
    return text.replace(/[  ]/g, ' ');
}

/**
 * 원본 + continuation을 합친 전체 텍스트 반환.
 */
export function getFullResponseText(sim, responseIdx) {
    const base = sim.responses[responseIdx] || '';
    const conts = sim.continuations?.[String(responseIdx)] || [];
    return base + conts.join('');
}

/**
 * 텍스트를 클립보드에 복사. HTTPS/localhost 가 아닌 환경 대비 fallback 포함.
 */
export async function copyTextToClipboard(text) {
    if (!text) return;
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
        } else {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        }
        if (typeof toastr !== 'undefined') toastr.success('복사되었습니다.', '시뮬 매니저');
    } catch (e) {
        console.error(DEBUG_PREFIX, 'Copy failed:', e);
        if (typeof toastr !== 'undefined') toastr.error('복사에 실패했습니다.', '시뮬 매니저');
    }
}

export function renderResponseText(text) {
    try {
        const context = getContext();
        if (typeof context.messageFormatting === 'function') {
            const result = context.messageFormatting(text, '', false, false, -1);
            if (result && result.length > 0) return result;
        }
    } catch (e) { /* fallback */ }

    let html = escapeHtml(text);
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    html = html.replace(/(^&gt; (.+)$\n?)+/gm, (match) => {
        const lines = match.trim().split('\n').map(l => l.replace(/^&gt; /, '')).join('<br>');
        return `<blockquote>${lines}</blockquote>`;
    });
    html = html.replace(/^---$/gm, '<hr>');
    html = html.replace(/\n/g, '<br>');
    return html;
}
