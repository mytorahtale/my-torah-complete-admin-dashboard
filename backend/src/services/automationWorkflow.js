const mongoose = require('mongoose');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const archiver = require('archiver');
const AutomationRun = require('../models/AutomationRun');
const User = require('../models/User');
const Book = require('../models/Book');
const Training = require('../models/Training');
const { evaluateSingleImage } = require('./evaluator');
const {
  uploadBufferToS3,
  deleteFromS3,
  generateImageKey,
  generateTrainingZipKey,
} = require('../config/s3');
const { replicate } = require('../config/replicate');
const { dispatchTraining, populateTrainingForClient } = require('./trainingWorkflow');
const { subscribeToTrainingUpdates } = require('./trainingEvents');
const { startStorybookAutomation } = require('./storybookWorkflow');
const { subscribeToStorybookUpdates } = require('./storybookEvents');
const { emitAutomationUpdate } = require('./automationEvents');
const { createPendingReplicateId } = require('../utils/replicateTraining');

const MAX_TRAINING_IMAGES = 25;

const RUN_STATUS_PROGRESS = {
  creating_user: 5,
  uploading_images: 15,
  training: 40,
  storybook_pending: 65,
  storybook: 80,
  completed: 100,
  failed: 100,
};

const pendingStorybookDispatch = new Set();
let watchersInitialised = false;

const clampProgress = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric < 0) return 0;
  if (numeric > 100) return 100;
  return Math.round(numeric);
};

const computeRunProgress = ({
  status,
  trainingProgress = 0,
  storybookProgress = 0,
}) => {
  switch (status) {
    case 'creating_user':
      return RUN_STATUS_PROGRESS.creating_user;
    case 'uploading_images':
      return RUN_STATUS_PROGRESS.uploading_images;
    case 'training':
      return Math.max(
        RUN_STATUS_PROGRESS.uploading_images,
        Math.round(20 + clampProgress(trainingProgress) * 0.4)
      );
    case 'storybook_pending':
      return Math.max(
        RUN_STATUS_PROGRESS.storybook_pending,
        Math.round(60 + clampProgress(trainingProgress) * 0.2)
      );
    case 'storybook':
      return Math.max(
        RUN_STATUS_PROGRESS.storybook,
        Math.round(65 + clampProgress(storybookProgress) * 0.35)
      );
    case 'completed':
      return RUN_STATUS_PROGRESS.completed;
    case 'failed':
      return Math.max(RUN_STATUS_PROGRESS.training, clampProgress(trainingProgress));
    default:
      return clampProgress(trainingProgress);
  }
};

const createEvent = (type, message, metadata = null) => ({
  type,
  message,
  metadata,
  timestamp: new Date(),
});

const sanitiseTrainingSnapshot = (training) => {
  if (!training) return null;
  const plain =
    typeof training.toObject === 'function'
      ? training.toObject({ depopulate: true })
      : JSON.parse(JSON.stringify(training));
  let userInfo = null;
  let userId = null;
  if (plain.userId && typeof plain.userId === 'object') {
    userInfo = {
      _id: plain.userId._id || plain.userId.id || plain.userId,
      name: plain.userId.name || '',
      email: plain.userId.email || '',
    };
    userId = userInfo._id;
  } else if (plain.userId) {
    userId = plain.userId;
  }
  return {
    _id: plain._id,
    status: plain.status,
    progress: clampProgress(plain.progress || 0),
    error: plain.error || null,
    attempts: plain.attempts || 0,
    modelName: plain.modelName || null,
    modelVersion: plain.modelVersion || null,
    logsUrl: plain.logsUrl || null,
    events: plain.events || [],
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
    user: userInfo,
    userId,
  };
};

