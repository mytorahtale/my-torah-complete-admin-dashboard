const mongoose = require('mongoose');

const imageAssetSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    url: { type: String, required: true },
    downloadUrl: { type: String, default: null },
    size: { type: Number, default: 0 },
    contentType: { type: String, default: null },
    uploadedAt: { type: Date, default: Date.now },
    originalName: { type: String, default: null },
    signedUrl: { type: String, default: null },
    backgroundRemoved: { type: Boolean, default: false },
  },
  { _id: true }
);

const storybookEventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    message: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: true }
);

const storybookPageSchema = new mongoose.Schema(
  {
    pageId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    order: {
      type: Number,
      required: true,
      min: 0,
    },
    prompt: {
      type: String,
      default: '',
      trim: true,
    },
    text: {
      type: String,
      default: '',
    },
    pageType: {
      type: String,
      enum: ['story', 'cover', 'dedication'],
      default: 'story',
    },
    status: {
      type: String,
      enum: ['queued', 'generating', 'completed', 'failed'],
      default: 'queued',
    },
    progress: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    generationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Generation',
      default: null,
    },
    characterAsset: {
      type: imageAssetSchema,
      default: null,
    },
    characterAssetOriginal: {
      type: imageAssetSchema,
      default: null,
    },
    characterPosition: {
      type: String,
      enum: ['auto', 'left', 'right'],
      default: 'auto',
    },
    generationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Generation',
      default: null,
    },
    candidateAssets: {
      type: [imageAssetSchema],
      default: [],
    },
    selectedCandidateIndex: {
      type: Number,
      default: null,
    },
    events: {
      type: [storybookEventSchema],
      default: [],
    },
    error: {
      type: String,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  { _id: true }
);

// Snapshot of a single PDF page, used for admin preview tooling.
// This is intentionally richer than the minimal fields required to render the PDF itself
// so that the frontend can reconstruct cover/dedication layouts, candidate grids, etc.
const pdfPageSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true },
    text: { type: String, default: '' },
    quote: { type: String, default: '' },

    // Final composited background and character assets used in the PDF
    background: { type: imageAssetSchema, default: null },
    character: { type: imageAssetSchema, default: null },
    characterOriginal: { type: imageAssetSchema, default: null },

    // Character placement for preview + safety: left/right
    characterPosition: { type: String, default: null },
    characterPositionResolved: { type: String, default: null },

    // Link back to the underlying generation & candidate set, if any
    generationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Generation',
      default: null,
    },
    candidateAssets: {
      type: [imageAssetSchema],
      default: [],
    },
    selectedCandidateIndex: {
      type: Number,
      default: null,
    },

    // Page role & structured front‑matter metadata
    pageType: {
      type: String,
      enum: ['story', 'cover', 'dedication'],
      default: 'story',
    },
    cover: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    coverPage: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    dedicationPage: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Optional pre‑rendered PNG used for fast preview / download
    renderedImage: {
      type: imageAssetSchema,
      default: null,
    },

    // Resolved child name at generation time (used for placeholder replacement)
    childName: {
      type: String,
      default: '',
    },

    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const pdfAssetSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    url: { type: String, required: true },
    size: { type: Number, default: 0 },
    contentType: { type: String, default: 'application/pdf' },
    title: { type: String, default: '' },
    pageCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },

    // Denormalised metadata for convenience when listing assets
    trainingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Training',
      default: null,
    },
    storybookJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StorybookJob',
      default: null,
    },
    readerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    readerName: {
      type: String,
      default: '',
    },
    readerGender: {
      type: String,
      default: '',
      trim: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    variant: {
      type: String,
      default: 'standard',
    },
    derivedFromAssetId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    derivedFromAssetKey: {
      type: String,
      default: null,
    },
    confirmedAt: {
      type: Date,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    // Per‑page snapshots
    pages: {
      type: [pdfPageSchema],
      default: [],
    },
  },
  { _id: true }
);

const storybookJobSchema = new mongoose.Schema(
  {
    bookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Book',
      required: true,
    },
    trainingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Training',
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    readerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    readerName: {
      type: String,
      default: '',
    },
    readerGender: {
      type: String,
      default: '',
      trim: true,
    },
    readerSecondTitle: {
      type: String,
      default: '',
      trim: true,
    },
    title: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['queued', 'generating', 'assembling', 'succeeded', 'failed'],
      default: 'queued',
    },
    progress: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    error: {
      type: String,
      default: null,
    },
    startedAt: {
      type: Date,
      default: null,
    },
    completedAt: {
      type: Date,
      default: null,
    },
    pages: {
      type: [storybookPageSchema],
      default: [],
    },
    events: {
      type: [storybookEventSchema],
      default: [],
    },
    logs: {
      type: [storybookEventSchema],
      default: [],
    },
    pdfAsset: {
      type: pdfAssetSchema,
      default: null,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

storybookJobSchema.index({ bookId: 1, createdAt: -1 });
storybookJobSchema.index({ status: 1, createdAt: -1 });
storybookJobSchema.index({ bookId: 1, status: 1, createdAt: -1 });
storybookJobSchema.index({ trainingId: 1 });
storybookJobSchema.index({ userId: 1 });

const StorybookJob = mongoose.model('StorybookJob', storybookJobSchema);

module.exports = StorybookJob;
