import { createHmac } from "node:crypto";

/**
 * Build a full imgproxy request URL.
 * - With key/salt (hex): HMAC signature — https://docs.imgproxy.net/usage/signing_url
 * - Without key/salt: imgproxy still requires a signature segment; use "insecure"
 *   — https://docs.imgproxy.net/usage/processing
 */
export function buildImgproxyRequestUrl(baseUrl, processingPath, keyHex, saltHex) {
    const path = processingPath.startsWith("/") ? processingPath : `/${processingPath}`;
    const base = baseUrl.replace(/\/$/, "");
    if (keyHex && saltHex) {
        const hmac = createHmac("sha256", Buffer.from(keyHex, "hex"));
        hmac.update(Buffer.from(saltHex, "hex"));
        hmac.update(path);
        const signature = hmac.digest("base64url");
        return `${base}/${signature}${path}`;
    }
    return `${base}/insecure${path}`;
}
