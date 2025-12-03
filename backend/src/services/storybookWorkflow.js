const crypto = require('crypto');
const mongoose = require('mongoose');
const Book = require('../models/Book');
const User = require('../models/User');
const Training = require('../models/Training');
const Generation = require('../models/Generation');
const StorybookJob = require('../models/StorybookJob');
const {
  uploadBufferToS3,
  generateBookCharacterOverlayKey,
  generateBookPdfKey,
  getSignedUrlForKey,
  downloadFromS3,
} = require('../config/s3');
const { generateStorybookPdf, removeBackground } = require('../utils/pdfGenerator');
const { emitStorybookUpdate } = require('./storybookEvents');
const { dispatchGenerationAttempt, populateForClient, broadcastGeneration } = require('./generationWorkflow');
const { subscribeToGenerationUpdates } = require('./generationEvents');

const MAX_GENERATION_WAIT_TIME_MS = Number(process.env.STORYBOOK_PAGE_TIMEOUT_MS || 15 * 60 * 1000);
const PAGE_CONCURRENCY = Math.max(
  1,
  Number(process.env.STORYBOOK_PAGE_CONCURRENCY || 5)
);

function toFiniteNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const STORYBOOK_PAGE_GENERATION_ATTEMPTS = Math.max(
  1,
  toFiniteNumber(process.env.STORYBOOK_PAGE_GENERATION_ATTEMPTS, 3)
);

const STORYBOOK_PAGE_RETRY_BASE_DELAY_MS = Math.max(
  250,
  toFiniteNumber(process.env.STORYBOOK_PAGE_RETRY_BASE_DELAY_MS, 1500)
);

const STORYBOOK_PAGE_RETRY_BACKOFF_FACTOR = Math.max(
  1,
  toFiniteNumber(process.env.STORYBOOK_PAGE_RETRY_BACKOFF_FACTOR, 2)
);

const generationWaiters = new Map();

const buildPreviewBatchId = () => {
  const timePart = Date.now().toString(36);
  const randomPart =
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 10);
  return `${timePart}-${randomPart}`;
};

subscribeToGenerationUpdates((payload) => {
  if (!payload?._id) return;
  const generationId = String(payload._id);
  const entry = generationWaiters.get(generationId);
  if (!entry) return;
  try {
    entry.onUpdate(payload);
    if (payload.status === 'succeeded') {
      generationWaiters.delete(generationId);
      entry.resolve(payload);
    } else if (payload.status === 'failed') {
      generationWaiters.delete(generationId);
      const errorMessage = payload.error || 'Generation failed';
      entry.reject(new Error(errorMessage));
    }
  } catch (error) {
    console.warn(`[storybook] watcher for generation ${generationId} threw:`, error);
  }
});

const clamp = (value, min, max) => {
  const num = Number(value);
  if (Number.isNaN(num)) return min;
  if (num < min) return min;
  if (num > max) return max;
  return num;
};

const slugify = (value) =>
  (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const getGenderPronouns = (gender) => {
  if (!gender) {
    return {
      subject: '',
      possessive: '',
      object: '',
      possessivePronoun: '',
      possessiveDeterminer: '',
    };
  }
  const lowerGender = gender.toLowerCase();
  if (lowerGender === 'male') {
    return {
      subject: 'He',
      possessive: 'His',
      object: 'Him',
      possessivePronoun: 'His',
      possessiveDeterminer: 'His',
    };
  }
  if (lowerGender === 'female') {
    return {
      subject: 'She',
      possessive: 'Her',
      object: 'Her',
      possessivePronoun: 'Hers',
      possessiveDeterminer: 'Her',
    };
  }
  return {
    subject: 'They',
    possessive: 'Their',
    object: 'Them',
    possessivePronoun: 'Theirs',
    possessiveDeterminer: 'Their',
  };
};

const applyPlaceholderCasing = (placeholder, replacement) => {
  if (!placeholder || typeof placeholder !== 'string') return replacement || '';
  if (!replacement) return '';

  const inner = placeholder.slice(1, -1);
  if (!inner) return replacement;

  if (inner === inner.toUpperCase()) {
    return replacement.toUpperCase();
  }
  if (inner === inner.toLowerCase()) {
    return replacement.toLowerCase();
  }

  const isTitleCase =
    inner[0] === inner[0].toUpperCase() && inner.slice(1) === inner.slice(1).toLowerCase();
  if (isTitleCase) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
  }

  return replacement;
};

const replaceReaderPlaceholders = (value, readerName, readerGender) => {
  if (!value || typeof value !== 'string') return value || '';
  let result = value;

  if (readerName) {
    const upperName = readerName.toUpperCase();
    result = result.replace(/\{name\}/gi, (matched) => {
      const inner = matched.slice(1, -1);
      if (inner === inner.toUpperCase()) {
        return upperName;
      }
      return readerName;
    });
  }

  if (readerGender) {
    const pronouns = getGenderPronouns(readerGender);
    result = result.replace(/\{gender\}/gi, (match) =>
      applyPlaceholderCasing(match, pronouns.subject)
    );
    result = result.replace(/\{genderpos\}/gi, (match) =>
      applyPlaceholderCasing(match, pronouns.possessiveDeterminer || pronouns.possessive)
    );
    result = result.replace(/\{genderper\}/gi, (match) =>
      applyPlaceholderCasing(match, pronouns.object)
    );
    result = result.replace(/\{genderx\}/gi, (match) =>
      applyPlaceholderCasing(match, pronouns.possessivePronoun || pronouns.possessive)
    );
    result = result.replace(/\{gendery\}/gi, (match) =>
      applyPlaceholderCasing(match, pronouns.object)
    );
    result = result.replace(/\{genderz\}/gi, (match) =>
      applyPlaceholderCasing(match, pronouns.possessiveDeterminer || pronouns.possessive)
    );
  }

  return result;
};

const normalizeCharacterPosition = (value, fallback = null) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'left' || normalized === 'right') {
      return normalized;
    }
  }
  return fallback;
};

const createEvent = (type, message, metadata = null) => ({
  type,
  message,
  metadata,
  timestamp: new Date(),
});

const computeAveragePageProgress = (pages = []) => {
  if (!pages.length) return 0;
  const total = pages.reduce((sum, page) => sum + (page?.progress || 0), 0);
  return clamp(total / pages.length, 0, 100);
};

const clonePlainObject = (value) => {
  if (!value || typeof value !== 'object') return null;
  return JSON.parse(JSON.stringify(value));
};

const sanitizeCoverForSnapshot = (cover) => {
  if (!cover || typeof cover !== 'object') return null;
  const cloned = clonePlainObject(cover) || {};

  const extractFromSegments = () => {
    if (!Array.isArray(cloned.textSegments)) {
      return { headline: '', body: '', footer: '' };
    }
    const textSegments = cloned.textSegments.filter((segment) => segment?.type === 'text');
    if (!textSegments.length) {
      return { headline: '', body: '', footer: '' };
    }
    const headlineSegment = textSegments[0]?.text || '';
    const footerSegment = textSegments.length > 1 ? textSegments[textSegments.length - 1].text || '' : '';
    const middleSegments = textSegments.slice(1, Math.max(textSegments.length - 1, 1));
    const body = middleSegments
      .map((segment) => (typeof segment?.text === 'string' ? segment.text : ''))
      .filter(Boolean)
      .join('\n');
    return { headline: headlineSegment, body, footer: footerSegment };
  };

  const legacy = extractFromSegments();

  return {
    headline: typeof cloned.headline === 'string' && cloned.headline.trim()
      ? cloned.headline
      : legacy.headline || '',
    footer: typeof cloned.footer === 'string' && cloned.footer.trim()
      ? cloned.footer
      : legacy.footer || '',
    bodyOverride: typeof cloned.bodyOverride === 'string' && cloned.bodyOverride.trim()
      ? cloned.bodyOverride
      : legacy.body || '',
    uppercaseName:
      typeof cloned.uppercaseName === 'boolean' ? cloned.uppercaseName : true,
    qrCodeImage: cloned.qrCodeImage ? sanitizeAssetForSnapshot(cloned.qrCodeImage) : null,
    childName: typeof cloned.childName === 'string' ? cloned.childName : '',
  };
};

