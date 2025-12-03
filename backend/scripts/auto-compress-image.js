#!/usr/bin/env node
/**
 * Auto-compress images while preserving full color quality.
 *
 * Features:
 * - Preserves full 24-bit color (no palette conversion)
 * - Maintains ICC color profiles
 * - Supports JPEG, PNG, WebP, AVIF formats
 * - Shows compression statistics
 *
 * Usage:
 *   node auto-compress-image.js <inputPath> [quality]
 *
 * Examples:
 *   node auto-compress-image.js photo.jpg           # Uses default 85% quality
 *   node auto-compress-image.js photo.jpg 90        # Uses 90% quality
 *   node auto-compress-image.js character.png 95    # High quality PNG
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_QUALITY = 85; // 85% quality = ~15% compression, preserves colors

const SUPPORTED_FORMATS = ['jpeg', 'jpg', 'png', 'webp', 'avif', 'tiff'];

// ============================================================================
// Helpers
// ============================================================================

const toMB = (bytes) => (bytes / (1024 * 1024)).toFixed(2);
const toKB = (bytes) => (bytes / 1024).toFixed(1);

const formatSize = (bytes) => {
  if (bytes >= 1024 * 1024) return `${toMB(bytes)} MB`;
  return `${toKB(bytes)} KB`;
};

const calcSavings = (original, compressed) => {
  const saved = original - compressed;
  const percent = ((saved / original) * 100).toFixed(1);
  return { saved, percent };
};

const clampQuality = (value) => {
  const num = parseInt(value, 10);
  if (Number.isNaN(num)) return DEFAULT_QUALITY;
  return Math.min(100, Math.max(1, num));
};

// ============================================================================
// Compression Pipeline
// ============================================================================

async function compressImage(inputPath, quality) {
  const image = sharp(inputPath);
  const metadata = await image.metadata();
  const format = (metadata.format || path.extname(inputPath).slice(1)).toLowerCase();

  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new Error(`Unsupported format: ${format}. Supported: ${SUPPORTED_FORMATS.join(', ')}`);
  }

  // Preserve color profiles and metadata
  const pipeline = image.clone().withMetadata();

  switch (format) {
    case 'jpeg':
    case 'jpg':
      pipeline.jpeg({
        quality,
        mozjpeg: true,              // Better compression algorithm
        progressive: true,          // Progressive loading
        chromaSubsampling: '4:4:4', // Full color - NO subsampling (preserves color fidelity)
      });
      break;

    case 'png':
      // PNG is lossless by nature - we only control compression level
      pipeline.png({
        compressionLevel: 6,        // 0-9: Balance between speed and size
        palette: false,             // CRITICAL: false = 16.7M colors, true = 256 colors only!
        adaptiveFiltering: true,    // Better compression ratios
        effort: 7,                  // 1-10: Higher = smaller file, slower
      });
      break;

    case 'webp':
      pipeline.webp({
        quality,
        effort: 4,                  // 0-6: Compression effort
        smartSubsample: true,       // Better color preservation
        nearLossless: quality >= 90, // Near-lossless for high quality settings
      });
      break;

    case 'avif':
      pipeline.avif({
        quality,
        effort: 4,                  // 0-9: Compression effort
        chromaSubsampling: '4:4:4', // Full color fidelity
      });
      break;

    case 'tiff':
      pipeline.tiff({
        quality,
        compression: 'lzw',         // Lossless compression
      });
      break;

    default:
      throw new Error(`No compression handler for format: ${format}`);
  }

  return { pipeline, format, metadata };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
Auto-Compress Image - Preserves Full Color Quality

Usage:
  node auto-compress-image.js <inputPath> [quality]

Arguments:
  inputPath   Path to the image file
  quality     Quality level 1-100 (default: ${DEFAULT_QUALITY})

Examples:
  node auto-compress-image.js photo.jpg
  node auto-compress-image.js photo.jpg 90
  node auto-compress-image.js character.png 95

Supported Formats: ${SUPPORTED_FORMATS.join(', ')}
`);
    process.exit(0);
  }

  const inputArg = args[0];
  const qualityArg = args[1];

  const inputPath = path.resolve(process.cwd(), inputArg);
  const quality = clampQuality(qualityArg || DEFAULT_QUALITY);

  // Validate input
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: File not found: ${inputPath}`);
    process.exit(1);
  }

  try {
    const sourceStats = fs.statSync(inputPath);
    const sourceSize = sourceStats.size;

    console.log('\n📷 Compressing image...\n');

    // Compress
    const { pipeline, format, metadata } = await compressImage(inputPath, quality);

    // Generate output path
    const { dir, name, ext } = path.parse(inputPath);
    const outputExt = ext || `.${format}`;
    const outputPath = path.join(dir, `${name}-compressed${outputExt}`);

    // Write output
    await pipeline.toFile(outputPath);

    const compressedStats = fs.statSync(outputPath);
    const compressedSize = compressedStats.size;
    const { saved, percent } = calcSavings(sourceSize, compressedSize);

    // Results
    console.log('┌─────────────────────────────────────────────────────────');
    console.log('│ COMPRESSION RESULTS');
    console.log('├─────────────────────────────────────────────────────────');
    console.log(`│ Input     : ${inputPath}`);
    console.log(`│ Output    : ${outputPath}`);
    console.log('├─────────────────────────────────────────────────────────');
    console.log(`│ Format    : ${format.toUpperCase()}`);
    console.log(`│ Quality   : ${quality}%`);
    console.log(`│ Dimensions: ${metadata.width} x ${metadata.height}`);
    console.log('├─────────────────────────────────────────────────────────');
    console.log(`│ Original  : ${formatSize(sourceSize)}`);
    console.log(`│ Compressed: ${formatSize(compressedSize)}`);
    console.log(`│ Saved     : ${formatSize(saved)} (${percent}% reduction)`);
    console.log('└─────────────────────────────────────────────────────────\n');

    if (compressedSize >= sourceSize) {
      console.log('⚠️  Note: Compressed file is same size or larger. Original may already be optimized.\n');
    } else {
      console.log('✅ Compression complete! Colors preserved with full fidelity.\n');
    }

  } catch (error) {
    console.error(`\n❌ Compression failed: ${error.message}\n`);
    process.exit(1);
  }
}

main();
