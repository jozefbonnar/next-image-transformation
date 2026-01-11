const { readdir, unlink, stat } = require("node:fs/promises");
const { constants: fsConstants } = require("node:fs");
const { join } = require("node:path");

const cacheDir = process?.env?.CACHE_DIR || "./cache";

// Get sharded cache path: use first 2 chars of hash to create subdirectories
function getShardedCachePath(key) {
    if (key.length < 2) {
        return join(cacheDir, key);
    }
    const subdir = key.substring(0, 2);
    return join(cacheDir, subdir, key);
}

async function cleanupDuplicates() {
    console.log(`Starting cleanup of duplicate files in ${cacheDir}...`);
    console.log(`This will delete files from the root directory that already exist in sharded subdirectories.\n`);

    try {
        // Read all entries from the root cache directory
        const entries = await readdir(cacheDir, { withFileTypes: true });

        // Filter to only files (not subdirectories)
        const files = entries.filter(entry => entry.isFile());
        
        if (files.length === 0) {
            console.log("No files found in cache directory. Nothing to cleanup.");
            return;
        }

        console.log(`Found ${files.length} files to check...\n`);

        let deletedCount = 0;
        let keptCount = 0;
        let errorCount = 0;
        let totalBytesFreed = 0;

        // Process files in batches for better progress reporting
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const fileName = file.name;

            // Skip files that are too short (shouldn't be cache files)
            if (fileName.length < 2) {
                keptCount++;
                continue;
            }

            // Skip if it looks like a subdirectory name (2 hex chars)
            const isSubdirName = /^[0-9a-f]{2}$/i.test(fileName);
            if (isSubdirName) {
                keptCount++;
                continue;
            }

            try {
                const rootPath = join(cacheDir, fileName);
                const shardedPath = getShardedCachePath(fileName);

                // Check if file exists in sharded location
                try {
                    await stat(shardedPath);
                    // File exists in sharded location - delete the duplicate in root
                    const fileSize = (await stat(rootPath)).size;
                    await unlink(rootPath);
                    deletedCount++;
                    totalBytesFreed += fileSize;

                    // Also delete the .json metadata file if it exists
                    try {
                        const rootMetaPath = `${rootPath}.json`;
                        const shardedMetaPath = `${shardedPath}.json`;
                        await stat(shardedMetaPath); // Check if metadata exists in sharded location
                        const metaSize = (await stat(rootMetaPath)).size;
                        await unlink(rootMetaPath);
                        totalBytesFreed += metaSize;
                    } catch (e) {
                        // Metadata doesn't exist or error - that's okay, continue
                    }

                    // Progress reporting every 100 files
                    if ((i + 1) % 100 === 0) {
                        console.log(`Processed ${i + 1}/${files.length} files... (${deletedCount} deleted, ${keptCount} kept, ${errorCount} errors)`);
                    }
                } catch (e) {
                    // File doesn't exist in sharded location - keep it in root (backwards compatibility)
                    keptCount++;
                }
            } catch (error) {
                errorCount++;
                console.error(`Error processing file ${fileName}:`, error.message);
            }
        }

        const freedMB = (totalBytesFreed / (1024 * 1024)).toFixed(2);

        console.log(`\nCleanup complete!`);
        console.log(`  - Deleted: ${deletedCount} duplicate files`);
        console.log(`  - Kept: ${keptCount} files (not in sharded locations)`);
        console.log(`  - Errors: ${errorCount} files`);
        console.log(`  - Space freed: ${freedMB} MB`);
        console.log(`\nDuplicate files have been removed from the root cache directory.`);
    } catch (error) {
        console.error("Fatal error during cleanup:", error);
        process.exit(1);
    }
}

// Run the cleanup
cleanupDuplicates();

