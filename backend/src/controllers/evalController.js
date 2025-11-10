const { evaluateSingleImage } = require('../services/evaluator');
const Evaluation = require('../models/Evaluation');
const {
  uploadBufferToS3,
  deleteFromS3,
  generateEvaluationImageKey,
} = require('../config/s3');

const normalizeTags = (input) => {
  if (!input) return [];
  const source = Array.isArray(input) ? input : [input];
  const set = new Set();
  const result = [];
  source.forEach((value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (set.has(lower)) return;
    set.add(lower);
    result.push(trimmed);
  });
  return result.slice(0, 12);
};

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const serializeEvaluation = (doc) => {
  if (!doc) return null;
  const source = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  const id = source.id || (source._id ? source._id.toString() : null);
  return {
    id,
    fileName: source.fileName,
    mimeType: source.mimeType,
    size: source.size,
    width: source.width,
    height: source.height,
    verdict: source.verdict,
    acceptable: source.acceptable,
    score: source.score,
    confidence: source.confidence,
    summary: source.summary,
    recommendations: source.recommendations,
    criteria: source.criteria,
    tags: Array.isArray(source.tags) ? source.tags : [],
    decision: source.decision,
    s3Key: source.s3Key,
    s3Url: source.s3Url,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    evaluation: source.evaluation || null,
  };
};

/**
 * Evaluate images for fine-tuning suitability using OpenRouter vision model
 * Stores the evaluation for future reference and returns both the raw evaluation
 * response and the persisted record metadata.
 * @route POST /api/evals
 */
exports.evaluateImages = async (req, res) => {
  try {
    const { image, images } = req.body || {};
    let targetImage = null;

    if (image && image.base64) {
      targetImage = image;
    } else if (Array.isArray(images) && images.length > 0) {
      if (images.length === 1 && images[0]?.base64) {
        targetImage = images[0];
      } else {
        return res.status(400).json({
          success: false,
          message: 'Only a single image may be evaluated at a time',
        });
      }
    }

    if (!targetImage || !targetImage.base64) {
      return res.status(400).json({
        success: false,
        message: 'Please provide one image to evaluate',
      });
    }

    const normalised = await evaluateSingleImage({
      name: targetImage.name,
      mimeType: targetImage.mimeType,
      base64: targetImage.base64,
    });

    const buffer = Buffer.from(targetImage.base64, 'base64');
    const uploadKey = generateEvaluationImageKey(targetImage.name || 'evaluation.jpg');

    let uploadedKey = null;
    let uploadedUrl = null;

    try {
      const { key, url } = await uploadBufferToS3(
        buffer,
        uploadKey,
        targetImage.mimeType || 'image/jpeg'
      );
      uploadedKey = key;
      uploadedUrl = url;
    } catch (uploadError) {
      throw uploadError;
    }

    const overall = normalised?.overallAcceptance || {};
    const imageResult = Array.isArray(normalised?.images) ? normalised.images[0] : null;

    let evaluationDocument;

    try {
      evaluationDocument = await Evaluation.create({
        fileName: targetImage.name || imageResult?.name || 'Uploaded Image',
        mimeType: targetImage.mimeType || 'image/jpeg',
        size:
          typeof targetImage.size === 'number' && targetImage.size > 0
            ? targetImage.size
            : buffer.length,
        width: targetImage.width || null,
        height: targetImage.height || null,
        verdict: imageResult?.verdict || overall.verdict || 'needs_more',
        acceptable: Boolean(imageResult?.acceptable),
        score: imageResult?.overallScorePercent ?? 0,
        confidence: imageResult?.confidencePercent ?? overall.confidencePercent ?? 0,
        summary: overall.summary || '',
        recommendations: imageResult?.recommendations || [],
        criteria: imageResult?.criteria || {},
        evaluation: normalised,
        tags: [],
        decision: 'pending',
        s3Key: uploadedKey,
        s3Url: uploadedUrl,
      });
    } catch (storageError) {
      if (uploadedKey) {
        await deleteFromS3(uploadedKey).catch((cleanupError) =>
          console.warn(
            `Failed to cleanup evaluation asset ${uploadedKey}: ${cleanupError.message}`
          )
        );
      }
      throw storageError;
    }

    return res.status(200).json({
      success: true,
      data: {
        evaluation: normalised,
        record: serializeEvaluation(evaluationDocument),
      },
    });
  } catch (error) {
    const statusCode = error.statusCode || error.status || 500;
    console.error('❌ Error evaluating images:', error);
    const friendlyMessage =
      statusCode === 502
        ? 'The evaluator was not able to process the image. Please try again in a moment or use a different photo.'
        : error.message || 'Failed to evaluate images';
    return res.status(statusCode).json({
      success: false,
      message: friendlyMessage,
      error: error.details || undefined,
    });
  }
};

