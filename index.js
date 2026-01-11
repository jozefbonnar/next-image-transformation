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

// Get sharded cache path: use first 2 chars of hash to create subdirectories
// This prevents performance issues with thousands of files in a single directory
function getShardedCachePath(key) {
    if (key.length < 2) {
        // Fallback for edge cases (shouldn't happen with SHA256)
        return join(cacheDir, key);
    }
    const subdir = key.substring(0, 2);
    return join(cacheDir, subdir, key);
}

async function readFromCache(key) {
    try {
        const filePath = getShardedCachePath(key);
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
        const filePath = getShardedCachePath(key);
        const metaPath = `${filePath}.json`;
        
        // Ensure subdirectory exists for sharded path
        const subdir = join(cacheDir, key.substring(0, 2));
        await mkdir(subdir, { recursive: true });
        
        const serializedHeaders = Array.from(headers.entries()).filter(
            ([name]) => name.toLowerCase() !== "x-cache"
        );
        
        const metadata = {
            headers: serializedHeaders,
            status,
            statusText,
            isTransparent // Track if image has transparent background
        };
        
        // Write both image and metadata - ensure both succeed
        const metadataJson = JSON.stringify(metadata);
        
        const [imageResult, metaResult] = await Promise.allSettled([
            writeFile(filePath, new Uint8Array(data)),
            writeFile(metaPath, metadataJson)
        ]);
        
        if (imageResult.status === 'rejected') {
            console.error("Failed to write image cache file:", imageResult.reason);
        }
        
        if (metaResult.status === 'rejected') {
            console.error("Failed to write image cache metadata:", metaResult.reason);
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

// Helper function to process files in a directory and accumulate stats
async function processCacheDirectory(dirPath, stats, dirStats = null) {
    try {
        const entries = await readdir(dirPath, { withFileTypes: true });
        const processedFiles = new Set();

        // FIRST PASS: Process all JSON metadata files first
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (!entry.name.endsWith(".json")) continue;
            
            const filePath = join(dirPath, entry.name);
            const size = (await stat(filePath)).size;
            stats.metadataBytes += size;
            if (dirStats) {
                dirStats.metadataBytes += size;
            }
            
            // Skip empty metadata files
            if (size === 0) continue;
            
            // Read metadata to check if image is transparent
            try {
                const metaRaw = await readFile(filePath, "utf8");
                if (!metaRaw || metaRaw.trim() === "") continue;
                
                const meta = JSON.parse(metaRaw);
                const baseName = entry.name.replace(".json", "");
                
                // Check if corresponding image file exists
                const imageFilePath = join(dirPath, baseName);
                try {
                    await access(imageFilePath, fsConstants.F_OK);
                    const imageSize = (await stat(imageFilePath)).size;
                    
                    // Skip empty image files
                    if (imageSize === 0) {
                        processedFiles.add(imageFilePath);
                        continue;
                    }
                    
                    if (meta.isTransparent === true) {
                        stats.transparentCount++;
                        stats.transparentBytes += imageSize;
                        if (dirStats) {
                            dirStats.transparentCount++;
                            dirStats.transparentBytes += imageSize;
                        }
                    } else {
                        stats.normalCount++;
                        stats.normalBytes += imageSize;
                        if (dirStats) {
                            dirStats.normalCount++;
                            dirStats.normalBytes += imageSize;
                        }
                    }
                    processedFiles.add(imageFilePath);
                    stats.imageBytes += imageSize;
                    if (dirStats) {
                        dirStats.imageBytes += imageSize;
                        dirStats.count++;
                    }
                } catch (e) {
                    // Image file doesn't exist, skip this metadata file
                }
            } catch (e) {
                // Failed to read/parse metadata - skip
            }
        }

        // SECOND PASS: Process remaining non-JSON files (uncategorized images without metadata)
        for (const entry of entries) {
            if (!entry.isFile()) continue;
            if (entry.name.endsWith(".json")) continue;
            
            const filePath = join(dirPath, entry.name);
            const size = (await stat(filePath)).size;
            
            // Image file without metadata (uncategorized)
            if (!processedFiles.has(filePath) && size > 0) {
                stats.uncategorizedCount++;
                stats.uncategorizedBytes += size;
                stats.imageBytes += size;
                processedFiles.add(filePath);
                if (dirStats) {
                    dirStats.uncategorizedCount++;
                    dirStats.uncategorizedBytes += size;
                    dirStats.count++;
                }
            }
        }
    } catch (e) {
        // Directory doesn't exist or can't be read - skip
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

    const stats = {
        imageBytes: 0,
        metadataBytes: 0,
        normalCount: 0,
        normalBytes: 0,
        transparentCount: 0,
        transparentBytes: 0,
        uncategorizedCount: 0,
        uncategorizedBytes: 0
    };

    const directoryStats = new Map(); // Track stats per directory

    // Process root directory (for backwards compatibility with old cache files)
    const rootDirStats = {
        count: 0,
        imageBytes: 0,
        metadataBytes: 0,
        normalCount: 0,
        normalBytes: 0,
        transparentCount: 0,
        transparentBytes: 0,
        uncategorizedCount: 0,
        uncategorizedBytes: 0
    };
    await processCacheDirectory(cacheDir, stats, rootDirStats);
    if (rootDirStats.count > 0) {
        directoryStats.set("(root)", rootDirStats);
    }

    // Process all sharded subdirectories (00-ff)
    // Generate all possible 2-character hex combinations
    for (let i = 0; i < 256; i++) {
        const subdir = i.toString(16).padStart(2, '0');
        const subdirPath = join(cacheDir, subdir);
        const dirStats = {
            count: 0,
            imageBytes: 0,
            metadataBytes: 0,
            normalCount: 0,
            normalBytes: 0,
            transparentCount: 0,
            transparentBytes: 0,
            uncategorizedCount: 0,
            uncategorizedBytes: 0
        };
        await processCacheDirectory(subdirPath, stats, dirStats);
        if (dirStats.count > 0) {
            directoryStats.set(subdir, dirStats);
        }
    }

    const totalCount = stats.normalCount + stats.transparentCount + stats.uncategorizedCount;

    // Calculate distribution statistics
    const shardedDirs = Array.from(directoryStats.entries()).filter(([name]) => name !== "(root)");
    const dirCounts = shardedDirs.map(([, d]) => d.count).filter(c => c > 0);
    const distribution = {
        totalSubdirectories: shardedDirs.length,
        emptySubdirectories: 256 - shardedDirs.length,
        minFilesPerDir: dirCounts.length > 0 ? Math.min(...dirCounts) : 0,
        maxFilesPerDir: dirCounts.length > 0 ? Math.max(...dirCounts) : 0,
        avgFilesPerDir: dirCounts.length > 0 ? Number((dirCounts.reduce((a, b) => a + b, 0) / dirCounts.length).toFixed(2)) : 0,
        medianFilesPerDir: dirCounts.length > 0 ? calculateMedian(dirCounts) : 0
    };

    // Get top and bottom directories by file count
    const sortedDirs = Array.from(directoryStats.entries())
        .filter(([name]) => name !== "(root)")
        .sort((a, b) => b[1].count - a[1].count);
    
    const topDirectories = sortedDirs.slice(0, 10).map(([name, dirStats]) => ({
        subdirectory: name,
        count: dirStats.count,
        sizeMB: toMB(dirStats.imageBytes + dirStats.metadataBytes),
        normalCount: dirStats.normalCount,
        transparentCount: dirStats.transparentCount
    }));

    const bottomDirectories = sortedDirs.slice(-10).reverse().map(([name, dirStats]) => ({
        subdirectory: name,
        count: dirStats.count,
        sizeMB: toMB(dirStats.imageBytes + dirStats.metadataBytes),
        normalCount: dirStats.normalCount,
        transparentCount: dirStats.transparentCount
    }));

    const result = {
        cacheEnabled: true,
        cacheDir,
        entries: totalCount,
        imageMB: toMB(stats.imageBytes),
        metadataMB: toMB(stats.metadataBytes),
        totalMB: toMB(stats.imageBytes + stats.metadataBytes),
        normalImages: {
            count: stats.normalCount,
            sizeMB: toMB(stats.normalBytes)
        },
        transparentImages: {
            count: stats.transparentCount,
            sizeMB: toMB(stats.transparentBytes)
        },
        uncategorizedImages: {
            count: stats.uncategorizedCount,
            sizeMB: toMB(stats.uncategorizedBytes)
        },
        distribution,
        topDirectories,
        bottomDirectories
    };

    // Add root directory stats if it has files
    if (directoryStats.has("(root)")) {
        const rootStats = directoryStats.get("(root)");
        result.rootDirectory = {
            count: rootStats.count,
            sizeMB: toMB(rootStats.imageBytes + rootStats.metadataBytes),
            normalCount: rootStats.normalCount,
            transparentCount: rootStats.transparentCount
        };
    }

    return result;
}

function calculateMedian(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 
        ? Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(2))
        : sorted[mid];
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