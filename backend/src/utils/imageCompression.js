const path = require('path');
const sharp = require('sharp');

const DEFAULT_QUALITY = 50;
const SIZE_THRESHOLD_MB = {
  HIGH: 10,
  MEDIUM: 4,
};

const MIME_BY_FORMAT = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

const FORMAT_BY_MIME = Object.entries(MIME_BY_FORMAT).reduce((acc, [format, mime]) => {
  acc[mime] = format;
  return acc;
}, {});

const SUPPORTED_FORMATS = new Set(['jpeg', 'jpg', 'png', 'webp', 'avif']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

const clampQuality = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_QUALITY;
  return Math.min(100, Math.max(1, Math.round(numeric)));
};

const selectQualityBySize = (byteLength) => {
  const sizeMb = byteLength / (1024 * 1024);
  if (sizeMb > SIZE_THRESHOLD_MB.HIGH) return 35;
  if (sizeMb >= SIZE_THRESHOLD_MB.MEDIUM) return 45;
  return 50;
};

const normalizeFormat = (format) => {
  if (!format) return null;
  const lower = format.toLowerCase();
  if (lower === 'jpg') return 'jpeg';
  return lower;
};

const formatFromKey = (key) => {
  if (!key) return null;
  const ext = normalizeFormat(path.extname(key).slice(1));
  if (SUPPORTED_FORMATS.has(ext)) return ext;
  return null;
};

const resolveFormat = ({ mimeType, metadataFormat, key }) => {
  if (mimeType) {
    const normalizedMime = mimeType.toLowerCase();
    if (FORMAT_BY_MIME[normalizedMime]) return normalizeFormat(FORMAT_BY_MIME[normalizedMime]);
  }

  const normalizedMeta = normalizeFormat(metadataFormat);
  if (normalizedMeta && SUPPORTED_FORMATS.has(normalizedMeta)) return normalizedMeta;

  const fromKey = formatFromKey(key);
  if (fromKey) return fromKey;

  return null;
};

const resolveContentType = (format, fallback) => MIME_BY_FORMAT[format] || fallback || null;

const isImageContentType = (contentType) =>
  typeof contentType === 'string' && contentType.toLowerCase().startsWith('image/');

const isImageKey = (key) => {
  if (!key) return false;
  const ext = path.extname(key).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
};

async function compressImageBuffer(buffer, { mimeType, quality, key } = {}) {
  const normalizedQuality = clampQuality(
    typeof quality === 'number' ? quality : selectQualityBySize(buffer.length)
  );
  const image = sharp(buffer);
  const metadata = await image.metadata();
  const format = resolveFormat({ mimeType, metadataFormat: metadata.format, key });

  if (!format || !SUPPORTED_FORMATS.has(format)) {
    return {
      buffer,
      contentType: mimeType || null,
      format: metadata.format || null,
      skipped: true,
    };
  }

  const pipeline = image.clone().withMetadata(); // preserve ICC/color profile where present

  switch (format) {
    case 'jpeg':
      pipeline.jpeg({
        quality: normalizedQuality,
        mozjpeg: true,
        progressive: true,
        chromaSubsampling: '4:4:4', // keep color fidelity
      });
      break;
    case 'png':
      pipeline.png({
        compressionLevel: 9,
        palette: true,
        quality: normalizedQuality,
        adaptiveFiltering: true,
      });
      break;
    case 'webp':
      pipeline.webp({ quality: normalizedQuality });
      break;
    case 'avif':
      pipeline.avif({ quality: normalizedQuality });
      break;
    default:
      return {
        buffer,
        contentType: mimeType || null,
        format: metadata.format || null,
        skipped: true,
      };
  }

  const compressedBuffer = await pipeline.toBuffer();
  const contentType = resolveContentType(format, mimeType);

  return {
    buffer: compressedBuffer,
    contentType,
    format,
    info: {
      width: metadata.width,
      height: metadata.height,
      quality: normalizedQuality,
      size: compressedBuffer.length,
    },
    skipped: false,
  };
}

module.exports = {
  DEFAULT_QUALITY,
  compressImageBuffer,
  isImageContentType,
  isImageKey,
  resolveContentType,
};