const safeText = (value) => (typeof value === 'string' ? value : '');

const normalizePromptText = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeGenderValue = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const resolvePromptByGender = (source = {}, gender = '') => {
  const male = normalizePromptText(
    source.characterPromptMale || source.promptMale || source.malePrompt
  );
  const female = normalizePromptText(
    source.characterPromptFemale || source.promptFemale || source.femalePrompt
  );
  const neutral = normalizePromptText(
    source.characterPrompt || source.prompt || source.neutralPrompt
  );
  const normalizedGender = normalizeGenderValue(gender);

  if (normalizedGender === 'male' && male) return male;
  if (normalizedGender === 'female' && female) return female;
  if (neutral) return neutral;
  if (normalizedGender === 'male' && female) return female;
  if (normalizedGender === 'female' && male) return male;
  return neutral || male || female || '';
};

const hasAnyPrompt = (source = {}) => {
  return Boolean(
    normalizePromptText(source.characterPrompt) ||
      normalizePromptText(source.characterPromptMale) ||
      normalizePromptText(source.characterPromptFemale) ||
      normalizePromptText(source.prompt)
  );
};

const sanitizeCoverPageForSnapshot = (coverPage) => {
  if (!coverPage || typeof coverPage !== 'object') return null;
  const cloned = clonePlainObject(coverPage) || {};
  return {
    backgroundImage: sanitizeAssetForSnapshot(cloned.backgroundImage),
    qrCode: sanitizeAssetForSnapshot(cloned.qrCode),
    // Preserve the character image used on the cover so the admin preview
    // can mirror the final PDF layout.
    characterImage: sanitizeAssetForSnapshot(cloned.characterImage),
    characterImageOriginal: sanitizeAssetForSnapshot(cloned.characterImageOriginal),
    characterPromptMale: normalizePromptText(cloned.characterPromptMale),
    characterPromptFemale: normalizePromptText(cloned.characterPromptFemale),
    leftSide: {
      title: safeText(cloned.leftSide?.title),
      content: safeText(cloned.leftSide?.content),
      bottomText: safeText(cloned.leftSide?.bottomText),
    },
    rightSide: {
      mainTitle: safeText(cloned.rightSide?.mainTitle),
      subtitle: safeText(cloned.rightSide?.subtitle),
    },
  };
};

const sanitizeDedicationForSnapshot = (dedicationPage) => {
  if (!dedicationPage || typeof dedicationPage !== 'object') return null;
  const cloned = clonePlainObject(dedicationPage) || {};
  return {
    backgroundImage: sanitizeAssetForSnapshot(cloned.backgroundImage),
    title: safeText(cloned.title),
    secondTitle: safeText(cloned.secondTitle),
    characterPromptMale: normalizePromptText(cloned.characterPromptMale),
    characterPromptFemale: normalizePromptText(cloned.characterPromptFemale),
    // Preserve hero image choices so the admin dedication preview can show
    // the same child placement as the PDF.
    kidImage: sanitizeAssetForSnapshot(cloned.kidImage),
    generatedImage: sanitizeAssetForSnapshot(cloned.generatedImage),
    generatedImageOriginal: sanitizeAssetForSnapshot(cloned.generatedImageOriginal),
  };
};

const computeJobProgress = (job) => {
  if (!job) return 0;
  if (job.status === 'succeeded') return 100;
  if (job.status === 'failed') return clamp(job.progress || 0, 0, 100);

  const average = computeAveragePageProgress(job.pages);
  if (job.status === 'assembling') {
    const assemblyProgress =
      (job.metadata && typeof job.metadata.assemblyProgress === 'number'
        ? clamp(job.metadata.assemblyProgress, 0, 10)
        : 0) || 0;
    return clamp(90 + assemblyProgress, 0, 100);
  }

  return Math.floor((average * 0.9) / 1);
};

const computeEtaSeconds = (job, progress) => {
  if (!job?.startedAt) return null;
  if (!Number.isFinite(progress) || progress <= 0 || progress >= 100) return null;
  const elapsedSeconds = (Date.now() - new Date(job.startedAt).getTime()) / 1000;
  if (elapsedSeconds <= 0) return null;
  const rate = progress / elapsedSeconds; // percent per second
  if (rate <= 0) return null;
  const remaining = (100 - progress) / rate;
  if (!Number.isFinite(remaining) || remaining < 0) return null;
  return Math.round(remaining);
};

const syncComputedFields = async (jobDoc) => {
  if (!jobDoc) return null;
  const jobPlain = jobDoc.toObject({ depopulate: true });
  const progress = computeJobProgress(jobPlain);
  const eta = computeEtaSeconds(jobPlain, progress);
  let needsSave = false;

  if (jobDoc.progress !== progress) {
    jobDoc.progress = progress;
    needsSave = true;
  }
  if (
    (eta === null && jobDoc.estimatedSecondsRemaining !== null) ||
    (eta !== null && jobDoc.estimatedSecondsRemaining !== eta)
  ) {
    jobDoc.estimatedSecondsRemaining = eta;
    needsSave = true;
  }

  if (needsSave) {
    await jobDoc.save();
  }

  const snapshot = jobDoc.toObject({ depopulate: true });
  snapshot.progress = progress;
  snapshot.estimatedSecondsRemaining = eta;
  return snapshot;
};

const emitJob = (jobDoc) => {
  if (!jobDoc) return null;
  const snapshot =
    typeof jobDoc.toObject === 'function' ? jobDoc.toObject({ depopulate: true }) : jobDoc;
  const progress = computeJobProgress(snapshot);
  const eta = computeEtaSeconds(snapshot, progress);
  snapshot.progress = progress;
  snapshot.estimatedSecondsRemaining = eta;
  emitStorybookUpdate(snapshot);
  return snapshot;
};

const updateJobAndEmit = async ({ jobId, update, arrayFilters }) => {
  const options = { new: true };
  if (Array.isArray(arrayFilters)) {
    options.arrayFilters = arrayFilters;
  }

  const jobDoc = await StorybookJob.findOneAndUpdate({ _id: jobId }, update, options);
  if (!jobDoc) return null;
  const snapshot = await syncComputedFields(jobDoc);
  emitStorybookUpdate(snapshot);
  return snapshot;
};

const registerGenerationWaiter = ({ generationId, jobId, pageId, pageOrder }) => {
  const generationKey = String(generationId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (generationWaiters.has(generationKey)) {
        generationWaiters.delete(generationKey);
        reject(new Error('Generation timed out while waiting for completion'));
      }
    }, MAX_GENERATION_WAIT_TIME_MS);

    const clear = () => clearTimeout(timeout);

    generationWaiters.set(generationKey, {
      resolve: (payload) => {
        clear();
        resolve(payload);
      },
      reject: (error) => {
        clear();
        reject(error);
      },
      onUpdate: (payload) => handleGenerationUpdate({ payload, jobId, pageId, pageOrder }),
    });
  });
};

