import {sign} from "./sign";

export default {
    async fetch(request, env) {
        // 1) parse requested path, call your backend to get presigned URL
        // e.g. GET https://api.mysite.com/presign?key=videos/abc.mp4
        const url = new URL(request.url)
        const key = url.pathname.replace(/^\/videos\//, '') // e.g. /video/videos/abc.mp4
        if (!key) return new Response('missing key', {status: 400});

        const timestamp = Math.floor(Date.now() / 1000).toString(); // seconds
        const signature = await sign(key, timestamp, env.WORKER_SECRET);

        // Get presigned URL from your backend (secure)
        const presignRes = await fetch(`${env.BACKEND_API_ENDPOINT}/api/v1/file/presign?key=${encodeURIComponent(key)}`, {
            method: 'GET',
            headers: {
                'X-Worker-Timestamp': timestamp,
                'X-Worker-Signature': signature,
                // optional: identify worker version
                'X-Worker-Id': 'worker-v1'
            }
        })

        if (!presignRes.ok) return new Response('Presign failed', {status: 502})

        const {success, data} = await presignRes.json()

        const {url: presignedUrl} = data

        // 2) fetch from presigned URL (this is origin request from Cloudflare edge)
        const originRes = await fetch(presignedUrl, {cf: {cacheEverything: true, cacheTtl: 3600 * 24}})

        // 3) return response to client, let CF cache it
        const headers = new Headers(originRes.headers)
        // enforce caching on edge
        headers.set('Cache-Control', 'public, max-age=0, s-maxage=86400') // s-maxage = edge TTL
        return new Response(originRes.body, {status: originRes.status, headers})
    }
}
