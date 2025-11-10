const path = require('path');
const { createCanvas, loadImage, registerFont } = require('canvas');
const fetch = require('node-fetch');
const Replicate = require('replicate');

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const registerCoverFonts = (() => {
  let registered = false;
  return () => {
    if (registered) return;
    const fontDir = path.join(__dirname, '..', '..', 'fonts');
    const fontEntries = [
      { file: 'CanvaSans-Regular.otf', family: 'CanvaSans', weight: '400' },
      { file: 'CanvaSans-Medium.otf', family: 'CanvaSans', weight: '500' },
      { file: 'CanvaSans-Bold.otf', family: 'CanvaSans', weight: '700' },
      { file: 'CanvaSans-RegularItalic.otf', family: 'CanvaSans', weight: '400', style: 'italic' },
      { file: 'CanvaSans-MediumItalic.otf', family: 'CanvaSans', weight: '500', style: 'italic' },
      { file: 'CanvaSans-BoldItalic.otf', family: 'CanvaSans', weight: '700', style: 'italic' },
    ];
    fontEntries.forEach(({ file, ...options }) => {
      try {
        registerFont(path.join(fontDir, file), options);
      } catch (error) {
        console.warn('[coverGenerator] Failed to register font', file, error.message);
      }
    });
    registered = true;
  };
})();

/**
 * Helper function to draw rounded rectangles
 */
function drawRoundedRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Box blur implementation
 */
function boxBlur(imageData, width, height, radius) {
  const pixels = imageData.data;
  const tempPixels = new Uint8ClampedArray(pixels);

  // Horizontal pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;

      for (let kx = -radius; kx <= radius; kx++) {
        const px = x + kx;
        if (px >= 0 && px < width) {
          const idx = (y * width + px) * 4;
          r += pixels[idx];
          g += pixels[idx + 1];
          b += pixels[idx + 2];
          a += pixels[idx + 3];
          count++;
        }
      }

      const idx = (y * width + x) * 4;
      tempPixels[idx] = r / count;
      tempPixels[idx + 1] = g / count;
      tempPixels[idx + 2] = b / count;
      tempPixels[idx + 3] = a / count;
    }
  }

  // Vertical pass
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;

      for (let ky = -radius; ky <= radius; ky++) {
        const py = y + ky;
        if (py >= 0 && py < height) {
          const idx = (py * width + x) * 4;
          r += tempPixels[idx];
          g += tempPixels[idx + 1];
          b += tempPixels[idx + 2];
          a += tempPixels[idx + 3];
          count++;
        }
      }

      const idx = (y * width + x) * 4;
      pixels[idx] = r / count;
      pixels[idx + 1] = g / count;
      pixels[idx + 2] = b / count;
      pixels[idx + 3] = a / count;
    }
  }

  return imageData;
}

/**
 * Get font size from font string
 */
function getFontSize(font) {
  const match = /([0-9]+(?:\.[0-9]+)?)px/.exec(font);
  return match ? parseFloat(match[1]) : 24;
}

/**
 * Build wrapped text lines
 */
function buildWrappedLines(ctx, segments, maxWidth) {
  const groups = { before: [], after: [] };
  let currentGroup = groups.before;

  segments.forEach((segment) => {
    if (segment.type === 'qrBreak') {
      currentGroup = groups.after;
      return;
    }

    if (segment.type === 'spacer') {
      currentGroup.push({
        type: 'spacer',
        size: segment.size ?? 24,
      });
      return;
    }

    if (segment.type === 'text') {
      const font = segment.font || '30px "CanvaSans"';
      const lineHeight = segment.lineHeight || 1.3;
      const color = segment.color;

      const rawLines = segment.text.split(/\r?\n/);
      rawLines.forEach((rawLine) => {
        if (!rawLine.trim()) {
          currentGroup.push({
            type: 'spacer',
            size: getFontSize(font) * (lineHeight + 0.2),
          });
          return;
        }

        currentGroup.push({
          type: 'text',
          text: rawLine,
          font,
          lineHeight,
          color,
        });
      });
    }
  });

  return groups;
}

/**
 * Layout text lines with positioning
 */
function layoutTextLines(ctx, lines, startX, startY) {
  const positioned = [];
  let cursorY = startY;
  let top = Infinity;
  let bottom = -Infinity;

  lines.forEach((line) => {
    if (line.type === 'spacer') {
      cursorY += line.size;
      return;
    }

    if (line.type === 'text') {
      const fontSize = getFontSize(line.font);
      const leading = line.lineHeight || 1.3;
      ctx.font = line.font || '30px "CanvaSans"';
      const measuredWidth = ctx.measureText(line.text).width;
      cursorY += fontSize;

      positioned.push({
        ...line,
        x: startX,
        y: cursorY,
        width: measuredWidth,
      });

      top = Math.min(top, cursorY - fontSize * 1.05);
      bottom = Math.max(bottom, cursorY);

      cursorY += Math.round(fontSize * Math.max(leading - 1, 0.25));
    }
  });

  if (!positioned.length) {
    top = startY;
    bottom = startY;
  }

  return { lines: positioned, top, bottom, cursor: cursorY };
}

