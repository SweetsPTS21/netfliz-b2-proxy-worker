/**
 * Filter headers we can safely forward from origin to client.
 * Avoid forwarding hop-by-hop or security-sensitive headers.
 * @param {Headers} originHeaders
 * @returns {Headers} new Headers object
 */
export function filterForwardHeaders(originHeaders) {
    const out = new Headers();
    // copy a selected set (common ones)
    const allowList = [
        'content-type',
        'content-length',
        'last-modified',
        'etag',
        'cache-control',
        'accept-ranges',
        'content-range',
        'content-disposition',
        'cf-cache-status'
    ];
    for (const name of allowList) {
        const v = originHeaders.get(name);
        if (v !== null) out.set(name, v);
    }
    // ensure CORS if needed (optional)
    if (!out.has('access-control-allow-origin')) {
        out.set('Access-Control-Allow-Origin', '*');
    }
    return out;
}