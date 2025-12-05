const { mkdir, readFile, writeFile, access, readdir, stat } = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");

let allowedDomains = process?.env?.ALLOWED_REMOTE_DOMAINS?.split(",") || ["*"];
let imgproxyUrl = process?.env?.IMGPROXY_URL || "http://localhost:8888";
const healthcheckImageUrl = process?.env?.HEALTHCHECK_IMAGE_URL || "https://sampletestfile.com/wp-content/uploads/2023/05/585-KB.png";
const cacheDir = process?.env?.CACHE_DIR || "./cache";
const cacheEnabled = process?.env?.CACHE_ENABLED !== "false";
const whiteBackgroundThreshold = parseInt(process?.env?.WHITE_BACKGROUND_THRESHOLD || "253");
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
            console.log("Health check requested");
            return await healthCheck();
        };
        if (url.pathname === "/stats") return await stats();
        if (url.pathname.startsWith("/image/")) return await resize(url);
        return Response.redirect("https://github.com/coollabsio/next-image-transformation", 302);
    }
});

async function resize(url) {
    
    const preset = "pr:sharp"
    // Extract source URL from pathname, handling URL encoding
    let src = url.pathname.split("/").slice(2).join("/");
    // Decode URL-encoded characters
    src = decodeURIComponent(src);
    // Fix common issues: if src starts with "https:/" (missing slash), fix it
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
    const removeBg = url.searchParams.get("removeBg") === "true" || url.searchParams.get("transparent") === "true";
    const cacheKey = getCacheKey(src, width, height, quality, removeBg);
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
        // Build imgproxy path with optional trim for background removal
        let imgproxyPath = `${preset}`;
        
        // Add trim option if background removal is requested
        // trim:threshold:color - explicitly specify white (FFFFFF) for better performance
        if (removeBg) {
            // Map threshold from 0-255 range to 0-100 range for imgproxy
            // Higher threshold = more sensitive (only very white), so we invert: 255 -> 0, 247 -> ~3, 240 -> ~6
            const trimThreshold = Math.max(0, Math.min(100, Math.round((255 - whiteBackgroundThreshold) / 2.55)));
            // Explicitly specify white color (FFFFFF) for trim - this is more efficient
            imgproxyPath += `/trim:${trimThreshold}:FFFFFF`;
            
            // After trim, resize to fit within requested dimensions, then extend to fill exactly
            const targetWidth = parseInt(width) || 0;
            const targetHeight = parseInt(height) || 0;
            
            // Determine the fit size: if only one dimension provided, use it for square
            // If both provided, use minimum to ensure it fits within bounds
            let fitSize;
            let finalWidth, finalHeight;
            
            if (targetWidth && targetHeight) {
                // Both dimensions provided - use minimum to fit within bounds
                fitSize = Math.min(targetWidth, targetHeight);
                finalWidth = targetWidth;
                finalHeight = targetHeight;
            } else if (targetWidth) {
                // Only width provided - create square
                fitSize = targetWidth;
                finalWidth = targetWidth;
                finalHeight = targetWidth;
            } else if (targetHeight) {
                // Only height provided - create square
                fitSize = targetHeight;
                finalWidth = targetHeight;
                finalHeight = targetHeight;
            } else {
                // No dimensions - use a default (shouldn't happen but just in case)
                fitSize = 256;
                finalWidth = 256;
                finalHeight = 256;
            }
            
            // Resize to fit within the target dimensions (preserves aspect ratio, fits within bounds)
            // This should ensure both dimensions are <= target
            imgproxyPath += `/resize:fit:${finalWidth}:${finalHeight}`;
            
            // Extend to fill exact dimensions with transparent background (centered)
            // This adds transparent padding if the image is smaller than requested
            imgproxyPath += `/extend:1:ce`;
            
            // Ensure WebP format for transparency support  
            imgproxyPath += `/format:webp`;
        } else {
            // Normal images: use fill to crop to exact dimensions
            imgproxyPath += `/resize:fill:${width}:${height}`;
        }
        
        imgproxyPath += `/q:${quality}/plain/${src}`;
        const imgproxyRequestUrl = `${imgproxyUrl}/${imgproxyPath}`;
        const image = await fetch(imgproxyRequestUrl, {
            headers: {
                "Accept": "image/avif,image/webp,image/apng,*/*",
            }
        })
        const arrayBuffer = await image.arrayBuffer();
        const headers = new Headers(image.headers);
        headers.set("Server", "NextImageTransformation");
        if (image.ok && cacheEnabled) {
            await writeToCache(cacheKey, arrayBuffer, headers, image.status, image.statusText, removeBg); // Track if transparent
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

function getCacheKey(src, width, height, quality, removeBg = false) {
    const hash = createHash("sha256");
    hash.update(`${src}|${width}|${height}|${quality}|${removeBg}`);
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

async function writeToCache(key, data, headers, status, statusText, isTransparent = false) {
    try {
        await ensureCacheDir();
        const filePath = join(cacheDir, key);
        const metaPath = `${filePath}.json`;
        const serializedHeaders = Array.from(headers.entries()).filter(
            ([name]) => name.toLowerCase() !== "x-cache"
        );
        
        // Write both image and metadata - if either fails, we want to know about it
        const [imageWrite, metaWrite] = await Promise.allSettled([
            writeFile(filePath, new Uint8Array(data)),
            writeFile(metaPath, JSON.stringify({
                headers: serializedHeaders,
                status,
                statusText,
                isTransparent // Track if image has transparent background
            }))
        ]);
        
        // Log warnings if either write failed
        if (imageWrite.status === 'rejected') {
            console.error("Failed to write image cache file:", imageWrite.reason);
        }
        if (metaWrite.status === 'rejected') {
            console.error("Failed to write image cache metadata:", metaWrite.reason);
            // If metadata write failed but image write succeeded, try to clean up the image file
            // to avoid uncategorized entries
            try {
                await access(filePath, fsConstants.F_OK);
                await writeFile(filePath, Buffer.alloc(0)); // Clear the file
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    } catch (err) {
        console.error("Failed to write image cache", err);
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
            imageMB: 0,
            metadataMB: 0,
            totalMB: 0,
            normalImages: {
                count: 0,
                sizeMB: 0
            },
            transparentImages: {
                count: 0,
                sizeMB: 0
            }
        };
    }

    await ensureCacheDir();
    const entries = await readdir(cacheDir, { withFileTypes: true });

    let imageBytes = 0;
    let metadataBytes = 0;
    let normalCount = 0;
    let normalBytes = 0;
    let transparentCount = 0;
    let transparentBytes = 0;
    let uncategorizedCount = 0;
    let uncategorizedBytes = 0;

    // Track which files we've processed to avoid double counting
    const processedFiles = new Set();

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = join(cacheDir, entry.name);
        const size = (await stat(filePath)).size;
        
        if (entry.name.endsWith(".json")) {
            metadataBytes += size;
            
            // Read metadata to check if image is transparent
            try {
                const metaRaw = await readFile(filePath, "utf8");
                const meta = JSON.parse(metaRaw);
                const baseName = entry.name.replace(".json", "");
                
                // Check if corresponding image file exists and hasn't been processed
                if (!processedFiles.has(baseName)) {
                    const imageFilePath = join(cacheDir, baseName);
                    try {
                        await access(imageFilePath, fsConstants.F_OK);
                        const imageSize = (await stat(imageFilePath)).size;
                        
                        if (meta.isTransparent === true) {
                            transparentCount++;
                            transparentBytes += imageSize;
                        } else {
                            normalCount++;
                            normalBytes += imageSize;
                        }
                        processedFiles.add(baseName);
                        imageBytes += imageSize;
                    } catch (e) {
                        // Image file doesn't exist, skip
                    }
                }
            } catch (e) {
                // Failed to read metadata, skip
            }
        } else {
            // Image file without metadata (uncategorized)
            if (!processedFiles.has(entry.name)) {
                uncategorizedCount++;
                uncategorizedBytes += size;
                imageBytes += size;
                processedFiles.add(entry.name);
            }
        }
    }

    const totalCount = normalCount + transparentCount + uncategorizedCount;

    return {
        cacheEnabled: true,
        cacheDir,
        entries: totalCount,
        imageMB: toMB(imageBytes),
        metadataMB: toMB(metadataBytes),
        totalMB: toMB(imageBytes + metadataBytes),
        normalImages: {
            count: normalCount,
            sizeMB: toMB(normalBytes)
        },
        transparentImages: {
            count: transparentCount,
            sizeMB: toMB(transparentBytes)
        },
        uncategorizedImages: {
            count: uncategorizedCount,
            sizeMB: toMB(uncategorizedBytes)
        }
    };
}

function toMB(bytes) {
    return Number((bytes / (1024 * 1024)).toFixed(2));
}

async function healthCheck() {
    const preset = "pr:sharp";
    const healthUrl = `${imgproxyUrl}/${preset}/resize:fit:1:1/plain/${healthcheckImageUrl}`;

    try {
        const response = await fetch(healthUrl, {
            headers: {
                "Accept": "image/avif,image/webp,image/apng,*/*",
            }
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