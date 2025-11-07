const mongoose = require('mongoose');

const toOptionalTrimmedString = (value) => {
  if (typeof value !== 'string') return value === '' ? undefined : value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const toOptionalLowercaseString = (value) => {
  if (typeof value !== 'string') return value === '' ? undefined : value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed.toLowerCase();
};

const evaluationSchema = new mongoose.Schema(
  {
    verdict: { type: String, default: null },
    acceptable: { type: Boolean, default: null },
    scorePercent: { type: Number, default: null },
    confidencePercent: { type: Number, default: null },
    summary: { type: String, default: '' },
    override: { type: Boolean, default: false },
  },
  { _id: false }
);

const imageAssetSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    url: { type: String, required: true },
    size: { type: Number, default: 0 },
    contentType: { type: String, default: null },
    uploadedAt: { type: Date, default: Date.now },
    originalName: { type: String, default: null },
    evaluation: { type: evaluationSchema, default: null },
  },
  { _id: true }
);

/**
 * User Schema for storing student/child information
 */
const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters long'],
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    secondTitle: {
      type: String,
      trim: true,
      maxlength: [500, 'Second title cannot exceed 500 characters'],
      set: toOptionalTrimmedString,
      default: '',
    },
    age: {
      type: Number,
      min: [0, 'Age must be at least 0'],
      max: [150, 'Age cannot exceed 150'],
      default: null,
    },
    gender: {
      type: String,
      enum: {
        values: ['male', 'female', 'other'],
        message: '{VALUE} is not a valid gender',
      },
      set: toOptionalTrimmedString,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      match: [
        /^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/,
        'Please enter a valid email address',
      ],
      set: toOptionalLowercaseString,
    },
    countryCode: {
      type: String,
      trim: true,
      match: [/^\+\d{1,4}$/, 'Please enter a valid country code (e.g., +1, +91)'],
      set: toOptionalTrimmedString,
    },
    phoneNumber: {
      type: String,
      trim: true,
      match: [/^\d{6,15}$/, 'Please enter a valid phone number'],
      set: toOptionalTrimmedString,
    },
    imageAssets: {
      type: [imageAssetSchema],
      default: [],
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

// Index for faster queries
userSchema.index({ status: 1 });

// Virtual for full phone number
userSchema.virtual('fullPhoneNumber').get(function () {
  const parts = [this.countryCode, this.phoneNumber].filter(Boolean);
  return parts.join(' ');
});

userSchema.methods.removeImageAsset = function (assetId) {
  this.imageAssets = this.imageAssets.filter((asset) => asset._id.toString() !== assetId.toString());
};

// Ensure virtuals are included in JSON
userSchema.set('toJSON', { virtuals: true });
userSchema.set('toObject', { virtuals: true });

const User = mongoose.model('User', userSchema);

module.exports = User;
