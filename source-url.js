/**
 * Query params reserved for this service (not part of the remote image URL).
 * Matched case-insensitively when merging or stripping the outer request search string.
 */
const TRANSFORM_QUERY_KEYS = new Set([
    "width",
    "height",
    "quality",
    "removebg",
    "transparent",
]);

/**
 * Strip transform params from the request's search string, preserving order and encoding
 * of remaining segments (important for presigned URLs).
 * @param {string} search - `url.search` (includes leading `?` or empty)
 * @returns {string} leading `?` + rest, or empty string
 */
export function stripTransformParamsFromSearch(search) {
    if (!search || search === "?") return "";
    const raw = search.startsWith("?") ? search.slice(1) : search;
    if (!raw) return "";
    const kept = [];
    for (const part of raw.split("&")) {
        if (!part) continue;
        const eq = part.indexOf("=");
        const name = eq >= 0 ? part.slice(0, eq) : part;
        let key;
        try {
            key = decodeURIComponent(name.replace(/\+/g, " ")).toLowerCase();
        } catch {
            key = name.toLowerCase();
        }
        if (!TRANSFORM_QUERY_KEYS.has(key)) {
            kept.push(part);
        }
    }
    return kept.length ? `?${kept.join("&")}` : "";
}

/**
 * Decode /image/{remoteUrl} path into a full remote URL. If the presigned query was split
 * onto the outer request (unencoded `?`), merge it back.
 * @param {URL} requestUrl
 * @returns {string} full http(s) source URL for fetching
 */
export function parseImageSourceFromRequest(requestUrl) {
    let src = requestUrl.pathname.split("/").slice(2).join("/");
    src = decodeURIComponent(src);
    if (src.startsWith("https:/") && !src.startsWith("https://")) {
        src = src.replace("https:/", "https://");
    }
    if (src.startsWith("http:/") && !src.startsWith("http://")) {
        src = src.replace("http:/", "http://");
    }

    if (!src.includes("?")) {
        const extra = stripTransformParamsFromSearch(requestUrl.search);
        if (extra) {
            src += extra;
        }
    }
    return src;
}

/**
 * Stable cache identity for http(s) URLs: origin + pathname (drops query and hash).
 * Presigned URLs that only differ by signature params share one cache entry.
 */
export function cacheKeySourceString(src) {
    try {
        const u = new URL(src);
        if (u.protocol === "http:" || u.protocol === "https:") {
            return `${u.origin}${u.pathname}`;
        }
    } catch {
        // fall through
    }
    return src;
}

/**
 * imgproxy /plain/ segment must not contain raw `?` or `&`; encode the full source URL.
 */
export function encodeImgproxyPlainSource(src) {
    return encodeURIComponent(src);
}
