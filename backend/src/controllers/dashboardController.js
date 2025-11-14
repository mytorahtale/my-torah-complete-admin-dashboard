const Book = require('../models/Book');
const User = require('../models/User');
const Training = require('../models/Training');
const Generation = require('../models/Generation');

const ACTIVE_TRAINING_STATUSES = new Set(['queued', 'starting', 'processing']);

const getSingleResult = (aggregateResult) =>
  Array.isArray(aggregateResult) && aggregateResult.length > 0 ? aggregateResult[0] : null;

// Minimal dashboard endpoint - only counts, no sorting
exports.getMinimalOverview = async (req, res) => {
  try {
    const [
      totalBooks,
      activeBooks,
      inactiveBooks,
      totalUsers,
      totalTrainings,
      activeTrainings,
      succeededTrainings,
      failedTrainings,
      totalGenerations,
      succeededGenerations,
      failedGenerations,
    ] = await Promise.all([
      Book.countDocuments(),
      Book.countDocuments({ status: 'active' }),
      Book.countDocuments({ status: 'inactive' }),
      User.countDocuments(),
      Training.countDocuments(),
      Training.countDocuments({ status: { $in: ['queued', 'starting', 'processing'] } }),
      Training.countDocuments({ status: 'succeeded' }),
      Training.countDocuments({ status: 'failed' }),
      Generation.countDocuments(),
      Generation.countDocuments({ status: 'succeeded' }),
      Generation.countDocuments({ status: 'failed' }),
    ]);

    const generationSuccessRate =
      totalGenerations > 0 ? (succeededGenerations / totalGenerations) * 100 : 0;

    res.status(200).json({
      success: true,
      data: {
        stats: {
          books: {
            total: totalBooks,
            active: activeBooks,
            inactive: inactiveBooks,
          },
          trainings: {
            total: totalTrainings,
            active: activeTrainings,
            failed: failedTrainings,
            succeeded: succeededTrainings,
            readyUsers: 0,
            failedUsers: 0,
          },
          users: {
            total: totalUsers,
          },
          generations: {
            total: totalGenerations,
            succeeded: succeededGenerations,
            failed: failedGenerations,
            successRate: generationSuccessRate,
          },
        },
        activity: [],
        lastUpdated: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[dashboard] minimal overview failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load dashboard overview',
      error: error.message,
    });
  }
};

exports.getOverview = async (req, res) => {
  try {
    // Use simple counts instead of expensive aggregations
    const [
      totalBooks,
      activeBooks,
      inactiveBooks,
      totalUsers,
      totalTrainings,
      activeTrainings,
      succeededTrainings,
      failedTrainings,
      totalGenerations,
      succeededGenerations,
      failedGenerations,
      queuedGenerations,
      recentBooks,
      recentTrainings,
      recentGenerations,
    ] = await Promise.all([
      // Book counts
      Book.countDocuments(),
      Book.countDocuments({ status: 'active' }),
      Book.countDocuments({ status: 'inactive' }),

      // User count
      User.countDocuments(),

      // Training counts
      Training.countDocuments(),
      Training.countDocuments({ status: { $in: ['queued', 'starting', 'processing'] } }),
      Training.countDocuments({ status: 'succeeded' }),
      Training.countDocuments({ status: 'failed' }),

      // Generation counts
      Generation.countDocuments(),
      Generation.countDocuments({ status: 'succeeded' }),
      Generation.countDocuments({ status: 'failed' }),
      Generation.countDocuments({ status: 'queued' }),

      // Recent items - limit to 5 each with allowDiskUse
      Book.find({}, { name: 1, status: 1, createdAt: 1, updatedAt: 1 })
        .sort({ updatedAt: -1 })
        .limit(5)
        .allowDiskUse(true)
        .lean(),
      Training.find({}, { modelName: 1, status: 1, createdAt: 1, updatedAt: 1 })
        .sort({ updatedAt: -1 })
        .limit(5)
        .allowDiskUse(true)
        .lean(),
      Generation.find({}, { prompt: 1, status: 1, createdAt: 1, updatedAt: 1 })
        .sort({ updatedAt: -1 })
        .limit(5)
        .allowDiskUse(true)
        .lean(),
    ]);

    // Calculate stats from simple counts
    const generationSuccessRate =
      totalGenerations > 0 ? (succeededGenerations / totalGenerations) * 100 : 0;

    const booksStats = {
      total: totalBooks,
      active: activeBooks,
      inactive: inactiveBooks,
      averagePages: 0, // Skip expensive page count calculation
    };

    const trainingsStats = {
      total: totalTrainings,
      active: activeTrainings,
      failed: failedTrainings,
      succeeded: succeededTrainings,
      readyUsers: 0, // Simplified - skip expensive user grouping
      failedUsers: 0, // Simplified - skip expensive user grouping
    };

    const usersStats = {
      total: totalUsers,
      totalImages: 0, // Skip expensive image count
      averageImages: 0, // Skip expensive calculation
    };

    const generationsStats = {
      total: totalGenerations,
      succeeded: succeededGenerations,
      failed: failedGenerations,
      queued: queuedGenerations,
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
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
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