const delay = (ms) =>
  new Promise((resolve) => {
    const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
    setTimeout(resolve, safeMs);
  });

const waitForStandaloneGeneration = (generationId) => {
  const generationKey = String(generationId);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Generation timed out while waiting for completion'));
    }, MAX_GENERATION_WAIT_TIME_MS);

    let unsubscribe = null;
    const cleanup = () => {
      clearTimeout(timeout);
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const listener = (payload) => {
      if (!payload?._id) return;
      if (String(payload._id) !== generationKey) return;

      if (payload.status === 'succeeded') {
        cleanup();
        resolve(payload);
      } else if (payload.status === 'failed') {
        cleanup();
        const errorMessage = payload.error || 'Generation failed';
        reject(new Error(errorMessage));
      }
    };

    unsubscribe = subscribeToGenerationUpdates(listener);
  });
};

const handleGenerationUpdate = async ({ payload, jobId, pageId, pageOrder }) => {
  const pageFilter = [];
  if (pageId) {
    const objectId =
      typeof pageId === 'string' ? new mongoose.Types.ObjectId(pageId) : pageId;
    pageFilter.push({ 'page.pageId': objectId });
  } else if (typeof pageOrder === 'number') {
    pageFilter.push({ 'page.order': pageOrder });
  }

  const arrayFilters = pageFilter.length
    ? pageFilter
    : [{ 'page.order': payload.generationConfig?.pageOrder || payload.storybookContext?.pageOrder }];

  const events = [];

  const progress = clamp(payload.progress || 0, 0, 100);

  let status = 'generating';
  if (payload.status === 'failed') {
    status = 'failed';
  } else if (payload.status === 'succeeded') {
    status = 'completed';
  }

  const update = {
    $set: {
      'pages.$[page].progress': progress,
      'pages.$[page].status': status,
    },
  };

  if (payload.status === 'failed') {
    update.$set['pages.$[page].error'] = payload.error || 'Generation failed';
  }

  update.$push = {
    'pages.$[page].events': createEvent('generation-update', `Generation ${payload.status}`, {
      generationId: payload._id,
      status: payload.status,
      progress,
    }),
  };

  await updateJobAndEmit({
    jobId,
    update,
    arrayFilters,
  });
};

const attachJobEvent = async (jobId, event) => {
  await updateJobAndEmit({
    jobId,
    update: {
      $push: { events: event },
    },
  });
};

const attachPageEvent = async (jobId, pageFilter, event) => {
  await updateJobAndEmit({
    jobId,
    update: {
      $push: {
        'pages.$[page].events': event,
      },
    },
    arrayFilters: [pageFilter],
  });
};

const resolveArrayFilterForPage = (page) => {
  if (page.pageId) {
    const objectId =
      typeof page.pageId === 'string' ? new mongoose.Types.ObjectId(page.pageId) : page.pageId;
    return { 'page.pageId': objectId };
  }
  return { 'page.order': page.order };
};

const copyAssetToBookCharacterSlot = async ({ book, page, asset }) => {
  if (!asset?.key) {
    throw new Error('Generation asset is missing S3 key');
  }

  const source = { ...asset };

  console.log('[copyAssetToBookCharacterSlot] asset URLs - url:', asset.url, 'downloadUrl:', asset.downloadUrl, 'signedUrl:', asset.signedUrl, 'key:', asset.key);

  const bookSlug = book.slug || `${slugify(book.name)}-${book._id.toString().slice(-6)}`;
  const key = generateBookCharacterOverlayKey(
    bookSlug,
    page.order,
    asset.originalName || `character-${page.order}.png`
  );

  let originalBuffer;
  try {
    originalBuffer = await downloadFromS3(asset.key);
  } catch (error) {
    if (error.Code === 'NoSuchKey' || error.name === 'NoSuchKey') {
      console.warn(`[copyAssetToBookCharacterSlot] S3 file not found for page ${page.order}, key: ${asset.key}. Skipping this page.`);
      return null;
    }
    throw error;
  }

  if (!originalBuffer || !originalBuffer.length) {
    console.warn(`[copyAssetToBookCharacterSlot] Empty buffer for page ${page.order}. Skipping this page.`);
    return null;
  }

  // Step 1: Upload original buffer to the book's character slot
  console.log('[copyAssetToBookCharacterSlot] Uploading original buffer to S3 key:', key);
  const { url: uploadedUrl } = await uploadBufferToS3(
    originalBuffer,
    key,
    asset.contentType || 'image/png',
    { acl: 'public-read' }
  );

  // Step 2: Get a signed URL for Brio to access
  const signedUrl = await getSignedUrlForKey(key).catch(() => uploadedUrl);
  console.log('[copyAssetToBookCharacterSlot] Got URL for Brio:', signedUrl ? 'Yes' : 'No');

  // Step 3: Call Brio to remove background (skip for dedication pages)
  let processedBuffer = null;
  let backgroundRemoved = false;

  if (page.pageType === 'dedication') {
    console.log('[copyAssetToBookCharacterSlot] Dedication page - skipping background removal');
    processedBuffer = originalBuffer;
    backgroundRemoved = false;
  } else if (asset.backgroundRemoved) {
    console.log('[copyAssetToBookCharacterSlot] Asset already has background removed, skipping Brio');
    processedBuffer = originalBuffer;
    backgroundRemoved = true;
  } else {
    console.log('[copyAssetToBookCharacterSlot] Calling Brio for page', page.order);
    try {
      const removalBuffer = await removeBackground({
        url: uploadedUrl,
        signedUrl: signedUrl,
        downloadUrl: uploadedUrl,
        key: key,
      });
      console.log('[copyAssetToBookCharacterSlot] Brio returned buffer length:', removalBuffer ? removalBuffer.length : null);

      if (removalBuffer && removalBuffer.length) {
        processedBuffer = removalBuffer;
        backgroundRemoved = true;
        console.log('[copyAssetToBookCharacterSlot] Background removal successful!');
      } else {
        console.warn('[copyAssetToBookCharacterSlot] Brio returned empty buffer, using original');
        processedBuffer = originalBuffer;
        backgroundRemoved = false;
      }
    } catch (error) {
      console.warn(
        `[copyAssetToBookCharacterSlot] Background removal failed for page ${page.order}:`,
        error.message
      );
      processedBuffer = originalBuffer;
      backgroundRemoved = false;
    }
  }

  if (!processedBuffer || !processedBuffer.length) {
    throw new Error(`Unable to obtain character buffer for page ${page.order}`);
  }

  // Step 4: Upload the final buffer (with or without background removed) to S3
  const contentType = backgroundRemoved ? 'image/png' : asset.contentType || 'image/png';
  console.log('[copyAssetToBookCharacterSlot] Uploading final buffer (backgroundRemoved:', backgroundRemoved, ') to S3');
  const { url } = await uploadBufferToS3(processedBuffer, key, contentType, { acl: 'public-read' });
  const finalSignedUrl = await getSignedUrlForKey(key).catch(() => null);

  const result = {
    key,
    url,
    signedUrl: finalSignedUrl || url,
    downloadUrl: url,
    size: processedBuffer.length,
    contentType,
    uploadedAt: new Date(),
    originalName: asset.originalName || `character-${page.order}.png`,
    backgroundRemoved,
  };

  console.log('[copyAssetToBookCharacterSlot] Returning asset for page', page.order, 'with backgroundRemoved:', backgroundRemoved);
  return result;
};

