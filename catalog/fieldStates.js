/** Reads one dotted field path without traversing prototypes.
 * @param {object} record Typed record.
 * @param {string} path Dotted path.
 * @returns {unknown} Current value or undefined.
 */
export function fieldValueAt(record, path) {
    let value = record;
    for (const part of path.split('.')) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
        value = value[part];
    }
    return value;
}

/** Assigns one dotted field on a detached JSON value; arrays are field values, never path segments.
 * @param {object} record Mutable detached record.
 * @param {string} path Dotted field path.
 * @param {unknown} value Replacement value.
 * @returns {void}
 */
export function setFieldValue(record, path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    let target = record;
    for (const part of parts) {
        if (!Object.hasOwn(target, part) || !target[part] || typeof target[part] !== 'object' || Array.isArray(target[part])) Object.defineProperty(target, part, { value: {}, enumerable: true, writable: true, configurable: true });
        target = target[part];
    }
    Object.defineProperty(target, last, { value, enumerable: true, writable: true, configurable: true });
}

/** Finds changed leaf fields; collection fields are replaced as one value.
 * @param {object} previous Existing record.
 * @param {object} patch Submitted patch.
 * @returns {string[]} Changed paths, excluding identity ID.
 */
export function changedFieldPaths(previous, patch) {
    const paths = [];
    const walk = (before, after, path) => {
        if (after == null && before && typeof before === 'object' && !Array.isArray(before) && Object.keys(before).length) {
            for (const key of Object.keys(before)) walk(before[key], null, `${path}.${key}`);
            return;
        }
        if (after && typeof after === 'object' && !Array.isArray(after)) {
            for (const key of new Set([...Object.keys(before && typeof before === 'object' ? before : {}), ...Object.keys(after)])) walk(before?.[key], after[key] ?? null, path ? `${path}.${key}` : key);
        } else if (JSON.stringify(before) !== JSON.stringify(after)) paths.push(path);
    };
    for (const [key, value] of Object.entries(patch)) if (key !== 'id') walk(previous[key], value, key);
    return paths;
}
