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
  },
  { _id: false }
);

const pageSchema = new mongoose.Schema(
  {
    order: { type: Number, required: true, min: 1 },
    text: { type: String, default: '', trim: true },
    characterPromptMale: { type: String, trim: true },
    characterPromptFemale: { type: String, trim: true },
    characterPosition: {
      type: String,
      enum: ['left', 'right'],
      default: 'left',
    },
    backgroundImage: {
      type: imageAssetSchema,
      default: null,
    },
  },
  { _id: true }
);

const coverPageSchema = new mongoose.Schema(
  {
    backgroundImage: {
      type: imageAssetSchema,
      default: null,
    },
    characterPromptMale: { type: String, trim: true },
    characterPromptFemale: { type: String, trim: true },
    leftSide: {
      title: { type: String, default: '', trim: true },
      content: { type: String, default: '', trim: true },
      bottomText: { type: String, default: '', trim: true },
    },
    rightSide: {
      mainTitle: { type: String, default: '', trim: true },
      subtitle: { type: String, default: '', trim: true },
    },
    qrCode: {
      type: imageAssetSchema,
      default: null,
    },
  },
  { _id: false }
);

const dedicationPageSchema = new mongoose.Schema(
  {
    backgroundImage: {
      type: imageAssetSchema,
      default: null,
    },
    title: { type: String, default: '', trim: true },
    secondTitle: { type: String, default: '', trim: true },
    characterPromptMale: { type: String, trim: true },
    characterPromptFemale: { type: String, trim: true },
  },
  { _id: false }
);

const bookSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Book name is required'],
      trim: true,
      minlength: [3, 'Book name must be at least 3 characters'],
      maxlength: [120, 'Book name cannot exceed 120 characters'],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    slug: {
      type: String,
      unique: true,
      index: true,
    },
    pages: {
      type: [pageSchema],
      default: [],
    },
    coverPage: {
      type: coverPageSchema,
      default: null,
    },
    dedicationPage: {
      type: dedicationPageSchema,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

bookSchema.index({ status: 1, createdAt: -1 });
bookSchema.index({ name: 'text', description: 'text' });

const Book = mongoose.model('Book', bookSchema);

module.exports = Book;