const updateBookCharacterImage = async ({ jobId, page, newAsset, originalAsset = null }) => {
  if (!jobId || !page) return null;

  const hasPageId = Boolean(page.pageId);
  const arrayFilters = [];

  if (hasPageId) {
    const objectId =
      typeof page.pageId === 'string' ? new mongoose.Types.ObjectId(page.pageId) : page.pageId;
    arrayFilters.push({ 'page.pageId': objectId });
  } else if (typeof page.order === 'number') {
    arrayFilters.push({ 'page.order': page.order });
  } else {
    return null;
  }

  await StorybookJob.updateOne(
    { _id: jobId },
    {
      $set: {
        'pages.$[page].characterAsset': newAsset,
        'pages.$[page].characterAssetOriginal': originalAsset,
      },
    },
    {
      arrayFilters,
    }
  );

  return { newAsset, originalAsset };
};

const buildCoverPageContent = ({
  book,
  readerName,
  readerGender,
  storyPages = [],
  jobPage = null,
}) => {
  const coverPage = sanitizeCoverPageForSnapshot(book.coverPage) || {};

  if (!coverPage.backgroundImage) {
    return null;
  }

  const characterAsset = sanitizeAssetForSnapshot(jobPage?.characterAsset || null);
  const characterOriginalAsset =
    sanitizeAssetForSnapshot(jobPage?.characterAssetOriginal || jobPage?.characterAsset || null);
  coverPage.characterImage = characterAsset;
  coverPage.characterImageOriginal = characterOriginalAsset || characterAsset || null;
  const coverPrompt = resolvePromptByGender(coverPage, readerGender);
  coverPage.characterPrompt = coverPrompt;
  const fallbackPosition = 'right';

  return {
    order: 1,
    text: '',
    quote: '',
    background: coverPage.backgroundImage,
    character: characterAsset,
    characterOriginal: characterOriginalAsset || characterAsset || null,
    generationId: jobPage?.generationId || null,
    candidateAssets: sanitizeAssetListForSnapshot(jobPage?.candidateAssets || []),
    selectedCandidateIndex: Number.isFinite(jobPage?.selectedCandidateIndex)
      ? jobPage.selectedCandidateIndex
      : null,
    pageType: 'cover',
    characterPosition: fallbackPosition,
    characterPositionResolved: fallbackPosition,
    cover: null,
    coverPage,
    dedicationPage: null,
    prompt: coverPrompt || '',
    childName: readerName || '',
  };
};

const buildDedicationPageContent = ({
  book,
  readerName,
  readerGender,
  readerSecondTitle,
  storyPages = [],
  jobPage = null,
}) => {
  const dedicationPage = sanitizeDedicationForSnapshot(book.dedicationPage) || {};

  // Replace {name} placeholder in title with actual reader name
  if (dedicationPage.title && readerName) {
    dedicationPage.title = dedicationPage.title.replace(/\{name\}/gi, readerName);
  }

  // Prioritize user's secondTitle over book's dedication secondTitle
  if (readerSecondTitle) {
    dedicationPage.secondTitle = readerSecondTitle;
  } else if (dedicationPage.secondTitle && readerName) {
    // If no user secondTitle, use book's secondTitle with name replacement
    dedicationPage.secondTitle = dedicationPage.secondTitle.replace(/\{name\}/gi, readerName);
  }

  if (!dedicationPage.backgroundImage) {
    return null;
  }

  const characterAsset = sanitizeAssetForSnapshot(jobPage?.characterAsset || null);
  const characterOriginalAsset =
    sanitizeAssetForSnapshot(jobPage?.characterAssetOriginal || jobPage?.characterAsset || null);
  dedicationPage.kidImage = characterAsset;
  dedicationPage.generatedImage = characterAsset;
  dedicationPage.generatedImageOriginal = characterOriginalAsset || characterAsset || null;
  const dedicationPrompt = resolvePromptByGender(dedicationPage, readerGender);
  dedicationPage.characterPrompt = dedicationPrompt;
  const fallbackPosition = 'left';

  return {
    order: 2,
    text: '',
    quote: '',
    background: dedicationPage.backgroundImage,
    character: characterAsset,
    characterOriginal: characterOriginalAsset || characterAsset || null,
    generationId: jobPage?.generationId || null,
    candidateAssets: sanitizeAssetListForSnapshot(jobPage?.candidateAssets || []),
    selectedCandidateIndex: Number.isFinite(jobPage?.selectedCandidateIndex)
      ? jobPage.selectedCandidateIndex
      : null,
    pageType: 'dedication',
    characterPosition: fallbackPosition,
    characterPositionResolved: fallbackPosition,
    cover: null,
    coverPage: null,
    dedicationPage,
    prompt: dedicationPrompt || '',
    childName: readerName || '',
  };
};

const preparePageStoryContent = ({ bookPage, jobPage, readerName, readerGender }) => {
  const pageType = bookPage.pageType === 'cover' ? 'cover' : 'story';
  let cover = null;

  const resolveCoverPlaceholder = (input, uppercaseName) => {
    if (!input || typeof input !== 'string') return input || '';
    if (!readerName) return input;
    const replacement = uppercaseName ? (readerName || '').toUpperCase() : readerName;
    let result = input.replace(/\{name\}/gi, replacement);
    if (readerGender) {
      const pronouns = getGenderPronouns(readerGender);
      result = result.replace(/\{gender\}/gi, pronouns.subject);
      result = result.replace(/\{genderpos\}/gi, pronouns.possessive);
      result = result.replace(/\{genderper\}/gi, pronouns.object);
    }
    return result;
  };

  let resolvedText = bookPage.text || '';

  if (pageType === 'cover' && bookPage.cover) {
    const coverSource = clonePlainObject(bookPage.cover) || {};
    const uppercaseName =
      typeof coverSource.uppercaseName === 'boolean' ? coverSource.uppercaseName : true;

    const bodySource = coverSource.bodyOverride || resolvedText;
    const headline = resolveCoverPlaceholder(coverSource.headline || '', uppercaseName);
    const footer = resolveCoverPlaceholder(coverSource.footer || '', uppercaseName);
    const body = resolveCoverPlaceholder(bodySource, uppercaseName);

    cover = {
      headline,
      footer,
      bodyOverride: coverSource.bodyOverride ? body : '',
      uppercaseName,
      qrCodeImage: coverSource.qrCodeImage
        ? sanitizeAssetForSnapshot(coverSource.qrCodeImage)
        : null,
      childName: readerName || '',
    };

    resolvedText = body;
  } else {
    resolvedText = replaceReaderPlaceholders(resolvedText, readerName, readerGender);
  }

  const resolvedPrompt = resolvePromptByGender(bookPage, readerGender);
  const resolvedCharacterPosition = normalizeCharacterPosition(
    bookPage.characterPosition,
    null
  );

  return {
    order: bookPage.order,
    text: resolvedText,
    prompt: resolvedPrompt,
    background: bookPage.backgroundImage || null,
    character: jobPage.characterAsset || bookPage.characterImage || null,
    characterOriginal:
      jobPage.characterAssetOriginal || bookPage.characterImageOriginal || null,
    quote: '',
    characterPosition: resolvedCharacterPosition,
    generationId: jobPage?.generationId || null,
    candidateAssets: sanitizeAssetListForSnapshot(jobPage?.candidateAssets || []),
    selectedCandidateIndex: Number.isFinite(jobPage?.selectedCandidateIndex)
      ? jobPage.selectedCandidateIndex
      : null,
    pageType,
    cover,
  };
};