const sanitiseStorybookSnapshot = (job) => {
  if (!job) return null;
  const plain =
    typeof job.toObject === 'function'
      ? job.toObject({ depopulate: true })
      : JSON.parse(JSON.stringify(job));
  return {
    _id: plain._id,
    status: plain.status,
    progress: clampProgress(plain.progress || 0),
    estimatedSecondsRemaining: plain.estimatedSecondsRemaining || null,
    error: plain.error || null,
    events: plain.events || [],
    pages: plain.pages || [],
    pdfAsset: plain.pdfAsset || plain.pdfAssetId || null,
    createdAt: plain.createdAt,
    updatedAt: plain.updatedAt,
  };
};

const emitRun = async (runId) => {
  const run = await AutomationRun.findById(runId)
    .populate('userId', 'name email age gender')
    .populate('bookId', 'name')
    .lean();
  if (run) {
    emitAutomationUpdate(run);
  }
  return run;
};

const updateRun = async (runId, update) => {
  const run = await AutomationRun.findByIdAndUpdate(runId, update, { new: true });
  if (!run) return null;
  await emitRun(run._id);
  return run;
};

const guessContentType = (fileName = '') => {
  const ext = path.extname(fileName).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.tiff':
    case '.tif':
      return 'image/tiff';
    case '.jpeg':
    case '.jpg':
    default:
      return 'image/jpeg';
  }
};

