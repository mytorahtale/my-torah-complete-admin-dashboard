const mongoose = require('mongoose');
const {
  startStorybookAutomation,
  getStorybookJobById,
  listStorybookJobsForBook,
  rebuildPdfForJob,
  regeneratePageForJob,
} = require('../services/storybookWorkflow');
const { subscribeToStorybookUpdates } = require('../services/storybookEvents');
const { applyCandidateSelection } = require('../services/storybookCandidateService');
const StorybookJob = require('../models/StorybookJob');
const ConfirmedStorybook = require('../models/ConfirmedStorybook');
const { downloadFromS3, uploadBufferToS3, deleteFromS3 } = require('../config/s3');
const Generation = require('../models/Generation');
const { splitStorybookPdf } = require('../utils/pdfGenerator');

const isValidObjectId = (value) => {
  if (!value) return false;
  return mongoose.Types.ObjectId.isValid(value);
};

exports.startAutomation = async (req, res) => {
  try {
    const { id: bookId } = req.params;
    const { trainingId, userId, readerId, readerName, readerGender, title } = req.body;

    if (!isValidObjectId(bookId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid book ID',
      });
    }

    if (!isValidObjectId(trainingId)) {
      return res.status(400).json({
        success: false,
        message: 'Training ID is required',
      });
    }

    if (!isValidObjectId(userId)) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required',
      });
    }

    let resolvedReaderId = readerId;
    if (readerId && !isValidObjectId(readerId)) {
      return res.status(400).json({
        success: false,
        message: 'Reader ID is invalid',
      });
    }
    if (!resolvedReaderId) {
      resolvedReaderId = userId;
    }

    const job = await startStorybookAutomation({
      bookId,
      trainingId,
      userId,
      readerId: resolvedReaderId,
      readerName,
      readerGender,
      title,
    });

    return res.status(202).json({
      success: true,
      message: 'Storybook automation started',
      data: job,
    });
  } catch (error) {
    console.error('Error starting storybook automation:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to start storybook automation',
    });
  }
};

exports.getJob = async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!isValidObjectId(jobId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid job ID',
      });
    }

    const job = await getStorybookJobById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Storybook job not found',
      });
    }

    return res.status(200).json({
      success: true,
      data: job,
    });
  } catch (error) {
    console.error('Error fetching storybook job:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch storybook job',
      error: error.message,
    });
  }
};

exports.listJobs = async (req, res) => {
  try {
    const { id: bookId } = req.params;
    if (!isValidObjectId(bookId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid book ID',
      });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    const minimal = req.query.minimal === 'true';
    const jobs = await listStorybookJobsForBook(bookId, limit, { minimal });

    return res.status(200).json({
      success: true,
      count: jobs.length,
      data: jobs,
    });
  } catch (error) {
    console.error('Error listing storybook jobs:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to list storybook jobs',
      error: error.message,
    });
  }
};

exports.applyCandidate = async (req, res) => {
  try {
    const { jobId } = req.params;
    const { pageOrder, candidateIndex } = req.body || {};

    if (!isValidObjectId(jobId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid job ID',
      });
    }

    if (!pageOrder && pageOrder !== 0) {
      return res.status(400).json({
        success: false,
        message: 'pageOrder is required',
      });
    }

    const numericCandidate = Number(candidateIndex);
    if (!Number.isFinite(numericCandidate) || numericCandidate <= 0) {
      return res.status(400).json({
        success: false,
        message: 'candidateIndex must be a positive integer starting at 1',
      });
    }

    const result = await applyCandidateSelection({
      jobId,
      pageToken: pageOrder,
      candidateIndex: numericCandidate,
    });

    return res.status(200).json({
      success: true,
      message: 'Candidate applied successfully; storybook PDF will be rebuilt.',
      data: result,
    });
  } catch (error) {
    console.error('Error applying storybook candidate:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to apply storybook candidate',
    });
  }
};

