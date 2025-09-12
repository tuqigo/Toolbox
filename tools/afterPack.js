const fs = require('fs');
const path = require('path');

/**
 * electron-builder afterPack hook
 * - Keep only en-US and zh-CN locale packs
 * - Verify better-sqlite3 native binary is unpacked
 */
module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir; // e.g., dist/win-unpacked
  const resourcesDir = path.join(appOutDir, 'resources');
  const rootLocalesDir = path.join(appOutDir, 'locales');
  const resourcesLocalesDir = path.join(resourcesDir, 'locales');
  const keepLocales = new Set(['en-US.pak', 'zh-CN.pak']);

  try {
    // Prune locales in possible locations: appOutDir/locales and resources/locales
    const candidateDirs = [rootLocalesDir, resourcesLocalesDir].filter((p, idx, arr) => !!p && arr.indexOf(p) === idx);
    let totalRemoved = 0;
    let prunedAtLeastOne = false;
    for (const dir of candidateDirs) {
      if (fs.existsSync(dir)) {
        const allFiles = fs.readdirSync(dir);
        let removed = 0;
        for (const fileName of allFiles) {
          if (!keepLocales.has(fileName)) {
            const filePath = path.join(dir, fileName);
            try {
              fs.unlinkSync(filePath);
              removed += 1;
            } catch (err) {
              console.warn(`[afterPack] Failed to remove locale: ${path.join(path.basename(dir), fileName)}`, err);
            }
          }
        }
        totalRemoved += removed;
        prunedAtLeastOne = true;
        console.log(`[afterPack] locales pruned at ${dir}. kept=${Array.from(keepLocales).join(', ')} removed=${removed}`);
      }
    }
    if (!prunedAtLeastOne) {
      console.log('[afterPack] locales directory not found in appOutDir or resources, skipping prune');
    }

    // Verify better-sqlite3 native addon exists in unpacked dir
    const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
    const bsqlDir = path.join(unpackedDir, 'node_modules', 'better-sqlite3', 'build', 'Release');
    const candidate = path.join(bsqlDir, 'better_sqlite3.node');
    if (!fs.existsSync(candidate)) {
      // Try alternative names just in case
      const alt = fs.existsSync(bsqlDir)
        ? fs.readdirSync(bsqlDir).find((f) => f.endsWith('.node'))
        : undefined;
      if (!alt) {
        throw new Error('[afterPack] better-sqlite3 native binary missing in app.asar.unpacked/build/Release');
      }
    }
    console.log('[afterPack] verified better-sqlite3 native addon is present');
  } catch (err) {
    console.error('[afterPack] error during post-pack optimization:', err);
    throw err; // fail build to avoid shipping broken artifacts
  }
};


