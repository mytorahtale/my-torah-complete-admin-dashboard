const User = require('../models/User');
const { validationResult } = require('express-validator');
const { uploadBufferToS3, deleteFromS3, generateImageKey } = require('../config/s3');
const { evaluateSingleImage } = require('../services/evaluator');

const parseBoolean = (value) =>
  typeof value === 'string' ? value === 'true' || value === '1' : Boolean(value);

const escapeRegex = (value) =>
  typeof value === 'string' ? value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : value;

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
};

const VALID_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'name', 'age', 'email']);

const sanitiseUserPayload = (source = {}) => {
  const payload = {};

  if (typeof source.name === 'string') {
    const trimmed = source.name.trim();
    if (trimmed) {
      payload.name = trimmed;
    }
  }

  if (source.age !== undefined && source.age !== null && `${source.age}`.trim() !== '') {
    const parsed = Number.parseInt(source.age, 10);
    if (!Number.isNaN(parsed)) {
      payload.age = parsed;
    }
  }

  if (typeof source.gender === 'string') {
    const trimmed = source.gender.trim();
    if (trimmed) {
      payload.gender = trimmed;
    }
  }

  if (typeof source.email === 'string') {
    const trimmed = source.email.trim();
    if (trimmed) {
      payload.email = trimmed;
    }
  }

  if (typeof source.countryCode === 'string') {
    const trimmed = source.countryCode.trim();
    if (trimmed) {
      payload.countryCode = trimmed;
    }
  }

  if (typeof source.phoneNumber === 'string') {
    const trimmed = source.phoneNumber.trim();
    if (trimmed) {
      payload.phoneNumber = trimmed;
    }
  }

  if (typeof source.status === 'string') {
    const trimmed = source.status.trim();
    if (trimmed) {
      payload.status = trimmed;
    }
  }

  return payload;
};

/**
 * Get all users
 * @route GET /api/users
 */
exports.getAllUsers = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = '',
      status,
      gender,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      minimal,
    } = req.query;

    const isMinimal = typeof minimal === 'string' && minimal.toLowerCase() === 'true';

    const numericLimit = toPositiveInteger(limit, 10);
    const rawPage = toPositiveInteger(page, 1) || 1;

    const filter = {};

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (gender && gender !== 'all') {
      filter.gender = gender;
    }

    if (search && typeof search === 'string') {
      const expression = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [
        { name: expression },
        { email: expression },
        { phoneNumber: expression },
        { countryCode: expression },
      ];
    }

    const resolvedSortField = VALID_SORT_FIELDS.has(sortBy) ? sortBy : 'createdAt';
    const resolvedSortOrder = sortOrder === 'asc' ? 1 : -1;
    const sort = { [resolvedSortField]: resolvedSortOrder, _id: resolvedSortOrder };

    const countPromise = User.countDocuments(filter);
    const statsPromise = isMinimal
      ? Promise.resolve([])
      : User.aggregate([
          { $match: filter },
          {
            $group: {
              _id: null,
              totalImages: {
                $sum: {
                  $size: {
                    $ifNull: ['$imageAssets', []],
                  },
                },
              },
            },
          },
        ]);

    const [totalUsers, imageStats] = await Promise.all([countPromise, statsPromise]);

    const totalImages =
      !isMinimal && Array.isArray(imageStats) && imageStats.length > 0
        ? imageStats[0].totalImages
        : 0;

    const totalPages =
      numericLimit > 0 && totalUsers > 0 ? Math.ceil(totalUsers / numericLimit) : totalUsers > 0 ? 1 : 0;
    const effectivePage =
      numericLimit > 0
        ? Math.min(Math.max(rawPage, 1), Math.max(totalPages, 1))
        : 1;
    const skip = numericLimit > 0 ? (effectivePage - 1) * numericLimit : 0;

    const projection = isMinimal
      ? {
          name: 1,
          email: 1,
          gender: 1,
          status: 1,
          createdAt: 1,
          updatedAt: 1,
        }
      : null;

    const query = User.find(filter).sort(sort);
    if (projection) {
      query.select(projection);
    }
    if (numericLimit > 0) {
      query.skip(skip).limit(numericLimit);
    }

    const users = await query.exec();

    res.status(200).json({
      success: true,
      count: users.length,
      data: users,
      pagination: {
        page: totalPages === 0 ? 1 : effectivePage,
        limit: numericLimit,
        total: totalUsers,
        totalPages,
        hasNextPage: numericLimit > 0 && effectivePage < totalPages,
        hasPrevPage: numericLimit > 0 && effectivePage > 1,
      },
      filters: {
        search: typeof search === 'string' ? search : '',
        status: status || 'all',
        gender: gender || 'all',
        sortBy: resolvedSortField,
        sortOrder: resolvedSortOrder === 1 ? 'asc' : 'desc',
      },
      stats: isMinimal
        ? null
        : {
            totalUsers,
            totalImages,
          },
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: error.message,
    });
  }
};

