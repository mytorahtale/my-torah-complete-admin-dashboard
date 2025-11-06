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

const rankingNoteSchema = new mongoose.Schema(
  {
    imageIndex: { type: Number, required: true, min: 1 },
    score: { type: Number, default: null },
    verdict: { type: String, default: '' },
    notes: { type: String, default: '' },
  },
  { _id: false }
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
    bookPageOrder: {
      type: Number,
      default: null,
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
      enum: ['queued', 'generating', 'ranking', 'completed', 'failed'],
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
    rankingWinner: {
      type: Number,
      default: null,
    },
    rankingSummary: {
      type: String,
      default: '',
    },
    rankingNotes: {
      type: [rankingNoteSchema],
      default: [],
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
    pages: {
      type: [
        new mongoose.Schema(
          {
            pageId: { type: mongoose.Schema.Types.ObjectId, default: null },
            order: { type: Number, required: true },
            bookPageOrder: { type: Number, default: null },
            text: { type: String, default: '' },
            quote: { type: String, default: '' },
            background: { type: imageAssetSchema, default: null },
            character: { type: imageAssetSchema, default: null },
            characterOriginal: { type: imageAssetSchema, default: null },
            candidateAssets: { type: [imageAssetSchema], default: [] },
            selectedCandidateIndex: { type: Number, default: null },
            generationId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: 'Generation',
              default: null,
            },
            rankingSummary: { type: String, default: '' },
            rankingNotes: { type: [rankingNoteSchema], default: [] },
            pageType: {
              type: String,
              enum: ['story', 'cover', 'dedication'],
              default: 'story',
            },
            cover: { type: mongoose.Schema.Types.Mixed, default: null },
            coverPage: { type: mongoose.Schema.Types.Mixed, default: null },
            dedicationPage: { type: mongoose.Schema.Types.Mixed, default: null },
            renderedImage: { type: imageAssetSchema, default: null },
            childName: { type: String, default: '' },
            characterPosition: {
              type: String,
              enum: ['auto', 'left', 'right'],
              default: 'auto',
            },
            characterPositionResolved: {
              type: String,
              default: null,
            },
            updatedAt: { type: Date, default: Date.now },
          },
          { _id: false }
        ),
      ],
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
    estimatedSecondsRemaining: {
      type: Number,
      default: null,
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
storybookJobSchema.index({ trainingId: 1 });
storybookJobSchema.index({ userId: 1 });

const StorybookJob = mongoose.model('StorybookJob', storybookJobSchema);

module.exports = StorybookJob;
