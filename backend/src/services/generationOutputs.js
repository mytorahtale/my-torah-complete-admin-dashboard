const fetch = require('node-fetch');
const {
  uploadBufferToS3,
  generateImageKey,
  downloadFromS3,
  deleteFromS3,
  getSignedUrlForKey,
} = require('../config/s3');

async function uploadGenerationOutputs({
  outputs,
  userId,
  generationId,
  targetFormat = 'png',
  fallbackContentType = 'image/png',
}) {
  const imageUrls = [];
  const imageAssets = [];
  const uploadedKeys = [];

  try {
    for (let index = 0; index < outputs.length; index += 1) {
      const imageUrl = resolveOutputUrl(outputs[index]);
      if (!imageUrl) {
        throw new Error(`Unable to resolve image URL for output index ${index}`);
      }

      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to download image ${index + 1}: ${response.status} ${response.statusText}`
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const detectedContentType = response.headers.get('content-type') || fallbackContentType;
      const fileName = `${generationId}-${index + 1}.${targetFormat}`;
      const key = generateImageKey(userId, fileName);
      const { url: s3Url, bytes: uploadedBytes, contentType: uploadedContentType } =
        await uploadBufferToS3(buffer, key, detectedContentType, {
          acl: 'public-read',
        });

      const signedUrl = await getSignedUrlForKey(key).catch(() => null);

      const asset = {
        key,
        url: s3Url,
        signedUrl: signedUrl || s3Url,
        size: uploadedBytes,
        contentType: uploadedContentType || detectedContentType,
        originalName: fileName,
        uploadedAt: new Date(),
      };

      uploadedKeys.push(key);
      imageUrls.push(s3Url);
      imageAssets.push(asset);
    }

    return {
      imageUrls,
      imageAssets,
    };
  } catch (error) {
    await Promise.all(
      uploadedKeys.map((key) =>
        deleteFromS3(key).catch((cleanupError) =>
          console.warn(`⚠️  Failed to cleanup uploaded asset ${key}`, cleanupError.message)
        )
      )
    );
    throw error;
  }
}

const resolveOutputUrl = (item) => {
  if (!item) return null;
  if (typeof item === 'string') return item;
  if (typeof item.url === 'function') {
    try {
      return item.url();
    } catch (error) {
      console.warn('⚠️  Failed to resolve url() from output item', error.message);
      return null;
    }
  }
  if (typeof item.url === 'string') return item.url;
  if (item.href) return item.href;
  return null;
};

async function getSignedDownloadUrls(imageAssets = []) {
  const signedUrls = await Promise.all(
    imageAssets.map(async (asset) => {
      if (!asset?.key) return null;
      try {
        const signedUrl = await getSignedUrlForKey(asset.key);
        return {
          ...asset,
          downloadUrl: signedUrl,
        };
      } catch (error) {
        console.warn(`⚠️  Failed to generate signed URL for ${asset.key}:`, error.message);
        return asset;
      }
    })
  );

  return signedUrls.filter(Boolean);
}

async function fetchExistingImageBuffers(imageAssets = []) {
  const buffers = [];
  for (let index = 0; index < imageAssets.length; index += 1) {
    const asset = imageAssets[index];
    if (!asset?.key) continue;
    try {
      const buffer = await downloadFromS3(asset.key);
      if (buffer?.length) {
        buffers.push({ buffer, asset });
      }
    } catch (error) {
      console.warn(`⚠️  Failed to download existing asset ${asset.key}:`, error.message);
    }
  }
  return buffers;
}

module.exports = {
  uploadGenerationOutputs,
  resolveOutputUrl,
  getSignedDownloadUrls,
  fetchExistingImageBuffers,
};
