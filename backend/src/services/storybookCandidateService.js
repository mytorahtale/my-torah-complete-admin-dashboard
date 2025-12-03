const mongoose = require('mongoose');
const Book = require('../models/Book');
const StorybookJob = require('../models/StorybookJob');
const { downloadFromS3, uploadBufferToS3, generateBookCharacterOverlayKey, getSignedUrlForKey } = require('../config/s3');
const { rebuildPdfForJob } = require('./storybookWorkflow');

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

  const uploadMeta = await uploadBufferToS3(
    originalBuffer,
    targetKey,
    candidate.contentType || 'image/png',
    { acl: 'public-read' }
  );

  const signedUrl = (await getSignedUrlForKey(targetKey).catch(() => null)) || uploadMeta.url;

  const characterAsset = {
    key: targetKey,
    url: uploadMeta.url,
    downloadUrl: uploadMeta.url,
    signedUrl,
    size: originalBuffer.length,
    contentType: candidate.contentType || 'image/png',
    uploadedAt: new Date(),
    originalName: candidate.originalName || `character-${page.order || 0}.png`,
    backgroundRemoved: Boolean(candidate.backgroundRemoved),
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
