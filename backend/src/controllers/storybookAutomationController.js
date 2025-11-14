const mongoose = require('mongoose');
const { startStorybookAutomation, getStorybookJobById, listStorybookJobsForBook } = require('../services/storybookWorkflow');
const { subscribeToStorybookUpdates } = require('../services/storybookEvents');

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
