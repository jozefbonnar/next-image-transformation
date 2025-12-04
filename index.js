const { mkdir, readFile, writeFile, access, readdir, stat } = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const { createHash } = require("node:crypto");
const { join } = require("node:path");
const sharp = require("sharp");

const version = "0.0.3"

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
        // If background removal is requested, process locally with sharp
        if (removeBg) {
            try {
                // Download the original image
                const originalImage = await fetch(src, {
                    headers: {
                        "Accept": "image/*",
                    }
                });
                
                if (!originalImage.ok) {
                    throw new Error(`Failed to fetch original image: ${originalImage.status}`);
                }
                
                const imageBuffer = Buffer.from(await originalImage.arrayBuffer());
                
                // Remove white background
                let processedImage = await removeWhiteBackground(imageBuffer);
                
                // Apply resizing and quality with sharp (since we have the image in memory)
                let sharpImage = sharp(processedImage);
                
                // Apply resize if dimensions are specified
                if (width > 0 || height > 0) {
                    if (width > 0 && height > 0) {
                        sharpImage = sharpImage.resize(parseInt(width), parseInt(height), {
                            fit: 'fill',
                            background: { r: 0, g: 0, b: 0, alpha: 0 } // Transparent background for fill
                        });
                    } else if (width > 0) {
                        sharpImage = sharpImage.resize(parseInt(width), null);
                    } else if (height > 0) {
                        sharpImage = sharpImage.resize(null, parseInt(height));
                    }
                }
                
                // Apply quality (for PNG, this affects compression level)
                const outputBuffer = await sharpImage.png({ 
                    quality: parseInt(quality),
                    compressionLevel: 9 - Math.floor(parseInt(quality) / 11.33) // Map quality 0-100 to compression 0-9
                }).toBuffer();
                
                const headers = new Headers({
                    "Content-Type": "image/png",
                    "Server": "NextImageTransformation"
                });
                
                if (cacheEnabled) {
                    await writeToCache(cacheKey, outputBuffer, headers, 200, "OK", true); // true = transparent
                }
                headers.set("X-Cache", cacheEnabled ? "MISS" : "BYPASS");
                
                return new Response(outputBuffer, {
                    headers,
                    status: 200,
                    statusText: "OK"
                });
            } catch (bgError) {
                console.error("Error removing background:", bgError);
                // Fall back to normal imgproxy processing if background removal fails
            }
        }
        
        // Normal processing through imgproxy (no background removal)
        const imgproxyPath = `${preset}/resize:fill:${width}:${height}/q:${quality}/plain/${src}`;
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
            await writeToCache(cacheKey, arrayBuffer, headers, image.status, image.statusText, false); // false = normal
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

