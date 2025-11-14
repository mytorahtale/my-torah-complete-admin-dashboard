const express = require('express');
const dashboardController = require('../controllers/dashboardController');

const router = express.Router();

// Use minimal overview by default (no sorting, only counts)
router.get('/overview', dashboardController.getMinimalOverview);

module.exports = router;
