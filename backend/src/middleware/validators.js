const { body } = require('express-validator');

/**
 * Validation rules for user creation/update
 */
exports.validateUser = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),

  body('age')
    .optional({ checkFalsy: true })
    .isInt({ min: 0, max: 150 })
    .withMessage('Age must be between 0 and 150'),

  body('gender')
    .optional({ checkFalsy: true })
    .isIn(['male', 'female', 'other'])
    .withMessage('Gender must be male, female, or other'),

  body('email')
    .optional({ checkFalsy: true })
    .trim()
    .isEmail()
    .withMessage('Please provide a valid email address')
    .normalizeEmail(),

  body('countryCode')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^\+\d{1,4}$/)
    .withMessage('Country code must be in format +XX'),

  body('phoneNumber')
    .optional({ checkFalsy: true })
    .trim()
    .matches(/^\d{6,15}$/)
    .withMessage('Phone number must be 6-15 digits'),
];

const BOOK_GENDERS = ['male', 'female', 'both'];
const BOOK_STATUSES = ['active', 'inactive'];

exports.validateBookCreate = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Book name is required')
    .isLength({ min: 3, max: 120 })
    .withMessage('Book name must be between 3 and 120 characters'),
  body('description')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Description cannot exceed 1000 characters'),
  body('gender')
    .optional()
    .isIn(BOOK_GENDERS)
    .withMessage('Gender must be male, female, or both'),
  body('status')
    .optional()
    .isIn(BOOK_STATUSES)
    .withMessage('Status must be active or inactive'),
];

exports.validateBookUpdate = [
  body('name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Book name cannot be empty')
    .isLength({ min: 3, max: 120 })
    .withMessage('Book name must be between 3 and 120 characters'),
  body('description')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Description cannot exceed 1000 characters'),
  body('gender')
    .optional()
    .isIn(BOOK_GENDERS)
    .withMessage('Gender must be male, female, or both'),
  body('status')
    .optional()
    .isIn(BOOK_STATUSES)
    .withMessage('Status must be active or inactive'),
];

/**
 * Validation rules for training
 */
exports.validateTraining = [
  body('userId').notEmpty().withMessage('User ID is required').isMongoId().withMessage('Invalid user ID'),

  body('modelName')
    .optional()
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage('Model name must be between 3 and 50 characters'),

  body('trainingConfig.steps')
    .optional()
    .isInt({ min: 100, max: 5000 })
    .withMessage('Training steps must be between 100 and 5000'),

  body('trainingConfig.learningRate')
    .optional()
    .isFloat({ min: 0.00001, max: 0.01 })
    .withMessage('Learning rate must be between 0.00001 and 0.01'),

  body('trainingConfig.batchSize')
    .optional()
    .isInt({ min: 1, max: 16 })
    .withMessage('Batch size must be between 1 and 16'),
];

/**
 * Validation rules for image generation
 */
exports.validateGeneration = [
  body('userId').notEmpty().withMessage('User ID is required').isMongoId().withMessage('Invalid user ID'),

  body('trainingId')
    .notEmpty()
    .withMessage('Training ID is required')
    .isMongoId()
    .withMessage('Invalid training ID'),

  body('prompt')
    .trim()
    .notEmpty()
    .withMessage('Prompt is required')
    .isLength({ min: 3, max: 1000 })
    .withMessage('Prompt must be between 3 and 1000 characters'),

  body('config.numOutputs')
    .optional()
    .isInt({ min: 1, max: 4 })
    .withMessage('Number of outputs must be between 1 and 4'),

  body('config.guidanceScale')
    .optional()
    .isFloat({ min: 0, max: 10 })
    .withMessage('Guidance scale must be between 0 and 10'),

  body('config.outputQuality')
    .optional()
    .isInt({ min: 0, max: 100 })
    .withMessage('Output quality must be between 0 and 100'),

  body('config.promptStrength')
    .optional()
    .isFloat({ min: 0, max: 1 })
    .withMessage('Prompt strength must be between 0 and 1'),
];
