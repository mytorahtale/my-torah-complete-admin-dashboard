const Book = require('../models/Book');
const User = require('../models/User');
const Training = require('../models/Training');
const Generation = require('../models/Generation');

const ACTIVE_TRAINING_STATUSES = new Set(['queued', 'starting', 'processing']);

const getSingleResult = (aggregateResult) =>
  Array.isArray(aggregateResult) && aggregateResult.length > 0 ? aggregateResult[0] : null;

exports.getOverview = async (req, res) => {
  try {
    const [
      bookAggregate,
      trainingStatusCounts,
      trainingUserStats,
      userAggregate,
      generationStatusCounts,
      recentBooks,
      recentTrainings,
      recentGenerations,
    ] = await Promise.all([
      Book.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: {
              $sum: {
                $cond: [{ $eq: ['$status', 'active'] }, 1, 0],
              },
            },
            inactive: {
              $sum: {
                $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0],
              },
            },
            pageCount: {
              $sum: {
                $size: { $ifNull: ['$pages', []] },
              },
            },
          },
        },
      ]),
      Training.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      Training.aggregate([
        {
          $group: {
            _id: '$userId',
            successes: {
              $sum: {
                $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0],
              },
            },
            failures: {
              $sum: {
                $cond: [{ $eq: ['$status', 'failed'] }, 1, 0],
              },
            },
          },
        },
      ]),
      User.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            totalImages: {
              $sum: {
                $size: { $ifNull: ['$imageAssets', []] },
              },
            },
          },
        },
      ]),
      Generation.aggregate([
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
          },
        },
      ]),
      Book.find({}, { name: 1, status: 1, createdAt: 1, updatedAt: 1 })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(8)
        .lean(),
      Training.find({}, { modelName: 1, status: 1, createdAt: 1, updatedAt: 1 })
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(8)
        .lean(),
      Generation.find(
        {},
        { prompt: 1, status: 1, createdAt: 1, updatedAt: 1 }
      )
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(8)
        .lean(),
    ]);

    const bookSummary = getSingleResult(bookAggregate) || {};
    const userSummary = getSingleResult(userAggregate) || {};

    const trainingStatusMap = trainingStatusCounts.reduce((acc, item) => {
      if (item?._id) {
        acc[item._id] = item.count;
      }
      return acc;
    }, {});

    const generationStatusMap = generationStatusCounts.reduce((acc, item) => {
      if (item?._id) {
        acc[item._id] = item.count;
      }
      return acc;
    }, {});

    const readyUsers = trainingUserStats.filter(
      (item) => item?._id && (item.successes || 0) > 0
    ).length;
    const failedUsers = trainingUserStats.filter(
      (item) => item?._id && (item.failures || 0) > 0
    ).length;

    const trainingTotal = trainingStatusCounts.reduce((sum, item) => sum + (item?.count || 0), 0);
    const trainingActive = trainingStatusCounts.reduce(
      (sum, item) =>
        ACTIVE_TRAINING_STATUSES.has(item?._id) ? sum + (item?.count || 0) : sum,
      0
    );

    const generationTotal = generationStatusCounts.reduce(
      (sum, item) => sum + (item?.count || 0),
      0
    );
    const generationSucceeded = generationStatusMap.succeeded || 0;
    const generationFailed = generationStatusMap.failed || 0;
    const generationQueued = generationStatusMap.queued || 0;
    const generationSuccessRate =
      generationTotal > 0 ? (generationSucceeded / generationTotal) * 100 : 0;

    const booksStats = {
      total: bookSummary.total || 0,
      active: bookSummary.active || 0,
      inactive: bookSummary.inactive || 0,
      averagePages:
        bookSummary.total > 0 ? (bookSummary.pageCount || 0) / bookSummary.total : 0,
    };

    const trainingsStats = {
      total: trainingTotal,
      active: trainingActive,
      failed: trainingStatusMap.failed || 0,
      succeeded: trainingStatusMap.succeeded || 0,
      readyUsers,
      failedUsers,
    };

    const usersStats = {
      total: userSummary.total || 0,
      totalImages: userSummary.totalImages || 0,
      averageImages:
        userSummary.total > 0 ? (userSummary.totalImages || 0) / userSummary.total : 0,
    };

    const generationsStats = {
      total: generationTotal,
      succeeded: generationSucceeded,
      failed: generationFailed,
      queued: generationQueued,
      successRate: generationSuccessRate,
    };

    const activity = [
      ...(recentBooks || []).map((book) => ({
        id: `book-${book._id}`,
        type: 'book',
        title: book.name || 'Untitled book',
        status: book.status || 'unknown',
        timestamp: book.updatedAt || book.createdAt,
        href: '/books',
      })),
      ...(recentTrainings || []).map((training) => ({
        id: `training-${training._id}`,
        type: 'training',
        title: training.modelName || 'Training job',
        status: training.status || 'pending',
        timestamp: training.updatedAt || training.createdAt,
        href: '/training',
      })),
      ...(recentGenerations || []).map((generation) => ({
        id: `generation-${generation._id}`,
        type: 'generation',
        title: generation.prompt ? generation.prompt.slice(0, 48) : 'Generation run',
        status: generation.status || 'queued',
        timestamp: generation.updatedAt || generation.createdAt,
        href: '/generate',
      })),
    ]
      .filter((item) => item.timestamp)
      .sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )
      .slice(0, 8);

    res.status(200).json({
      success: true,
      data: {
        stats: {
          books: booksStats,
          trainings: trainingsStats,
          users: usersStats,
          generations: generationsStats,
        },
        activity,
        lastUpdated: new Date().toISOString(),
        errors: [],
      },
    });
  } catch (error) {
    console.error('[dashboard] overview failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load dashboard overview',
      error: error.message,
    });
  }
};
