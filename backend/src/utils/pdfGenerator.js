const fs = require('fs');
const path = require('path');
const https = require('https');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fetch = require('node-fetch');
const Replicate = require('replicate');
const { downloadFromS3 } = require('../config/s3');
const { createCanvas, loadImage } = require('canvas');
const { generateCoverImage } = require('./coverRenderer');
const { generateCoverPage } = require('./coverGenerator');
const { generateDedicationPage } = require('./dedicationGenerator');

const replicate = new Replicate();

const PAGE_WIDTH = 842; // A4 landscape width in points
const PAGE_HEIGHT = 421; // A4 landscape height in points
const CHARACTER_MAX_WIDTH_RATIO = 0.4;
const CHARACTER_MAX_HEIGHT_RATIO = 0.8;
const TEXT_BLOCK_WIDTH = 300;
const TEXT_BLOCK_WIDTH_RATIO = 0.35;
const TEXT_MARGIN = 40;
const FONT_SIZE = 16;
const LINE_HEIGHT = FONT_SIZE * 1.4;
const TEXT_BASELINE_OFFSET = 18;
const TEXT_BG_LEFT_PADDING = 90;
const TEXT_BG_RIGHT_PADDING = 60;
const TEXT_BG_VERTICAL_PADDING = 40;
const HEBREW_BASE_FONT_SIZE = 16;
const HEBREW_WAVE_AMPLITUDE = 8;
const HEBREW_LINE_SPACING = HEBREW_BASE_FONT_SIZE * 1.4;
const STORYBOOK_PDF_PREFETCH_CONCURRENCY = Math.max(
  1,
  Number(process.env.STORYBOOK_PDF_PREFETCH_CONCURRENCY || 5)
);

const HTTP_AGENT = new https.Agent({
  keepAlive: true,
  timeout: 30000,
  keepAliveMsecs: 30000,
});

const optionalFontPath = (envKey, fallbackRelative) => {
  const fromEnv = process.env[envKey];
  if (fromEnv) return path.resolve(process.cwd(), fromEnv);
  if (fallbackRelative) {
    const resolved = path.resolve(process.cwd(), fallbackRelative);
    if (fs.existsSync(resolved)) return resolved;
  }
  return null;
};

const tryEmbedCustomFont = async (pdfDoc, fontPath) => {
  if (!fontPath) return null;
  try {
    const bytes = fs.readFileSync(fontPath);
    pdfDoc.registerFontkit(fontkit);
    return pdfDoc.embedFont(bytes);
  } catch (error) {
    return null;
  }
};

const fetchBufferFromUrl = async (url) => {
  if (!url) return null;
  if (typeof url !== 'string') {
    throw new Error('Asset URL must be a string');
  }
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    throw new Error('Asset URL must be a non-empty string');
  }

  const isS3Private =
    normalizedUrl.includes('amazonaws.com') && !normalizedUrl.includes('replicate.delivery');

  try {
    const response = await fetch(normalizedUrl, {
      timeout: 30000,
      agent: normalizedUrl.startsWith('https') ? HTTP_AGENT : undefined,
      headers: isS3Private
        ? { 'User-Agent': 'aws-sdk-nodejs/3.x' }
        : {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0 Safari/537.36',
          },
    });
    if (!response.ok) {
      console.warn(`[fetchBufferFromUrl] Failed to fetch ${normalizedUrl}: ${response.status} ${response.statusText}`);
      return null;
    }
    const buffer = await response.buffer();
    console.log('[fetchBufferFromUrl] fetched', normalizedUrl, 'size', buffer.length);
    return buffer;
  } catch (error) {
    console.warn(`[fetchBufferFromUrl] Error fetching ${normalizedUrl}:`, error.message);
    return null;
  }
};

const getImageBuffer = async (source) => {
  if (!source) return null;
  if (source.buffer) return source.buffer;
  if (source.key) {
    try {
      const buffer = await downloadFromS3(source.key);
      if (buffer) return buffer;
    } catch (error) {
      if (error.Code === 'NoSuchKey' || error.name === 'NoSuchKey') {
        console.warn('[pdf] S3 file not found, trying alternate sources. Key:', source.key);
        // Fall through to try other sources
      } else {
        console.warn('[pdf] Error downloading from S3:', error.message);
      }
    }
  }
  if (source.downloadUrl && typeof source.downloadUrl === 'string') {
    return fetchBufferFromUrl(source.downloadUrl);
  }
  if (source.signedUrl && typeof source.signedUrl === 'string') {
    return fetchBufferFromUrl(source.signedUrl);
  }
  if (source.url) {
    return fetchBufferFromUrl(source.url);
  }
  return null;
};

const embedImage = async (pdfDoc, buffer) => {
  if (!buffer) return null;
  try {
    console.log('[pdf] embedding PNG buffer of length', buffer.length);
    return await pdfDoc.embedPng(buffer);
  } catch (error) {
    console.warn('[pdf] embedPng failed, falling back to JPG:', error.message);
    return pdfDoc.embedJpg(buffer);
  }
};