const createTrainingZipFromAssets = async ({ modelName, assets }) => {
  let localZipPath;
  let zipKey;

  try {
    const tempDir = path.join(os.tmpdir(), 'automation-training');
    await fs.ensureDir(tempDir);
    localZipPath = path.join(tempDir, `${modelName}.zip`);

    const archiveOutput = fs.createWriteStream(localZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const archivePromise = new Promise((resolve, reject) => {
      archiveOutput.on('close', resolve);
      archiveOutput.on('error', reject);
    });

    archive.pipe(archiveOutput);

    assets.forEach((asset, index) => {
      const fileName =
        asset.originalName || `training-image-${index + 1}.${asset.contentType?.split('/')[1] || 'jpg'}`;
      archive.append(asset.buffer, { name: fileName });
    });

    archive.finalize();
    await archivePromise;

    zipKey = generateTrainingZipKey(modelName);
    const zipBuffer = await fs.readFile(localZipPath);
    const uploadResult = await uploadBufferToS3(zipBuffer, zipKey, 'application/zip');

    return {
      localZipPath,
      zipKey,
      zipUrl: uploadResult.url,
    };
  } catch (error) {
    if (zipKey) {
      await deleteFromS3(zipKey).catch(() => {});
    }
    if (localZipPath) {
      await fs.remove(localZipPath).catch(() => {});
    }
    throw error;
  }
};

const dispatchTrainingForAutomation = async ({
  user,
  runId,
  assets,
  trainingConfigInput = {},
}) => {
  if (!assets.length) {
    throw new Error('No training assets available for automation run.');
  }

  const timestamp = Date.now();
  const baseName = user.name ? user.name.toLowerCase().replace(/[^a-z0-9-]/g, '-') : 'model';
  const uniqueModelName = `${baseName}-${timestamp}`;

  const { localZipPath, zipKey, zipUrl } = await createTrainingZipFromAssets({
    modelName: uniqueModelName,
    assets,
  });

  let training;

  try {
    const trainingInput = {
      input_images: zipUrl,
      steps: trainingConfigInput?.steps ? Number(trainingConfigInput.steps) : 1000,
      lora_rank: trainingConfigInput?.loraRank ? Number(trainingConfigInput.loraRank) : 16,
      batch_size: trainingConfigInput?.batchSize ? Number(trainingConfigInput.batchSize) : 1,
      learning_rate: trainingConfigInput?.learningRate ? Number(trainingConfigInput.learningRate) : 0.0004,
      trigger_word: uniqueModelName,
    };

    const replicateOptions = {
      input: trainingInput,
    };

    if (process.env.REPLICATE_USERNAME) {
      const destinationPath = `${process.env.REPLICATE_USERNAME}/${uniqueModelName}`;
      replicateOptions.destination = destinationPath;
      try {
        await replicate.models.create(process.env.REPLICATE_USERNAME, uniqueModelName, {
          visibility: 'private',
          hardware: 'gpu-t4',
          description: `Fine-tuned Flux model for ${user.name || user.email || 'automation reader'}`,
        });
      } catch (modelError) {
        console.error('[automation] Failed to create Replicate model:', modelError.message);
        throw new Error(`Failed to create model on Replicate: ${modelError.message}`);
      }
    } else {
      console.warn('[automation] REPLICATE_USERNAME not set - training will not persist model destination');
    }

    training = await Training.create({
      userId: user._id,
      modelName: uniqueModelName,
      replicateTrainingId: createPendingReplicateId(uniqueModelName),
      imageUrls: assets.map((asset) => asset.previewUrl || asset.url).filter(Boolean),
      imageAssets: assets.map((asset) => ({
        key: asset.key,
        url: asset.url,
        originalName: asset.originalName,
        size: asset.size,
        contentType: asset.contentType,
      })),
      status: 'queued',
      progress: 0,
      logsUrl: null,
      trainingConfig: {
        ...trainingConfigInput,
        modelName: uniqueModelName,
        source: 'upload',
        zipKey,
        zipUrl,
      },
      attempts: 0,
      events: [
        createEvent('created', 'Automation training queued', {
          runId,
          modelName: uniqueModelName,
          assets: assets.length,
        }),
      ],
    });

    await dispatchTraining({
      trainingId: training._id,
      replicateArgs: {
        owner: 'ostris',
        project: 'flux-dev-lora-trainer',
        version: 'e440909d3512c31646ee2e0c7d6f6f4923224863a6a10c494606e79fb5844497',
        ...replicateOptions,
      },
      reason: 'automation',
    });
  } catch (error) {
    await deleteFromS3(zipKey).catch(() => {});
    if (localZipPath) {
      await fs.remove(localZipPath).catch(() => {});
    }
    throw error;
  }

  if (localZipPath) {
    await fs.remove(localZipPath).catch(() => {});
  }

  const populated = await populateTrainingForClient(training._id);
  return populated;
};

const triggerStorybookForRun = async (run, trainingSnapshot) => {
  if (!run || !trainingSnapshot) return null;
  const runId = run._id.toString();
  if (!run.bookId || !run.userId || pendingStorybookDispatch.has(runId)) {
    return null;
  }

  pendingStorybookDispatch.add(runId);

  try {
    const book = await Book.findById(run.bookId).lean();
    if (!book) {
      throw new Error('Book not found for automation run');
    }

    const job = await startStorybookAutomation({
      bookId: run.bookId,
      trainingId: trainingSnapshot._id || run.trainingId,
      userId: run.userId,
      readerId: run.userId,
      readerName:
        trainingSnapshot?.user?.name ||
        trainingSnapshot?.user?.email ||
        trainingSnapshot?.modelName ||
        '',
      title: `${book.name} Storybook`,
    });

    await updateRun(run._id, {
      $set: {
        storybookJobId: job?._id || job?.id || job,
        status: 'storybook',
        storybookSnapshot: sanitiseStorybookSnapshot(job),
        progress: computeRunProgress({
          status: 'storybook',
          trainingProgress: trainingSnapshot.progress || 100,
          storybookProgress: job?.progress || 0,
        }),
      },
      $push: {
        events: createEvent('storybook_started', 'Storybook automation started', {
          jobId: job?._id || null,
        }),
      },
    });
  } catch (error) {
    await updateRun(run._id, {
      $set: {
        status: 'failed',
        error: error.message || 'Failed to start storybook automation',
        progress: computeRunProgress({
          status: 'failed',
          trainingProgress: trainingSnapshot.progress || 100,
        }),
      },
      $push: {
        events: createEvent('error', 'Storybook automation failed to start', {
          error: error.message,
        }),
      },
    });
  } finally {
    pendingStorybookDispatch.delete(runId);
  }
};

const handleTrainingUpdate = async (training) => {
  if (!training?._id) return;
  const run = await AutomationRun.findOne({ trainingId: training._id });
  if (!run) return;

  const trainingSnapshot = sanitiseTrainingSnapshot(training);
  let status = run.status;
  let error = run.error;

  if (trainingSnapshot.status === 'failed') {
    status = 'failed';
    error = trainingSnapshot.error || 'Training failed';
  } else if (trainingSnapshot.status === 'succeeded') {
    status =
      run.storybookJobId || pendingStorybookDispatch.has(run._id.toString())
        ? 'storybook'
        : 'storybook_pending';
  } else {
    status = 'training';
  }

  const progress = computeRunProgress({
    status,
    trainingProgress: trainingSnapshot.progress || 0,
    storybookProgress: run.storybookSnapshot?.progress || 0,
  });

  const update = {
    $set: {
      status,
      error,
      trainingSnapshot,
      progress,
    },
  };

  if (trainingSnapshot.status === 'failed') {
    update.$push = {
      events: createEvent('training_failed', trainingSnapshot.error || 'Training failed'),
    };
  } else if (trainingSnapshot.status === 'succeeded' && run.status !== 'storybook') {
    update.$push = {
      events: createEvent('training_completed', 'Training completed successfully', {
        modelVersion: trainingSnapshot.modelVersion,
      }),
    };
  }

  const updated = await AutomationRun.findByIdAndUpdate(run._id, update, {
    new: true,
  });
  if (!updated) return;
  await emitRun(updated._id);

  if (
    trainingSnapshot.status === 'succeeded' &&
    !updated.storybookJobId &&
    !pendingStorybookDispatch.has(updated._id.toString())
  ) {
    await triggerStorybookForRun(updated, trainingSnapshot);
  }
};

const handleStorybookUpdate = async (job) => {
  if (!job?._id) return;
  const run = await AutomationRun.findOne({ storybookJobId: job._id });
  if (!run) return;

  const storybookSnapshot = sanitiseStorybookSnapshot(job);
  let status = run.status;
  let error = run.error;

  if (storybookSnapshot.status === 'failed') {
    status = 'failed';
    error = storybookSnapshot.error || 'Storybook automation failed';
  } else if (storybookSnapshot.status === 'succeeded') {
    status = 'completed';
  } else {
    status = 'storybook';
  }

  const progress = computeRunProgress({
    status,
    trainingProgress: run.trainingSnapshot?.progress || 100,
    storybookProgress: storybookSnapshot.progress || 0,
  });

  const update = {
    $set: {
      status,
      error,
      storybookSnapshot,
      progress,
    },
  };

  if (storybookSnapshot.status === 'failed') {
    update.$push = {
      events: createEvent('storybook_failed', storybookSnapshot.error || 'Storybook failed'),
    };
  } else if (storybookSnapshot.status === 'succeeded' && run.status !== 'completed') {
    update.$push = {
      events: createEvent('storybook_completed', 'Storybook automation completed'),
    };
  }

  await updateRun(run._id, update);
};

const initialiseAutomationWatchers = () => {
  if (watchersInitialised) return;
  watchersInitialised = true;

  subscribeToTrainingUpdates((payload) => {
    handleTrainingUpdate(payload).catch((error) => {
      console.error('[automation] Training update handler failed:', error);
    });
  });

  subscribeToStorybookUpdates((payload) => {
    handleStorybookUpdate(payload).catch((error) => {
      console.error('[automation] Storybook update handler failed:', error);
    });
  });
};

const createAutomationRun = async ({ bookId, userInput, files, overrides = [] }) => {
  initialiseAutomationWatchers();

  const run = await AutomationRun.create({
    bookId,
    status: 'creating_user',
    progress: RUN_STATUS_PROGRESS.creating_user,
    events: [
      createEvent('created', 'Automation run created', {
        bookId,
      }),
    ],
  });

  await emitRun(run._id);

  let user = null;
  const processedAssets = [];
  const uploadedAssetMetas = [];

  try {
    const book = await Book.findById(bookId);
    if (!book) {
      throw new Error('Book not found');
    }

    user = await User.create({
      name: userInput.name,
      age: userInput.age,
      gender: userInput.gender,
      email: userInput.email,
      countryCode: userInput.countryCode,
      phoneNumber: userInput.phoneNumber,
      imageAssets: [],
    });

    await updateRun(run._id, {
      $set: {
        userId: user._id,
        status: 'uploading_images',
        progress: RUN_STATUS_PROGRESS.uploading_images,
      },
      $push: {
        events: createEvent('user_created', 'User created for automation', {
          userId: user._id,
        }),
      },
    });

    const includedFiles = files.filter((file) => file);
    if (!includedFiles.length) {
      throw new Error('No reference photos uploaded for automation.');
    }

    const maxAssets = includedFiles.slice(0, MAX_TRAINING_IMAGES);

    for (let index = 0; index < maxAssets.length; index += 1) {
      const file = maxAssets[index];
      const override = overrides[index] === true || overrides[index] === 'true';

      const base64 = file.buffer.toString('base64');
      let evaluation;
      try {
        evaluation = await evaluateSingleImage({
          name: file.originalname,
          mimeType: file.mimetype,
          base64,
        });
      } catch (error) {
        throw new Error(error.message || 'Image evaluation failed');
      }

      const imageEvaluation = Array.isArray(evaluation?.images) ? evaluation.images[0] : null;
      if (!override && (!imageEvaluation || !imageEvaluation.acceptable)) {
        throw new Error(
          `Image "${file.originalname}" rejected by evaluator. Enable override if you still want to include it.`
        );
      }

      const key = generateImageKey(user._id, file.originalname);
      const uploadResult = await uploadBufferToS3(file.buffer, key, file.mimetype);

      const asset = {
        key,
        url: uploadResult.url,
        size: file.size,
        contentType: file.mimetype || guessContentType(file.originalname),
        uploadedAt: new Date(),
        originalName: file.originalname,
        evaluation: imageEvaluation
          ? {
              verdict: imageEvaluation.verdict,
              acceptable: Boolean(imageEvaluation.acceptable),
              scorePercent: imageEvaluation.overallScorePercent ?? null,
              confidencePercent: imageEvaluation.confidencePercent ?? null,
              summary: evaluation?.overallAcceptance?.summary || '',
              override,
            }
          : {
              override,
            },
      };

      processedAssets.push({
        buffer: Buffer.from(file.buffer),
        originalName: file.originalname,
        contentType: asset.contentType,
        size: file.size,
        url: uploadResult.url,
        key,
      });
      uploadedAssetMetas.push(asset);

      user.imageAssets.push(asset);
    }

    await user.save();

    await updateRun(run._id, {
      $set: {
        status: 'training',
        steps: {
          uploads: 'completed',
        },
      },
      $push: {
        events: createEvent('images_uploaded', 'Reference photos uploaded', {
          count: uploadedAssetMetas.length,
        }),
      },
    });

    const training = await dispatchTrainingForAutomation({
      user,
      runId: run._id,
      assets: processedAssets,
    });

    await updateRun(run._id, {
      $set: {
        trainingId: training._id,
        trainingSnapshot: sanitiseTrainingSnapshot(training),
        progress: computeRunProgress({
          status: 'training',
          trainingProgress: training.progress || 0,
        }),
      },
      $push: {
        events: createEvent('training_started', 'Training started', {
          trainingId: training._id,
        }),
      },
    });

    return emitRun(run._id);
  } catch (error) {
    if (user && uploadedAssetMetas.length) {
      const assetKeys = uploadedAssetMetas.map((asset) => asset.key);
      await Promise.all(assetKeys.map((key) => deleteFromS3(key).catch(() => {})));
      user.imageAssets = user.imageAssets.filter(
        (asset) => !assetKeys.includes(asset.key)
      );
      await user.save().catch(() => {});
    }

    await updateRun(run._id, {
      $set: {
        status: 'failed',
        error: error.message || 'Automation failed to start',
        progress: RUN_STATUS_PROGRESS.failed,
      },
      $push: {
        events: createEvent('error', error.message || 'Automation failed'),
      },
    });

    throw error;
  }
};

const escapeRegex = (value) =>
  typeof value === 'string' ? value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : value;

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
};