function drawHeroTitle(ctx, childName, width, height, overrides = {}) {
  const safeName =
    childName && childName.trim() ? childName.trim().toUpperCase() : 'YOUR CHILD';
  const topLine =
    typeof overrides.mainTitle === 'string' && overrides.mainTitle.trim()
      ? overrides.mainTitle.trim()
      : `${safeName}'S TRIP`;
  const bottomLine =
    typeof overrides.subtitle === 'string' && overrides.subtitle.trim()
      ? overrides.subtitle.trim()
      : 'TO ISRAEL';

  const textX = width * 0.75;
  const bottomMargin = 250;
  const topY = height - bottomMargin - 280;
  const bottomY = topY + 280;

  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  const topGradient = ctx.createLinearGradient(0, topY - 280, 0, topY);
  topGradient.addColorStop(0, '#FFE082');
  topGradient.addColorStop(0.3, '#FFD54F');
  topGradient.addColorStop(0.7, '#FFB300');
  topGradient.addColorStop(1, '#FF9800');

  ctx.font = '700 280px "CanvaSans"';
  ctx.strokeStyle = '#1565C0';
  ctx.lineWidth = 35;
  ctx.strokeText(topLine, textX, topY);
  ctx.fillStyle = topGradient;
  ctx.fillText(topLine, textX, topY);

  const bottomGradient = ctx.createLinearGradient(0, bottomY - 200, 0, bottomY);
  bottomGradient.addColorStop(0, '#FFE082');
  bottomGradient.addColorStop(0.3, '#FFD54F');
  bottomGradient.addColorStop(0.7, '#FFB300');
  bottomGradient.addColorStop(1, '#FF9800');

  ctx.font = '700 200px "CanvaSans"';
  ctx.strokeStyle = '#1565C0';
  ctx.lineWidth = 28;
  ctx.strokeText(bottomLine, textX, bottomY);
  ctx.fillStyle = bottomGradient;
  ctx.fillText(bottomLine, textX, bottomY);
}

/**
 * Load image from buffer or URL
 */
async function loadImageFromSource(source) {
  if (Buffer.isBuffer(source)) {
    return await loadImage(source);
  } else if (typeof source === 'string') {
    // It's a URL
    const response = await fetch(source);
    const buffer = await response.buffer();
    return await loadImage(buffer);
  }
  throw new Error('Invalid image source');
}

/**
 * Generate cover page
 */
