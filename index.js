const { mkdir, readFile, writeFile, access, readdir, stat } = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");

const version = "0.0.3"

let allowedDomains = process?.env?.ALLOWED_REMOTE_DOMAINS?.split(",") || ["*"];
let imgproxyUrl = process?.env?.IMGPROXY_URL || "http://localhost:8888";
const cacheDir = process?.env?.CACHE_DIR || "./cache";
const cacheEnabled = process?.env?.CACHE_ENABLED !== "false";
let cacheInitialized = false;

if (process.env.NODE_ENV === "development") {
    imgproxyUrl = "http://localhost:8888"
}
allowedDomains = allowedDomains.map(d => d.trim());

Bun.serve({
    port: 3000,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") {
            return Response.redirect("https://jozef.uk", 302);
        }

        if (url.pathname === "/health") {
            return new Response("OK");
        };
        if (url.pathname === "/stats") return await stats();
        if (url.pathname.startsWith("/image/")) return await resize(url);
        return Response.redirect("https://github.com/coollabsio/next-image-transformation", 302);
    }
});

async function resize(url) {
    const preset = "pr:sharp"
    const src = url.pathname.split("/").slice(2).join("/");
    const origin = new URL(src).hostname;
    const allowed = allowedDomains.filter(domain => {
        if (domain === "*") return true;
        if (domain === origin) return true;
        if (domain.startsWith("*.") && origin.endsWith(domain.split("*.").pop())) return true;
        return false;
    })
    if (allowed.length === 0) {
        return new Response(`Domain (${origin}) not allowed. More details here: https://github.com/coollabsio/next-image-transformation`, { status: 403 });
    }
    const width = url.searchParams.get("width") || 0;
    const height = url.searchParams.get("height") || 0;
    const quality = url.searchParams.get("quality") || 75;
    const cacheKey = getCacheKey(src, width, height, quality);

    if (cacheEnabled) {
        const cached = await readFromCache(cacheKey);
        if (cached) {
            cached.headers.set("Server", "NextImageTransformation");
            cached.headers.set("X-Cache", "HIT");
            return new Response(cached.body, {
                headers: cached.headers,
                status: cached.status,
                statusText: cached.statusText
            });
        }
    }

    try {
        const url = `${imgproxyUrl}/${preset}/resize:fill:${width}:${height}/q:${quality}/plain/${src}`
        const image = await fetch(url, {
            headers: {
                "Accept": "image/avif,image/webp,image/apng,*/*",
            }
        })
        const arrayBuffer = await image.arrayBuffer();
        const headers = new Headers(image.headers);
        headers.set("Server", "NextImageTransformation");
        if (image.ok && cacheEnabled) {
            await writeToCache(cacheKey, arrayBuffer, headers, image.status, image.statusText);
        }
        headers.set("X-Cache", image.ok ? (cacheEnabled ? "MISS" : "BYPASS") : "SKIP");
        return new Response(arrayBuffer, {
            headers,
            status: image.status,
            statusText: image.statusText
        })
    } catch (e) {
        console.log(e)
        return new Response("Error resizing image")
    }
}

function getCacheKey(src, width, height, quality) {
    const hash = createHash("sha256");
    hash.update(`${src}|${width}|${height}|${quality}`);
    return hash.digest("hex");
}

async function ensureCacheDir() {
    if (!cacheEnabled || cacheInitialized) return;
    await mkdir(cacheDir, { recursive: true });
    cacheInitialized = true;
}

async function readFromCache(key) {
    try {
        const filePath = join(cacheDir, key);
        const metaPath = `${filePath}.json`;
        await ensureCacheDir();
        await Promise.all([
            access(filePath, fsConstants.F_OK),
            access(metaPath, fsConstants.F_OK)
        ]);
        const [body, metaRaw] = await Promise.all([
            readFile(filePath),
            readFile(metaPath, "utf8")
        ]);
        const meta = JSON.parse(metaRaw);
        const headers = new Headers(meta.headers || []);
        return {
            body,
            headers,
            status: meta.status || 200,
            statusText: meta.statusText || "OK"
        };
    } catch (err) {
        return null;
    }
}

async function writeToCache(key, data, headers, status, statusText) {
    try {
        await ensureCacheDir();
        const filePath = join(cacheDir, key);
        const metaPath = `${filePath}.json`;
        const serializedHeaders = Array.from(headers.entries()).filter(
            ([name]) => name.toLowerCase() !== "x-cache"
        );
        await Promise.all([
            writeFile(filePath, new Uint8Array(data)),
            writeFile(metaPath, JSON.stringify({
                headers: serializedHeaders,
                status,
                statusText
            }))
        ]);
    } catch (err) {
        console.warn("Failed to write image cache", err);
    }
}

async function stats() {
    try {
        const summary = await getCacheStats();
        const headers = new Headers({
            "Content-Type": "application/json",
            "Server": "NextImageTransformation"
        });
        return new Response(JSON.stringify(summary, null, 2), { headers });
    } catch (err) {
        console.error("Failed to calculate cache stats", err);
        return new Response("Failed to read cache stats", { status: 500 });
    }
}

async function getCacheStats() {
    if (!cacheEnabled) {
        return {
            cacheEnabled: false,
            cacheDir,
            entries: 0,
            imageBytes: 0,
            metadataBytes: 0,
            totalBytes: 0
        };
    }

    await ensureCacheDir();
    const entries = await readdir(cacheDir, { withFileTypes: true });

    let itemCount = 0;
    let imageBytes = 0;
    let metadataBytes = 0;

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = join(cacheDir, entry.name);
        const size = (await stat(filePath)).size;
        if (entry.name.endsWith(".json")) {
            metadataBytes += size;
        } else {
            itemCount += 1;
            imageBytes += size;
        }
    }

    return {
        cacheEnabled: true,
        cacheDir,
        entries: itemCount,
        imageBytes,
        metadataBytes,
        totalBytes: imageBytes + metadataBytes
    };
}