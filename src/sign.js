const encoder = new TextEncoder();

function hexEncode(bytes) {
    return Array.from(new Uint8Array(bytes))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Cache imported CryptoKeys per secret to avoid re-importing on every request.
 * Workers run in isolates that can handle many requests, so this saves
 * a subtle.importKey call on hot paths.
 */
let cachedKey = null;
let cachedSecret = null;

async function getKey(secret) {
    if (cachedKey && cachedSecret === secret) return cachedKey;
    cachedKey = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    cachedSecret = secret;
    return cachedKey;
}

export async function sign(keyPath, timestamp, secret) {
    const msg = encoder.encode(`${keyPath}\n${timestamp}`);
    const key = await getKey(secret);
    const sig = await crypto.subtle.sign('HMAC', key, msg);
    return hexEncode(sig);
}