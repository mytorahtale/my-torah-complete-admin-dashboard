const express = require('express');
const dashboardController = require('../controllers/dashboardController');

const router = express.Router();

router.get('/overview', dashboardController.getOverview);

module.exports = router;