exports.regeneratePage = async (req, res) => {
  try {
    const { id: bookId, jobId, pageOrder } = req.params;

    if (!isValidObjectId(bookId) || !isValidObjectId(jobId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid book or job ID',
      });
    }

    const job = await StorybookJob.findById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Storybook job not found',
      });
    }

    if (String(job.bookId) !== String(bookId)) {
      return res.status(400).json({
        success: false,
        message: 'Storybook job does not belong to this book',
      });
    }

    let resolvedOrder;
    if (pageOrder === 'cover') {
      resolvedOrder = 1;
    } else if (pageOrder === 'dedication') {
      resolvedOrder = 2;
    } else {
      const numericOrder = Number(pageOrder);
      if (!Number.isFinite(numericOrder) || numericOrder <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid page order for regeneration',
        });
      }
      resolvedOrder = numericOrder;
    }

    const snapshot = await regeneratePageForJob({
      jobId: job._id,
      pageOrder: resolvedOrder,
    });

    return res.status(200).json({
      success: true,
      message: 'Storybook page regenerated successfully.',
      data: snapshot,
    });
  } catch (error) {
    console.error('Error regenerating storybook page:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to regenerate storybook page',
    });
  }
};

exports.regeneratePdf = async (req, res) => {
  try {
    const { jobId } = req.params;

    if (!isValidObjectId(jobId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid job ID',
      });
    }

    const pdfAsset = await rebuildPdfForJob(jobId);

    return res.status(200).json({
      success: true,
      message: 'Storybook PDF regenerated successfully.',
      data: pdfAsset,
    });
  } catch (error) {
    console.error('Error regenerating storybook PDF:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to regenerate storybook PDF',
    });
  }
};

exports.deleteJob = async (req, res) => {
  try {
    const { id: bookId, jobId } = req.params;

    if (!isValidObjectId(bookId) || !isValidObjectId(jobId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid book or job ID',
      });
    }

    const job = await StorybookJob.findById(jobId);
    if (!job) {
      return res.status(404).json({
        success: false,
        message: 'Storybook job not found',
      });
    }

    if (String(job.bookId) !== String(bookId)) {
      return res.status(400).json({
        success: false,
        message: 'Storybook job does not belong to this book',
      });
    }

    const keysToDelete = new Set();

    const collectAssetKey = (asset) => {
      if (asset && asset.key && typeof asset.key === 'string') {
        keysToDelete.add(asset.key);
      }
    };

    const collectAssetListKeys = (assets) => {
      if (!Array.isArray(assets)) return;
      assets.forEach((asset) => collectAssetKey(asset));
    };

    if (Array.isArray(job.pages)) {
      job.pages.forEach((page) => {
        collectAssetKey(page.characterAsset);
        collectAssetKey(page.characterAssetOriginal);
        collectAssetListKeys(page.candidateAssets);
      });
    }

    if (job.pdfAsset) {
      collectAssetKey(job.pdfAsset);
      if (Array.isArray(job.pdfAsset.pages)) {
        job.pdfAsset.pages.forEach((pdfPage) => {
          collectAssetKey(pdfPage.background);
          collectAssetKey(pdfPage.character);
          collectAssetKey(pdfPage.renderedImage);
        });
      }
    }

    // Any confirmed storybooks that point to this job should also be removed,
    // including their split PDF assets.
    const confirmedList = await ConfirmedStorybook.find({
      bookId,
      storybookJobId: jobId,
    }).lean();
    confirmedList.forEach((item) => {
      if (item.pdfKey) {
        keysToDelete.add(item.pdfKey);
      }
    });

    await Promise.all([
      StorybookJob.deleteOne({ _id: jobId }),
      Generation.deleteMany({ 'storybookContext.jobId': jobId }),
      ConfirmedStorybook.deleteMany({ bookId, storybookJobId: jobId }),
    ]);

    if (keysToDelete.size > 0) {
      await Promise.all(
        Array.from(keysToDelete).map((key) =>
          deleteFromS3(key).catch((error) =>
            console.warn(`⚠️  Failed to cleanup S3 asset ${key}: ${error.message}`)
          )
        )
      );
    }

    return res.status(200).json({
      success: true,
      message: 'Storybook run deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting storybook job:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete storybook job',
    });
  }
};

