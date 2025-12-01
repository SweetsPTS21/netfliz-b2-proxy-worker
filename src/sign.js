function hexEncode(bytes) {
    return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2,'0')).join('');
}

export async function sign(keyPath, timestamp, secret) {
    // message: `${keyPath}\n${timestamp}`
    const msg = new TextEncoder().encode(`${keyPath}\n${timestamp}`);
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, msg);
    return hexEncode(sig);
}