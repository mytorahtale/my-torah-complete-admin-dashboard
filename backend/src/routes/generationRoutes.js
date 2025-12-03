const express = require('express');
const router = express.Router();
const generationController = require('../controllers/generationController');
const { validateGeneration } = require('../middleware/validators');

/**
 * @route   GET /api/generations
 * @desc    Get all generations
 * @access  Public
 */
router.get('/', generationController.getAllGenerations);

/**
 * @route   GET /api/generations/stream/live
 * @desc    Subscribe to generation updates (SSE)
 * @access  Public
 */
router.get('/stream/live', generationController.streamGenerations);

/**
 * @route   GET /api/generations/:id
 * @desc    Get generation by ID
 * @access  Public
 */
router.get('/:id', generationController.getGenerationById);

/**
 * @route   POST /api/generations
 * @desc    Generate new image
 * @access  Public
 */
router.post('/', validateGeneration, generationController.generateImage);

/**
 * @route   POST /api/generations/:id/download
 * @desc    Download generated images
 * @access  Public
 */
router.post('/:id/download', generationController.downloadImage);

/**
 * @route   GET /api/generations/user/:userId
 * @desc    Get generations by user
 * @access  Public
 */
router.get('/user/:userId', generationController.getGenerationsByUser);

module.exports = router;
