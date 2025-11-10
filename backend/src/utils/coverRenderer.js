const path = require('path');
const { createCanvas, loadImage, registerFont } = require('canvas');

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
      { file: 'CanvaSans-BoldItalic.otf', family: 'CanvaSans', weight: '700', style: 'italic' },
      { file: 'CanvaSans-MediumItalic.otf', family: 'CanvaSans', weight: '500', style: 'italic' },
    ];
    fontEntries.forEach(({ file, ...options }) => {
      try {
        registerFont(path.join(fontDir, file), options);
      } catch (error) {
        console.warn('[coverRenderer] Failed to register font', file, error.message);
      }
    });
    registered = true;
  };
})();

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

function boxBlur(imageData, width, height, radius) {
  const pixels = imageData.data;
  const tempPixels = new Uint8ClampedArray(pixels);

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

function fitImageCover(ctx, image, width, height) {
  const imgRatio = image.width / image.height;
  const canvasRatio = width / height;
  let drawWidth = width;
  let drawHeight = height;
  let offsetX = 0;
  let offsetY = 0;

  if (imgRatio > canvasRatio) {
    drawHeight = height;
    drawWidth = drawHeight * imgRatio;
    offsetX = -(drawWidth - width) / 2;
  } else {
    drawWidth = width;
    drawHeight = drawWidth / imgRatio;
    offsetY = -(drawHeight - height) / 2;
  }

  ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

function createTextSegments({ childName, headline, bodyText, footer }) {
  const safeChildName =
    typeof childName === 'string' && childName.trim() ? childName.trim() : 'Your child';

  const defaultHeadline = `Join ${safeChildName} on an Unforgettable Adventure Across Israel!`;
  const defaultBody = `From the sparkling shores of the Kinneret to the ancient stones of the Kotel, ${safeChildName} is on a journey like no other! With his trusty backpack and endless curiosity, he explores Israel's most treasured landmarks - floating in the Dead Sea, climbing Masada at sunrise, and dancing through the colorful streets of Jerusalem.
Packed with wonder, learning, and heart, ${safeChildName}'s Trip to Israel is the perfect introduction to the Land of Israel for young explorers everywhere.`;
  const defaultFooter = 'Shop more books at Mytorahtales.com';

  const resolvedHeadline = headline && headline.trim() ? headline : defaultHeadline;
  const resolvedBody = bodyText && bodyText.trim() ? bodyText : defaultBody;
  const resolvedFooter = footer && footer.trim() ? footer : defaultFooter;

  const segments = [];
  if (resolvedHeadline) {
    segments.push({
      type: 'text',
      text: resolvedHeadline,
      font: '600 100px "CanvaSans"',
      lineHeight: 1.08,
      color: 'rgba(255,255,255,0.96)',
    });
    segments.push({ type: 'spacer', size: 28 });
  }
  if (resolvedBody) {
    segments.push({
      type: 'text',
      text: resolvedBody,
      font: '400 70px "CanvaSans"',
      lineHeight: 1.45,
      color: 'rgba(255,255,255,0.92)',
    });
  }
  segments.push({ type: 'qrBreak' });
  segments.push({ type: 'spacer', size: 28 });
  if (resolvedFooter) {
    segments.push({
      type: 'text',
      text: resolvedFooter,
      font: '700 60px "CanvaSans"',
      lineHeight: 1.1,
      color: 'rgba(255,255,255,0.94)',
    });
  }
  return segments;
}

function getFontSize(font) {
  const match = /([0-9]+(?:\.[0-9]+)?)px/.exec(font);
  return match ? parseFloat(match[1]) : 24;
}

function layoutText(ctx, segments, startX, startY, maxWidth) {
  const groups = { before: [], after: [] };
  let currentGroup = groups.before;
  segments.forEach((segment) => {
    if (segment.type === 'qrBreak') {
      currentGroup = groups.after;
      return;
    }
    if (segment.type === 'spacer') {
      currentGroup.push({ type: 'spacer', size: segment.size ?? 24 });
      return;
    }
    if (segment.type === 'text') {
      const font = segment.font || '30px "CanvaSans"';
      const lineHeight = segment.lineHeight || 1.3;
      const color = segment.color;
      segment.text.split(/\r?\n/).forEach((rawLine) => {
        if (!rawLine.trim()) {
          currentGroup.push({ type: 'spacer', size: getFontSize(font) * (lineHeight + 0.2) });
          return;
        }
        currentGroup.push({ type: 'text', text: rawLine, font, lineHeight, color });
      });
    }
  });
  return groups;
}

function layoutLines(ctx, lines, startX, startY) {
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
      positioned.push({ ...line, x: startX, y: cursorY, width: measuredWidth });
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

function drawHeroTitle(ctx, childName, width, height) {
  const safeName = childName && childName.trim() ? childName.trim().toUpperCase() : 'YOUR CHILD';
  const topLine = `${safeName}'S TRIP`;
  const bottomLine = 'TO ISRAEL';

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

async function renderCoverToCanvas({
  pageWidth,
  pageHeight,
  backgroundBuffer,
  characterBuffer,
  qrBuffer,
  cover,
  bodyText,
  childName,
}) {
  registerCoverFonts();

  // Add 0.75 inch margin on all sides at 300 DPI (print quality)
  // 0.75 inch × 300 DPI = 225 pixels
  const MARGIN = 225;
  const canvasWidth = pageWidth + (MARGIN * 2);
  const canvasHeight = pageHeight + (MARGIN * 2);

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  // Fill with white background (margin area)
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Translate context to add margin offset to all drawing operations
  ctx.save();
  ctx.translate(MARGIN, MARGIN);

  // Draw black background for content area
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, pageWidth, pageHeight);

  let backgroundImage = null;
  if (backgroundBuffer) {
    try {
      backgroundImage = await loadImage(backgroundBuffer);
      fitImageCover(ctx, backgroundImage, pageWidth, pageHeight);
    } catch (error) {
      console.warn('[coverRenderer] Failed to load background image:', error.message);
      backgroundImage = null;
      ctx.fillStyle = '#0b1d3a';
      ctx.fillRect(0, 0, pageWidth, pageHeight);
    }
  } else {
    ctx.fillStyle = '#0b1d3a';
    ctx.fillRect(0, 0, pageWidth, pageHeight);
  }

  let characterImage = null;
  if (characterBuffer) {
    try {
      characterImage = await loadImage(characterBuffer);
    } catch (error) {
      console.warn('[coverRenderer] Failed to load character image:', error.message);
      characterImage = null;
    }
  }

  if (characterImage) {
    const baseWidthRatio = 0.4 * 1.1;
    const baseHeightRatio = 0.8 * 1.1;
    const charAreaWidth = pageWidth * baseWidthRatio;
    const charAreaHeight = pageHeight * baseHeightRatio;
    const horizontalMargin = pageWidth * 0.02;
    const bottomMargin = pageHeight * 0.02;
    const areaX = pageWidth - charAreaWidth - horizontalMargin;
    const areaY = Math.max(-pageHeight * 0.02, pageHeight - charAreaHeight - bottomMargin);

    const charAspectRatio = characterImage.width / characterImage.height;
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
    ctx.drawImage(characterImage, drawX, drawY, drawWidth, drawHeight);
  }

  const segments = createTextSegments({
    childName,
    headline: cover?.headline || '',
    bodyText,
    footer: cover?.footer || '',
  });

  const textX = pageWidth * 0.06;
  const textStartY = pageHeight * 0.22;
  const textMaxWidth = pageWidth * 0.32;

  const textGroups = layoutText(ctx, segments, textX, textStartY, textMaxWidth);
  const beforeLayout = layoutLines(ctx, textGroups.before, textX, textStartY);

  const blurPaddingX = pageWidth * 0.03;

  let qrImage = null;
  if (qrBuffer) {
    try {
      qrImage = await loadImage(qrBuffer);
    } catch (error) {
      console.warn('[coverRenderer] Failed to load QR image:', error.message);
      qrImage = null;
    }
  }

  const qrGapTop = qrImage ? 50 : 0;
  const qrGapBottom = qrImage ? 50 : 0;

  const qrSize = qrImage
    ? Math.min(pageHeight * 0.1, Math.max(pageWidth * 0.06, 100))
    : 0;

  let blurX = Math.max(0, textX - blurPaddingX);
  const baseMaxLineWidth = Math.max(
    textMaxWidth,
    beforeLayout.lines.reduce((max, line) => Math.max(max, line.width || 0), 0)
  );

  const computeLayout = (qrYPosition) => {
    const afterLayout = layoutLines(
      ctx,
      textGroups.after,
      textX,
      qrYPosition + (qrImage ? qrSize + qrGapBottom : 0)
    );

    const internalPadding = 100;
    const textContentTop = beforeLayout.top - 10;
    let textContentBottom = beforeLayout.bottom;

    if (afterLayout.lines.length) {
      textContentBottom = afterLayout.bottom;
    }
    if (qrImage) {
      textContentBottom = Math.max(textContentBottom, qrYPosition + qrSize);
    }

    const lastLineGroup = afterLayout.lines.length ? afterLayout.lines : beforeLayout.lines;
    const lastLine = lastLineGroup[lastLineGroup.length - 1];
    const lastFontSize = lastLine ? getFontSize(lastLine.font) : 0;
    const dynamicPadding = Math.max(40, Math.round(lastFontSize * 0.6));

    const topPadding = 70;
    const bottomPadding = Math.max(100, dynamicPadding);
    const blurHeight = textContentBottom - textContentTop + topPadding + bottomPadding;
    let blurY = textContentTop - topPadding;
    if (blurY < 0) {
      blurY = 0;
    }
    if (blurY + blurHeight > pageHeight) {
      blurY = Math.max(0, pageHeight - blurHeight);
    }

    const afterMaxWidth = afterLayout.lines.reduce(
      (max, line) => Math.max(max, line.width || 0),
      0
    );
    const maxLineWidth = Math.max(baseMaxLineWidth, afterMaxWidth, qrImage ? qrSize : 0);
    const desiredWidth = maxLineWidth + blurPaddingX * 2;
    let effectiveBlurX = blurX;
    let blurWidth = desiredWidth;

    if (effectiveBlurX + blurWidth > pageWidth) {
      if (desiredWidth >= pageWidth) {
        effectiveBlurX = 0;
        blurWidth = pageWidth;
      } else {
        effectiveBlurX = Math.max(0, pageWidth - desiredWidth);
        blurWidth = desiredWidth;
      }
    }

    return { afterLayout, blurY, blurHeight, blurWidth, blurX: effectiveBlurX };
  };

  let qrY = qrImage ? beforeLayout.bottom + qrGapTop : beforeLayout.bottom;
  let { afterLayout, blurY, blurHeight, blurWidth, blurX: effectiveBlurX } = computeLayout(qrY);
  blurX = effectiveBlurX;

  if (blurHeight > 0 && blurWidth > 0) {
    const scale = 0.5;
    const tempWidth = Math.floor(blurWidth * scale);
    const tempHeight = Math.floor(blurHeight * scale);
    const blurCanvas = createCanvas(tempWidth, tempHeight);
    const blurCtx = blurCanvas.getContext('2d');

    if (backgroundImage) {
      blurCtx.drawImage(
        backgroundImage,
        blurX,
        blurY,
        blurWidth,
        blurHeight,
        0,
        0,
        tempWidth,
        tempHeight
      );
    } else {
      blurCtx.fillStyle = 'rgba(12, 32, 78, 0.85)';
      blurCtx.fillRect(0, 0, tempWidth, tempHeight);
    }

    const imageData = blurCtx.getImageData(0, 0, tempWidth, tempHeight);
    const blurRadius = 15;
    for (let i = 0; i < 8; i++) {
      boxBlur(imageData, tempWidth, tempHeight, blurRadius);
    }
    blurCtx.putImageData(imageData, 0, 0);

    ctx.save();
    const overlayRadius = 20;
    drawRoundedRect(ctx, blurX, blurY, blurWidth, blurHeight, overlayRadius);
    ctx.clip();
    ctx.drawImage(blurCanvas, blurX, blurY, blurWidth, blurHeight);

    drawRoundedRect(ctx, blurX, blurY, blurWidth, blurHeight, overlayRadius);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fill();

    ctx.restore();
  }

  const allLines = beforeLayout.lines.concat(afterLayout.lines);
  ctx.textBaseline = 'alphabetic';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  allLines.forEach((line) => {
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

  drawHeroTitle(ctx, childName, pageWidth, pageHeight);

  // Restore context (end margin offset)
  ctx.restore();

  return canvas;
}

async function generateCoverImage(options) {
  const canvas = await renderCoverToCanvas(options);
  return canvas.toBuffer('image/png');
}

module.exports = {
  generateCoverImage,
  renderCoverToCanvas,
};
