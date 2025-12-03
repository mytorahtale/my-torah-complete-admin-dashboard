require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const connectDatabase = require('./config/database');
const { validateReplicateToken } = require('./config/replicate');

// Import routes
const userRoutes = require('./routes/userRoutes');
const trainingRoutes = require('./routes/trainingRoutes');
const generationRoutes = require('./routes/generationRoutes');
const evalRoutes = require('./routes/evalRoutes');
const bookRoutes = require('./routes/bookRoutes');
const promptRoutes = require('./routes/promptRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const automationRoutes = require('./routes/automationRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const { initialiseAutomationWatchers } = require('./services/automationWorkflow');

// Initialize express app
const app = express();

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));
app.use(bodyParser.json({ limit: '25mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '25mb' }));

// Static font assets for canvas rendering (fonts are in backend/fonts, not backend/src/fonts)
app.use('/fonts', express.static(path.join(__dirname, '../fonts')));

// Serve frontend static files
const frontendBuildPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendBuildPath));

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// API Routes
app.use('/api/books', bookRoutes);
app.use('/api/prompts', promptRoutes);
app.use('/api/users', userRoutes);
app.use('/api/trainings', trainingRoutes);
app.use('/api/generations', generationRoutes);
app.use('/api/evals', evalRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/automation', automationRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Image proxy endpoint for CORS bypass (allows frontend canvas operations)
app.get('/api/image-proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ success: false, message: 'URL parameter is required' });
    }

    // Only allow proxying from trusted S3 domains
    const parsedUrl = new URL(url);
    const allowedHosts = [
      's3.amazonaws.com',
      's3.us-east-1.amazonaws.com',
      's3.us-west-2.amazonaws.com',
    ];
    const isS3 = parsedUrl.hostname.includes('.s3.') ||
                 parsedUrl.hostname.includes('s3.amazonaws.com') ||
                 allowedHosts.some(host => parsedUrl.hostname.includes(host));

    if (!isS3) {
      return res.status(403).json({ success: false, message: 'Only S3 URLs are allowed' });
    }

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ success: false, message: 'Failed to fetch image' });
    }

    const contentType = response.headers.get('content-type') || 'image/png';
    const buffer = Buffer.from(await response.arrayBuffer());

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (error) {
    console.error('[image-proxy] Error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to proxy image' });
  }
});

// Health check route
app.get('/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'AI Book Story API is running',
    timestamp: new Date().toISOString(),
  });
});

// API overview route
app.get('/api', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Welcome to AI Book Story API',
    version: '1.0.0',
    endpoints: {
      users: '/api/users',
      books: '/api/books',
      prompts: '/api/prompts',
      trainings: '/api/trainings',
      generations: '/api/generations',
      evals: '/api/evals',
      automation: '/api/automation',
      dashboard: '/api/dashboard',
      health: '/health',
    },
  });
});

// Root route - serve the frontend entry point
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendBuildPath, 'index.html'));
});

// Serve frontend for all non-API routes (for React Router)
app.get('*', (req, res) => {
  // Skip API routes
  if (req.path.startsWith('/api')) {
    return res.status(404).json({
      success: false,
      message: 'API route not found',
    });
  }

  res.sendFile(path.join(frontendBuildPath, 'index.html'));
});

// 404 handler (this won't be reached due to catch-all above, but keeping for completeness)
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found',
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err : {},
  });
});

// Start server
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    // Validate Replicate token
    validateReplicateToken();

    // Connect to database
    await connectDatabase();

    // Initialise automation watchers
    initialiseAutomationWatchers();

    // Start listening
    app.listen(PORT, () => {
      console.log('='.repeat(50));
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📡 Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🌐 API URL: http://localhost:${PORT}`);
      console.log(`💚 Health check: http://localhost:${PORT}/health`);
      console.log('='.repeat(50));
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Handle unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled Rejection:', err);
  process.exit(1);
});

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.log('👋 SIGTERM received, shutting down gracefully');
  process.exit(0);
});

startServer();

module.exports = app;
