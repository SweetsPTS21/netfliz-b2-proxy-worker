import { sign } from './sign';
import { filterForwardHeaders } from './utils';

/**
 * Cloudflare Worker — proxy files from B2 via backend-issued presigned URLs.
 *
 * Optimisations applied:
 *  1. Presigned URL is cached in CF Cache API so repeated requests for the
 *     same key skip the backend call entirely.
 *  2. CORS preflight handled early.
 *  3. Range requests also benefit from the presigned-URL cache.
 *  4. Cleaner error propagation.
 */

// ── helpers ──────────────────────────────────────────────────────────

/** Build a synthetic cache key URL for storing presigned URLs in CF Cache. */
function presignCacheKey(request, key) {
    const url = new URL(request.url);
    return new Request(`${url.origin}/__presign__/${key}`, { method: 'GET' });
}

/** Fetch (or retrieve from cache) a presigned URL for the given object key. */
async function getPresignedUrl(request, key, env) {
    const cache = caches.default;
    const cacheReq = presignCacheKey(request, key);

    // 1. Try cache first
    const cached = await cache.match(cacheReq);
    if (cached) {
        const body = await cached.json();
        // Only reuse if the presigned URL hasn't expired yet (with 60 s margin)
        if (body.expires > Date.now() / 1000 + 60) {
            return body.url;
        }
    }

    // 2. Cache miss / expired → call backend
    const endpoint = env.BACKEND_API_ENDPOINT || 'https://api.swpts.site';
    const secret = env.WORKER_SECRET || 'worker-secret';

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await sign(key, timestamp, secret);

    const res = await fetch(
        `${endpoint}/api/files/presigned-url?key=${encodeURIComponent(key)}`,
        {
            method: 'GET',
            headers: {
                'X-Worker-Timestamp': timestamp,
                'X-Worker-Signature': signature,
                'X-Worker-Id': 'worker-v1',
            },
        },
    );

    if (!res.ok) {
        throw new HttpError(502, 'Presign backend returned ' + res.status);
    }

    const json = await res.json();
    if (!json.success) {
        throw new HttpError(502, 'Presign backend returned success=false');
    }

    const { url: presignedUrl, expires } = json.data;

    // 3. Store in CF cache – TTL = time until the presigned URL expires minus a
    //    small margin so we never serve a stale URL.
    const ttl = Math.max(expires - Math.floor(Date.now() / 1000) - 60, 10);
    const cacheRes = new Response(JSON.stringify({ url: presignedUrl, expires }), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': `public, max-age=${ttl}`,
        },
    });
    // put() is fire-and-forget — no need to await
    cache.put(cacheReq, cacheRes);

    return presignedUrl;
}

// ── simple error class ──────────────────────────────────────────────

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// ── CORS preflight ──────────────────────────────────────────────────

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Range',
    'Access-Control-Max-Age': '86400',
};

function handleOptions() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ── main handler ────────────────────────────────────────────────────

export default {
    async fetch(request, env) {
        try {
            // CORS preflight
            if (request.method === 'OPTIONS') return handleOptions();

            // Only allow GET / HEAD
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                return new Response('Method Not Allowed', { status: 405 });
            }

            // Parse key from path:  /files/video/videos/abc.mp4 → video/videos/abc.mp4
            // Decode '+' as space and handle percent-encoded chars (e.g. Test1+Part1.mp3 → Test1 Part1.mp3)
            const url = new URL(request.url);
            const rawPath = url.pathname.replace(/^\/files\//, '');
            const key = decodeURIComponent(rawPath.replace(/\+/g, ' '));
            if (!key) return new Response('Missing key', { status: 400 });

            const cacheTime = Number(env.CACHE_TTL) || 86400;

            // Get presigned URL (may come from CF cache)
            const presignedUrl = await getPresignedUrl(request, key, env);

            // ── Range request ──
            const rangeHeader = request.headers.get('Range');
            if (rangeHeader) {
                const originRes = await fetch(presignedUrl, {
                    headers: { Range: rangeHeader },
                    cf: { cacheEverything: false },
                });

                const headers = filterForwardHeaders(originRes.headers);
                headers.set('Accept-Ranges', 'bytes');
                // Don't edge-cache partial responses — they'd fragment the cache
                headers.set('Cache-Control', 'public, max-age=0, s-maxage=0');

                return new Response(originRes.body, {
                    status: originRes.status,
                    headers,
                });
            }

            // ── Full request (edge-cached) ──
            const originRes = await fetch(presignedUrl, {
                cf: { cacheEverything: true, cacheTtl: cacheTime },
            });

            if (!originRes.ok) {
                const txt = await originRes.text().catch(() => '');
                return new Response(`Origin fetch failed: ${originRes.status} ${txt}`, {
                    status: originRes.status,
                });
            }

            const headers = filterForwardHeaders(originRes.headers);
            headers.set('Cache-Control', `public, max-age=3600, s-maxage=${cacheTime}, immutable`);
            headers.set('Accept-Ranges', 'bytes');

            return new Response(originRes.body, { status: originRes.status, headers });
        } catch (err) {
            const status = err instanceof HttpError ? err.status : 500;
            return new Response(err.message || 'Internal Error', { status });
        }
    },
};
