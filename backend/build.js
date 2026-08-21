import { minify } from 'terser';
import fs from 'fs';
import path from 'path';

const filesToBuild = [
  'store.js',
  'shell.js',
  'utils.js',
  'sw.js',
  'ussdEngine.js'
];

const outputDir = './production_dist';

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

async function buildProductionAssets() {
  console.log('🚀 Starting Terser Production Build for Kwabz Store...');
  let totalSavedBytes = 0;

  for (const file of filesToBuild) {
    if (fs.existsSync(file)) {
      const originalCode = fs.readFileSync(file, 'utf8');
      const originalSize = Buffer.byteLength(originalCode, 'utf8');

      try {
        const minified = await minify(originalCode, {
          compress: {
            drop_console: true,   // Removes all console.log, console.warn, console.info
            drop_debugger: true   // Removes debugger statements
          },
          mangle: {
            toplevel: false
          },
          output: {
            comments: false       // Strips all comments
          }
        });

        if (minified.code) {
          const dest = path.join(outputDir, file);
          fs.writeFileSync(dest, minified.code, 'utf8');
          const minifiedSize = Buffer.byteLength(minified.code, 'utf8');
          const savedBytes = originalSize - minifiedSize;
          totalSavedBytes += savedBytes;

          console.log(`✅ [Terser] ${file} → ${dest} (${(originalSize / 1024).toFixed(1)} KB -> ${(minifiedSize / 1024).toFixed(1)} KB, Saved ${(savedBytes / 1024).toFixed(1)} KB | Console logs stripped)`);
        }
      } catch (err) {
        console.error(`❌ [Terser Error] Failed to minify ${file}:`, err.message);
      }
    }
  }

  console.log(`\n🎉 Terser Build Complete! Total saved: ${(totalSavedBytes / 1024).toFixed(1)} KB across production assets.`);
}

buildProductionAssets();
