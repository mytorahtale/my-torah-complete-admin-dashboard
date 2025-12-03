const mongoose = require('mongoose');
const Book = require('../models/Book');
const StorybookJob = require('../models/StorybookJob');
const { downloadFromS3, uploadBufferToS3, generateBookCharacterOverlayKey, getSignedUrlForKey } = require('../config/s3');
const { rebuildPdfForJob } = require('./storybookWorkflow');
const { removeBackground } = require('../utils/pdfGenerator');

const createEvent = (type, message, metadata = null) => ({
  type,
  message,
  metadata,
  timestamp: new Date(),
});

async function applyCandidateSelection({ jobId, pageToken, candidateIndex }) {
  if (!jobId || candidateIndex == null) {
    throw new Error('jobId and candidateIndex are required');
  }

  const pageOrder =
    pageToken === 'cover'
      ? 1
      : pageToken === 'dedication'
      ? 2
      : Number(pageToken);

  if (!Number.isFinite(pageOrder)) {
    throw new Error('Invalid page identifier for candidate selection');
  }

  const job = await StorybookJob.findById(jobId);
  if (!job) {
    throw new Error('Storybook job not found');
  }

  const page = job.pages.find((entry) => entry.order === pageOrder);
  if (!page) {
    throw new Error('Target page not found in storybook job');
  }

  const zeroBasedIndex = candidateIndex - 1;
  if (!Array.isArray(page.candidateAssets) || zeroBasedIndex < 0 || zeroBasedIndex >= page.candidateAssets.length) {
    throw new Error('Candidate index is out of range');
  }

  const candidate = page.candidateAssets[zeroBasedIndex];
  if (!candidate?.key) {
    throw new Error('Selected candidate is missing S3 key');
  }

  const book = await Book.findById(job.bookId);
  if (!book) {
    throw new Error('Book not found for candidate selection');
  }

  const bookSlug =
    book.slug || `${String(book.name || 'book').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${String(book._id).slice(-6)}`;

  const originalBuffer = await downloadFromS3(candidate.key);
  if (!originalBuffer || !originalBuffer.length) {
    throw new Error('Failed to download candidate image from S3');
  }

  const targetKey = generateBookCharacterOverlayKey(
    bookSlug,
    page.order || 0,
    candidate.originalName || `character-${page.order || 0}.png`
  );

  // Step 1: Upload original buffer to S3 first (needed for Brio to access)
  const initialUpload = await uploadBufferToS3(
    originalBuffer,
    targetKey,
    candidate.contentType || 'image/png',
    { acl: 'public-read' }
  );

  // Step 2: Handle background removal based on page type
  // - Dedication pages: KEEP the background (skip removal)
  // - Cover and story pages: REMOVE the background
  let finalBuffer = originalBuffer;
  let backgroundRemoved = Boolean(candidate.backgroundRemoved);

  if (page.pageType === 'dedication') {
    // Dedication page - keep the background as-is
    console.log('[applyCandidateSelection] Dedication page - skipping background removal');
    finalBuffer = originalBuffer;
    backgroundRemoved = false;
  } else if (candidate.backgroundRemoved) {
    // Already has background removed
    console.log('[applyCandidateSelection] Candidate already has background removed');
    finalBuffer = originalBuffer;
    backgroundRemoved = true;
  } else {
    // Cover and story pages - remove background using Brio
    console.log('[applyCandidateSelection] Removing background for', page.pageType || 'story', 'page');
    try {
      const signedUrlForBrio = await getSignedUrlForKey(targetKey).catch(() => initialUpload.url);
      const removalBuffer = await removeBackground({
        url: initialUpload.url,
        signedUrl: signedUrlForBrio,
        downloadUrl: initialUpload.url,
        key: targetKey,
      });

      if (removalBuffer && removalBuffer.length) {
        console.log('[applyCandidateSelection] Background removal successful, buffer length:', removalBuffer.length);
        finalBuffer = removalBuffer;
        backgroundRemoved = true;
      } else {
        console.warn('[applyCandidateSelection] Brio returned empty buffer, using original');
        finalBuffer = originalBuffer;
        backgroundRemoved = false;
      }
    } catch (error) {
      console.warn('[applyCandidateSelection] Background removal failed:', error.message);
      finalBuffer = originalBuffer;
      backgroundRemoved = false;
    }
  }

  // Step 3: Upload the final buffer (with or without background removed)
  const contentType = backgroundRemoved ? 'image/png' : (candidate.contentType || 'image/png');
  const uploadMeta = await uploadBufferToS3(
    finalBuffer,
    targetKey,
    contentType,
    { acl: 'public-read' }
  );

  const signedUrl = (await getSignedUrlForKey(targetKey).catch(() => null)) || uploadMeta.url;

  const characterAsset = {
    key: targetKey,
    url: uploadMeta.url,
    downloadUrl: uploadMeta.url,
    signedUrl,
    size: finalBuffer.length,
    contentType,
    uploadedAt: new Date(),
    originalName: candidate.originalName || `character-${page.order || 0}.png`,
    backgroundRemoved,
  };

  page.characterAsset = characterAsset;
  page.characterAssetOriginal = {
    key: candidate.key,
    url: candidate.url,
    downloadUrl: candidate.downloadUrl || candidate.url,
    signedUrl: candidate.signedUrl || null,
    size: candidate.size || 0,
    contentType: candidate.contentType || null,
    uploadedAt: candidate.uploadedAt || new Date(),
    originalName: candidate.originalName || null,
    backgroundRemoved: Boolean(candidate.backgroundRemoved),
  };
  page.selectedCandidateIndex = candidateIndex;
  page.events = page.events || [];
  page.events.push(
    createEvent('candidate-selected', 'User selected a candidate image for this page', {
      candidateIndex,
    })
  );

  await job.save();

  await rebuildPdfForJob(job._id);

  return {
    jobId: job._id,
    pageOrder: page.order,
    candidateIndex,
  };
}

module.exports = {
  applyCandidateSelection,
};
