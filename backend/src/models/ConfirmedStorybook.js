const mongoose = require('mongoose');

const confirmedStorybookSchema = new mongoose.Schema(
  {
    bookId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Book',
      required: true,
    },
    storybookJobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'StorybookJob',
      required: true,
    },
    pdfKey: {
      type: String,
      required: true,
    },
    pdfUrl: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      default: '',
      trim: true,
    },
    readerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    readerName: {
      type: String,
      default: '',
      trim: true,
    },
    readerGender: {
      type: String,
      default: '',
      trim: true,
    },
    trainingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Training',
      default: null,
    },
    size: {
      type: Number,
      default: 0,
    },
    pageCount: {
      type: Number,
      default: 0,
    },
    confirmedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

confirmedStorybookSchema.index({ bookId: 1, createdAt: -1 });

const ConfirmedStorybook = mongoose.model('ConfirmedStorybook', confirmedStorybookSchema);

module.exports = ConfirmedStorybook;

