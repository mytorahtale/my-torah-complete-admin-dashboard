const express = require('express');
const multer = require('multer');
const promptController = require('../controllers/promptController');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB per image
  },
});

router.get('/', promptController.listPrompts);
router.post('/', upload.single('image'), promptController.createPrompt);
router.post('/generate', upload.array('images', 10), promptController.generatePrompts);
router.get('/:id', promptController.getPromptById);
router.patch('/:id', promptController.updatePrompt);
router.patch('/:id/quality', promptController.updatePromptQuality);
router.patch('/:id/tags', promptController.updatePromptTags);
router.delete('/:id', promptController.deletePrompt);

module.exports = router;