const resolveReplicateOutputBuffer = async (output) => {
  if (!output) return null;
  if (Buffer.isBuffer(output)) return output;
  if (output instanceof Uint8Array) return Buffer.from(output);

  if (typeof output === 'string') {
    console.log('[resolveReplicateOutputBuffer] string output', output.slice(0, 80));
    return fetchBufferFromUrl(output);
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      const buffer = await resolveReplicateOutputBuffer(item);
      if (buffer) return buffer;
    }
    return null;
  }

  if (typeof output === 'object') {
    if (output.output && typeof output.output === 'string') {
      console.log('[resolveReplicateOutputBuffer] direct output string', output.output.slice(0, 120));
      return fetchBufferFromUrl(output.output);
    }

    if (Array.isArray(output.output)) {
      const buffer = await resolveReplicateOutputBuffer(output.output);
      if (buffer) return buffer;
    }

    if (output.output && typeof output.output === 'object') {
      const buffer = await resolveReplicateOutputBuffer(output.output);
      if (buffer) return buffer;
    }

    if (typeof output.image === 'string' && output.image) {
      return fetchBufferFromUrl(output.image);
    }

    if (output.image && typeof output.image === 'object') {
      const buffer = await resolveReplicateOutputBuffer(output.image);
      if (buffer) return buffer;
    }

    if (typeof output.url === 'function') {
      try {
        const urlValue = output.url();
        const resolvedUrl = typeof urlValue === 'string' ? urlValue : await urlValue;
        if (typeof resolvedUrl === 'string' && resolvedUrl) {
          return fetchBufferFromUrl(resolvedUrl);
        }
      } catch (error) {
        // ignore and continue fallbacks
      }
    }

    if (typeof output.url === 'string' && output.url) {
      return fetchBufferFromUrl(output.url);
    }

    if (typeof output.href === 'string' && output.href) {
      return fetchBufferFromUrl(output.href);
    }

    if (typeof output.base64 === 'string' && output.base64) {
      return Buffer.from(output.base64, 'base64');
    }

    if (typeof output.file === 'string' && output.file.startsWith('data:')) {
      const base64 = output.file.split(',')[1];
      if (base64) return Buffer.from(base64, 'base64');
    }

    if (output.urls?.get) {
      try {
        const response = await fetch(output.urls.get, {
          headers: {
            Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
          },
        });
        if (response.ok) {
          const prediction = await response.json();
          return resolveReplicateOutputBuffer(prediction.output);
        }
        console.warn('[resolve] prediction lookup failed', response.status, response.statusText);
      } catch (error) {
        console.warn('[resolve] failed to fetch prediction detail', error.message);
      }
    }
  }

  return null;
};

const resolveAssetPreferredUrl = (asset) => {
  if (!asset || typeof asset !== 'object') return null;
  if (typeof asset.downloadUrl === 'string' && asset.downloadUrl.trim()) {
    return asset.downloadUrl.trim();
  }
  if (typeof asset.signedUrl === 'string' && asset.signedUrl.trim()) {
    return asset.signedUrl.trim();
  }
  if (typeof asset.url === 'string' && asset.url.trim()) {
    return asset.url.trim();
  }
  return null;
};

const resolveGeneratorSource = async (asset) => {
  if (!asset) return null;
  if (typeof asset === 'string' && asset.trim()) {
    return asset.trim();
  }
  const preferredUrl = resolveAssetPreferredUrl(asset);
  if (preferredUrl) return preferredUrl;
  if (asset.buffer) return asset.buffer;
  if (asset.key) {
    try {
      const buffer = await downloadFromS3(asset.key);
      if (buffer) return buffer;
    } catch (error) {
      console.warn('[pdf] failed to download asset buffer for generator:', error.message);
    }
  }
  return null;
};

const buildGeneratorCandidates = async (asset, resolvedSource, label) => {
  const candidates = [];

  if (asset) {
    try {
      const buffer = await getImageBuffer(asset);
      if (buffer && buffer.length) {
        candidates.push(buffer);
      }
    } catch (error) {
      console.warn(
        `[pdf] failed to obtain ${label} buffer for dedication generator:`,
        error.message
      );
    }
  }

  if (Buffer.isBuffer(resolvedSource)) {
    candidates.push(resolvedSource);
  } else if (resolvedSource) {
    candidates.push(resolvedSource);
  }

  return candidates;
};

const replaceChildPlaceholders = (value, childName) => {
  if (!value || typeof value !== 'string') return value || '';
  if (!childName) return value;
  const upperName = childName.toUpperCase();
  return value.replace(/\{name\}/gi, (matched) => {
    const inner = matched.slice(1, -1);
    if (inner === inner.toUpperCase()) {
      return upperName;
    }
    return childName;
  });
};