exports.listEvaluations = async (req, res) => {
  try {
    const page = toPositiveInteger(req.query.page, 1);
    const limit = Math.min(toPositiveInteger(req.query.limit, 10), 100);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const verdictFilter = typeof req.query.verdict === 'string' ? req.query.verdict.trim() : 'all';
    const decisionFilter =
      typeof req.query.decision === 'string' ? req.query.decision.trim() : 'all';
    const tagsFilter = normalizeTags(req.query.tags ? String(req.query.tags).split(',') : []);
    const sortParam = typeof req.query.sortBy === 'string' ? req.query.sortBy : 'createdAt';
    const sortOrderParam = req.query.sortOrder === 'asc' ? 1 : -1;

    const filters = {};

    if (search) {
      filters.$or = [
        { fileName: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        { summary: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      ];
    }

    if (['accept', 'needs_more', 'reject'].includes(verdictFilter)) {
      filters.verdict = verdictFilter;
    }

    if (['pending', 'approved', 'rejected'].includes(decisionFilter)) {
      filters.decision = decisionFilter;
    }

    if (tagsFilter.length > 0) {
      filters.tags = { $all: tagsFilter.map((tag) => new RegExp(`^${tag}$`, 'i')) };
    }

    const [total, statsAggregate] = await Promise.all([
      Evaluation.countDocuments(filters),
      Evaluation.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            totalApproved: {
              $sum: { $cond: [{ $eq: ['$decision', 'approved'] }, 1, 0] },
            },
            totalPending: {
              $sum: { $cond: [{ $eq: ['$decision', 'pending'] }, 1, 0] },
            },
            totalRejectedDecision: {
              $sum: { $cond: [{ $eq: ['$decision', 'rejected'] }, 1, 0] },
            },
            totalVerdictAccept: {
              $sum: { $cond: [{ $eq: ['$verdict', 'accept'] }, 1, 0] },
            },
            totalVerdictNeedsMore: {
              $sum: { $cond: [{ $eq: ['$verdict', 'needs_more'] }, 1, 0] },
            },
            totalVerdictReject: {
              $sum: { $cond: [{ $eq: ['$verdict', 'reject'] }, 1, 0] },
            },
          },
        },
      ]),
    ]);

    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
    const effectivePage = totalPages > 0 ? Math.min(Math.max(page, 1), totalPages) : 1;
    const skip = limit > 0 ? (effectivePage - 1) * limit : 0;

    const allowedSortFields = new Set(['createdAt', 'fileName', 'score']);
    const resolvedSortField = allowedSortFields.has(sortParam) ? sortParam : 'createdAt';
    const sort = { [resolvedSortField]: sortOrderParam, _id: sortOrderParam };

    const query = Evaluation.find(filters).sort(sort).allowDiskUse(true);
    if (limit > 0) {
      query.skip(skip).limit(limit);
    }

    const items = await query.lean();
    const data = items.map((item) => serializeEvaluation(item));

    res.status(200).json({
      success: true,
      count: data.length,
      data,
      pagination: {
        page: totalPages === 0 ? 1 : effectivePage,
        limit,
        total,
        totalPages,
        hasNextPage: limit > 0 && effectivePage < totalPages,
        hasPrevPage: limit > 0 && effectivePage > 1,
      },
      filters: {
        search,
        verdict: ['accept', 'needs_more', 'reject'].includes(verdictFilter)
          ? verdictFilter
          : 'all',
        decision: ['pending', 'approved', 'rejected'].includes(decisionFilter)
          ? decisionFilter
          : 'all',
        tags: tagsFilter,
        sortBy: resolvedSortField,
        sortOrder: sortOrderParam === 1 ? 'asc' : 'desc',
      },
      stats: statsAggregate[0] || {
        total: 0,
        totalApproved: 0,
        totalPending: 0,
        totalRejectedDecision: 0,
        totalVerdictAccept: 0,
        totalVerdictNeedsMore: 0,
        totalVerdictReject: 0,
      },
    });
  } catch (error) {
    console.error('Error fetching evaluations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch evaluations',
      error: error.message,
    });
  }
};

exports.updateEvaluationTags = async (req, res) => {
  try {
    const tags = normalizeTags(req.body?.tags);
    const evaluation = await Evaluation.findByIdAndUpdate(
      req.params.id,
      { tags },
      { new: true }
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        message: 'Evaluation not found',
      });
    }

    res.status(200).json({
      success: true,
      data: serializeEvaluation(evaluation),
    });
  } catch (error) {
    console.error('Error updating evaluation tags:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? 'Invalid evaluation identifier' : 'Failed to update evaluation tags',
      error: status === 400 ? undefined : error.message,
    });
  }
};

exports.updateEvaluationDecision = async (req, res) => {
  try {
    const { decision } = req.body || {};
    const allowed = ['pending', 'approved', 'rejected'];
    if (!allowed.includes(decision)) {
      return res.status(400).json({
        success: false,
        message: 'Provide a valid decision (pending | approved | rejected)',
      });
    }

    const evaluation = await Evaluation.findByIdAndUpdate(
      req.params.id,
      { decision },
      { new: true }
    );

    if (!evaluation) {
      return res.status(404).json({
        success: false,
        message: 'Evaluation not found',
      });
    }

    res.status(200).json({
      success: true,
      data: serializeEvaluation(evaluation),
    });
  } catch (error) {
    console.error('Error updating evaluation decision:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    res.status(status).json({
      success: false,
      message:
        status === 400 ? 'Invalid evaluation identifier' : 'Failed to update evaluation decision',
      error: status === 400 ? undefined : error.message,
    });
  }
};

exports.deleteEvaluation = async (req, res) => {
  try {
    const evaluation = await Evaluation.findById(req.params.id);
    if (!evaluation) {
      return res.status(404).json({
        success: false,
        message: 'Evaluation not found',
      });
    }

    if (evaluation.s3Key) {
      await deleteFromS3(evaluation.s3Key).catch((error) =>
        console.warn(`Failed to remove evaluation asset ${evaluation.s3Key}: ${error.message}`)
      );
    }

    await evaluation.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Evaluation deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting evaluation:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? 'Invalid evaluation identifier' : 'Failed to delete evaluation',
      error: status === 400 ? undefined : error.message,
    });
  }
};