exports.confirmPdfForJob = async (req, res) => {
  try {
    const { id: bookId, jobId } = req.params;

    if (!isValidObjectId(bookId) || !isValidObjectId(jobId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid book or job ID',
      });
    }

    const jobDoc = await StorybookJob.findById(jobId);
    if (!jobDoc) {
      return res.status(404).json({
        success: false,
        message: 'Storybook job not found',
      });
    }

    if (String(jobDoc.bookId) !== String(bookId)) {
      return res.status(400).json({
        success: false,
        message: 'Storybook job does not belong to this book',
      });
    }

    const pdfAsset = jobDoc.pdfAsset;
    if (!pdfAsset || !pdfAsset.key || !pdfAsset.url) {
      return res.status(400).json({
        success: false,
        message: 'No PDF asset found for this job',
      });
    }

    // Load the original PDF from S3 and split it into halves per story page,
    // keeping the cover page intact.
    const originalBuffer = await downloadFromS3(pdfAsset.key);
    if (!originalBuffer || !originalBuffer.length) {
      return res.status(500).json({
        success: false,
        message: 'Failed to download storybook PDF for confirmation',
      });
    }

    const splitResult = await splitStorybookPdf(originalBuffer);
    const splitBuffer = splitResult.buffer;
    const splitPageCount = splitResult.pageCount || pdfAsset.pageCount || 0;

    const originalKey = pdfAsset.key || `books/${bookId}/storybook.pdf`;
    const splitKey = originalKey.endsWith('.pdf')
      ? originalKey.replace(/\.pdf$/, '-confirmed.pdf')
      : `${originalKey}-confirmed.pdf`;

    const uploaded = await uploadBufferToS3(splitBuffer, splitKey, 'application/pdf', {
      acl: 'public-read',
    });

    const payload = {
      bookId,
      storybookJobId: jobDoc._id,
      pdfKey: splitKey,
      pdfUrl: uploaded.url,
      title: pdfAsset.title || jobDoc.title || '',
      readerId: jobDoc.readerId || null,
      readerName: jobDoc.readerName || '',
      readerGender: jobDoc.readerGender || '',
      trainingId: jobDoc.trainingId || null,
      size: splitBuffer.length || pdfAsset.size || 0,
      pageCount: splitPageCount,
      confirmedAt: new Date(),
    };

    let confirmed = await ConfirmedStorybook.findOne({
      bookId,
      storybookJobId: jobDoc._id,
    });

    if (confirmed) {
      Object.assign(confirmed, payload);
      await confirmed.save();
    } else {
      confirmed = await ConfirmedStorybook.create(payload);
    }

    return res.status(200).json({
      success: true,
      message: 'Storybook confirmed successfully.',
      data: confirmed,
    });
  } catch (error) {
    console.error('Error confirming storybook PDF:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to confirm storybook PDF',
    });
  }
};

exports.listConfirmedForBook = async (req, res) => {
  try {
    const { id: bookId } = req.params;
    if (!isValidObjectId(bookId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid book ID',
      });
    }

    const items = await ConfirmedStorybook.find({ bookId })
      .sort({ confirmedAt: -1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: items.length,
      data: items,
    });
  } catch (error) {
    console.error('Error listing confirmed storybooks:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to list confirmed storybooks',
      error: error.message,
    });
  }
};

exports.deleteConfirmed = async (req, res) => {
  try {
    const { id: bookId, confirmedId } = req.params;
    if (!isValidObjectId(bookId) || !isValidObjectId(confirmedId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid ID',
      });
    }

    const existing = await ConfirmedStorybook.findOne({
      _id: confirmedId,
      bookId,
    });

    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Confirmed storybook not found for this book',
      });
    }

    await ConfirmedStorybook.deleteOne({ _id: existing._id });

    return res.status(200).json({
      success: true,
      message: 'Confirmed storybook removed from list.',
    });
  } catch (error) {
    console.error('Error deleting confirmed storybook:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete confirmed storybook',
    });
  }
};


exports.streamJobs = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  res.write(': storybook-stream-start\n\n');

  const bookFilter = isValidObjectId(req.query.bookId) ? req.query.bookId : null;

  const send = (payload) => {
    if (!payload) return;
    if (bookFilter && String(payload.bookId) !== String(bookFilter)) {
      return;
    }
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const unsubscribe = subscribeToStorybookUpdates(send);
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
};