const VALID_AUTOMATION_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'status', 'progress']);

const listAutomationRuns = async (options = {}) => {
  const {
    page = 1,
    limit = 10,
    status,
    bookId,
    userId,
    search = '',
    from,
    to,
    sortBy = 'createdAt',
    sortOrder = 'desc',
  } = options;

  const numericLimit = toPositiveInteger(limit, 10);
  const rawPage = toPositiveInteger(page, 1) || 1;

  const matchStage = {};

  if (status && status !== 'all') {
    matchStage.status = status;
  }

  if (bookId && mongoose.Types.ObjectId.isValid(bookId)) {
    matchStage.bookId = new mongoose.Types.ObjectId(bookId);
  }

  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    matchStage.userId = new mongoose.Types.ObjectId(userId);
  }

  if (from || to) {
    const createdAtFilter = {};
    if (from) {
      const fromDate = new Date(from);
      if (!Number.isNaN(fromDate.getTime())) {
        createdAtFilter.$gte = fromDate;
      }
    }
    if (to) {
      const toDate = new Date(to);
      if (!Number.isNaN(toDate.getTime())) {
        createdAtFilter.$lte = toDate;
      }
    }
    if (Object.keys(createdAtFilter).length > 0) {
      matchStage.createdAt = createdAtFilter;
    }
  }

  const sortField = VALID_AUTOMATION_SORT_FIELDS.has(sortBy) ? sortBy : 'createdAt';
  const sortDirection = sortOrder === 'asc' ? 1 : -1;
  const sortStage = { [sortField]: sortDirection, _id: sortDirection };

  const pipeline = [{ $match: matchStage }];

  pipeline.push(
    {
      $lookup: {
        from: 'books',
        localField: 'bookId',
        foreignField: '_id',
        as: 'book',
      },
    },
    {
      $unwind: {
        path: '$book',
        preserveNullAndEmptyArrays: true,
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        as: 'user',
      },
    },
    {
      $unwind: {
        path: '$user',
        preserveNullAndEmptyArrays: true,
      },
    }
  );

  if (search && typeof search === 'string') {
    const regex = new RegExp(escapeRegex(search.trim()), 'i');
    pipeline.push({
      $match: {
        $or: [
          { 'book.name': regex },
          { 'user.name': regex },
          { 'user.email': regex },
        ],
      },
    });
  }

  pipeline.push({
    $addFields: {
      limitedEvents: {
        $let: {
          vars: { eventsArray: { $ifNull: ['$events', []] } },
          in: {
            $cond: [
              { $lte: [{ $size: '$$eventsArray' }, 12] },
              '$$eventsArray',
              {
                $slice: [
                  '$$eventsArray',
                  { $subtract: [{ $size: '$$eventsArray' }, 12] },
                  12,
                ],
              },
            ],
          },
        },
      },
    },
  });

  pipeline.push({
    $project: {
      _id: 1,
      userId: {
        _id: '$user._id',
        name: '$user.name',
        email: '$user.email',
        age: '$user.age',
        gender: '$user.gender',
      },
      user: {
        _id: '$user._id',
        name: '$user.name',
        email: '$user.email',
        age: '$user.age',
        gender: '$user.gender',
      },
      bookId: {
        _id: '$book._id',
        name: '$book.name',
      },
      book: {
        _id: '$book._id',
        name: '$book.name',
      },
      trainingId: 1,
      storybookJobId: 1,
      status: 1,
      progress: 1,
      error: 1,
      trainingSnapshot: {
        $cond: [
          { $ne: ['$trainingSnapshot', null] },
          {
            status: '$trainingSnapshot.status',
            progress: { $ifNull: ['$trainingSnapshot.progress', 0] },
            attempts: { $ifNull: ['$trainingSnapshot.attempts', 0] },
            modelName: '$trainingSnapshot.modelName',
            modelVersion: '$trainingSnapshot.modelVersion',
            error: '$trainingSnapshot.error',
          },
          null,
        ],
      },
      storybookSnapshot: {
        $cond: [
          { $ne: ['$storybookSnapshot', null] },
          {
            status: '$storybookSnapshot.status',
            progress: { $ifNull: ['$storybookSnapshot.progress', 0] },
            estimatedSecondsRemaining: '$storybookSnapshot.estimatedSecondsRemaining',
            error: '$storybookSnapshot.error',
            pdfAsset: '$storybookSnapshot.pdfAsset',
          },
          null,
        ],
      },
      events: '$limitedEvents',
      createdAt: 1,
      updatedAt: 1,
    },
  });

  pipeline.push({ $sort: sortStage });

  const dataPipeline = [];
  if (numericLimit > 0) {
    const skip = (Math.max(rawPage, 1) - 1) * numericLimit;
    if (skip > 0) {
      dataPipeline.push({ $skip: skip });
    }
    dataPipeline.push({ $limit: numericLimit });
  } else if (rawPage > 1) {
    // No limit means return everything, ignore page.
  }

  const aggregatePipeline = [
    ...pipeline,
    {
      $facet: {
        data: dataPipeline,
        totalCount: [{ $count: 'count' }],
        statusCounts: [
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ];

  const [result] = await AutomationRun.aggregate(aggregatePipeline);
  const runs = Array.isArray(result?.data) ? result.data : [];
  const total = Array.isArray(result?.totalCount) && result.totalCount.length > 0 ? result.totalCount[0].count : 0;

  const statusBreakdown = {};
  if (Array.isArray(result?.statusCounts)) {
    result.statusCounts.forEach((item) => {
      if (item?._id) {
        statusBreakdown[item._id] = item.count;
      }
    });
  }

  const totalPages =
    numericLimit > 0 && total > 0 ? Math.ceil(total / numericLimit) : total > 0 ? 1 : 0;
  const effectivePage =
    numericLimit > 0 ? Math.min(Math.max(rawPage, 1), Math.max(totalPages, 1)) : 1;

  return {
    data: runs,
    pagination: {
      page: totalPages === 0 ? 1 : effectivePage,
      limit: numericLimit,
      total,
      totalPages,
      hasNextPage: numericLimit > 0 && effectivePage < totalPages,
      hasPrevPage: numericLimit > 0 && effectivePage > 1,
    },
    filters: {
      search: typeof search === 'string' ? search : '',
      status: status || 'all',
      bookId: bookId || '',
      userId: userId || '',
      from: from || '',
      to: to || '',
      sortBy: sortField,
      sortOrder: sortDirection === 1 ? 'asc' : 'desc',
    },
    stats: {
      totalRuns: total,
      byStatus: statusBreakdown,
    },
  };
};

const getAutomationRun = async (id) => {
  return AutomationRun.findById(id)
    .populate('userId', 'name email age gender')
    .populate('bookId', 'name')
    .lean();
};

module.exports = {
  createAutomationRun,
  listAutomationRuns,
  getAutomationRun,
  initialiseAutomationWatchers,
};