const performBackgroundRemoval = async (imageUrl) => {
  try {
    console.log('[bria] requesting background removal for:', imageUrl);
    const result = await replicate.run('bria/remove-background', {
      input: {
        image: imageUrl,
      },
    });
    console.log('[bria] remove-background response type:', typeof result);
    console.log('[bria] remove-background response keys:', result && typeof result === 'object' ? Object.keys(result) : 'N/A');
    console.log('[bria] remove-background response constructor:', result && typeof result === 'object' ? result.constructor.name : 'N/A');

    // Handle FileOutput objects (Replicate SDK v1.3.0+)
    if (result && typeof result === 'object' && typeof result.url === 'function') {
      console.log('[bria] detected FileOutput object, calling url() method');
      const urlValue = result.url();
      // Convert URL object to string if needed
      let outputUrl;
      if (typeof urlValue === 'string') {
        outputUrl = urlValue;
      } else if (urlValue && typeof urlValue === 'object' && urlValue.href) {
        // URL object has href property
        outputUrl = urlValue.href;
      } else if (urlValue && typeof urlValue.toString === 'function') {
        outputUrl = urlValue.toString();
      } else {
        outputUrl = await urlValue;
      }
      console.log('[bria] FileOutput URL string:', outputUrl);
      const processedBuffer = await fetchBufferFromUrl(outputUrl);
      console.log('[bria] resolved buffer length', processedBuffer ? processedBuffer.length : null);
      if (processedBuffer && processedBuffer.length) {
        return processedBuffer;
      }
      throw new Error('Background removal returned empty buffer');
    }

    // Handle direct URL string responses (older SDK versions)
    if (typeof result === 'string' && result.trim()) {
      console.log('[bria] direct URL string:', result);
      const processedBuffer = await fetchBufferFromUrl(result);
      console.log('[bria] resolved buffer length', processedBuffer ? processedBuffer.length : null);
      if (processedBuffer && processedBuffer.length) {
        return processedBuffer;
      }
      throw new Error('Background removal returned empty buffer');
    }

    // Handle object responses with nested properties
    if (result && typeof result === 'object') {
      let outputUrl = null;

      // Check various possible response formats
      if (typeof result.output === 'string' && result.output) {
        outputUrl = result.output;
      } else if (Array.isArray(result) && result.length > 0) {
        // Handle array of FileOutput objects
        const firstItem = result[0];
        if (typeof firstItem === 'string') {
          outputUrl = firstItem;
        } else if (firstItem && typeof firstItem.url === 'function') {
          const urlValue = firstItem.url();
          outputUrl = typeof urlValue === 'string' ? urlValue : await urlValue;
        }
      } else if (typeof result.url === 'string' && result.url) {
        outputUrl = result.url;
      }

      if (outputUrl) {
        console.log('[bria] extracted URL from object:', outputUrl);
        const processedBuffer = await fetchBufferFromUrl(outputUrl);
        console.log('[bria] resolved buffer length', processedBuffer ? processedBuffer.length : null);
        if (processedBuffer && processedBuffer.length) {
          return processedBuffer;
        }
        throw new Error('Background removal returned empty buffer');
      }
    }

    // If we get here, we couldn't extract a valid URL
    console.error('[bria] unable to extract URL from response:', JSON.stringify(result));
    throw new Error('No valid output URL in response from remove-background model');
  } catch (error) {
    console.error(`[bria] Background removal failed for ${imageUrl}`);
    console.error(`[bria] Error: ${error.message}`);
    console.error(`[bria] Stack:`, error.stack);
    throw error; // Re-throw the error instead of returning null
  }
};