const sanitizeAssetForSnapshot = (asset) => {
  if (!asset) return null;
  return {
    key: asset.key,
    url: asset.url,
    signedUrl: asset.signedUrl || null,
    downloadUrl: asset.url || asset.downloadUrl || asset.signedUrl || null,
    size: asset.size || 0,
    contentType: asset.contentType || null,
    uploadedAt: asset.uploadedAt ? new Date(asset.uploadedAt) : new Date(),
    originalName: asset.originalName || null,
    backgroundRemoved: Boolean(asset.backgroundRemoved),
  };
};

const sanitizeAssetListForSnapshot = (assets) =>
  Array.isArray(assets)
    ? assets
        .map((asset) => sanitizeAssetForSnapshot(asset))
        .filter((asset) => Boolean(asset?.key || asset?.url))
    : [];

const buildPdfAsset = async ({ book, job, pages }) => {
  const { buffer, pageCount, renderedPages } = await generateStorybookPdf({
    title: job.title || `${book.name} Storybook`,
    pages,
  });

  const bookSlug = book.slug || `${slugify(book.name)}-${book._id.toString().slice(-6)}`;
  const pdfKey = generateBookPdfKey(bookSlug, job.title || `${book.name} Storybook`);
  const { url } = await uploadBufferToS3(buffer, pdfKey, 'application/pdf', { acl: 'public-read' });
  const previewBatchId = buildPreviewBatchId();

  const renderedUploads = await Promise.all(
    (renderedPages || []).map(async ({ index, type, buffer: pageBuffer }, position) => {
      if (!pageBuffer || !Buffer.isBuffer(pageBuffer)) {
        return null;
      }
      const normalizedIndex = Number.isInteger(index) ? index : position;
      const safeIndex = Number.isInteger(normalizedIndex) ? normalizedIndex : position;
      const typeSlug =
        typeof type === 'string' && type.trim() ? type.trim().toLowerCase() : 'page';
      const imageKey = `books/${bookSlug}/storybook-previews/${previewBatchId}-${safeIndex + 1}-${typeSlug}.png`;
      const uploadMeta = await uploadBufferToS3(pageBuffer, imageKey, 'image/png', {
        acl: 'public-read',
      });
      return {
        index: safeIndex,
        asset: {
          key: imageKey,
          url: uploadMeta.url,
          downloadUrl: uploadMeta.url,
          size: pageBuffer.length,
          contentType: 'image/png',
          uploadedAt: new Date(),
          originalName: `${typeSlug}-${safeIndex + 1}.png`,
          backgroundRemoved: false,
        },
      };
    })
  );

  const renderedByIndex = new Map(
    renderedUploads.filter(Boolean).map(({ index, asset }) => [index, asset])
  );

  return {
    key: pdfKey,
    url,
    size: buffer.length,
    contentType: 'application/pdf',
    title: job.title || `${book.name} Storybook`,
    pageCount,
    createdAt: new Date(),
    updatedAt: new Date(),
    trainingId: job.trainingId || null,
    storybookJobId: job._id || null,
    readerId: job.readerId || null,
    readerName: job.readerName || '',
    readerGender: job.readerGender || '',
    userId: job.userId || null,
    variant: 'standard',
    derivedFromAssetId: null,
    derivedFromAssetKey: null,
    confirmedAt: null,
    metadata: null,
    pages: pages.map((page, pageIndex) => ({
      order: pageIndex + 1,
      text: page.text || '',
      quote: page.quote || '',
      background: sanitizeAssetForSnapshot(page.background),
      character: sanitizeAssetForSnapshot(page.character),
      characterOriginal: sanitizeAssetForSnapshot(page.characterOriginal),
      characterPosition: page.characterPosition || null,
      characterPositionResolved: page.characterPositionResolved || null,
      generationId: page.generationId || null,
      candidateAssets: sanitizeAssetListForSnapshot(page.candidateAssets),
      selectedCandidateIndex: Number.isFinite(page.selectedCandidateIndex)
        ? page.selectedCandidateIndex
        : null,
      pageType: page.pageType || 'story',
      cover: sanitizeCoverForSnapshot(page.cover),
      coverPage: sanitizeCoverPageForSnapshot(page.coverPage),
      dedicationPage: sanitizeDedicationForSnapshot(page.dedicationPage),
      renderedImage: sanitizeAssetForSnapshot(renderedByIndex.get(pageIndex)),
      childName: typeof page.childName === 'string' ? page.childName : '',
      updatedAt: new Date(),
    })),
  };
};

const waitForGeneration = async ({ generationId, job, page }) => {
  const payload = await registerGenerationWaiter({
    generationId,
    jobId: job._id,
    pageId: page.pageId,
    pageOrder: page.order,
  });
  return payload;
};

const deriveWinnerAsset = (generation) => {
  if (!generation) return null;
  const assets = generation.imageAssets || [];
  if (!assets.length) return null;

  const asset = assets[0];
  const winnerNumber = 1;

  return {
    asset,
    winner: winnerNumber,
    summary: '',
    notes: [],
  };
};

const recordGenerationAttemptFailure = async ({
  job,
  page,
  pageFilter,
  attempt,
  maxAttempts,
  error,
  isFinalAttempt,
}) => {
  const timestamp = new Date();
  const safeMessage =
    (error && typeof error.message === 'string' && error.message.trim()) ||
    'Unknown error';

  const baseMetadata = {
    attempt,
    maxAttempts,
  };

  const retryMessage = isFinalAttempt
    ? `Generation failed after ${maxAttempts} attempts: ${safeMessage}`
    : `Generation attempt ${attempt} of ${maxAttempts} failed: ${safeMessage}. Retrying...`;

  const update = {
    $set: {
      'pages.$[page].error': safeMessage,
      'pages.$[page].status': isFinalAttempt ? 'failed' : 'generating',
      'pages.$[page].progress': isFinalAttempt
        ? 0
        : Math.min(95, Math.max(10, attempt * 10)),
    },
    $push: {
      'pages.$[page].events': createEvent(
        isFinalAttempt ? 'generation-failed' : 'generation-retry-scheduled',
        retryMessage,
        baseMetadata
      ),
    },
  };

  if (isFinalAttempt) {
    update.$set['pages.$[page].completedAt'] = timestamp;
    update.$push.events = createEvent(
      'generation-failed',
      `Generation failed for page ${page.order}: ${safeMessage}`,
      baseMetadata
    );
  } else {
    update.$push.events = createEvent(
      'generation-retry-scheduled',
      `Scheduled retry for page ${page.order} (attempt ${attempt + 1} of ${maxAttempts})`,
      baseMetadata
    );
  }

  await updateJobAndEmit({
    jobId: job._id,
    update,
    arrayFilters: [pageFilter],
  });
};