async function generateCoverPage(options) {
  const {
    backgroundImage,
    characterImage = null,
    leftSide = {},
    rightSide = {},
    qrCode = null,
    childName = '',
  } = options;

  registerCoverFonts();

  // Load background image
  const bgImage = await loadImageFromSource(backgroundImage);
  const width = bgImage.width;
  const height = bgImage.height;

  // Add 0.75 inch margin on all sides at 300 DPI (print quality)
  // 0.75 inch × 300 DPI = 225 pixels
  const MARGIN = 225;
  const canvasWidth = width + (MARGIN * 2);
  const canvasHeight = height + (MARGIN * 2);

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // Fill with white background (margin area)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Translate context to add margin offset to all drawing operations
  ctx.save();
  ctx.translate(MARGIN, MARGIN);

  // Draw background image
  ctx.drawImage(bgImage, 0, 0, width, height);

  // Load and draw character image if provided with transparent background
  let charImage = null;
  if (characterImage) {
    try {
      console.log('Loading and removing background from character image...');

      // Determine if characterImage is a URL or buffer
      let imageUrl;
      if (Buffer.isBuffer(characterImage)) {
        // If it's a buffer, we need to convert it to a URL or handle it differently
        // For now, let's assume it's a URL string
        imageUrl = characterImage;
      } else {
        imageUrl = characterImage;
      }

      // Remove background using Replicate API
      const removeBgInput = { image: imageUrl };
      const bgRemovedOutput = await replicate.run('bria/remove-background', {
        input: removeBgInput,
      });

      // Load the background-removed image
      const bgRemovedImageResponse = await fetch(bgRemovedOutput);
      const bgRemovedImageBuffer = await bgRemovedImageResponse.buffer();
      charImage = await loadImage(Buffer.from(bgRemovedImageBuffer));

      console.log('Background removed successfully from character image');
    } catch (error) {
      console.warn('Failed to load or process character image:', error.message);
    }
  }

  if (charImage) {
    const baseWidthRatio = 0.4 * 1.1;
    const baseHeightRatio = 0.8 * 1.1;
    const charAreaWidth = width * baseWidthRatio;
    const charAreaHeight = height * baseHeightRatio;
    const horizontalMargin = width * 0.02;
    const bottomMargin = height * 0.02;
    const areaX = width - charAreaWidth - horizontalMargin;
    const areaY = Math.max(-height * 0.02, height - charAreaHeight - bottomMargin);

    const charAspectRatio = charImage.width / charImage.height;
    const targetAspectRatio = charAreaWidth / charAreaHeight;

    let drawWidth;
    let drawHeight;

    if (charAspectRatio > targetAspectRatio) {
      drawWidth = charAreaWidth;
      drawHeight = drawWidth / charAspectRatio;
    } else {
      drawHeight = charAreaHeight;
      drawWidth = drawHeight * charAspectRatio;
    }

    const drawX = areaX + (charAreaWidth - drawWidth) / 2;
    const drawY = areaY + (charAreaHeight - drawHeight);

    ctx.drawImage(charImage, drawX, drawY, drawWidth, drawHeight);
  }

  // Load QR code if provided
  let qrImage = null;
  if (qrCode) {
    try {
      qrImage = await loadImageFromSource(qrCode);
    } catch (error) {
      console.warn('Failed to load QR code:', error.message);
    }
  }

  const safeChildName =
    typeof childName === 'string' && childName.trim()
      ? childName.trim()
      : 'Your child';

  const defaultTitle = `Join ${safeChildName} on an Unforgettable Adventure Across Israel!`;
  const defaultContent = `From the sparkling shores of the Kinneret to the ancient stones of the Kotel, ${safeChildName} is on a journey like no other! With his trusty backpack and endless curiosity, he explores Israel's most treasured landmarks - floating in the Dead Sea, climbing Masada at sunrise, and dancing through the colorful streets of Jerusalem.
Packed with wonder, learning, and heart, ${safeChildName}'s Trip to Israel is the perfect introduction to the Land of Israel for young explorers everywhere.`;
  const defaultFooter = 'Shop more books at Mytorahtales.com';

  const resolvedTitle =
    typeof leftSide.title === 'string' && leftSide.title.trim() ? leftSide.title : defaultTitle;
  const resolvedContent =
    typeof leftSide.content === 'string' && leftSide.content.trim()
      ? leftSide.content
      : defaultContent;
  const resolvedFooter =
    typeof leftSide.bottomText === 'string' && leftSide.bottomText.trim()
      ? leftSide.bottomText
      : defaultFooter;

  const textSegments = [];

  if (resolvedTitle) {
    textSegments.push({
      type: 'text',
      text: resolvedTitle,
      font: '600 100px "CanvaSans"',
      lineHeight: 1.08,
      color: 'rgba(255,255,255,0.96)',
    });
    textSegments.push({ type: 'spacer', size: 28 });
  }

  if (resolvedContent) {
    textSegments.push({
      type: 'text',
      text: resolvedContent,
      font: '400 70px "CanvaSans"',
      lineHeight: 1.45,
      color: 'rgba(255,255,255,0.92)',
    });
  }

  textSegments.push({ type: 'qrBreak' });
  textSegments.push({ type: 'spacer', size: 28 });

  if (resolvedFooter) {
    textSegments.push({
      type: 'text',
      text: resolvedFooter,
      font: '700 60px "CanvaSans"',
      lineHeight: 1.1,
      color: 'rgba(255,255,255,0.94)',
    });
  }

  // Calculate text layout
  const textX = width * 0.06;
  const textStartY = height * 0.22;
  const textMaxWidth = width * 0.32;

  const textGroups = buildWrappedLines(ctx, textSegments, textMaxWidth);
  const beforeLayout = layoutTextLines(ctx, textGroups.before, textX, textStartY);

  // QR code dimensions and layout
  const qrSize = qrImage ? Math.min(height * 0.10, Math.max(width * 0.06, 100)) : 0;
  const qrGapTop = qrImage ? 50 : 0;
  const qrGapBottom = qrImage ? 50 : 0;
  const qrY = qrImage ? beforeLayout.bottom + qrGapTop : beforeLayout.bottom;

  const afterLayout = layoutTextLines(
    ctx,
    textGroups.after,
    textX,
    qrY + (qrImage ? qrSize + qrGapBottom : 0)
  );

  // Calculate blur box dimensions
  const blurPaddingX = width * 0.03;
  let blurX = Math.max(0, textX - blurPaddingX);
  const baseMaxLineWidth = Math.max(
    textMaxWidth,
    beforeLayout.lines.reduce((max, line) => Math.max(max, line.width || 0), 0)
  );

  const computeBlurMetrics = () => {
    const textContentTop = beforeLayout.top - 10;
    let textContentBottom = beforeLayout.bottom;
    if (afterLayout.lines.length > 0) {
      textContentBottom = afterLayout.bottom;
    }
    if (qrImage) {
      textContentBottom = Math.max(textContentBottom, qrY + qrSize);
    }

    const lastLineGroup = afterLayout.lines.length ? afterLayout.lines : beforeLayout.lines;
    const lastLine = lastLineGroup[lastLineGroup.length - 1];
    const lastFontSize = lastLine ? getFontSize(lastLine.font) : 0;
    const dynamicPadding = Math.max(40, Math.round(lastFontSize * 0.6));
    const topPadding = 70;
    const bottomPadding = Math.max(100, dynamicPadding);
    const blurHeight = (textContentBottom - textContentTop) + topPadding + bottomPadding;
    let blurY = textContentTop - topPadding;
    if (blurY < 0) blurY = 0;
    if (blurY + blurHeight > height) {
      blurY = Math.max(0, height - blurHeight);
    }

    const afterMaxWidth = afterLayout.lines.reduce(
      (max, line) => Math.max(max, line.width || 0),
      0
    );
    const maxLineWidth = Math.max(baseMaxLineWidth, afterMaxWidth, qrImage ? qrSize : 0);
    const desiredWidth = maxLineWidth + blurPaddingX * 2;
    let effectiveBlurX = blurX;
    let blurWidth = desiredWidth;

    if (effectiveBlurX + blurWidth > width) {
      if (desiredWidth >= width) {
        effectiveBlurX = 0;
        blurWidth = width;
      } else {
        effectiveBlurX = Math.max(0, width - desiredWidth);
        blurWidth = desiredWidth;
      }
    }

    return { blurHeight, blurY, blurWidth, blurX: effectiveBlurX };
  };

  const { blurHeight, blurY, blurWidth, blurX: effectiveBlurX } = computeBlurMetrics();
  blurX = effectiveBlurX;

  const overlayRadius = 20;

  // Create and apply blur
  if (blurHeight > 0 && blurWidth > 0) {
    const scale = 0.5;
    const tempWidth = Math.floor(blurWidth * scale);
    const tempHeight = Math.floor(blurHeight * scale);

    const blurCanvas = createCanvas(tempWidth, tempHeight);
    const blurCtx = blurCanvas.getContext('2d');

    blurCtx.drawImage(
      bgImage,
      blurX,
      blurY,
      blurWidth,
      blurHeight,
      0,
      0,
      tempWidth,
      tempHeight
    );

    const imageData = blurCtx.getImageData(0, 0, tempWidth, tempHeight);

    const blurRadius = 15;
    for (let i = 0; i < 8; i++) {
      boxBlur(imageData, tempWidth, tempHeight, blurRadius);
    }

    blurCtx.putImageData(imageData, 0, 0);

    ctx.save();
    drawRoundedRect(ctx, blurX, blurY, blurWidth, blurHeight, overlayRadius);
    ctx.clip();
    ctx.drawImage(blurCanvas, blurX, blurY, blurWidth, blurHeight);

    drawRoundedRect(ctx, blurX, blurY, blurWidth, blurHeight, overlayRadius);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fill();

    ctx.restore();
  }

  // Draw text
  const allTextLines = beforeLayout.lines.concat(afterLayout.lines);
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  allTextLines.forEach((line) => {
    ctx.font = line.font;
    ctx.fillStyle = line.color || '#ffffff';

    if (line.text.includes('Shop more books')) {
      ctx.textAlign = 'center';
      const centerX = blurX + blurWidth / 2;
      ctx.fillText(line.text, centerX, line.y);
    } else {
      ctx.textAlign = 'left';
      ctx.fillText(line.text, line.x, line.y);
    }
  });

  // Draw QR code
  if (qrImage && blurHeight > 0) {
    const qrX = blurX + (blurWidth - qrSize) / 2;
    const frameX = qrX - 18;
    const frameY = qrY - 18;
    const frameSize = qrSize + 36;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 20;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 10;
    drawRoundedRect(ctx, frameX, frameY, frameSize, frameSize, 28);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fill();
    ctx.restore();

    ctx.drawImage(qrImage, qrX, qrY, qrSize, qrSize);
  }

  drawHeroTitle(ctx, childName, width, height, rightSide);

  // Restore context (end margin offset)
  ctx.restore();

  return canvas.toBuffer('image/png');
}

module.exports = {
  generateCoverPage,
};