const removeBackground = async (character) => {
  if (!character) return null;

  const candidates = [];
  const appendCandidate = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!candidates.includes(trimmed)) {
      candidates.push(trimmed);
    }
  };

  appendCandidate(character.url);
  appendCandidate(character.downloadUrl);
  appendCandidate(character.signedUrl);

  if (!candidates.length) {
    return null;
  }

  let lastError = null;

  for (const candidate of candidates) {
    try {
      const buffer = await performBackgroundRemoval(candidate);
      if (buffer && buffer.length) {
        return buffer;
      }
      lastError = new Error('Background removal returned empty buffer');
      console.warn('[bria] empty buffer after background removal attempt for', candidate);
    } catch (error) {
      lastError = error;
      console.warn('[bria] background removal attempt failed for', candidate, ':', error.message);
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const boxBlur = (imageData, width, height, radius) => {
  if (!radius || radius < 1) {
    return imageData;
  }

  const pixels = imageData.data;
  const tempPixels = new Uint8ClampedArray(pixels);

  // Horizontal pass
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let k = -radius; k <= radius; k += 1) {
        const px = x + k;
        if (px >= 0 && px < width) {
          const idx = (y * width + px) * 4;
          r += pixels[idx];
          g += pixels[idx + 1];
          b += pixels[idx + 2];
          a += pixels[idx + 3];
          count += 1;
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
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let k = -radius; k <= radius; k += 1) {
        const py = y + k;
        if (py >= 0 && py < height) {
          const idx = (py * width + x) * 4;
          r += tempPixels[idx];
          g += tempPixels[idx + 1];
          b += tempPixels[idx + 2];
          a += tempPixels[idx + 3];
          count += 1;
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
};

const createBlurredBackground = async (
  backgroundBuffer,
  x,
  y,
  width,
  height,
  blurRadius = 15
) => {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const safeX = clamp(Math.floor(x), 0, PAGE_WIDTH);
  const safeY = clamp(Math.floor(y), 0, PAGE_HEIGHT);

  if (!backgroundBuffer || safeWidth <= 0 || safeHeight <= 0) {
    return null;
  }

  try {
    const backgroundImage = await loadImage(backgroundBuffer);

    const scaleX = backgroundImage.width / PAGE_WIDTH;
    const scaleY = backgroundImage.height / PAGE_HEIGHT;

    const sourceX = clamp(Math.floor(safeX * scaleX), 0, backgroundImage.width);
    const sourceY = clamp(
      Math.floor((PAGE_HEIGHT - safeY - safeHeight) * scaleY),
      0,
      backgroundImage.height
    );
    const sourceWidth = clamp(
      Math.floor(safeWidth * scaleX),
      1,
      backgroundImage.width - sourceX
    );
    const sourceHeight = clamp(
      Math.floor(safeHeight * scaleY),
      1,
      backgroundImage.height - sourceY
    );

    const canvas = createCanvas(safeWidth, safeHeight);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(
      backgroundImage,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      safeWidth,
      safeHeight
    );

    let imageData = ctx.getImageData(0, 0, safeWidth, safeHeight);
    imageData = boxBlur(imageData, safeWidth, safeHeight, blurRadius);
    imageData = boxBlur(imageData, safeWidth, safeHeight, blurRadius);
    ctx.putImageData(imageData, 0, 0);

    const maskedCanvas = createCanvas(safeWidth, safeHeight);
    const maskedCtx = maskedCanvas.getContext('2d');
    maskedCtx.drawImage(canvas, 0, 0);

    const maskData = maskedCtx.getImageData(0, 0, safeWidth, safeHeight);
    const pixels = maskData.data;

    const centerX = safeWidth / 2 - 20;
    const centerY = safeHeight / 2;
    const radiusX = safeWidth / 2.2 * 1.12;
    const radiusY = safeHeight / 2 * 1.12;

    // Match frontend radial gradient: solid from 0% to 82%, fade from 82% to 100%
    const solidThreshold = 0.82; // Start fading at 82% of radius
    const fadeRegion = 1.0 - solidThreshold; // Fade from 82% to 100% (18% region)

    for (let py = 0; py < safeHeight; py += 1) {
      for (let px = 0; px < safeWidth; px += 1) {
        const dx = (px - centerX) / radiusX;
        const dy = (py - centerY) / radiusY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        let alpha = 1;
        if (distance > 1) {
          // Outside ellipse - fully transparent
          alpha = 0;
        } else if (distance > solidThreshold) {
          // Fade region (82% to 100%)
          const fadeProgress = (1 - distance) / fadeRegion;
          alpha = Math.max(0, Math.min(1, fadeProgress));
        }
        // else: inside solid region (0% to 82%) - alpha stays 1

        const idx = (py * safeWidth + px) * 4 + 3;
        pixels[idx] = Math.min(255, pixels[idx] * alpha);
      }
    }

    maskedCtx.putImageData(maskData, 0, 0);
    return maskedCanvas.toBuffer('image/png');
  } catch (error) {
    console.error('[pdf] createBlurredBackground failed:', error.message);
    const fallbackCanvas = createCanvas(safeWidth, safeHeight);
    const fallbackCtx = fallbackCanvas.getContext('2d');
    fallbackCtx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    fallbackCtx.fillRect(0, 0, safeWidth, safeHeight);
    return fallbackCanvas.toBuffer('image/png');
  }
};

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const cloneDeepPlain = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => cloneDeepPlain(item));
  }
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [key, cloneDeepPlain(val)])
    );
  }
  return value;
};

