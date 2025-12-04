#!/usr/bin/env node

/**
 * Split a PDF so that every page after the first is divided vertically into left/right halves.
 * - The first page is kept as-is.
 * - Remaining pages become two pages each (left half, right half), with content anchored at x=0.
 *
 * Usage:
 *   node backend/scripts/split-pdf.js [input.pdf] [output.pdf]
 *
 * Defaults:
 *   input: backend/scripts/pdf.pdf
 *   output: backend/scripts/pdf-split.pdf
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb } = require('pdf-lib');

async function splitPdf(inputPath, outputPath) {
  const sourceBytes = fs.readFileSync(inputPath);
  const sourcePdf = await PDFDocument.load(sourceBytes);
  const targetPdf = await PDFDocument.create();

  const pageCount = sourcePdf.getPageCount();
  if (pageCount === 0) {
    throw new Error('Input PDF has no pages');
  }

  // Copy the first page unchanged
  const [firstEmbedded] = await targetPdf.embedPdf(sourceBytes, [0]);
  const firstPage = targetPdf.addPage([firstEmbedded.width, firstEmbedded.height]);
  firstPage.drawPage(firstEmbedded);

  // Process remaining pages: split into left/right halves
  for (let i = 1; i < pageCount; i += 1) {
    const [embeddedPage] = await targetPdf.embedPdf(sourceBytes, [i]);
    const originalWidth = embeddedPage.width;
    const originalHeight = embeddedPage.height;
    const halfWidth = originalWidth / 2;

    // Left half
    const leftPage = targetPdf.addPage([halfWidth, originalHeight]);
    leftPage.drawPage(embeddedPage, {
      x: 0,
      y: 0,
      width: originalWidth,
      height: originalHeight,
    });
    // Mask overflow to keep only the left half
    leftPage.drawRectangle({
      x: halfWidth,
      y: 0,
      width: halfWidth,
      height: originalHeight,
      color: rgb(1, 1, 1),
    });

    // Right half
    const rightPage = targetPdf.addPage([halfWidth, originalHeight]);
    rightPage.drawPage(embeddedPage, {
      x: -halfWidth,
      y: 0,
      width: originalWidth,
      height: originalHeight,
    });
    // Mask overflow to keep only the right half
    rightPage.drawRectangle({
      x: -halfWidth,
      y: 0,
      width: halfWidth,
      height: originalHeight,
      color: rgb(1, 1, 1),
    });
  }

  const outputBytes = await targetPdf.save();
  fs.writeFileSync(outputPath, outputBytes);
  console.log(`✅ Split PDF saved to ${outputPath} (pages: ${targetPdf.getPageCount()})`);
}

async function main() {
  const inputArg = process.argv[2];
  const outputArg = process.argv[3];
  const defaultInput = path.join(__dirname, 'pdf.pdf');
  const defaultOutput = path.join(__dirname, 'pdf-split.pdf');

  const inputPath = inputArg ? path.resolve(inputArg) : defaultInput;
  const outputPath = outputArg ? path.resolve(outputArg) : defaultOutput;

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input PDF not found: ${inputPath}`);
  }

  await splitPdf(inputPath, outputPath);
}

main().catch((error) => {
  console.error('❌ Failed to split PDF:', error);
  process.exit(1);
});