const processJobPage = async ({ job, page, book, training, readerName, readerGender }) => {
  const pageFilter = resolveArrayFilterForPage(page);
  const rawPrompt = page.prompt || page.text || '';

  // If page has no prompt/text, check if it has a background image
  if (!rawPrompt || !rawPrompt.trim()) {
    if (!page.backgroundImage) {
      throw new Error(`Page ${page.order} has no prompt, text, or background image. Please add content to this page.`);
    }
    // Page only has background image, skip character generation
    console.log(`[storybook] Page ${page.order} has no prompt/text, skipping character generation (background-only page)`);
    await updateJobAndEmit({
      jobId: job._id,
      update: {
        $set: {
          'pages.$[page].status': 'completed',
          'pages.$[page].startedAt': new Date(),
          'pages.$[page].completedAt': new Date(),
          'pages.$[page].progress': 100,
        },
        $push: {
          'pages.$[page].events': createEvent(
            'page-completed',
            `Page ${page.order} completed (background-only, no character generation needed)`
          ),
        },
      },
      arrayFilters: [pageFilter],
    });
    return null;
  }

  const generationPrompt = replaceReaderPlaceholders(rawPrompt, readerName, readerGender);

  if (!generationPrompt || !generationPrompt.trim()) {
    throw new Error(`Page ${page.order} has an empty prompt after placeholder replacement. Raw prompt: "${rawPrompt}"`);
  }

  await updateJobAndEmit({
    jobId: job._id,
    update: {
      $set: {
        'pages.$[page].status': 'generating',
        'pages.$[page].startedAt': new Date(),
        'pages.$[page].progress': 5,
      },
      $push: {
        'pages.$[page].events': createEvent(
          'page-started',
          `Started generation for page ${page.order}`,
          { prompt: generationPrompt }
        ),
      },
    },
    arrayFilters: [pageFilter],
  });

  const generationInput = {
    prompt: generationPrompt,
    guidance_scale: 2,
    output_quality: 100,
    output_format: 'png',
    num_outputs: 4,
    go_fast: false,
    num_inference_steps: 28,
    megapixels: '1',
    lora_scale: 1,
    extra_lora_scale: 1,
    pageOrder: page.order,
  };

  const maxAttempts = STORYBOOK_PAGE_GENERATION_ATTEMPTS;
  const baseDelayMs = STORYBOOK_PAGE_RETRY_BASE_DELAY_MS;
  const backoffFactor = STORYBOOK_PAGE_RETRY_BACKOFF_FACTOR;

  let attempt = 0;
  let lastError = null;
  let finalWinner = null;
  let finalCandidateAssets = [];
  let finalGenerationId = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    const isRetry = attempt > 1;
    const createdAt = new Date();

    try {
      const generation = await Generation.create({
        userId: job.userId,
        trainingId: training._id,
        modelVersion: training.modelVersion,
        prompt: generationPrompt,
        generationConfig: {
          model: 'standard',
          goFast: Boolean(generationInput.go_fast),
          loraScale: generationInput.lora_scale,
          megapixels: generationInput.megapixels,
          numOutputs: generationInput.num_outputs,
          aspectRatio: generationInput.aspect_ratio || '1:1',
          outputFormat: generationInput.output_format,
          guidanceScale: generationInput.guidance_scale,
          outputQuality: generationInput.output_quality,
          promptStrength: generationInput.prompt_strength || 0.8,
          extraLoraScale: generationInput.extra_lora_scale,
          numInferenceSteps: generationInput.num_inference_steps,
          pageOrder: page.order,
        },
        status: 'queued',
        progress: 0,
        attempts: 0,
        replicateInput: generationInput,
        storybookContext: {
          jobId: job._id,
          bookId: job.bookId,
          pageId: page.pageId,
          pageOrder: page.order,
          attempt,
          maxAttempts,
        },
        events: [
          {
            type: 'created',
            message: isRetry
              ? `Storybook generation retry queued (attempt ${attempt} of ${maxAttempts})`
              : 'Storybook generation queued',
            metadata: {
              jobId: job._id,
              pageOrder: page.order,
              attempt,
              maxAttempts,
            },
            timestamp: createdAt,
          },
        ],
      });

      const attemptMetadata = {
        generationId: generation._id,
        attempt,
        maxAttempts,
      };

      await updateJobAndEmit({
        jobId: job._id,
        update: {
          $set: {
            'pages.$[page].generationId': generation._id,
            'pages.$[page].status': 'generating',
            'pages.$[page].progress': attempt === 1 ? 5 : Math.min(95, 5 + attempt * 10),
          },
          $push: {
            events: createEvent(
              isRetry ? 'page-generation-retry' : 'page-generation-created',
              isRetry
                ? `Retrying generation for page ${page.order} (attempt ${attempt} of ${maxAttempts})`
                : `Generation created for page ${page.order}`,
              attemptMetadata
            ),
            'pages.$[page].events': createEvent(
              isRetry ? 'generation-retry' : 'generation-created',
              isRetry
                ? `Retrying generation (attempt ${attempt} of ${maxAttempts})`
                : 'Generation created',
              attemptMetadata
            ),
          },
        },
        arrayFilters: [pageFilter],
      });

      await broadcastGeneration(generation._id);

      await dispatchGenerationAttempt({
        generationId: generation._id,
        modelVersion: training.modelVersion,
        input: generationInput,
        reason: isRetry ? `storybook-page-retry-${attempt}` : 'storybook-page',
      });

      await waitForGeneration({
        generationId: generation._id,
        job,
        page,
      });

      const populatedGeneration = await populateForClient(generation._id);
      const winner = deriveWinnerAsset(populatedGeneration);
      const candidateAssets = sanitizeAssetListForSnapshot(
        populatedGeneration?.imageAssets || []
      );

      if (!winner || !winner.asset) {
        throw new Error(`No winning asset found for page ${page.order}`);
      }

      finalGenerationId = generation._id;
      finalWinner = winner;
      finalCandidateAssets = candidateAssets;
      break;
    } catch (error) {
      lastError = error;
      console.warn(
        `[processJobPage] attempt ${attempt} failed for page ${page.order}:`,
        error.message
      );
      const isFinalAttempt = attempt >= maxAttempts;
      await recordGenerationAttemptFailure({
        job,
        page,
        pageFilter,
        attempt,
        maxAttempts,
        error,
        isFinalAttempt,
      });
      if (isFinalAttempt) {
        throw error;
      }
      const backoffDelayMs = baseDelayMs * Math.pow(backoffFactor, attempt - 1);
      await delay(backoffDelayMs);
    }
  }

  if (!finalWinner || !finalWinner.asset) {
    throw lastError || new Error(`No winning asset found for page ${page.order}`);
  }

  const winner = finalWinner;
  const candidateAssets = finalCandidateAssets;
  const generationIdForPage = finalGenerationId;

  const bookCharacterAsset = await copyAssetToBookCharacterSlot({
    book,
    page,
    asset: winner.asset,
  });

  if (!bookCharacterAsset) {
    console.warn(`[processJobPage] Skipping page ${page.order} - asset not available`);
    await updateJobAndEmit({
      jobId: job._id,
      update: {
        $set: {
          'pages.$[page].status': 'skipped',
          'pages.$[page].error': 'Asset file not found in S3',
          'pages.$[page].completedAt': new Date(),
        },
        $push: {
          'pages.$[page].events': createEvent(
            'page-skipped',
            'Page skipped due to missing S3 asset'
          ),
        },
      },
      arrayFilters: [pageFilter],
    });
    return;
  }

  const sanitizedOriginalAsset = sanitizeAssetForSnapshot(winner.asset);

  await updateBookCharacterImage({
    jobId: job._id,
    page,
    newAsset: bookCharacterAsset,
    originalAsset: sanitizedOriginalAsset,
  });

  await updateJobAndEmit({
    jobId: job._id,
    update: {
      $set: {
        'pages.$[page].status': 'completed',
        'pages.$[page].completedAt': new Date(),
        'pages.$[page].characterAsset': bookCharacterAsset,
        'pages.$[page].characterAssetOriginal': sanitizedOriginalAsset,
        'pages.$[page].progress': 100,
        'pages.$[page].candidateAssets': candidateAssets,
        'pages.$[page].generationId': generationIdForPage,
        'pages.$[page].selectedCandidateIndex': winner.winner ? winner.winner - 1 : 0,
        'pages.$[page].error': null,
      },
      $push: {
        'pages.$[page].events': createEvent('page-completed', 'Page generation completed', {
          generationId: generationIdForPage,
          winner: winner.winner,
        }),
      },
    },
    arrayFilters: [pageFilter],
  });
};

