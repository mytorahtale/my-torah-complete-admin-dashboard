const { createCanvas, loadImage } = require('canvas');
const fetch = require('node-fetch');
const Replicate = require('replicate');

const {
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
  HALF_WIDTH,
  TEXT_PADDING_RATIO,
  TEXT_HEIGHT_RATIO,
  TEXT_TOP_RATIO,
  ensureFontsRegistered,
  drawKidImage,
  drawTextBlock,
} = require('./dedicationLayout');

const replicateClient = process.env.REPLICATE_API_TOKEN
  ? new Replicate({ auth: process.env.REPLICATE_API_TOKEN })
  : null;

const fetchImage = async (source) => {
  if (!source) return null;
  if (Buffer.isBuffer(source)) {
    return loadImage(source);
  }
  if (typeof source === 'string') {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    const buffer = await response.buffer();
    return loadImage(buffer);
  }
  throw new Error('Unsupported image source');
};

const resolveReplicateOutput = async (output) => {
  if (!output) return null;

  if (Buffer.isBuffer(output)) return output;
  if (output instanceof Uint8Array) return Buffer.from(output);

  if (typeof output === 'string') {
    const response = await fetch(output);
    if (!response.ok) {
      throw new Error(`Failed to fetch replicate output: ${response.status} ${response.statusText}`);
    }
    return response.buffer();
  }

  if (Array.isArray(output)) {
    for (const item of output) {
      const buffer = await resolveReplicateOutput(item);
      if (buffer) return buffer;
    }
    return null;
  }

  if (typeof output === 'object' && output !== null) {
    if (output.output) {
      return resolveReplicateOutput(output.output);
    }
  }

  return null;
};

const loadKidImage = async (source) => {
  if (!source) return null;

  if (Buffer.isBuffer(source)) {
    return loadImage(source);
  }

  if (typeof source === 'string' && replicateClient) {
    try {
      const replicateOutput = await replicateClient.run('bria/remove-background', {
        input: { image: source },
      });
      const processedBuffer = await resolveReplicateOutput(replicateOutput);
      if (processedBuffer) {
        return loadImage(processedBuffer);
      }
      console.warn('[dedicationGenerator] Replicate returned no usable output, using original image');
    } catch (error) {
      console.warn('[dedicationGenerator] Background removal failed, falling back:', error.message);
    }
  }

  return fetchImage(source);
};

const generateDedicationPage = async ({
  backgroundImage,
  kidImage,
  title = '',
  secondTitle = '',
}) => {
  ensureFontsRegistered();

  const canvas = createCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  const ctx = canvas.getContext('2d');

  if (!backgroundImage) {
    throw new Error('backgroundImage is required');
  }

  const background = await fetchImage(backgroundImage);
  ctx.drawImage(background, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  if (kidImage) {
    try {
      const hero = await loadKidImage(kidImage);
      drawKidImage(ctx, hero);
    } catch (error) {
      console.warn('[dedicationGenerator] Failed to draw kid image:', error.message);
    }
  }

  // Text area on right half with 0.125 inch margins on all sides
  const MARGIN_SIZE = 37.5; // 0.125 inches at 300 DPI
  const textArea = {
    x: HALF_WIDTH + MARGIN_SIZE,
    y: MARGIN_SIZE,
    width: HALF_WIDTH - (MARGIN_SIZE * 2),
    height: CANVAS_HEIGHT - (MARGIN_SIZE * 2),
  };

  drawTextBlock(ctx, {
    area: textArea,
    title,
    subtitle: secondTitle,
  });

  return canvas.toBuffer('image/png');
};

module.exports = {
  generateDedicationPage,
  CANVAS_WIDTH,
  CANVAS_HEIGHT,
};