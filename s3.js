/**
 * Next Image Transformation server with S3 cache backend.
 * Requires: S3_BUCKET, and AWS credentials (env or IAM).
 * Optional: S3_REGION, S3_CACHE_PREFIX (default "cache"), S3_ENDPOINT (for S3-compatible storage e.g. Tigris)
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    ListObjectsV2Command,
    HeadObjectCommand,
} from "@aws-sdk/client-s3";

let allowedDomains = process?.env?.ALLOWED_REMOTE_DOMAINS?.split(",") || ["*"];
let imgproxyUrl = process?.env?.IMGPROXY_URL || "http://localhost:8888";
const healthcheckImageUrl = process?.env?.HEALTHCHECK_IMAGE_URL || "https://sampletestfile.com/wp-content/uploads/2023/05/585-KB.png";
const cacheEnabled = process?.env?.CACHE_ENABLED !== "false";
const whiteBackgroundThreshold = parseInt(process?.env?.WHITE_BACKGROUND_THRESHOLD || "253");
const _tint = process?.env?.SERVER_TINT_COLOR?.trim();
const serverTintColor = _tint ? (_tint.startsWith("#") ? _tint : `#${_tint}`) : null;

const s3Bucket = process?.env?.S3_BUCKET || "";
const s3Region = process?.env?.S3_REGION || process?.env?.AWS_REGION || "us-east-1";
const s3Prefix = (process?.env?.S3_CACHE_PREFIX || "cache").replace(/^\/|\/$/g, "");
const s3Endpoint = process?.env?.S3_ENDPOINT?.trim() || null;

if (process.env.NODE_ENV === "development") {
    imgproxyUrl = "http://localhost:8888";
}
allowedDomains = allowedDomains.map((d) => d.trim());

const s3ClientConfig = { region: s3Region };
if (s3Endpoint) {
    s3ClientConfig.endpoint = s3Endpoint;
    s3ClientConfig.forcePathStyle = true;
}
const s3 = new S3Client(s3ClientConfig);

function normalizeUrlForCache(src) {
    try {
        const u = new URL(src);
        u.search = "";
        return u.toString();
    } catch {
        return src;
    }
}

function getCacheKey(src, width, height, quality, removeBg = false, tintColor = null) {
    const normalizedSrc = normalizeUrlForCache(src);
    const hash = createHash("sha256");
    hash.update(`${normalizedSrc}|${width}|${height}|${quality}|${removeBg}|${tintColor || ""}`);
    return hash.digest("hex");
}

function getS3Keys(key) {
    const shard = key.length >= 2 ? key.substring(0, 2) : "00";
    const base = s3Prefix ? `${s3Prefix}/${shard}/${key}` : `${shard}/${key}`;
    return { imageKey: base, metaKey: `${base}.json` };
}

async function readFromCache(key) {
    if (!s3Bucket || !cacheEnabled) return null;
    try {
        const { imageKey, metaKey } = getS3Keys(key);
        const [imageResp, metaResp] = await Promise.all([
            s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: imageKey })),
            s3.send(new GetObjectCommand({ Bucket: s3Bucket, Key: metaKey })),
        ]);
        const body = await imageResp.Body.transformToByteArray();
        const metaRaw = await metaResp.Body.transformToString();
        const meta = JSON.parse(metaRaw);
        const headers = new Headers(meta.headers || []);
        return {
            body: new Uint8Array(body),
            headers,
            status: meta.status || 200,
            statusText: meta.statusText || "OK",
        };
    } catch (err) {
        return null;
    }
}

async function writeToCache(key, data, headers, status, statusText, isTransparent = false) {
    if (!s3Bucket || !cacheEnabled) return;
    try {
        const { imageKey, metaKey } = getS3Keys(key);
        const serializedHeaders = Array.from(headers.entries()).filter(
            ([name]) => name.toLowerCase() !== "x-cache"
        );
        const metadata = {
            headers: serializedHeaders,
            status,
            statusText,
            isTransparent,
        };

        const contentType = headers.get("content-type") || "image/webp";
        await Promise.all([
            s3.send(
                new PutObjectCommand({
                    Bucket: s3Bucket,
                    Key: imageKey,
                    Body: new Uint8Array(data),
                    ContentType: contentType,
                })
            ),
            s3.send(
                new PutObjectCommand({
                    Bucket: s3Bucket,
                    Key: metaKey,
                    Body: JSON.stringify(metadata),
                    ContentType: "application/json",
                    Metadata: {
                        istransparent: isTransparent ? "true" : "false",
                    },
                })
            ),
        ]);
    } catch (err) {
        console.error("Failed to write S3 cache", err);
    }
}

async function getCacheStats() {
    if (!cacheEnabled) {
        return {
            cacheEnabled: false,
            cacheBackend: "s3",
            cacheDir: `s3://${s3Bucket}/${s3Prefix || ""}`,
            entries: 0,
            imageMB: 0,
            metadataMB: 0,
            totalMB: 0,
            normalImages: { count: 0, sizeMB: 0 },
            transparentImages: { count: 0, sizeMB: 0 },
            uncategorizedImages: { count: 0, sizeMB: 0 },
        };
    }
    if (!s3Bucket) {
        return {
            cacheEnabled: true,
            cacheBackend: "s3",
            error: "S3_BUCKET not set",
            cacheDir: null,
            entries: 0,
            imageMB: 0,
            metadataMB: 0,
            totalMB: 0,
            normalImages: { count: 0, sizeMB: 0 },
            transparentImages: { count: 0, sizeMB: 0 },
            uncategorizedImages: { count: 0, sizeMB: 0 },
        };
    }

    const list = [];
    let continuationToken;
    do {
        const resp = await s3.send(
            new ListObjectsV2Command({
                Bucket: s3Bucket,
                Prefix: s3Prefix ? `${s3Prefix}/` : "",
                ContinuationToken: continuationToken,
            })
        );
        if (resp.Contents) list.push(...resp.Contents);
        continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    const imageEntries = list.filter((o) => o.Key && !o.Key.endsWith(".json"));
    const metaEntries = list.filter((o) => o.Key && o.Key.endsWith(".json"));
    const imageByKey = new Map(imageEntries.map((o) => [o.Key, o.Size || 0]));
    const metaByKey = new Map(metaEntries.map((o) => [o.Key, o.Size || 0]));

    let normalCount = 0,
        normalBytes = 0,
        transparentCount = 0,
        transparentBytes = 0;
    const HEAD_BATCH = 50;
    for (let i = 0; i < metaEntries.length; i += HEAD_BATCH) {
        const batch = metaEntries.slice(i, i + HEAD_BATCH);
        const heads = await Promise.all(
            batch.map((o) =>
                s3.send(
                    new HeadObjectCommand({ Bucket: s3Bucket, Key: o.Key })
                ).catch(() => null)
            )
        );
        for (let j = 0; j < batch.length; j++) {
            const metaKey = batch[j].Key;
            const imageKey = metaKey.replace(/\.json$/, "");
            const imageSize = imageByKey.get(imageKey) || 0;
            const head = heads[j];
            const isTransparent =
                head?.Metadata?.istransparent === "true";
            if (isTransparent) {
                transparentCount++;
                transparentBytes += imageSize;
            } else {
                normalCount++;
                normalBytes += imageSize;
            }
        }
    }

    const metadataBytes = metaEntries.reduce((s, o) => s + (o.Size || 0), 0);
    const imageBytes = imageEntries.reduce((s, o) => s + (o.Size || 0), 0);
    const totalCount = imageEntries.length;
    const dirCounts = new Map();
    for (const o of list) {
        if (!o.Key || o.Key.endsWith(".json")) continue;
        const parts = o.Key.split("/");
        const shard = parts.length >= 2 ? parts[parts.length - 2] : "(root)";
        dirCounts.set(shard, (dirCounts.get(shard) || 0) + 1);
    }
    const shardedCounts = [...dirCounts.entries()].filter(([k]) => k !== "(root)" && /^[0-9a-f]{2}$/i.test(k));
    const counts = shardedCounts.map(([, c]) => c);

    function toMB(bytes) {
        return Number((bytes / (1024 * 1024)).toFixed(2));
    }
    function median(values) {
        if (values.length === 0) return 0;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
            ? Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2))
            : sorted[mid];
    }

    const distribution = {
        totalSubdirectories: shardedCounts.length,
        emptySubdirectories: Math.max(0, 256 - shardedCounts.length),
        minFilesPerDir: counts.length > 0 ? Math.min(...counts) : 0,
        maxFilesPerDir: counts.length > 0 ? Math.max(...counts) : 0,
        avgFilesPerDir: counts.length > 0 ? Number((counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(2)) : 0,
        medianFilesPerDir: median(counts),
    };

    const sortedDirs = shardedCounts.sort((a, b) => b[1] - a[1]);
    const topDirectories = sortedDirs.slice(0, 10).map(([name, count]) => ({
        subdirectory: name,
        count,
        sizeMB: toMB(0),
        normalCount: 0,
        transparentCount: 0,
    }));
    const bottomDirectories = sortedDirs.slice(-10).reverse().map(([name, count]) => ({
        subdirectory: name,
        count,
        sizeMB: toMB(0),
        normalCount: 0,
        transparentCount: 0,
    }));

    return {
        cacheEnabled: true,
        cacheBackend: "s3",
        cacheDir: `s3://${s3Bucket}/${s3Prefix || ""}`,
        entries: totalCount,
        imageMB: toMB(imageBytes),
        metadataMB: toMB(metadataBytes),
        totalMB: toMB(imageBytes + metadataBytes),
        normalImages: { count: normalCount, sizeMB: toMB(normalBytes) },
        transparentImages: { count: transparentCount, sizeMB: toMB(transparentBytes) },
        uncategorizedImages: { count: 0, sizeMB: 0 },
        distribution,
        topDirectories,
        bottomDirectories,
    };
}

async function resize(url) {
    const preset = "pr:sharp";
    let src = url.pathname.split("/").slice(2).join("/");
    src = decodeURIComponent(src);
    if (src.startsWith("https:/") && !src.startsWith("https://")) {
        src = src.replace("https:/", "https://");
    }
    if (src.startsWith("http:/") && !src.startsWith("http://")) {
        src = src.replace("http:/", "http://");
    }

    let origin;
    try {
        origin = new URL(src).hostname;
    } catch (e) {
        return new Response(`Invalid URL: ${src}`, { status: 400 });
    }
    const allowed = allowedDomains.filter((domain) => {
        if (domain === "*") return true;
        if (domain === origin) return true;
        if (domain.startsWith("*.") && origin.endsWith(domain.split("*.").pop())) return true;
        return false;
    });
    if (allowed.length === 0) {
        return new Response(`Domain (${origin}) not allowed. More details here: https://github.com/coollabsio/next-image-transformation`, { status: 403 });
    }

    const width = url.searchParams.get("width") || 0;
    const height = url.searchParams.get("height") || 0;
    const quality = url.searchParams.get("quality") || 75;
    const removeBg = url.searchParams.get("removeBg") === "true" || url.searchParams.get("transparent") === "true";
    const cacheKey = getCacheKey(src, width, height, quality, removeBg, serverTintColor);

    if (cacheEnabled) {
        const cached = await readFromCache(cacheKey);
        if (cached) {
            cached.headers.set("Server", "NextImageTransformation");
            cached.headers.set("X-Cache", "HIT");
            return new Response(cached.body, {
                headers: cached.headers,
                status: cached.status,
                statusText: cached.statusText,
            });
        }
    }

    try {
        let imgproxyPath = `${preset}`;
        if (removeBg) {
            const trimThreshold = Math.max(0, Math.min(100, Math.round((255 - whiteBackgroundThreshold) / 2.55)));
            imgproxyPath += `/trim:${trimThreshold}:FFFFFF`;
            const targetWidth = parseInt(width) || 0;
            const targetHeight = parseInt(height) || 0;
            let finalWidth, finalHeight;
            if (targetWidth && targetHeight) {
                finalWidth = targetWidth;
                finalHeight = targetHeight;
            } else if (targetWidth) {
                finalWidth = finalHeight = targetWidth;
            } else if (targetHeight) {
                finalWidth = finalHeight = targetHeight;
            } else {
                finalWidth = finalHeight = 256;
            }
            imgproxyPath += `/resize:fit:${finalWidth}:${finalHeight}`;
            imgproxyPath += `/extend:1:ce`;
            imgproxyPath += `/format:webp`;
        } else {
            imgproxyPath += `/resize:fill:${width}:${height}`;
        }
        imgproxyPath += `/q:${quality}/plain/${src}`;
        const imgproxyRequestUrl = `${imgproxyUrl}/${imgproxyPath}`;
        const image = await fetch(imgproxyRequestUrl, {
            headers: { Accept: "image/avif,image/webp,image/apng,*/*" },
        });
        let arrayBuffer = await image.arrayBuffer();
        if (image.ok && serverTintColor) {
            try {
                const tinted = await sharp(Buffer.from(arrayBuffer))
                    .tint(serverTintColor)
                    .toBuffer();
                arrayBuffer = tinted.buffer.slice(tinted.byteOffset, tinted.byteOffset + tinted.byteLength);
            } catch (tintErr) {
                console.warn("Failed to apply server tint:", tintErr.message);
            }
        }
        const headers = new Headers(image.headers);
        headers.set("Server", "NextImageTransformation");
        if (image.ok && cacheEnabled) {
            await writeToCache(cacheKey, arrayBuffer, headers, image.status, image.statusText, removeBg);
        }
        headers.set("X-Cache", image.ok ? (cacheEnabled ? "MISS" : "BYPASS") : "SKIP");
        return new Response(arrayBuffer, {
            headers,
            status: image.status,
            statusText: image.statusText,
        });
    } catch (e) {
        console.log(e);
        return new Response("Error resizing image", { status: 500 });
    }
}

