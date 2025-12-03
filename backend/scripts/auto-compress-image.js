#!/usr/bin/env node
/**
 * Auto-compress an image without resizing it.
 * Quality rules:
 *  - > 10MB  => quality 35
 *  - 4-10MB => quality 45
 *  - < 4MB  => quality 50
 *
 * Usage:
 *   node auto-compress-image.js [inputPath]
 * Example:
 *   node auto-compress-image.js img-compression.jpg
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const inputArg = process.argv[2];
const inputPath = inputArg
  ? path.resolve(process.cwd(), inputArg)
  : path.join(__dirname, 'img-compression.jpg');

if (!fs.existsSync(inputPath)) {
  console.error(`Input image not found: ${inputPath}`);
  process.exit(1);
}

const TEN_MB = 10 * 1024 * 1024;
const FOUR_MB = 4 * 1024 * 1024;

const pickQuality = (size) => {
  if (size > TEN_MB) return 35;
  if (size >= FOUR_MB) return 45;
  return 50;
};

async function compress() {
  try {
    const stat = fs.statSync(inputPath);
    const sourceSize = stat.size;
    const image = sharp(inputPath);
    const metadata = await image.metadata();
    const format = (metadata.format || path.parse(inputPath).ext.replace('.', '')).toLowerCase();
    const quality = pickQuality(sourceSize);

    const { dir, name, ext } = path.parse(inputPath);
    const defaultExt = ext || '.jpg';
    const outputPath = path.join(dir, `${name}-auto-q${quality}${defaultExt}`);

    const pipeline = image.clone().withMetadata();
    switch (format) {
      case 'jpeg':
      case 'jpg':
        pipeline.jpeg({
          quality,
          mozjpeg: true,
          progressive: true,
          chromaSubsampling: '4:4:4',
        });
        break;
      case 'png':
        pipeline.png({
          compressionLevel: 9,
          palette: true,
          quality,
          adaptiveFiltering: true,
        });
        break;
      case 'webp':
        pipeline.webp({ quality });
        break;
      default:
        throw new Error(`Unsupported format for compression: ${format}`);
    }

    await pipeline.toFile(outputPath);
    const compressedSize = fs.statSync(outputPath).size;

    const toMB = (bytes) => (bytes / (1024 * 1024)).toFixed(2);
    console.log(`Input : ${inputPath} (${toMB(sourceSize)} MB)`);
    console.log(`Output: ${outputPath} (${toMB(compressedSize)} MB)`);
    console.log(`Format: ${format.toUpperCase()} | Applied quality: ${quality}`);
  } catch (error) {
    console.error('Compression failed:', error.message);
    process.exit(1);
  }
}

compress();