const mapWithConcurrency = async (items, limit, mapper) => {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
  let currentIndex = 0;
  let error = null;

  const worker = async () => {
    while (true) {
      if (error) {
        return;
      }

      const nextIndex = currentIndex;
      currentIndex += 1;
      if (nextIndex >= items.length) {
        return;
      }

      try {
        results[nextIndex] = await mapper(items[nextIndex], nextIndex);
      } catch (err) {
        error = err;
        return;
      }
    }
  };

  const workerCount = Math.min(Math.max(1, limit || 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (error) {
    throw error;
  }

  return results;
};

const prepareStoryPageAssets = async ({ page, index }) => {
  const pageData = page || {};
  const result = {
    index,
    backgroundBuffer: null,
    backgroundError: null,
    character: null,
  };

  try {
    result.backgroundBuffer = await getImageBuffer(pageData.background);
  } catch (error) {
    result.backgroundError = error;
  }

  if (pageData.character) {
    const characterResult = {
      buffer: null,
      source: 'none',
      attemptedRemoval: false,
      removalError: null,
    };

    try {
      if (pageData.character.backgroundRemoved) {
        characterResult.buffer = await getImageBuffer(pageData.character);
        characterResult.source = characterResult.buffer ? 'stored-removed' : 'none';
      } else {
        characterResult.attemptedRemoval = true;
        try {
          const removedBuffer = await removeBackground(pageData.character);
          if (removedBuffer && removedBuffer.length) {
            characterResult.buffer = removedBuffer;
            characterResult.source = 'removed';
          }
        } catch (error) {
          characterResult.removalError = error;
        }

        if (!characterResult.buffer || !characterResult.buffer.length) {
          const fallbackBuffer = await getImageBuffer(pageData.character);
          characterResult.buffer = fallbackBuffer;
          characterResult.source = fallbackBuffer ? 'original' : 'none';
        }
      }
    } catch (error) {
      characterResult.removalError = characterResult.removalError || error;
    }

    result.character = characterResult;
  }

  return result;
};

const wrapText = (text, maxWidth, fontSize) => {
  if (!text) return [];

  // Split by newlines to preserve admin's exact line breaks
  // No auto-wrapping - respect only the line breaks provided by admin
  // This matches the frontend wrapTextToLines function exactly
  // Note: maxWidth and fontSize are kept for API compatibility but not used
  const lines = text.split(/\r?\n/).map(line => line.trim());

  return lines;
};

async function generateStorybookPdf({ title, pages }) {
  const inputPages = Array.isArray(pages) ? pages : [];
  if (inputPages.length === 0) {
    throw new Error('At least one page is required to build the PDF');
  }

  // Clone page data up front to avoid mutations from parallel jobs bleeding across runs
  const pagesToRender = inputPages.map((page) => cloneDeepPlain(page));

  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  pdfDoc.setTitle(title || 'Storybook');
  pdfDoc.setCreator('AI Book Story');
  pdfDoc.setProducer('AI Book Story');

  let bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  let accentFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  let hebrewFont = bodyFont;

  const fontsDir = path.join(__dirname, '..', '..', 'fonts');
  const bodyFontPath = optionalFontPath(
    'STORYBOOK_BODY_FONT',
    path.join(fontsDir, 'CanvaSans-Regular.otf')
  );
  const accentFontPath = optionalFontPath(
    'STORYBOOK_ACCENT_FONT',
    path.join(fontsDir, 'CanvaSans-Bold.otf')
  );
  const hebrewFontPath = optionalFontPath(
    'STORYBOOK_HEBREW_FONT',
    path.join(fontsDir, 'nehama.ttf')
  );

  const customBodyFont = await tryEmbedCustomFont(pdfDoc, bodyFontPath);
  if (customBodyFont) {
    bodyFont = customBodyFont;
  }
  const customAccentFont = await tryEmbedCustomFont(pdfDoc, accentFontPath);
  if (customAccentFont) {
    accentFont = customAccentFont;
  }
  const customHebrewFont = await tryEmbedCustomFont(pdfDoc, hebrewFontPath);
  if (customHebrewFont) {
    hebrewFont = customHebrewFont;
  }

  let prefetchedStoryAssets = new Map();
  const storyPagesForPrefetch = pagesToRender
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => {
      const pageType = (page && page.pageType) || 'story';
      return pageType === 'story';
    });

  if (storyPagesForPrefetch.length) {
    try {
      const prefetchedResults = await mapWithConcurrency(
        storyPagesForPrefetch,
        STORYBOOK_PDF_PREFETCH_CONCURRENCY,
        (entry) => prepareStoryPageAssets(entry)
      );
      prefetchedStoryAssets = new Map(
        prefetchedResults
          .filter((value) => Boolean(value && typeof value.index === 'number'))
          .map((value) => [value.index, value])
      );
    } catch (error) {
      console.warn(
        '[pdf] prefetching story page assets failed, continuing sequential processing:',
        error.message
      );
      prefetchedStoryAssets = new Map();
    }
  }

  const renderedPageBuffers = [];

  for (let index = 0; index < pagesToRender.length; index += 1) {
    const pageData = pagesToRender[index] || {};
    const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const pageType = pageData.pageType || 'story';
    const isCoverPage = pageType === 'cover';
    const isDedicationPage = pageType === 'dedication';
    const isCharacterOnRight = index % 2 === 0;
    let charWidth = 0;
    let charHeight = 0;
    let charX = isCharacterOnRight ? PAGE_WIDTH - PAGE_WIDTH * CHARACTER_MAX_WIDTH_RATIO : 0;
    const charY = 0;
    const childName = pageData.childName || '';

    if (isCoverPage) {
      const coverPage = pageData.coverPage || null;

      if (coverPage) {
        try {
          const coverBuffer = await generateCoverPage({
            backgroundImage:
              (await resolveGeneratorSource(coverPage.backgroundImage)) ||
              (await resolveGeneratorSource(pageData.background)),
            characterImage:
              (await resolveGeneratorSource(coverPage.characterImage)) ||
              (await resolveGeneratorSource(pageData.character)),
            leftSide: {
              title: replaceChildPlaceholders(coverPage.leftSide?.title, childName),
              content: replaceChildPlaceholders(coverPage.leftSide?.content, childName),
              bottomText: replaceChildPlaceholders(coverPage.leftSide?.bottomText, childName),
            },
            rightSide: {
              mainTitle: (replaceChildPlaceholders(coverPage.rightSide?.mainTitle, childName) || '').toUpperCase(),
              subtitle: replaceChildPlaceholders(coverPage.rightSide?.subtitle, childName),
            },
            qrCode: await resolveGeneratorSource(coverPage.qrCode),
            childName,
          });

          if (coverBuffer) {
            const coverImage = await pdfDoc.embedPng(coverBuffer);
            page.drawImage(coverImage, {
              x: 0,
              y: 0,
              width: PAGE_WIDTH,
              height: PAGE_HEIGHT,
            });
            renderedPageBuffers.push({ index, type: 'cover', buffer: coverBuffer });
            continue;
          }
        } catch (error) {
          console.warn(
            '[pdf] generateCoverPage failed, falling back to legacy renderer:',
            error.message
          );
        }
      }

      const fallbackBackgroundAsset = coverPage?.backgroundImage || pageData.background || null;
      const backgroundBuffer = await getImageBuffer(fallbackBackgroundAsset);

      let characterBuffer = null;
      const coverCharacterAsset = coverPage?.characterImage || pageData.character || null;
      if (coverCharacterAsset) {
        if (coverCharacterAsset.backgroundRemoved) {
          characterBuffer = await getImageBuffer(coverCharacterAsset);
        } else {
          try {
            characterBuffer = await removeBackground(coverCharacterAsset);
          } catch (error) {
            console.warn('[pdf] background removal failed for cover page:', error.message);
            characterBuffer = await getImageBuffer(coverCharacterAsset);
          }
        }
      }

      const fallbackCover =
        pageData.cover ||
        (coverPage
          ? {
              headline: replaceChildPlaceholders(coverPage.leftSide?.title, childName),
              footer: replaceChildPlaceholders(coverPage.leftSide?.bottomText, childName),
              bodyOverride: replaceChildPlaceholders(coverPage.leftSide?.content, childName),
              qrCodeImage: coverPage.qrCode || null,
              uppercaseName: true,
              childName,
            }
          : null);

      const qrAsset =
        (fallbackCover && fallbackCover.qrCodeImage) || coverPage?.qrCode || null;
      const qrBuffer = qrAsset ? await getImageBuffer(qrAsset) : null;

      const bodyText = fallbackCover?.bodyOverride
        ? fallbackCover.bodyOverride
        : pageData.text || '';

      const coverBuffer = await generateCoverImage({
        pageWidth: PAGE_WIDTH,
        pageHeight: PAGE_HEIGHT,
        backgroundBuffer,
        characterBuffer,
        qrBuffer,
        cover: fallbackCover || {},
        bodyText,
        childName: fallbackCover?.childName || childName || '',
      });

      const coverImage = await pdfDoc.embedPng(coverBuffer);
      page.drawImage(coverImage, {
        x: 0,
        y: 0,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
      });
      renderedPageBuffers.push({ index, type: 'cover', buffer: coverBuffer });
      continue;
    }

    if (isDedicationPage) {
      const dedication = pageData.dedicationPage || {};
      const backgroundAsset = dedication.backgroundImage || pageData.background || null;
      const heroAsset =
        dedication.generatedImage ||
        dedication.generatedImageOriginal ||
        dedication.kidImage ||
        null;

      const backgroundSource = await resolveGeneratorSource(backgroundAsset);
      const heroSource = await resolveGeneratorSource(heroAsset);

      const backgroundCandidates = await buildGeneratorCandidates(
        backgroundAsset,
        backgroundSource,
        'background'
      );
      if (!backgroundCandidates.some(Boolean)) {
        throw new Error('Dedication page is missing a background image');
      }

      const heroCandidatesRaw = await buildGeneratorCandidates(heroAsset, heroSource, 'hero');
      const heroCandidates = heroCandidatesRaw.length ? heroCandidatesRaw : [];
      if (!heroCandidates.some((candidate) => candidate === null)) {
        heroCandidates.push(null);
      }

      const primaryTitle = replaceChildPlaceholders(dedication.title, childName);
      const secondaryTitle = replaceChildPlaceholders(dedication.secondTitle, childName);

      let dedicationBuffer = null;
      let lastError = null;
      let dedicationHandled = false;

      backgroundLoop: for (const backgroundCandidate of backgroundCandidates) {
        if (!backgroundCandidate) continue;
        for (const heroCandidate of heroCandidates) {
          try {
            dedicationBuffer = await generateDedicationPage({
              backgroundImage: backgroundCandidate,
              kidImage: heroCandidate,
              title: primaryTitle,
              secondTitle: secondaryTitle,
            });

            if (!dedicationBuffer || !dedicationBuffer.length) {
              throw new Error('generateDedicationPage returned empty buffer');
            }

            const dedicationImage = await pdfDoc.embedPng(dedicationBuffer);
            page.drawImage(dedicationImage, {
              x: 0,
              y: 0,
              width: PAGE_WIDTH,
              height: PAGE_HEIGHT,
            });
            renderedPageBuffers.push({ index, type: 'dedication', buffer: dedicationBuffer });
            dedicationHandled = true;
            break backgroundLoop;
          } catch (error) {
            lastError = error;
            const bgType = Buffer.isBuffer(backgroundCandidate) ? 'buffer' : 'url';
            const heroType = heroCandidate
              ? Buffer.isBuffer(heroCandidate)
                ? 'buffer'
                : 'url'
              : 'none';
            console.warn(
              `[pdf] generateDedicationPage attempt failed (${bgType} background, ${heroType} hero):`,
              error.message
            );
          }
        }
      }

      if (dedicationHandled) {
        continue;
      }

      const errorMessage = lastError ? lastError.message : 'generateDedicationPage produced no output';
      throw new Error(`Failed to render dedication page: ${errorMessage}`);
    }

    const prefetchedAssets = prefetchedStoryAssets.get(index) || null;

    let backgroundBuffer =
      (prefetchedAssets && prefetchedAssets.backgroundBuffer) || null;
    if (prefetchedAssets?.backgroundError) {
      console.warn(
        `[pdf] Failed to prefetch background for page ${index + 1}:`,
        prefetchedAssets.backgroundError.message
      );
    }
    if (!backgroundBuffer) {
      backgroundBuffer = await getImageBuffer(pageData.background);
    }
    let hasBackground = false;
    if (backgroundBuffer) {
      console.log(
        `[pdf] background buffer length for page ${index + 1}:`,
        backgroundBuffer.length
      );
      const backgroundImage = await embedImage(pdfDoc, backgroundBuffer);
      if (backgroundImage) {
        page.drawImage(backgroundImage, {
          x: 0,
          y: 0,
          width: PAGE_WIDTH,
          height: PAGE_HEIGHT,
        });
        hasBackground = true;
      }
    }

    if (!hasBackground) {
      console.warn(`[pdf] No background available for page ${index + 1}, using white background`);
      page.drawRectangle({
        x: 0,
        y: 0,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        color: rgb(1, 1, 1),
      });
    }

    if (pageData.character) {
      const prefetchedCharacter = prefetchedAssets?.character || null;
      let characterBuffer = (prefetchedCharacter && prefetchedCharacter.buffer) || null;
      let characterSource = (prefetchedCharacter && prefetchedCharacter.source) || 'none';

      if (prefetchedCharacter?.removalError) {
        console.warn(
          `[pdf] background removal failed for page ${index + 1}:`,
          prefetchedCharacter.removalError.message
        );
      }

      if (characterBuffer && characterBuffer.length) {
        if (characterSource === 'stored-removed') {
          console.log(
            `[pdf] using stored background-removed buffer for page ${index + 1}:`,
            characterBuffer.length
          );
        } else if (characterSource === 'removed') {
          console.log(
            `[pdf] removeBackground result for page ${index + 1}:`,
            characterBuffer.length
          );
        } else if (characterSource === 'original') {
          console.log(
            `[pdf] using original character buffer for page ${index + 1}:`,
            characterBuffer.length
          );
        }
      }

      if (!characterBuffer || !characterBuffer.length) {
        if (pageData.character.backgroundRemoved) {
          characterBuffer = await getImageBuffer(pageData.character);
          characterSource = characterBuffer ? 'stored-removed' : 'none';
          if (characterBuffer && characterBuffer.length) {
            console.log(
              `[pdf] using stored background-removed buffer for page ${index + 1}:`,
              characterBuffer.length
            );
          }
        } else if (!prefetchedCharacter || !prefetchedCharacter.attemptedRemoval) {
          try {
            const removedBuffer = await removeBackground(pageData.character);
            if (removedBuffer && removedBuffer.length) {
              characterBuffer = removedBuffer;
              characterSource = 'removed';
              console.log(
                `[pdf] removeBackground result for page ${index + 1}:`,
                characterBuffer.length
              );
            }
          } catch (error) {
            console.warn(
              `[pdf] background removal failed for page ${index + 1}:`,
              error.message
            );
          }

          if (!characterBuffer || !characterBuffer.length) {
            const fallbackBuffer = await getImageBuffer(pageData.character);
            if (fallbackBuffer && fallbackBuffer.length) {
              characterBuffer = fallbackBuffer;
              characterSource = 'original';
              console.log(
                `[pdf] using original character buffer for page ${index + 1}:`,
                characterBuffer.length
              );
            }
          }
        } else if (!characterBuffer || !characterBuffer.length) {
          const fallbackBuffer = await getImageBuffer(pageData.character);
          if (fallbackBuffer && fallbackBuffer.length) {
            characterBuffer = fallbackBuffer;
            characterSource = 'original';
            console.log(
              `[pdf] using original character buffer for page ${index + 1}:`,
              characterBuffer.length
            );
          }
        }
      }

      if (!characterBuffer || !characterBuffer.length) {
        console.warn(
          `[pdf] Failed to obtain character image buffer for page ${index + 1}, skipping character`
        );
        // Continue without character instead of throwing
      } else {

        const characterImage = await embedImage(pdfDoc, characterBuffer);
        console.log(
          '[pdf] embedded character image',
          characterImage ? { width: characterImage.width, height: characterImage.height } : null
        );

        if (!characterImage) {
          console.warn(`[pdf] Failed to embed character image for page ${index + 1}, skipping character`);
        } else {
          const aspectRatio = characterImage.width / characterImage.height;
          const maxCharWidth = PAGE_WIDTH * CHARACTER_MAX_WIDTH_RATIO;
          const maxCharHeight = PAGE_HEIGHT * CHARACTER_MAX_HEIGHT_RATIO;

          if (aspectRatio > maxCharWidth / maxCharHeight) {
            charWidth = maxCharWidth;
            charHeight = charWidth / aspectRatio;
          } else {
            charHeight = maxCharHeight;
            charWidth = charHeight * aspectRatio;
          }

          charX = isCharacterOnRight ? PAGE_WIDTH - charWidth : 0;

          page.drawImage(characterImage, {
            x: charX,
            y: charY,
            width: charWidth,
            height: charHeight,
          });
        }
      }
    }

    const hebrewQuote = (pageData.hebrewQuote || pageData.quote || '').trim();
    if (hebrewQuote) {
      const availableHebrewWidth = clamp(
        Math.max(charWidth * 0.8, PAGE_WIDTH * 0.3),
        80,
        PAGE_WIDTH - TEXT_MARGIN * 2
      );
      const quoteXBase = charWidth
        ? charX + charWidth * 0.1
        : isCharacterOnRight
        ? TEXT_MARGIN
        : PAGE_WIDTH - availableHebrewWidth - TEXT_MARGIN;
      const quoteMinX = TEXT_MARGIN;
      const quoteMaxX = Math.max(TEXT_MARGIN, PAGE_WIDTH - availableHebrewWidth - TEXT_MARGIN);
      const quoteX = clamp(quoteXBase, quoteMinX, quoteMaxX);
      const quoteYBase = charY + charHeight + 20;
      const quoteMinY = TEXT_MARGIN;
      const quoteMaxY = Math.max(TEXT_MARGIN, PAGE_HEIGHT - HEBREW_BASE_FONT_SIZE);
      const quoteY = clamp(quoteYBase, quoteMinY, quoteMaxY);
      const hebrewLines = wrapText(hebrewQuote, availableHebrewWidth, HEBREW_BASE_FONT_SIZE);

      hebrewLines.forEach((line, lineIndex) => {
        const chars = line.split('');
        const baselineY = quoteY - lineIndex * HEBREW_LINE_SPACING;
        let cursorX = quoteX;

        chars.forEach((char, charIndex) => {
          const totalChars = Math.max(chars.length - 1, 1);
          const progress = totalChars > 0 ? charIndex / totalChars : 0.5;
          const waveOffset = Math.sin(progress * Math.PI) * HEBREW_WAVE_AMPLITUDE;
          const sizeFactor = 1 + Math.cos(progress * Math.PI) * 0.3;
          const fontSize = HEBREW_BASE_FONT_SIZE * sizeFactor;
          const charWidthEstimate = fontSize * 0.6;
          const x = cursorX;
          const y = baselineY + waveOffset;

          const outlineOffsets = [
            [-0.4, 0],
            [0.4, 0],
            [0, -0.4],
            [0, 0.4],
          ];

          outlineOffsets.forEach(([dx, dy]) => {
            page.drawText(char, {
              x: x + dx,
              y: y + dy,
              size: fontSize,
              font: hebrewFont,
              color: rgb(0, 0, 0),
              opacity: 0.7,
            });
          });

          page.drawText(char, {
            x,
            y,
            size: fontSize,
            font: hebrewFont,
            color: rgb(1, 1, 1),
          });

          cursorX += charWidthEstimate;
        });
      });
    }

    const textBlockWidth = Math.min(
      Math.max(PAGE_WIDTH * TEXT_BLOCK_WIDTH_RATIO, TEXT_BLOCK_WIDTH),
      PAGE_WIDTH - TEXT_MARGIN * 2
    );

    const textX = isCharacterOnRight ? TEXT_MARGIN : PAGE_WIDTH - textBlockWidth - TEXT_MARGIN;
    const textY = PAGE_HEIGHT * 0.7;

    const storyText = pageData.text || '';
    const textLines = wrapText(storyText, textBlockWidth, FONT_SIZE);
    const textHeight = textLines.length * LINE_HEIGHT;

    if (textLines.length) {
      const rawBgX = textX - TEXT_BG_LEFT_PADDING;
      const rawBgY = textY - textHeight - TEXT_BG_VERTICAL_PADDING;
      const rawBgWidth = textBlockWidth + TEXT_BG_LEFT_PADDING + TEXT_BG_RIGHT_PADDING;
      const rawBgHeight = textHeight + TEXT_BG_VERTICAL_PADDING * 2;

      const bgX = clamp(rawBgX, 0, PAGE_WIDTH - 1);
      const bgY = clamp(rawBgY, 0, PAGE_HEIGHT - 1);
      const xOffset = bgX - rawBgX;
      const yOffset = bgY - rawBgY;
      const availableWidth = Math.max(1, Math.round(PAGE_WIDTH - bgX));
      const availableHeight = Math.max(1, Math.round(PAGE_HEIGHT - bgY));
      const bgWidth = Math.min(
        Math.max(1, Math.round(rawBgWidth - xOffset)),
        availableWidth
      );
      const bgHeight = Math.min(
        Math.max(1, Math.round(rawBgHeight - yOffset)),
        availableHeight
      );

      let blurredBgBuffer = null;
      if (backgroundBuffer) {
        blurredBgBuffer = await createBlurredBackground(
          backgroundBuffer,
          bgX,
          bgY,
          bgWidth,
          bgHeight,
          15
        );
      }

      if (blurredBgBuffer) {
        const blurredBgImage = await embedImage(pdfDoc, blurredBgBuffer);
        page.drawImage(blurredBgImage, {
          x: bgX,
          y: bgY,
          width: bgWidth,
          height: bgHeight,
        });
      } else {
        page.drawRectangle({
          x: bgX,
          y: bgY,
          width: bgWidth,
          height: bgHeight,
          color: rgb(0, 0, 0),
          opacity: 0.45,
        });
      }

      textLines.forEach((line, lineIndex) => {
        const y = textY - lineIndex * LINE_HEIGHT - TEXT_BASELINE_OFFSET;
        page.drawText(line, {
          x: textX,
          y,
          size: FONT_SIZE,
          font: bodyFont,
          color: rgb(1, 1, 1),
        });
      });
    }
  }

  const pdfBytes = await pdfDoc.save();
  return {
    buffer: pdfBytes,
    pageCount: pagesToRender.length,
    renderedPages: renderedPageBuffers,
  };
}

module.exports = {
  generateStorybookPdf,
  removeBackground,
};