async function removeWhiteBackground(imageBuffer) {
    // Load the image with sharp and ensure it has an alpha channel
    const image = sharp(imageBuffer).ensureAlpha();
    
    // Get raw pixel data as RGBA
    const { data, info } = await image
        .raw()
        .toBuffer({ resolveWithObject: true });
    
    const width = info.width;
    const height = info.height;
    const pixels = new Uint8Array(data);
    const threshold = whiteBackgroundThreshold; // White threshold (configurable via WHITE_BACKGROUND_THRESHOLD env var)
    const totalPixels = width * height;
    
    // Pre-calculate pixel indices for better performance
    // Use TypedArray for better performance
    const toRemove = new Uint8Array(totalPixels); // 0 = keep, 1 = remove
    const visited = new Uint8Array(totalPixels);
    
    // Efficient queue using head/tail pointers (avoid O(n) shift operations)
    const queue = new Int32Array(totalPixels * 2); // [x, y, x, y, ...]
    let queueHead = 0;
    let queueTail = 0;
    
    const pushQueue = (x, y) => {
        queue[queueTail++] = x;
        queue[queueTail++] = y;
    };
    
    const popQueue = () => {
        const x = queue[queueHead++];
        const y = queue[queueHead++];
        return { x, y };
    };
    
    const isEmpty = () => queueHead >= queueTail;
    
    // Helper to get pixel index (inline for performance)
    const getPixelIdx = (x, y) => (y * width + x) * 4;
    const getPixelPos = (x, y) => y * width + x;
    
    // Fast white check (inline)
    const isWhite = (idx) => {
        return pixels[idx] >= threshold && 
               pixels[idx + 1] >= threshold && 
               pixels[idx + 2] >= threshold;
    };
    
    // Add all edge pixels that are white to the queue
    // Process edges in batches for better cache performance
    for (let x = 0; x < width; x++) {
        // Top edge
        const topIdx = getPixelIdx(x, 0);
        if (isWhite(topIdx)) {
            const pos = x;
            if (!visited[pos]) {
                visited[pos] = 1;
                pushQueue(x, 0);
            }
        }
        
        // Bottom edge
        const bottomPos = (height - 1) * width + x;
        const bottomIdx = getPixelIdx(x, height - 1);
        if (isWhite(bottomIdx)) {
            if (!visited[bottomPos]) {
                visited[bottomPos] = 1;
                pushQueue(x, height - 1);
            }
        }
    }
    
    for (let y = 0; y < height; y++) {
        // Left edge
        const leftPos = y * width;
        const leftIdx = getPixelIdx(0, y);
        if (isWhite(leftIdx)) {
            if (!visited[leftPos]) {
                visited[leftPos] = 1;
                pushQueue(0, y);
            }
        }
        
        // Right edge
        const rightPos = y * width + (width - 1);
        const rightIdx = getPixelIdx(width - 1, y);
        if (isWhite(rightIdx)) {
            if (!visited[rightPos]) {
                visited[rightPos] = 1;
                pushQueue(width - 1, y);
            }
        }
    }
    
    // Flood fill from edge white pixels using efficient queue
    // Process aggressively without yielding for maximum CPU usage
    while (!isEmpty()) {
        const { x, y } = popQueue();
        const pixelPos = getPixelPos(x, y);
        
        // Mark as background to remove
        toRemove[pixelPos] = 1;
        
        // Check 4-connected neighbors (unrolled and optimized for performance)
        // Process all neighbors in one pass for better CPU utilization
        
        // Left neighbor
        if (x > 0) {
            const leftPos = pixelPos - 1;
            if (!visited[leftPos]) {
                const leftIdx = (pixelPos - 1) * 4;
                if (pixels[leftIdx] >= threshold && 
                    pixels[leftIdx + 1] >= threshold && 
                    pixels[leftIdx + 2] >= threshold) {
                    visited[leftPos] = 1;
                    pushQueue(x - 1, y);
                }
            }
        }
        
        // Right neighbor
        if (x < width - 1) {
            const rightPos = pixelPos + 1;
            if (!visited[rightPos]) {
                const rightIdx = (pixelPos + 1) * 4;
                if (pixels[rightIdx] >= threshold && 
                    pixels[rightIdx + 1] >= threshold && 
                    pixels[rightIdx + 2] >= threshold) {
                    visited[rightPos] = 1;
                    pushQueue(x + 1, y);
                }
            }
        }
        
        // Up neighbor
        if (y > 0) {
            const upPos = pixelPos - width;
            if (!visited[upPos]) {
                const upIdx = upPos * 4;
                if (pixels[upIdx] >= threshold && 
                    pixels[upIdx + 1] >= threshold && 
                    pixels[upIdx + 2] >= threshold) {
                    visited[upPos] = 1;
                    pushQueue(x, y - 1);
                }
            }
        }
        
        // Down neighbor
        if (y < height - 1) {
            const downPos = pixelPos + width;
            if (!visited[downPos]) {
                const downIdx = downPos * 4;
                if (pixels[downIdx] >= threshold && 
                    pixels[downIdx + 1] >= threshold && 
                    pixels[downIdx + 2] >= threshold) {
                    visited[downPos] = 1;
                    pushQueue(x, y + 1);
                }
            }
        }
    }
    
    // Apply the mask: remove only pixels marked as background
    // Process all pixels aggressively for maximum CPU usage
    for (let i = 0; i < pixels.length; i += 4) {
        if (toRemove[i >> 2]) { // i / 4 using bit shift (faster)
            pixels[i + 3] = 0; // Set alpha to 0 (fully transparent)
        }
    }
    
    // Convert processed pixels back to PNG with transparency preserved
    return await sharp(pixels, {
        raw: {
            width: info.width,
            height: info.height,
            channels: 4
        }
    })
    .png()
    .toBuffer();
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
        await Promise.all([
            writeFile(filePath, new Uint8Array(data)),
            writeFile(metaPath, JSON.stringify({
                headers: serializedHeaders,
                status,
                statusText,
                isTransparent // Track if image has transparent background
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

    let itemCount = 0;
    let imageBytes = 0;
    let metadataBytes = 0;
    let normalCount = 0;
    let normalBytes = 0;
    let transparentCount = 0;
    let transparentBytes = 0;

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
                    } catch (e) {
                        // Image file doesn't exist, skip
                    }
                }
            } catch (e) {
                // Failed to read metadata, skip
            }
        } else {
            // Only count if not already processed via metadata
            if (!processedFiles.has(entry.name)) {
                itemCount += 1;
                imageBytes += size;
            }
        }
    }

    return {
        cacheEnabled: true,
        cacheDir,
        entries: itemCount,
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