async function stats() {
    try {
        const summary = await getCacheStats();
        return new Response(JSON.stringify(summary, null, 2), {
            headers: {
                "Content-Type": "application/json",
                Server: "NextImageTransformation",
            },
        });
    } catch (err) {
        console.error("Failed to calculate S3 cache stats", err);
        return new Response("Failed to read cache stats", { status: 500 });
    }
}

async function healthCheck() {
    const preset = "pr:sharp";
    const healthUrl = `${imgproxyUrl}/${preset}/resize:fit:1:1/plain/${healthcheckImageUrl}`;
    try {
        const response = await fetch(healthUrl, {
            headers: { Accept: "image/avif,image/webp,image/apng,*/*" },
        });
        if (!response.ok) {
            console.warn("Health check failed", response.status, response.statusText);
            return new Response("Imgproxy health check failed", { status: 503 });
        }
        return new Response("OK");
    } catch (error) {
        console.error("Health check error", error);
        return new Response("Imgproxy health check failed", { status: 503 });
    }
}

Bun.serve({
    port: parseInt(process.env.PORT || "3000", 10),
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") {
            return Response.redirect("https://jozef.uk", 302);
        }
        if (url.pathname === "/health") {
            console.log("Health check requested");
            return await healthCheck();
        }
        if (url.pathname === "/stats") return await stats();
        if (url.pathname.startsWith("/image/")) return await resize(url);
        return Response.redirect("https://github.com/coollabsio/next-image-transformation", 302);
    },
});

console.log("Next Image Transformation (S3 cache) listening on port", process.env.PORT || 3000);
if (cacheEnabled && !s3Bucket) {
    console.warn("CACHE_ENABLED is true but S3_BUCKET is not set; cache will be no-op.");
}