/**
 * Get single user by ID
 * @route GET /api/users/:id
 */
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: error.message,
    });
  }
};

/**
 * Create new user
 * @route POST /api/users
 */
exports.createUser = async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array(),
      });
    }

    const payload = sanitiseUserPayload(req.body);

    const user = await User.create({
      ...payload,
      imageAssets: [],
    });

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      data: user,
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create user',
      error: error.message,
    });
  }
};

/**
 * Update user
 * @route PUT /api/users/:id
 */
exports.updateUser = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array(),
      });
    }

    const payload = sanitiseUserPayload(req.body);

    // Check if user exists
    let user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Update user fields
    user = await User.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });

    res.status(200).json({
      success: true,
      message: 'User updated successfully',
      data: user,
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user',
      error: error.message,
    });
  }
};

/**
 * Delete user
 * @route DELETE /api/users/:id
 */
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    if (Array.isArray(user.imageAssets) && user.imageAssets.length > 0) {
      await Promise.all(
        user.imageAssets.map((asset) =>
          deleteFromS3(asset.key).catch((err) =>
            console.warn('⚠️  Failed to delete image from S3 during user removal:', err.message)
          )
        )
      );
    }

    await User.findByIdAndDelete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'User deleted successfully',
      data: {},
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user',
      error: error.message,
    });
  }
};

/**
 * Upload user image asset
 * @route POST /api/users/:id/images/upload
 */
exports.uploadImageAsset = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'Please provide an image file',
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const override = parseBoolean(req.body.override);
    const base64 = req.file.buffer.toString('base64');

    let evaluation = null;
    let imageEvaluation = null;

    try {
      evaluation = await evaluateSingleImage({
        name: req.file.originalname,
        mimeType: req.file.mimetype,
        base64,
      });
      imageEvaluation = Array.isArray(evaluation?.images) ? evaluation.images[0] : null;
    } catch (error) {
      const statusCode = error.statusCode || error.status || 500;
      return res.status(statusCode).json({
        success: false,
        message: error.message || 'Failed to evaluate image',
        error: error.details || undefined,
      });
    }

    if (!override && (!imageEvaluation || !imageEvaluation.acceptable)) {
      return res.status(422).json({
        success: false,
        message: 'Image rejected by evaluator',
        evaluation,
        data: imageEvaluation,
      });
    }

    const key = generateImageKey(user._id, req.file.originalname);
    const { url } = await uploadBufferToS3(req.file.buffer, key, req.file.mimetype);

    const asset = {
      key,
      url,
      size: req.file.size,
      contentType: req.file.mimetype,
      uploadedAt: new Date(),
      originalName: req.file.originalname,
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

    user.imageAssets.push(asset);
    await user.save();

    res.status(200).json({
      success: true,
      message:
        override && !imageEvaluation?.acceptable
          ? 'Image uploaded with override'
          : 'Image uploaded successfully',
      data: {
        asset,
        evaluation,
      },
    });
  } catch (error) {
    console.error('Error uploading image asset:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload image',
      error: error.message,
    });
  }
};

/**
 * Remove user image asset
 * @route DELETE /api/users/:id/images/:assetId
 */
exports.removeImageAsset = async (req, res) => {
  try {
    const { assetId } = req.params;

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const asset = user.imageAssets.id(assetId);
    if (!asset) {
      return res.status(404).json({
        success: false,
        message: 'Image not found for this user',
      });
    }

    const { deleteFromS3 } = require('../config/s3');
    await deleteFromS3(asset.key);

    user.removeImageAsset(assetId);
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Image removed successfully',
      data: user.imageAssets,
    });
  } catch (error) {
    console.error('Error removing image asset:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove image',
      error: error.message,
    });
  }
};
