// Only structured, non-account data is saved here. Never persist request URLs,
// cookies, API bodies, note contents, or arbitrary exception messages.
const STORAGE_KEY = 'backupDiagnostics';
const MAX_ENTRIES = 300;
const EVENTS = new Set([
    'job.started', 'job.finished', 'task.started', 'task.finished',
    'annotation.api', 'annotation.fallback', 'doulist.api', 'doulist.missing_tags',
]);
const OUTCOMES = new Set(['completed', 'empty', 'failed']);
const REASONS = new Set(['http_error', 'invalid_response', 'empty_response']);
const LIST_TYPES = new Set(['owned', 'following']);
const ERROR_TYPES = new Set([
    'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
    'TaskError', 'AbortError', 'NetworkError', 'QuotaExceededError',
]);
let pendingWrite = Promise.resolve();

function integer(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function token(value, maxLength = 40) {
    return typeof value === 'string' && value.length <= maxLength && /^[a-zA-Z0-9_.-]+$/.test(value)
        ? value : undefined;
}

export function newDiagnosticRunId() {
    return crypto.randomUUID();
}

export function recordDiagnostic(runId, event, details = {}) {
    if (!EVENTS.has(event) || !token(runId, 40)) return Promise.resolve();
    const entry = {
        time: new Date().toISOString(),
        runId,
        event,
    };
    const task = token(details.task);
    const outcome = OUTCOMES.has(details.outcome) ? details.outcome : undefined;
    const reason = REASONS.has(details.reason) ? details.reason : undefined;
    const listType = LIST_TYPES.has(details.listType) ? details.listType : undefined;
    const errorType = ERROR_TYPES.has(details.errorType) ? details.errorType :
        (details.errorType ? 'Error' : undefined);
    // Keep only the extension module and line, never the extension ID, full URL,
    // local filesystem path, or raw exception text.
    const locationMatch = typeof details.errorStack === 'string' ?
        details.errorStack.match(/\/(tasks|services)\/([a-zA-Z0-9_/-]+\.js):(\d+)(?::\d+)?/) : null;
    const errorLocation = locationMatch ? `${locationMatch[1]}/${locationMatch[2]}:${locationMatch[3]}` : undefined;
    for (const [key, value] of Object.entries({task, outcome, reason, listType, errorType, errorLocation})) {
        if (value !== undefined) entry[key] = value;
    }
    for (const key of ['status', 'apiTotal', 'apiGroups', 'count', 'total', 'pages', 'failedCount', 'emptyCount']) {
        const value = integer(details[key]);
        if (value !== undefined) entry[key] = value;
    }
    if (typeof details.isOther === 'boolean') entry.isOther = details.isOther;

    pendingWrite = pendingWrite.catch(() => undefined).then(async () => {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        const entries = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
        entries.push(entry);
        await chrome.storage.local.set({[STORAGE_KEY]: entries.slice(-MAX_ENTRIES)});
    }).catch(() => undefined); // Diagnostic storage must never stop a backup.
    return pendingWrite;
}

export async function getDiagnosticReport() {
    await pendingWrite.catch(() => undefined);
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return {
        format: 'tofu-backup-diagnostics-v1',
        generatedAt: new Date().toISOString(),
        extensionVersion: chrome.runtime.getManifest().version,
        entries: Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [],
    };
}
