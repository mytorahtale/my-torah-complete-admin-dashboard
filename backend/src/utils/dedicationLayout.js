const path = require('path');
const { registerFont } = require('canvas');

const CANVAS_WIDTH = 5375;
const CANVAS_HEIGHT = 2975;
const HALF_WIDTH = CANVAS_WIDTH / 2;
const KID_WIDTH_RATIO = 0.44;
const KID_HEIGHT_RATIO = 0.88;
const TEXT_PADDING_RATIO = 0.08;
const TEXT_HEIGHT_RATIO = 0.64;
const TEXT_TOP_RATIO = 0.18;

const ensureFontsRegistered = (() => {
  let registered = false;
  return () => {
    if (registered) return;
    const fontDir = path.join(__dirname, '..', '..', 'fonts');
    const fonts = [
      { file: 'CanvaSans-Regular.otf', family: 'CanvaSans', weight: '400' },
      { file: 'CanvaSans-Medium.otf', family: 'CanvaSans', weight: '500' },
      { file: 'CanvaSans-Bold.otf', family: 'CanvaSans', weight: '700' },
      { file: 'CanvaSans-RegularItalic.otf', family: 'CanvaSans', weight: '400', style: 'italic' },
      { file: 'CanvaSans-MediumItalic.otf', family: 'CanvaSans', weight: '500', style: 'italic' },
      { file: 'CanvaSans-BoldItalic.otf', family: 'CanvaSans', weight: '700', style: 'italic' },
    ];
    fonts.forEach(({ file, ...options }) => {
      try {
        registerFont(path.join(fontDir, file), options);
      } catch (error) {
        console.warn('[dedicationLayout] Failed to register font', file, error.message);
      }
    });
    registered = true;
  };
})();

const sanitizeText = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  return String(value || '').trim();
};

const splitLines = (value) =>
  sanitizeText(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const fitFontSize = (ctx, lines, { target, min, maxWidth, weight }) => {
  if (!lines.length) return 0;

  const safeMaxWidth = Math.max(1, maxWidth);
  let size = Math.max(Math.round(target), Math.round(min));

  while (size > min) {
    ctx.font = `${weight} ${size}px "CanvaSans"`;
    const tooWide = lines.some((line) => ctx.measureText(line).width > safeMaxWidth);
    if (!tooWide) return size;
    size -= Math.max(2, Math.round(size * 0.06));
  }

  size = Math.max(Math.round(min), 20);
  ctx.font = `${weight} ${size}px "CanvaSans"`;
  let stillTooWide = lines.some((line) => ctx.measureText(line).width > safeMaxWidth);
  while (stillTooWide && size > 20) {
    size -= Math.max(1, Math.round(size * 0.05));
    ctx.font = `${weight} ${size}px "CanvaSans"`;
    stillTooWide = lines.some((line) => ctx.measureText(line).width > safeMaxWidth);
  }

  return Math.max(size, 20);
};

const drawKidImage = (ctx, image) => {
  if (!image) return;

  const kidAspect = image.width / image.height;

  // Always cover full height, adjust width based on aspect ratio
  const drawHeight = CANVAS_HEIGHT;
  const drawWidth = drawHeight * kidAspect;

  // Align to right edge of left half, extending leftward
  const drawX = HALF_WIDTH - drawWidth;
  const drawY = 0;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.45)';
  ctx.shadowBlur = 55;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 25;
  ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  ctx.restore();
};

const drawTextBlock = (ctx, { area, title, subtitle }) => {
  const primary = splitLines(title);
  const secondary = splitLines(subtitle);
  if (!primary.length && !secondary.length) return;

  const maxWidth = area.width;
  const areaHeight = area.height;

  const titleTarget = Math.min(480, maxWidth * 0.6, areaHeight * 0.5);
  const titleMin = Math.max(140, Math.round(Math.min(maxWidth, areaHeight) * 0.18));
  const titleSize = primary.length
    ? fitFontSize(ctx, primary, {
        target: titleTarget,
        min: titleMin,
        maxWidth,
        weight: 'bold',
      })
    : 0;

  let subtitleSize = 0;
  if (secondary.length) {
    const subtitleBase = titleSize
      ? Math.max(Math.min(titleSize * 0.95, titleSize - 5), 0)
      : Math.min(420, maxWidth * 0.55, areaHeight * 0.45);
    const subtitleMin = Math.max(170, Math.round(Math.min(maxWidth, areaHeight) * 0.2));
    const subtitleTarget = Math.max(subtitleBase, subtitleMin);
    subtitleSize = fitFontSize(ctx, secondary, {
      target: subtitleTarget,
      min: subtitleMin,
      maxWidth: maxWidth * 1.2,
      weight: 'normal',
    });

    subtitleSize = Math.round(subtitleSize * 1);

    if (titleSize && subtitleSize >= titleSize * 0.98) {
      subtitleSize = Math.max(titleSize * 0.95, subtitleMin);
    }
  }

  const titleLineHeight = primary.length && titleSize ? titleSize * 1.05 : 0;
  const titleSpacing = primary.length > 1 && titleSize ? Math.round(titleSize * 0.2) : 0;
  const titleBlockHeight =
    primary.length && titleSize
      ? primary.length * titleLineHeight + (primary.length - 1) * titleSpacing
      : 0;

  const subtitleLineHeight = secondary.length && subtitleSize ? subtitleSize * 1.08 : 0;
  const subtitleSpacing =
    secondary.length > 1 && subtitleSize ? Math.round(subtitleSize * 0.22) : 0;
  const subtitleBlockHeight =
    secondary.length && subtitleSize
      ? secondary.length * subtitleLineHeight + (secondary.length - 1) * subtitleSpacing
      : 0;

  const gap =
    primary.length && secondary.length
      ? Math.max(Math.round(Math.min(titleSize || 0, subtitleSize || 0) * 0.9), 70)
      : 0;

  const totalHeight = titleBlockHeight + subtitleBlockHeight + gap;
  const centerX = area.x + area.width / 2;
  const leftX = area.x + area.width * 0.02;
  let cursorY = area.y + (area.height - totalHeight) / 2;

  ctx.save();
  ctx.fillStyle = '#FFFFFF';

  if (primary.length && titleSize) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `bold ${Math.round(titleSize)}px "CanvaSans"`;
    primary.forEach((line, index) => {
      cursorY += titleLineHeight;
      ctx.fillText(line, centerX, cursorY);
      if (index < primary.length - 1) {
        cursorY += titleSpacing;
      }
    });
  }

  if (secondary.length && subtitleSize) {
    if (primary.length && titleSize) {
      cursorY += gap;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `normal ${Math.round(subtitleSize)}px "CanvaSans"`;
    secondary.forEach((line, index) => {
      cursorY += subtitleLineHeight;
      ctx.fillText(line, leftX, cursorY);
      if (index < secondary.length - 1) {
        cursorY += subtitleSpacing;
      }
    });
  }

  ctx.restore();
};

module.exports = {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  HALF_WIDTH,
  KID_WIDTH_RATIO,
  KID_HEIGHT_RATIO,
  TEXT_PADDING_RATIO,
  TEXT_HEIGHT_RATIO,
  TEXT_TOP_RATIO,
  ensureFontsRegistered,
  splitLines,
  fitFontSize,
  drawKidImage,
  drawTextBlock,
};
