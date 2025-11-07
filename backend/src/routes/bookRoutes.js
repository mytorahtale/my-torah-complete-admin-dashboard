const express = require('express');
const multer = require('multer');
const bookController = require('../controllers/bookController');
const { validateBookCreate, validateBookUpdate } = require('../middleware/validators');
const storybookAutomationController = require('../controllers/storybookAutomationController');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per image (increased for high-res dedication page images)
  },
});

const uploadFields = upload.fields([
  { name: 'coverImage', maxCount: 1 },
  { name: 'pageImages', maxCount: 100 },
  { name: 'pageQrImages', maxCount: 100 },
  { name: 'coverPageBackgroundImage', maxCount: 1 },
  { name: 'coverPageQrCode', maxCount: 1 },
  { name: 'dedicationPageBackgroundImage', maxCount: 1 },
]);

const coverPreviewFields = upload.fields([
  { name: 'backgroundImage', maxCount: 1 },
  { name: 'qrCode', maxCount: 1 },
]);

const dedicationUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per image for high-res dedication page images (5375x2975px)
  },
});

const dedicationPreviewFields = dedicationUpload.fields([
  { name: 'backgroundImage', maxCount: 1 },
]);

const storybookUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20MB per background
  },
});

const storybookFields = storybookUpload.fields([{ name: 'characterImages', maxCount: 100 }]);

const markEditableResponse = (req, res, next) => {
  req.returnEditablePayload = true;
  next();
};

router.get('/', bookController.getAllBooks);
router.post('/cover-preview', coverPreviewFields, bookController.generateCoverPreview);
router.post('/dedication-preview', dedicationPreviewFields, bookController.generateDedicationPreview);
router.get('/storybooks/stream/live', storybookAutomationController.streamJobs);
router.get('/:id/storybooks', bookController.getBookStorybooks);
router.get('/:id/storybooks/jobs', storybookAutomationController.listJobs);
router.get('/:id/storybooks/jobs/:jobId', storybookAutomationController.getJob);
router.post('/:id/storybooks', storybookFields, bookController.generateStorybook);
router.post('/:id/storybooks/auto', storybookAutomationController.startAutomation);
router.get('/:id/storybooks/:assetId/pages', bookController.getStorybookAssetPages);
router.post(
  '/:id/storybooks/:assetId/pages/:pageOrder/regenerate',
  bookController.regenerateStorybookPage
);
router.post('/:id/storybooks/:assetId/regenerate', bookController.regenerateStorybookPdf);
router.post('/:id/storybooks/:assetId/confirm', bookController.confirmStorybookPdf);
router.post(
  '/:id/storybooks/:assetId/pages/:pageOrder/select',
  bookController.selectStorybookPageCandidate
);
router.get('/:id/editable', bookController.getBookForEdit);
router.get('/:id', bookController.getBookById);
router.put(
  '/:id/editable',
  uploadFields,
  markEditableResponse,
  validateBookUpdate,
  bookController.updateBook
);
router.post('/', uploadFields, validateBookCreate, bookController.createBook);
router.put('/:id', uploadFields, validateBookUpdate, bookController.updateBook);
router.delete('/:id', bookController.deleteBook);
router.patch('/:id/status', bookController.updateBookStatus);

module.exports = router;
