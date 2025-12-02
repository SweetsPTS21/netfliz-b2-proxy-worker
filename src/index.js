import {sign} from "./sign";
import {filterForwardHeaders} from "./utils";

export default {
    async fetch(request, env) {
        const cacheTime = env.CACHE_TTL || 86400
        const endpoint = env.BACKEND_API_ENDPOINT || 'https://api.swpts.site'
        const secret = env.WORKER_SECRET || 'worker-secret'

        // parse requested path
        const url = new URL(request.url)
        const key = url.pathname.replace(/^\/videos\//, '') // e.g. /video/videos/abc.mp4
        if (!key) return new Response('missing key', {status: 400});

        const timestamp = Math.floor(Date.now() / 1000).toString(); // seconds
        const signature = await sign(key, timestamp, secret);

        // Lấy presigned URL từ backend
        const presignRes = await fetch(`${endpoint}/api/v1/file/presign-url?key=${encodeURIComponent(key)}`, {
            method: 'GET',
            headers: {
                'X-Worker-Timestamp': timestamp,
                'X-Worker-Signature': signature,
                'X-Worker-Id': 'worker-v1'
            }
        })

        if (!presignRes.ok) return new Response('Presign failed', {status: 502})
        const {success, data} = await presignRes.json()
        if (!success) return new Response('Presign failed', {status: 502})

        const {url: presignedUrl, expires: presignedExpires} = data

        // If client asked for Range, forward Range and do not aggressively cache this response
        const rangeHeader = request.headers.get('range');
        if (rangeHeader) {
            // Forward Range request to origin. We won't set long edge cache for ranged responses.
            const originRangeResp = await fetch(presignedUrl, {
                method: 'GET',
                headers: {
                    'Range': rangeHeader
                },
                // For origin request, allow CF to use its own caching if configured, but range responses
                // are typically not cached well; we rely on origin to support Range.
                cf: {cacheEverything: false}
            });

            // forward most headers from origin, but enforce Accept-Ranges
            const headers = filterForwardHeaders(originRangeResp.headers);
            headers.set('Accept-Ranges', 'bytes');
            // we deliberately avoid long s-maxage for Range responses to prevent stale partials
            headers.set('Cache-Control', 'public, max-age=0, s-maxage=0');

            return new Response(originRangeResp.body, {
                status: originRangeResp.status,
                headers
            });
        }

        // fetch from presigned URL (this is origin request from Cloudflare edge)
        const originRes = await fetch(presignedUrl, {cf: {cacheEverything: true, cacheTtl: cacheTime}})

        if (!originRes.ok) {
            const txt = await originRes.text().catch(() => '');
            return new Response(`origin fetch failed: ${originRes.status} ${txt}`, { status: originRes.status });
        }

        // 3) return response to client, let CF cache it
        const headers = filterForwardHeaders(originRes.headers)
        // enforce caching on edge
        headers.set('Cache-Control', `public, max-age=3600, s-maxage=${cacheTime}, immutable`) // s-maxage = edge TTL
        headers.set('Accept-Ranges', 'bytes');

        return new Response(originRes.body, {status: originRes.status, headers})
    }
}
