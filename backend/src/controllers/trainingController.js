const mongoose = require('mongoose');
const Training = require('../models/Training');
const User = require('../models/User');
const { replicate } = require('../config/replicate');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const archiver = require('archiver');
const {
  uploadBufferToS3,
  deleteFromS3,
  generateTrainingImageKey,
  generateTrainingZipKey,
  downloadFromS3,
} = require('../config/s3');
const { subscribeToTrainingUpdates } = require('../services/trainingEvents');
const {
  dispatchTraining,
  processTrainingEvent,
  broadcastTraining,
  populateTrainingForClient,
} = require('../services/trainingWorkflow');
const {
  createPendingReplicateId,
  isPendingReplicateId,
} = require('../utils/replicateTraining');

const MAX_TRAINING_IMAGES = 25;

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

const buildFileNameFromAsset = (asset, index) => {
  if (!asset) {
    return `training-image-${index + 1}.jpg`;
  }

  if (asset.originalName) {
    return asset.originalName;
  }

  if (asset.key) {
    return path.basename(asset.key);
  }

  if (asset.name) {
    return asset.name;
  }

  return `training-image-${index + 1}.jpg`;
};

const normaliseUrl = (url) => {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.toString();
  } catch (error) {
    return encodeURI(url);
  }
};

const downloadAssetBuffer = async (asset, index) => {
  if (!asset) return null;

  if (asset.key) {
    try {
      const buffer = await downloadFromS3(asset.key);
      if (buffer && buffer.length > 0) {
        return buffer;
      }
    } catch (error) {
      console.warn(`⚠️  Failed to download asset ${asset.key} from S3: ${error.message}`);
    }
  }

  if (asset.url) {
    const targetUrl = normaliseUrl(asset.url);
    if (!targetUrl) return null;
    const response = await fetch(targetUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image from ${targetUrl} (status ${response.status})`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  console.warn(`⚠️  Asset at index ${index} had neither key nor URL. Skipping.`);
  return null;
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

const VALID_TRAINING_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'status', 'modelName', 'attempts']);

/**
 * Get all training jobs
 * @route GET /api/trainings
 */
exports.getAllTrainings = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      userId,
      status,
      search = '',
      from,
      to,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      minimal,
    } = req.query;

    const isMinimal = typeof minimal === 'string' && minimal.toLowerCase() === 'true';

    const filter = {};

    if (userId) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid userId provided',
        });
      }
      filter.userId = new mongoose.Types.ObjectId(userId);
    }

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (search && typeof search === 'string') {
      const expression = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [{ modelName: expression }, { modelVersion: expression }];
    }

    if (from || to) {
      const dateFilter = {};
      if (from) {
        const fromDate = new Date(from);
        if (!Number.isNaN(fromDate.getTime())) {
          dateFilter.$gte = fromDate;
        }
      }
      if (to) {
        const toDate = new Date(to);
        if (!Number.isNaN(toDate.getTime())) {
          dateFilter.$lte = toDate;
        }
      }
      if (Object.keys(dateFilter).length > 0) {
        filter.createdAt = dateFilter;
      }
    }

    const numericLimit = toPositiveInteger(limit, 10);
    const rawPage = toPositiveInteger(page, 1) || 1;

    const sortField = VALID_TRAINING_SORT_FIELDS.has(sortBy) ? sortBy : 'createdAt';
    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    const sort = { [sortField]: sortDirection, _id: sortDirection };

    const totalTrainings = await Training.countDocuments(filter);
    const totalPages =
      numericLimit > 0 && totalTrainings > 0
        ? Math.ceil(totalTrainings / numericLimit)
        : totalTrainings > 0
        ? 1
        : 0;
    const effectivePage =
      numericLimit > 0
        ? Math.min(Math.max(rawPage, 1), Math.max(totalPages, 1))
        : 1;
    const skip = numericLimit > 0 ? (effectivePage - 1) * numericLimit : 0;

    const query = Training.find(filter)
      .populate('userId', 'name email age gender')
      .sort(sort)
      .allowDiskUse(true);

    if (isMinimal) {
      query
        .select(
          'status progress attempts modelName modelVersion trainingConfig error createdAt updatedAt startedAt completedAt imageAssets imageUrls userId'
        )
        .lean({ virtuals: false });
    }

    if (numericLimit > 0) {
      query.skip(skip).limit(numericLimit);
    }

    let trainings = await query.exec();

    if (isMinimal) {
      trainings = trainings.map((training) => {
        const plain = { ...training };
        const imageAssets = Array.isArray(plain.imageAssets) ? plain.imageAssets : [];
        const imageUrls = Array.isArray(plain.imageUrls) ? plain.imageUrls : [];

        return {
          ...plain,
          imageAssets: imageAssets.slice(0, 12),
          imageAssetCount: imageAssets.length,
          imageUrls: imageUrls.slice(0, 12),
          imageUrlCount: imageUrls.length,
        };
      });
    }

    const statusAggregation = await Training.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]);

    const statusBreakdown = statusAggregation.reduce((accumulator, item) => {
      if (item?._id) {
        accumulator[item._id] = item.count;
      }
      return accumulator;
    }, {});

    res.status(200).json({
      success: true,
      count: trainings.length,
      data: trainings,
      pagination: {
        page: totalPages === 0 ? 1 : effectivePage,
        limit: numericLimit,
        total: totalTrainings,
        totalPages,
        hasNextPage: numericLimit > 0 && effectivePage < totalPages,
        hasPrevPage: numericLimit > 0 && effectivePage > 1,
      },
      filters: {
        search: typeof search === 'string' ? search : '',
        status: status || 'all',
        userId: userId || '',
        from: from || '',
        to: to || '',
        sortBy: sortField,
        sortOrder: sortDirection === 1 ? 'asc' : 'desc',
      },
      stats: {
        total: totalTrainings,
        byStatus: statusBreakdown,
      },
    });
  } catch (error) {
    console.error('Error fetching trainings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trainings',
      error: error.message,
    });
  }
};

/**
 * Get trainings with minimal data for list view (optimized for large datasets)
 * @route GET /api/trainings/lean
 */
exports.getTrainingsLean = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      userId,
      status,
      search = '',
      from,
      to,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = req.query;

    const numericLimit = Math.min(toPositiveInteger(limit, 10), 100);
    const rawPage = toPositiveInteger(page, 1) || 1;

    const filter = {};

    if (userId) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid userId provided',
        });
      }
      filter.userId = new mongoose.Types.ObjectId(userId);
    }

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (search && typeof search === 'string') {
      const expression = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [{ modelName: expression }];
    }

    if (from || to) {
      filter.createdAt = {};
      if (from) {
        const fromDate = new Date(from);
        if (!Number.isNaN(fromDate.getTime())) {
          filter.createdAt.$gte = fromDate;
        }
      }
      if (to) {
        const toDate = new Date(to);
        if (!Number.isNaN(toDate.getTime())) {
          filter.createdAt.$lte = toDate;
        }
      }
    }

    const sortField = VALID_TRAINING_SORT_FIELDS.has(sortBy) ? sortBy : 'createdAt';
    const sortDirection = sortOrder === 'asc' ? 1 : -1;

    // Use aggregation for efficient querying with minimal data
    const pipeline = [
      { $match: filter },
      {
        $project: {
          _id: 1,
          userId: 1,
          modelName: 1,
          status: 1,
          progress: 1,
          attempts: 1,
          modelVersion: 1,
          error: 1,
          createdAt: 1,
          startedAt: 1,
          completedAt: 1,
          updatedAt: 1,
          // Only include minimal imageAsset data (url, size, contentType)
          imageAssets: {
            $map: {
              input: { $ifNull: ['$imageAssets', []] },
              as: 'asset',
              in: {
                url: '$$asset.url',
                size: '$$asset.size',
                contentType: '$$asset.contentType',
              },
            },
          },
          imageUrls: 1,
          imageAssetCount: { $size: { $ifNull: ['$imageAssets', []] } },
          imageUrlCount: { $size: { $ifNull: ['$imageUrls', []] } },
        },
      },
      { $sort: { [sortField]: sortDirection, _id: sortDirection } },
    ];

    // Get total count
    const countPipeline = [...pipeline, { $count: 'total' }];
    const countResult = await Training.aggregate(countPipeline).allowDiskUse(true);
    const totalTrainings = countResult.length > 0 ? countResult[0].total : 0;

    // Add pagination
    const totalPages =
      numericLimit > 0 && totalTrainings > 0
        ? Math.ceil(totalTrainings / numericLimit)
        : totalTrainings > 0
        ? 1
        : 0;
    const effectivePage =
      numericLimit > 0 ? Math.min(Math.max(rawPage, 1), Math.max(totalPages, 1)) : 1;
    const skip = numericLimit > 0 ? (effectivePage - 1) * numericLimit : 0;

    if (numericLimit > 0) {
      pipeline.push({ $skip: skip });
      pipeline.push({ $limit: numericLimit });
    }

    // Lookup user data
    pipeline.push({
      $lookup: {
        from: 'users',
        localField: 'userId',
        foreignField: '_id',
        as: 'userInfo',
      },
    });

    pipeline.push({
      $addFields: {
        userId: {
          $let: {
            vars: { user: { $arrayElemAt: ['$userInfo', 0] } },
            in: {
              $cond: {
                if: { $ne: ['$$user', null] },
                then: {
                  _id: '$$user._id',
                  name: '$$user.name',
                  email: '$$user.email',
                },
                else: null,
              },
            },
          },
        },
      },
    });

    pipeline.push({ $project: { userInfo: 0 } });

    const trainings = await Training.aggregate(pipeline).allowDiskUse(true);

    // Limit imageAssets to first 12 for display
    const processedTrainings = trainings.map((training) => ({
      ...training,
      imageAssets: (training.imageAssets || []).slice(0, 12),
      imageUrls: (training.imageUrls || []).slice(0, 12),
    }));

    // Get status breakdown
    const statusAggregation = await Training.aggregate([
      { $match: filter },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
        },
      },
    ]).allowDiskUse(true);

    const statusBreakdown = statusAggregation.reduce((accumulator, item) => {
      if (item?._id) {
        accumulator[item._id] = item.count;
      }
      return accumulator;
    }, {});

    res.status(200).json({
      success: true,
      count: processedTrainings.length,
      data: processedTrainings,
      pagination: {
        page: totalPages === 0 ? 1 : effectivePage,
        limit: numericLimit,
        total: totalTrainings,
        totalPages,
        hasNextPage: numericLimit > 0 && effectivePage < totalPages,
        hasPrevPage: numericLimit > 0 && effectivePage > 1,
      },
      filters: {
        search: typeof search === 'string' ? search : '',
        status: status || 'all',
        userId: userId || '',
        from: from || '',
        to: to || '',
        sortBy: sortField,
        sortOrder: sortDirection === 1 ? 'asc' : 'desc',
      },
      stats: {
        total: totalTrainings,
        byStatus: statusBreakdown,
      },
    });
  } catch (error) {
    console.error('Error fetching lean trainings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch trainings',
      error: error.message,
    });
  }
};

/**
 * Get single training by ID
 * @route GET /api/trainings/:id
 */
exports.getTrainingById = async (req, res) => {
  try {
    const training = await Training.findById(req.params.id).populate(
      'userId',
      'name email age gender'
    );

    if (!training) {
      return res.status(404).json({
        success: false,
        message: 'Training not found',
      });
    }

    res.status(200).json({
      success: true,
      data: training,
    });
  } catch (error) {
    console.error('Error fetching training:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch training',
      error: error.message,
    });
  }
};

/**
 * Fetch logs for a specific training job
 * @route GET /api/trainings/:id/logs
 */
exports.getTrainingLogs = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid training ID provided',
      });
    }

    const rawLimit = Number(req.query.limit);
    const limit = toPositiveInteger(rawLimit, 0);
    const orderInput = typeof req.query.order === 'string' ? req.query.order.toLowerCase() : 'desc';
    const order = orderInput === 'asc' ? 'asc' : 'desc';

    const training = await Training.findById(id).select('logs logsUrl modelName status userId');
    if (!training) {
      return res.status(404).json({
        success: false,
        message: 'Training not found',
      });
    }

    const fullLogs = Array.isArray(training.logs) ? training.logs : [];
    let logs = fullLogs.slice();

    if (limit > 0 && fullLogs.length > limit) {
      logs = fullLogs.slice(-limit);
    }

    if (order === 'desc') {
      logs = logs.slice().reverse();
    }

    res.status(200).json({
      success: true,
      trainingId: training._id,
      count: fullLogs.length,
      logsReturned: logs.length,
      order,
      limit: limit || null,
      logs,
      logsUrl: training.logsUrl || null,
    });
  } catch (error) {
    console.error('Error fetching training logs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch training logs',
      error: error.message,
    });
  }
};

/**
 * Start fine-tuning for a user
 * @route POST /api/trainings
 */
exports.startTraining = async (req, res) => {
  const incomingFiles = Array.isArray(req.files) ? req.files : [];
  let uploadedAssets = [];
  let generatedZipKey = null;
  let localZipPath;

  try {
    const { userId } = req.body;
    const modelName = req.body.modelName;
    const trainingConfigInput =
      req.body.trainingConfig && typeof req.body.trainingConfig === 'object'
        ? req.body.trainingConfig
        : {};

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const useUserAssets = incomingFiles.length === 0;
    let sourceAssets = [];
    let userAssetIdsUsed = [];

    if (useUserAssets) {
      const userAssets = Array.isArray(user.imageAssets) ? user.imageAssets : [];
      if (!userAssets.length) {
        return res.status(400).json({
          success: false,
          message: 'Selected user has no uploaded images. Add reference photos before starting training.',
        });
      }

      const assetsToProcess = userAssets.slice(0, MAX_TRAINING_IMAGES);
      userAssetIdsUsed = assetsToProcess.map((asset) => asset._id);

      for (let index = 0; index < assetsToProcess.length; index += 1) {
        const asset = assetsToProcess[index];
        try {
          const buffer = await downloadAssetBuffer(asset, index);

          if (!buffer || buffer.length === 0) {
            console.warn(`⚠️  Skipping empty buffer for asset index ${index} (user ${userId})`);
            continue;
          }

          const originalName = buildFileNameFromAsset(asset, index);
          sourceAssets.push({
            buffer,
            originalName,
            contentType: asset.contentType || guessContentType(originalName),
            size: buffer.length,
          });
        } catch (downloadError) {
          throw new Error(
            `Failed to load user asset "${asset?.originalName || asset?.key || index}" for training: ${downloadError.message}`
          );
        }
      }

      if (!sourceAssets.length) {
        return res.status(400).json({
          success: false,
          message: 'Unable to load user images for training. Please verify the uploaded files and try again.',
        });
      }
    } else {
      sourceAssets = incomingFiles.map((file, index) => ({
        buffer: file.buffer,
        originalName: file.originalname || buildFileNameFromAsset(file, index),
        contentType: file.mimetype || guessContentType(file.originalname),
        size: file.size,
      }));
    }

    if (!sourceAssets.length) {
      return res.status(400).json({
        success: false,
        message: 'No training images available. Upload reference photos for the user before starting training.',
      });
    }

    const timestamp = Date.now();
    const baseModelName = (modelName || user.name.toLowerCase()).replace(/[^a-z0-9-]/g, '-');
    const uniqueModelName = `${baseModelName}-${timestamp}`;

    if (sourceAssets.length < 10) {
      console.log(
        `⚠️  Only ${sourceAssets.length} training images provided for ${uniqueModelName}. More images improve fine-tuning quality.`
      );
    }

    console.log(
      `📸 Preparing ${sourceAssets.length} training images for ${uniqueModelName} (source: ${
        useUserAssets ? 'user-library' : 'direct-upload'
      })`
    );

    const tempDir = path.join(os.tmpdir(), 'training-zips');
    await fs.ensureDir(tempDir);
    localZipPath = path.join(tempDir, `${uniqueModelName}.zip`);

    const zipOutput = fs.createWriteStream(localZipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const archivePromise = new Promise((resolve, reject) => {
      zipOutput.on('close', resolve);
      archive.on('error', reject);
    });
    archive.pipe(zipOutput);

    const uploadPromises = sourceAssets.map((asset, index) => {
      const fileName = asset.originalName || `training-image-${index + 1}.jpg`;
      archive.append(asset.buffer, { name: fileName });
      const key = generateTrainingImageKey(uniqueModelName, fileName, index);
      return uploadBufferToS3(asset.buffer, key, asset.contentType, { acl: 'public-read' }).then(({ url }) => ({
        key,
        url,
        size: asset.size ?? asset.buffer.length,
        contentType: asset.contentType,
        uploadedAt: new Date(),
        originalName: fileName,
      }));
    });

    await archive.finalize();
    await archivePromise;

    uploadedAssets = await Promise.all(uploadPromises);

    const zipBuffer = await fs.readFile(localZipPath);
    generatedZipKey = generateTrainingZipKey(uniqueModelName);
    const { url: zipUrl } = await uploadBufferToS3(zipBuffer, generatedZipKey, 'application/zip', { acl: 'public-read' });
    await fs.remove(localZipPath);

    console.log('🌐 Uploaded dataset ZIP to S3:', zipUrl);

    const triggerWord = baseModelName;
    const trainingInput = {
      input_images: zipUrl,
      steps: trainingConfigInput?.steps ? Number(trainingConfigInput.steps) : 1000,
      lora_rank: trainingConfigInput?.loraRank ? Number(trainingConfigInput.loraRank) : 16,
      batch_size: trainingConfigInput?.batchSize ? Number(trainingConfigInput.batchSize) : 1,
      learning_rate: trainingConfigInput?.learningRate ? Number(trainingConfigInput.learningRate) : 0.0004,
      trigger_word: triggerWord,
    };

    const trainingConfigRecord = {
      steps: trainingInput.steps,
      learningRate: trainingInput.learning_rate,
      batchSize: trainingInput.batch_size,
      triggerWord,
      source: useUserAssets ? 'user-library' : 'upload',
      zipPath: generatedZipKey,
      zipUrl,
    };

    if (useUserAssets && userAssetIdsUsed.length) {
      trainingConfigRecord.userAssetIds = userAssetIdsUsed;
    }
    console.log('🚀 Preparing training request for Replicate...');
    console.log('Training Config:', trainingInput);

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
          description: `Fine-tuned Flux model for ${user.name} (trigger: ${triggerWord})`,
        });
        console.log('✅ Model created on Replicate');
      } catch (modelError) {
        console.error('❌ Model creation failed:', modelError.message);
        throw new Error(`Failed to create model: ${modelError.message}`);
      }
    } else {
      console.log('⚠️  No REPLICATE_USERNAME set - training will not be saved to account');
    }

    const pendingReplicateTrainingId = createPendingReplicateId(uniqueModelName);

    const newTraining = await Training.create({
      userId,
      modelName: uniqueModelName,
      imageUrls: uploadedAssets.map((asset) => asset.url),
      imageAssets: uploadedAssets,
      status: 'queued',
      progress: 0,
      logsUrl: null,
      replicateTrainingId: pendingReplicateTrainingId,
      trainingConfig: trainingConfigRecord,
      attempts: 0,
      events: [
        {
          type: 'created',
          message: 'Training dataset prepared and queued',
          metadata: {
            userId,
            modelName: uniqueModelName,
            images: uploadedAssets.length,
            source: trainingConfigRecord.source,
          },
          timestamp: new Date(),
        },
      ],
    });

    await broadcastTraining(newTraining._id);

    const replicateArgs = {
      owner: 'ostris',
      project: 'flux-dev-lora-trainer',
      version: 'e440909d3512c31646ee2e0c7d6f6f4923224863a6a10c494606e79fb5844497',
      ...replicateOptions,
    };

    try {
      await dispatchTraining({
        trainingId: newTraining._id,
        replicateArgs,
        reason: 'initial',
      });
    } catch (dispatchError) {
      const failureTime = new Date();
      await Training.findByIdAndUpdate(newTraining._id, {
        $set: {
          status: 'failed',
          error: dispatchError.message,
          completedAt: failureTime,
        },
        $push: {
          events: {
            type: 'error',
            message: `Failed to dispatch training: ${dispatchError.message}`,
            metadata: { attempt: 1 },
            timestamp: failureTime,
          },
        },
      });
      await broadcastTraining(newTraining._id);
      throw dispatchError;
    }

    const populatedTraining = await populateTrainingForClient(newTraining._id);

    res.status(202).json({
      success: true,
      message: 'Training started successfully',
      data: populatedTraining,
    });
  } catch (error) {
    console.error('❌ Error starting training:', error);
    if (generatedZipKey) {
      try {
        await deleteFromS3(generatedZipKey);
      } catch (cleanupError) {
        console.warn('⚠️  Failed to delete zip from S3 after error:', cleanupError.message);
      }
    }
    if (uploadedAssets.length) {
      await Promise.all(
        uploadedAssets.map((asset) =>
          deleteFromS3(asset.key).catch((cleanupError) =>
            console.warn('⚠️  Failed to delete image from S3 after error:', cleanupError.message)
          )
        )
      );
    }
    if (localZipPath) {
      await fs.remove(localZipPath).catch(() => {});
    }
    res.status(500).json({
      success: false,
      message: 'Failed to start training',
      error: error.message,
    });
  }
};

/**
 * Check training status
 * @route GET /api/trainings/:id/status
 */
exports.checkTrainingStatus = async (req, res) => {
  try {
    const training = await Training.findById(req.params.id);

    if (!training) {
      return res.status(404).json({
        success: false,
        message: 'Training not found',
      });
    }

    if (!training.replicateTrainingId || isPendingReplicateId(training.replicateTrainingId)) {
      return res.status(200).json({
        success: true,
        data: training,
      });
    }

    const replicateTraining = await replicate.trainings.get(training.replicateTrainingId);
    const eventType = ['succeeded', 'failed', 'canceled'].includes(replicateTraining.status)
      ? 'completed'
      : 'update';

    await processTrainingEvent({
      trainingId: training._id,
      replicateTraining,
      eventType,
    });

    const updated = await populateTrainingForClient(training._id);

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    console.error('Error checking training status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check training status',
      error: error.message,
    });
  }
};

/**
 * Cancel training
 * @route POST /api/trainings/:id/cancel
 */
exports.cancelTraining = async (req, res) => {
  try {
    const training = await Training.findById(req.params.id);

    if (!training) {
      return res.status(404).json({
        success: false,
        message: 'Training not found',
      });
    }

    if (!training.replicateTrainingId || isPendingReplicateId(training.replicateTrainingId)) {
      return res.status(400).json({
        success: false,
        message: 'Training has not been dispatched to Replicate yet.',
      });
    }

    // Cancel training on Replicate
    await replicate.trainings.cancel(training.replicateTrainingId);

    const now = new Date();
    await Training.findByIdAndUpdate(training._id, {
      $set: {
        status: 'canceled',
        completedAt: now,
      },
      $push: {
        events: {
          type: 'canceled',
          message: 'Training canceled by user',
          metadata: {
            replicateTrainingId: training.replicateTrainingId,
          },
          timestamp: now,
        },
      },
    });

    const updatedTraining = await populateTrainingForClient(training._id);
    await broadcastTraining(training._id);

    res.status(200).json({
      success: true,
      message: 'Training canceled successfully',
      data: updatedTraining,
    });
  } catch (error) {
    console.error('Error canceling training:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel training',
      error: error.message,
    });
  }
};

const serialiseTraining = (payload) => {
  if (!payload) return null;
  if (typeof payload.toJSON === 'function') {
    return payload.toJSON();
  }
  return payload;
};

exports.streamTrainings = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  res.write(': stream-start\n\n');

  const send = (payload) => {
    const data = serialiseTraining(payload);
    if (!data) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const unsubscribe = subscribeToTrainingUpdates(send);
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
};

/**
 * Get successful trainings for a user (for dropdown in generation)
 * @route GET /api/trainings/user/:userId/successful
 */
exports.getUserSuccessfulTrainings = async (req, res) => {
  try {
    const trainings = await Training.find({
      userId: req.params.userId,
      status: 'succeeded',
      modelVersion: { $ne: null },
    })
      .select('modelName modelVersion createdAt completedAt')
      .sort({ completedAt: -1 })
      .allowDiskUse(true);

    res.status(200).json({
      success: true,
      count: trainings.length,
      data: trainings,
    });
  } catch (error) {
    console.error('Error fetching successful trainings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch successful trainings',
      error: error.message,
    });
  }
};