const rebuildPdfForJob = async (jobId) => {
  const job = await StorybookJob.findById(jobId);
  if (!job) {
    throw new Error(`Storybook job ${jobId} not found`);
  }

  const book = await Book.findById(job.bookId);
  if (!book) {
    throw new Error('Book not found for storybook automation');
  }

  const reader = job.readerId
    ? await User.findById(job.readerId).select('name gender secondTitle')
    : null;
  const readerName = job.readerName || reader?.name || '';
  const readerGender = job.readerGender || reader?.gender || '';
  const readerSecondTitle = job.readerSecondTitle || reader?.secondTitle || '';

  const refreshedJob = await StorybookJob.findById(jobId).lean();
  const refreshedBook = await Book.findById(job.bookId).lean();

  const storyPages = (refreshedBook.pages || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((bookPage) => {
      const jobPage =
        refreshedJob.pages.find(
          (entry) =>
            entry.pageType === 'story' &&
            entry.pageId &&
            entry.pageId.toString() === bookPage._id.toString()
        ) || {};
      return {
        bookPage,
        jobPage,
        isSkipped: jobPage?.status === 'skipped',
      };
    })
    .filter(({ isSkipped }) => !isSkipped)
    .map(({ bookPage, jobPage }) =>
      preparePageStoryContent({
        bookPage,
        jobPage,
        readerName,
        readerGender,
      })
    );

  const frontMatterPages = [];

  const coverJobPage = refreshedJob.pages.find((page) => page.pageType === 'cover');
  const coverContent = buildCoverPageContent({
    book: refreshedBook,
    readerName,
    readerGender,
    storyPages,
    jobPage: coverJobPage,
  });
  if (coverContent) {
    frontMatterPages.push(coverContent);
  }

  const dedicationJobPage = refreshedJob.pages.find((page) => page.pageType === 'dedication');
  const dedicationContent = buildDedicationPageContent({
    book: refreshedBook,
    readerName,
    readerGender,
    readerSecondTitle,
    storyPages,
    jobPage: dedicationJobPage,
  });
  if (dedicationContent) {
    frontMatterPages.push(dedicationContent);
  }

  const pdfPages = [...frontMatterPages, ...storyPages];

  if (!pdfPages.length) {
    throw new Error('No valid pages to generate PDF - all pages were skipped or failed');
  }

  const pdfAsset = await buildPdfAsset({
    book: refreshedBook,
    job,
    pages: pdfPages,
  });

  await updateJobAndEmit({
    jobId: job._id,
    update: {
      $set: {
        pdfAsset,
        completedAt: new Date(),
        metadata: { ...(job.metadata || {}), assemblyProgress: 10 },
      },
      $push: {
        events: createEvent('job-pdf-updated', 'Storybook PDF rebuilt after candidate selection', {
          pdfKey: pdfAsset.key,
        }),
      },
    },
  });

  return pdfAsset;
};

const processStorybookJob = async (jobId) => {
  const job = await StorybookJob.findById(jobId);
  if (!job) {
    throw new Error(`Storybook job ${jobId} not found`);
  }

  if (!job.startedAt) {
    job.startedAt = new Date();
    await job.save();
  }

  const book = await Book.findById(job.bookId);
  if (!book) {
    throw new Error('Book not found for storybook automation');
  }

  const training = await Training.findById(job.trainingId);
  if (!training || training.status !== 'succeeded' || !training.modelVersion) {
    throw new Error('Training must be successful with a model version');
  }

  const reader = job.readerId ? await User.findById(job.readerId).select('name gender secondTitle') : null;
  const readerName = job.readerName || reader?.name || '';
  const readerGender = job.readerGender || reader?.gender || '';
  const readerSecondTitle = job.readerSecondTitle || reader?.secondTitle || '';

  await updateJobAndEmit({
    jobId: job._id,
    update: {
      $set: {
        status: 'generating',
      },
      $push: {
        events: createEvent('job-started', 'Storybook automation started'),
      },
    },
  });

  const errors = [];
  let cursor = 0;

  const runWorker = async () => {
    while (cursor < job.pages.length) {
      const index = cursor;
      cursor += 1;
      const page = job.pages[index];
      try {
        await processJobPage({
          job,
          page,
          book,
          training,
          readerName,
          readerGender,
        });
      } catch (error) {
        errors.push({ page, error });
        return;
      }
    }
  };

  const workerCount = Math.min(PAGE_CONCURRENCY, job.pages.length);
  const workers = Array.from({ length: workerCount }, () => runWorker());
  await Promise.all(workers);

  if (errors.length) {
    const failure = errors[0];
    await updateJobAndEmit({
      jobId: job._id,
      update: {
        $set: {
          status: 'failed',
          error: failure.error.message,
          completedAt: new Date(),
        },
        $push: {
          events: createEvent('job-failed', failure.error.message, {
            pageOrder: failure.page?.order,
          }),
        },
      },
    });
    throw failure.error;
  }

  await updateJobAndEmit({
    jobId: job._id,
    update: {
      $set: {
        status: 'assembling',
        metadata: { assemblyProgress: 0 },
      },
      $push: {
        events: createEvent('job-assembling', 'Generating final PDF'),
      },
    },
  });

  const refreshedJob = await StorybookJob.findById(job._id);
  const refreshedBook = await Book.findById(job.bookId);

  const storyPages = refreshedBook.pages
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((bookPage) => {
      const jobPage =
        refreshedJob.pages.find(
          (entry) =>
            entry.pageType === 'story' &&
            entry.pageId &&
            entry.pageId.toString() === bookPage._id.toString()
        ) || {};
      return {
        bookPage,
        jobPage,
        isSkipped: jobPage?.status === 'skipped',
      };
    })
    .filter(({ isSkipped }) => {
      if (isSkipped) {
        console.log('[storybook] Skipping page in PDF assembly due to skipped status');
      }
      return !isSkipped;
    })
    .map(({ bookPage, jobPage }) =>
      preparePageStoryContent({
        bookPage,
        jobPage,
        readerName,
        readerGender,
      })
    );

  const frontMatterPages = [];

  // Find job page for cover
  const coverJobPage = refreshedJob.pages.find((page) => page.pageType === 'cover');
  const coverContent = buildCoverPageContent({
    book: refreshedBook,
    readerName,
    readerGender,
    storyPages,
    jobPage: coverJobPage,
  });
  if (coverContent) {
    frontMatterPages.push(coverContent);
  }

  // Find job page for dedication
  const dedicationJobPage = refreshedJob.pages.find((page) => page.pageType === 'dedication');
  const dedicationContent = buildDedicationPageContent({
    book: refreshedBook,
    readerName,
    readerGender,
    readerSecondTitle,
    storyPages,
    jobPage: dedicationJobPage,
  });
  if (dedicationContent) {
    frontMatterPages.push(dedicationContent);
  }

  const pdfPages = [...frontMatterPages, ...storyPages];

  if (pdfPages.length === 0) {
    throw new Error('No valid pages to generate PDF - all pages were skipped or failed');
  }

  const pdfAsset = await buildPdfAsset({
    book: refreshedBook,
    job: refreshedJob,
    pages: pdfPages,
  });

  await updateJobAndEmit({
    jobId: job._id,
    update: {
      $set: {
        status: 'succeeded',
        pdfAsset,
        completedAt: new Date(),
        metadata: { assemblyProgress: 10 },
      },
      $push: {
        events: createEvent('job-completed', 'Storybook automation completed successfully', {
          pdfKey: pdfAsset.key,
        }),
      },
    },
  });
};

const formatBookPagesForJob = (book, { readerGender = '' } = {}) => {
  const jobPages = [];
  const cover = book.coverPage || {};
  const dedication = book.dedicationPage || {};

  let nextOrder = 1;

  const coverPrompt = resolvePromptByGender(cover, readerGender);
  const hasCoverFrontMatter = Boolean(cover.backgroundImage) || Boolean(coverPrompt?.trim());
  if (hasCoverFrontMatter) {
    jobPages.push({
      pageId: null,
      order: nextOrder,
      prompt: coverPrompt,
      text: '',
      pageType: 'cover',
      status: 'queued',
      progress: 0,
      events: [createEvent('page-queued', 'Cover page queued for generation')],
    });
    nextOrder += 1;
  }

  const dedicationPrompt = resolvePromptByGender(dedication, readerGender);
  const hasDedicationFrontMatter =
    Boolean(dedication.backgroundImage) || Boolean(dedicationPrompt?.trim());
  if (hasDedicationFrontMatter) {
    jobPages.push({
      pageId: null,
      order: nextOrder,
      prompt: dedicationPrompt,
      text: '',
      pageType: 'dedication',
      status: 'queued',
      progress: 0,
      events: [createEvent('page-queued', 'Dedication page queued for generation')],
    });
    nextOrder += 1;
  }

  const storyPages = (book.pages || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((page) => {
      const order = nextOrder;
      nextOrder += 1;
      const prompt = resolvePromptByGender(page, readerGender);
      const hasPrompt = Boolean(prompt && prompt.trim());
      const hasText = Boolean(page.text && page.text.trim());
      const hasBackgroundImage = Boolean(page.backgroundImage);
      const isValid = hasPrompt || hasText || hasBackgroundImage;

      if (!isValid) {
        console.warn(
          `[storybook] Skipping page ${page.order} - no content. prompt: ${hasPrompt}, text: ${hasText}, backgroundImage: ${hasBackgroundImage}`
        );
        return null;
      }

      console.log(
        `[storybook] Including page ${page.order} as story order ${order} - prompt: ${hasPrompt}, text: ${hasText}, backgroundImage: ${hasBackgroundImage}`
      );

      return {
        pageId: page._id,
        order,
        prompt,
        text: page.text || '',
        backgroundImage: page.backgroundImage,
        pageType: 'story',
        characterPosition: normalizeCharacterPosition(page.characterPosition, null),
        status: 'queued',
        progress: 0,
        events: [createEvent('page-queued', 'Page queued for generation')],
      };
    })
    .filter(Boolean);

  return [...jobPages, ...storyPages];
};

const startStorybookAutomation = async ({
  bookId,
  trainingId,
  userId,
  readerId,
  readerName,
  readerGender,
  readerSecondTitle,
  title,
}) => {
  const book = await Book.findById(bookId);
  if (!book) {
    throw new Error('Book not found');
  }

  if (!Array.isArray(book.pages) || !book.pages.length) {
    throw new Error('Book has no pages to generate');
  }

  const training = await Training.findById(trainingId);
  if (!training) {
    throw new Error('Training not found');
  }

  if (training.status !== 'succeeded' || !training.modelVersion) {
    throw new Error('Training must be completed successfully before generating images');
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new Error('User (reader) not found for generation');
  }

  const resolvedReaderId = readerId || userId;
  let resolvedReaderName = readerName || user.name || '';
  let resolvedReaderGender = normalizeGenderValue(readerGender) || normalizeGenderValue(user.gender);
  let resolvedReaderSecondTitle = readerSecondTitle || user.secondTitle || '';

  if (resolvedReaderId) {
    const readerDoc = await User.findById(resolvedReaderId).select('name gender secondTitle');
    if (readerDoc) {
      if (!resolvedReaderName && readerDoc.name) {
        resolvedReaderName = readerDoc.name;
      }
      if (!resolvedReaderGender && readerDoc.gender) {
        resolvedReaderGender = normalizeGenderValue(readerDoc.gender);
      }
      if (!resolvedReaderSecondTitle && readerDoc.secondTitle) {
        resolvedReaderSecondTitle = readerDoc.secondTitle;
      }
    }
  }

  const jobPages = formatBookPagesForJob(book, {
    readerGender: resolvedReaderGender,
  });
  if (!jobPages || jobPages.length === 0) {
    throw new Error('No valid pages to generate. All pages are missing content. Please add character prompts, page text, or background images to at least one page.');
  }

  const job = await StorybookJob.create({
    bookId,
    trainingId,
    userId,
    readerId: resolvedReaderId,
    readerName: resolvedReaderName,
    readerGender: resolvedReaderGender,
    readerSecondTitle: resolvedReaderSecondTitle,
    title: title || `${book.name} Storybook`,
    status: 'queued',
    progress: 0,
    pages: jobPages,
    events: [createEvent('job-queued', 'Storybook automation queued')],
  });

  process.nextTick(() => {
    processStorybookJob(job._id).catch((error) => {
      console.error(`[storybook] job ${job._id} failed:`, error);
    });
  });

  const jobDoc = await StorybookJob.findById(job._id);
  const snapshot = await syncComputedFields(jobDoc);
  emitStorybookUpdate(snapshot);
  return snapshot;
};

const getStorybookJobById = async (jobId) => {
  const job = await StorybookJob.findById(jobId);
  if (!job) return null;
  return emitJob(job);
};

const listStorybookJobsForBook = async (bookId, limit = 10, options = {}) => {
  const { minimal = false } = options;
  const jobs = await StorybookJob.find({ bookId })
    .sort({ createdAt: -1 })
    .limit(limit);
  return jobs.map((job) => {
    const snapshot = job.toObject({ depopulate: true });
    snapshot.progress = computeJobProgress(snapshot);
    snapshot.estimatedSecondsRemaining = computeEtaSeconds(snapshot, snapshot.progress);

    // In minimal mode, exclude large arrays to reduce payload size
    if (minimal) {
      const pageCount = Array.isArray(snapshot.pages) ? snapshot.pages.length : 0;
      delete snapshot.pages;
      delete snapshot.events;
      delete snapshot.logs;
      snapshot.pageCount = pageCount;

      // Also strip pages array from pdfAsset if present
      if (snapshot.pdfAsset && Array.isArray(snapshot.pdfAsset.pages)) {
        const assetPageCount = snapshot.pdfAsset.pages.length;
        delete snapshot.pdfAsset.pages;
        if (!snapshot.pdfAsset.pageCount) {
          snapshot.pdfAsset.pageCount = assetPageCount;
        }
      }
    }

    return snapshot;
  });
};

module.exports = {
  startStorybookAutomation,
  getStorybookJobById,
  listStorybookJobsForBook,
  buildCoverPageContent,
  buildDedicationPageContent,
  rebuildPdfForJob,
};
