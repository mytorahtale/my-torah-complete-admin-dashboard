const Book = require('../models/Book');
const StorybookJob = require('../models/StorybookJob');
const { getStorybookJobById, copyAssetToBookCharacterSlot } = require('./storybookWorkflow');

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

  // Use the shared pipeline to copy the candidate into the book's
  // character slot and run background removal where appropriate
  // (story/cover pages), so the stored asset matches the final PDF.
  const characterAsset = await copyAssetToBookCharacterSlot({
    book,
    page,
    asset: candidate,
  });

  if (!characterAsset) {
    throw new Error('Failed to prepare candidate image for this page');
  }

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

  // Emit an updated snapshot so any live Storybook streams (SSE)
  // receive the latest page/candidate state.
  await getStorybookJobById(job._id);

  return {
    jobId: job._id,
    pageOrder: page.order,
    candidateIndex,
  };
}

module.exports = {
  applyCandidateSelection,
};
