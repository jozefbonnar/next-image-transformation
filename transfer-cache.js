const { mkdir, readdir, rename, stat } = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const { join } = require("node:path");

const cacheDir = process?.env?.CACHE_DIR || "./cache";

// Get sharded cache path: use first 2 chars of hash to create subdirectories
function getShardedCachePath(key) {
    if (key.length < 2) {
        // Fallback for edge cases (shouldn't happen with SHA256)
        return join(cacheDir, key);
    }
    const subdir = key.substring(0, 2);
    return join(cacheDir, subdir, key);
}

async function transferCache() {
    console.log(`Starting cache transfer from ${cacheDir}...`);
    console.log(`This will move files from the root cache directory into sharded subdirectories.\n`);

    try {
        // Read all entries from the root cache directory
        const entries = await readdir(cacheDir, { withFileTypes: true });

        // Filter to only files (not subdirectories)
        const files = entries.filter(entry => entry.isFile());
        
        if (files.length === 0) {
            console.log("No files found in cache directory. Nothing to transfer.");
            return;
        }

        console.log(`Found ${files.length} files to process...\n`);

        let movedCount = 0;
        let skippedCount = 0;
        let skippedTooShort = 0;
        let skippedSubdirName = 0;
        let skippedAlreadyExists = 0;
        let errorCount = 0;

        // Process files in batches for better progress reporting
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = file.name;

            // Skip files that are already in subdirectories (shouldn't happen, but just in case)
            if (fileName.length < 2) {
                skippedCount++;
                skippedTooShort++;
                continue;
            }

            // Skip if it looks like a subdirectory name (2 hex chars)
            // We only want to process actual cache files
            const isSubdirName = /^[0-9a-f]{2}$/i.test(fileName);
            if (isSubdirName) {
                skippedCount++;
                skippedSubdirName++;
                continue;
            }

            try {
                const sourcePath = join(cacheDir, fileName);
                const targetPath = getShardedCachePath(fileName);

                // Check if target already exists (file might already be in sharded location)
                try {
                    await stat(targetPath);
                    skippedCount++;
                    skippedAlreadyExists++;
                    continue;
                } catch (e) {
                    // File doesn't exist at target, safe to move
                }

                // Ensure target subdirectory exists
                const subdir = join(cacheDir, fileName.substring(0, 2));
                await mkdir(subdir, { recursive: true });

                // Move the file
                await rename(sourcePath, targetPath);
                movedCount++;

                // Progress reporting every 100 files
                if ((i + 1) % 100 === 0) {
                    console.log(`Processed ${i + 1}/${files.length} files... (${movedCount} moved, ${skippedCount} skipped, ${errorCount} errors)`);
                }
            } catch (error) {
                errorCount++;
                console.error(`Error moving file ${fileName}:`, error.message);
            }
        }

        console.log(`\nTransfer complete!`);
        console.log(`  - Moved: ${movedCount} files`);
        console.log(`  - Skipped: ${skippedCount} files`);
        console.log(`    - Too short (< 2 chars): ${skippedTooShort}`);
        console.log(`    - Subdirectory names (2 hex chars): ${skippedSubdirName}`);
        console.log(`    - Already exists at target: ${skippedAlreadyExists}`);
        console.log(`  - Errors: ${errorCount} files`);
        console.log(`\nCache files have been reorganized into sharded subdirectories.`);
    } catch (error) {
        console.error("Fatal error during transfer:", error);
        process.exit(1);
    }
}

// Run the transfer
transferCache();

