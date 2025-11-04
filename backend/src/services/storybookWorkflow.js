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
  if (!gender) return { subject: '', possessive: '', object: '' };
  const lowerGender = gender.toLowerCase();
  if (lowerGender === 'male') {
    return { subject: 'He', possessive: 'His', object: 'Him' };
  }
  if (lowerGender === 'female') {
    return { subject: 'She', possessive: 'Hers', object: 'Her' };
  }
  return { subject: 'They', possessive: 'Their', object: 'Them' };
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
    result = result.replace(/\{gender\}/gi, pronouns.subject);
    result = result.replace(/\{genderpos\}/gi, pronouns.possessive);
    result = result.replace(/\{genderper\}/gi, pronouns.object);
  }

  return result;
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
    characterImage: sanitizeAssetForSnapshot(cloned.characterImage),
    characterImageOriginal: sanitizeAssetForSnapshot(cloned.characterImageOriginal),
    qrCode: sanitizeAssetForSnapshot(cloned.qrCode),
    characterPrompt: normalizePromptText(cloned.characterPrompt),
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
    kidImage: sanitizeAssetForSnapshot(cloned.kidImage),
    generatedImage: sanitizeAssetForSnapshot(cloned.generatedImage),
    generatedImageOriginal: sanitizeAssetForSnapshot(cloned.generatedImageOriginal),
    title: safeText(cloned.title),
    secondTitle: safeText(cloned.secondTitle),
    characterPrompt: normalizePromptText(cloned.characterPrompt),
    characterPromptMale: normalizePromptText(cloned.characterPromptMale),
    characterPromptFemale: normalizePromptText(cloned.characterPromptFemale),
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
  } else if (payload.ranking && payload.ranking.winners && payload.ranking.winners.length) {
    status = 'completed';
  } else if (
    Array.isArray(payload.events) &&
    payload.events.some((event) => event?.type === 'ranking')
  ) {
    status = 'ranking';
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

const updateBookCharacterImage = async ({ bookId, page, newAsset, originalAsset = null }) => {
  if (page.pageType === 'cover') {
    await Book.updateOne(
      { _id: bookId },
      {
        $set: {
          'coverPage.characterImage': newAsset,
          'coverPage.characterImageOriginal': originalAsset,
        },
      }
    );
    return;
  }

  if (page.pageType === 'dedication') {
    const updatePayload = {
      'dedicationPage.generatedImage': newAsset,
      'dedicationPage.kidImage': newAsset,
    };
    if (originalAsset) {
      updatePayload['dedicationPage.generatedImageOriginal'] = originalAsset;
    }
    await Book.updateOne(
      { _id: bookId },
      {
        $set: updatePayload,
      }
    );
    return;
  }

  const hasPageId = Boolean(page.pageId);
  const arrayFilters = [];

  if (hasPageId) {
    const objectId =
      typeof page.pageId === 'string' ? new mongoose.Types.ObjectId(page.pageId) : page.pageId;
    arrayFilters.push({ 'page._id': objectId });
  } else {
    arrayFilters.push({ 'page.order': page.order });
  }

  console.log('[updateBookCharacterImage] Saving to DB - newAsset.backgroundRemoved:', newAsset?.backgroundRemoved, 'pageOrder:', page.order);
  await Book.updateOne(
    { _id: bookId },
    {
      $set: {
        'pages.$[page].characterImage': newAsset,
        'pages.$[page].characterImageOriginal': originalAsset,
      },
    },
    {
      arrayFilters,
    }
  );
  console.log('[updateBookCharacterImage] Saved to DB successfully');
};

const buildCoverPageContent = ({
  book,
  readerName,
  readerGender,
  storyPages = [],
  jobPage = null,
}) => {
  const coverPage = sanitizeCoverPageForSnapshot(book.coverPage) || {};

  const firstStoryBackground = storyPages.find((page) =>
    Boolean(page?.background && (page.background.key || page.background.url))
  );
  const firstStoryCharacter = storyPages.find((page) =>
    Boolean(page?.character && (page.character.key || page.character.url))
  );

  if (!coverPage.backgroundImage && firstStoryBackground?.background) {
    coverPage.backgroundImage = sanitizeAssetForSnapshot(firstStoryBackground.background);
  }
  if (!coverPage.characterImage && firstStoryCharacter?.character) {
    coverPage.characterImage = sanitizeAssetForSnapshot(firstStoryCharacter.character);
  }

  if (!coverPage.backgroundImage) {
    return null;
  }

  coverPage.characterImage = coverPage.characterImage || null;
  coverPage.characterImageOriginal = coverPage.characterImageOriginal || coverPage.characterImage || null;
  const coverPrompt = resolvePromptByGender(coverPage, readerGender);
  coverPage.characterPrompt = coverPrompt;

  return {
    order: 0,
    text: '',
    quote: '',
    background: coverPage.backgroundImage,
    character: coverPage.characterImage || null,
    characterOriginal: coverPage.characterImage || null,
    generationId: jobPage?.generationId || null,
    candidateAssets: sanitizeAssetListForSnapshot(jobPage?.candidateAssets || []),
    selectedCandidateIndex: Number.isFinite(jobPage?.selectedCandidateIndex)
      ? jobPage.selectedCandidateIndex
      : null,
    rankingSummary: jobPage?.rankingSummary || '',
    rankingNotes: Array.isArray(jobPage?.rankingNotes) ? jobPage.rankingNotes : [],
    pageType: 'cover',
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
  storyPages = [],
  jobPage = null,
}) => {
  const dedicationPage = sanitizeDedicationForSnapshot(book.dedicationPage) || {};

  const firstStoryBackground = storyPages.find((page) =>
    Boolean(page?.background && (page.background.key || page.background.url))
  );
  const firstStoryCharacterOriginal = storyPages.find((page) =>
    Boolean(page?.characterOriginal && (page.characterOriginal.key || page.characterOriginal.url))
  );
  const firstStoryCharacter = storyPages.find((page) =>
    Boolean(page?.character && (page.character.key || page.character.url))
  );

  if (!dedicationPage.backgroundImage && firstStoryBackground?.background) {
    dedicationPage.backgroundImage = sanitizeAssetForSnapshot(firstStoryBackground.background);
  }
  if (!dedicationPage.kidImage) {
    const fallbackKid =
      (firstStoryCharacterOriginal && firstStoryCharacterOriginal.characterOriginal) ||
      (firstStoryCharacter && firstStoryCharacter.character) ||
      null;
    dedicationPage.kidImage = fallbackKid ? sanitizeAssetForSnapshot(fallbackKid) : null;
  }

  if (!dedicationPage.backgroundImage) {
    return null;
  }

  dedicationPage.kidImage = dedicationPage.kidImage || null;
  dedicationPage.generatedImage = dedicationPage.generatedImage || dedicationPage.kidImage || null;
  dedicationPage.generatedImageOriginal =
    dedicationPage.generatedImageOriginal || dedicationPage.generatedImage || null;
  const dedicationPrompt = resolvePromptByGender(dedicationPage, readerGender);
  dedicationPage.characterPrompt = dedicationPrompt;

  return {
    order: 0.5,
    text: '',
    quote: '',
    background: dedicationPage.backgroundImage,
    character: dedicationPage.kidImage || null,
    characterOriginal: dedicationPage.kidImage || null,
    generationId: jobPage?.generationId || null,
    candidateAssets: sanitizeAssetListForSnapshot(jobPage?.candidateAssets || []),
    selectedCandidateIndex: Number.isFinite(jobPage?.selectedCandidateIndex)
      ? jobPage.selectedCandidateIndex
      : null,
    rankingSummary: jobPage?.rankingSummary || '',
    rankingNotes: Array.isArray(jobPage?.rankingNotes) ? jobPage.rankingNotes : [],
    pageType: 'dedication',
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

  return {
    order: bookPage.order,
    text: resolvedText,
    prompt: resolvedPrompt,
    background: bookPage.backgroundImage || null,
    character: jobPage.characterAsset || bookPage.characterImage || null,
    characterOriginal:
      jobPage.characterAssetOriginal || bookPage.characterImageOriginal || null,
    quote: '',
    characterPosition: 'auto',
    generationId: jobPage?.generationId || null,
    candidateAssets: sanitizeAssetListForSnapshot(jobPage?.candidateAssets || []),
    selectedCandidateIndex: Number.isFinite(jobPage?.selectedCandidateIndex)
      ? jobPage.selectedCandidateIndex
      : null,
    rankingSummary: jobPage.rankingSummary || '',
    rankingNotes: Array.isArray(jobPage.rankingNotes) ? jobPage.rankingNotes : [],
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
      order: page.order,
      text: page.text || '',
      quote: page.quote || '',
      background: sanitizeAssetForSnapshot(page.background),
      character: sanitizeAssetForSnapshot(page.character),
      characterOriginal: sanitizeAssetForSnapshot(page.characterOriginal),
      generationId: page.generationId || null,
      candidateAssets: sanitizeAssetListForSnapshot(page.candidateAssets),
      selectedCandidateIndex: Number.isFinite(page.selectedCandidateIndex)
        ? page.selectedCandidateIndex
        : null,
      rankingSummary: page.rankingSummary || '',
      rankingNotes: Array.isArray(page.rankingNotes) ? page.rankingNotes : [],
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

const normaliseWinnerIndex = (value, total) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;

  if (parsed >= 1 && parsed <= total) {
    return Math.floor(parsed) - 1;
  }

  if (parsed >= 0 && parsed < total) {
    return Math.floor(parsed);
  }

  return null;
};

const deriveWinnerAsset = (generation) => {
  if (!generation) return null;
  const assets = generation.imageAssets || [];
  if (!assets.length) return null;

  const rankedEntries = Array.isArray(generation.ranking?.ranked)
    ? generation.ranking.ranked
    : [];
  const rawWinners = Array.isArray(generation.ranking?.winners)
    ? generation.ranking.winners
    : [];

  const preferredIndexes = rawWinners
    .map((value) => normaliseWinnerIndex(value, assets.length))
    .filter((value) => value !== null);

  let winnerIndex = preferredIndexes.length ? preferredIndexes[0] : null;

  if (winnerIndex === null && rankedEntries.length) {
    const sortedRanked = rankedEntries
      .slice()
      .sort((a, b) => {
        const rankA = Number.isFinite(a.rank) ? a.rank : Number.POSITIVE_INFINITY;
        const rankB = Number.isFinite(b.rank) ? b.rank : Number.POSITIVE_INFINITY;
        if (rankA !== rankB) {
          return rankA - rankB;
        }
        const scoreA = Number.isFinite(a.score) ? a.score : 0;
        const scoreB = Number.isFinite(b.score) ? b.score : 0;
        return scoreB - scoreA;
      });
    const bestRanked = sortedRanked[0];
    winnerIndex =
      bestRanked && bestRanked.imageIndex !== undefined
        ? normaliseWinnerIndex(bestRanked.imageIndex, assets.length)
        : null;
  }

  if (winnerIndex === null) {
    winnerIndex = 0;
  }

  const asset = assets[winnerIndex] || assets[0];
  const winnerNumber = winnerIndex + 1;

  return {
    asset,
    winner: winnerNumber,
    summary: generation.ranking?.summary || '',
    notes: rankedEntries.map((entry) => ({
      imageIndex: entry.imageIndex,
      score: entry.score,
      verdict: entry.verdict,
      notes: entry.notes,
    })),
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
          model: 'ranked',
          mode: 'ranked',
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
              ? `Storybook ranked generation retry queued (attempt ${attempt} of ${maxAttempts})`
              : 'Storybook ranked generation queued',
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
                ? `Retrying ranked generation (attempt ${attempt} of ${maxAttempts})`
                : 'Ranked generation created',
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
    bookId: book._id,
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
        'pages.$[page].rankingWinner': winner.winner,
        'pages.$[page].rankingSummary': winner.summary,
        'pages.$[page].rankingNotes': winner.notes,
        'pages.$[page].progress': 100,
        'pages.$[page].candidateAssets': candidateAssets,
        'pages.$[page].generationId': generationIdForPage,
        'pages.$[page].selectedCandidateIndex': winner.winner,
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

  const reader = job.readerId ? await User.findById(job.readerId).select('name gender') : null;
  const readerName = job.readerName || reader?.name || '';
  const readerGender = job.readerGender || reader?.gender || '';

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
      const jobPage = refreshedJob.pages.find(
        (entry) =>
          (entry.pageId && entry.pageId.toString() === bookPage._id.toString()) ||
          entry.order === bookPage.order
      );
      return {
        bookPage,
        jobPage: jobPage || {},
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

  // Find job page for cover (order 0)
  const coverJobPage = refreshedJob.pages.find((page) => page.pageType === 'cover' || page.order === 0);
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

  // Find job page for dedication (order 0.5)
  const dedicationJobPage = refreshedJob.pages.find((page) => page.pageType === 'dedication' || page.order === 0.5);
  const dedicationContent = buildDedicationPageContent({
    book: refreshedBook,
    readerName,
    readerGender,
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

  const storybookImageUpdates = {};
  if (coverContent?.coverPage?.characterImage) {
    storybookImageUpdates['coverPage.characterImage'] = coverContent.coverPage.characterImage;
  }
  if (!refreshedBook.coverPage?.backgroundImage && coverContent?.coverPage?.backgroundImage) {
    storybookImageUpdates['coverPage.backgroundImage'] = coverContent.coverPage.backgroundImage;
  }
  if (!refreshedBook.coverPage?.qrCode && coverContent?.coverPage?.qrCode) {
    storybookImageUpdates['coverPage.qrCode'] = coverContent.coverPage.qrCode;
  }
  if (dedicationContent?.dedicationPage?.kidImage) {
    storybookImageUpdates['dedicationPage.kidImage'] = dedicationContent.dedicationPage.kidImage;
  }
  if (dedicationContent?.dedicationPage?.generatedImage) {
    storybookImageUpdates['dedicationPage.generatedImage'] =
      dedicationContent.dedicationPage.generatedImage;
  }
  if (
    !refreshedBook.dedicationPage?.backgroundImage &&
    dedicationContent?.dedicationPage?.backgroundImage
  ) {
    storybookImageUpdates['dedicationPage.backgroundImage'] =
      dedicationContent.dedicationPage.backgroundImage;
  }

  const pdfAsset = await buildPdfAsset({
    book: refreshedBook,
    job: refreshedJob,
    pages: pdfPages,
  });

  const bookUpdatePayload = {
    $push: {
      pdfAssets: pdfAsset,
    },
  };
  if (Object.keys(storybookImageUpdates).length) {
    bookUpdatePayload.$set = storybookImageUpdates;
  }

  await Book.findByIdAndUpdate(book._id, bookUpdatePayload);

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

  const coverPrompt = resolvePromptByGender(cover, readerGender);
  const hasCoverFrontMatter = Boolean(cover.backgroundImage) || Boolean(coverPrompt?.trim());
  if (hasCoverFrontMatter) {
    jobPages.push({
      pageId: null,
      order: 0,
      prompt: coverPrompt,
      text: '',
      pageType: 'cover',
      status: 'queued',
      progress: 0,
      events: [createEvent('page-queued', 'Cover page queued for generation')],
    });
  }

  const dedicationPrompt = resolvePromptByGender(dedication, readerGender);
  const hasDedicationFrontMatter =
    Boolean(dedication.backgroundImage) || Boolean(dedicationPrompt?.trim());
  if (hasDedicationFrontMatter) {
    jobPages.push({
      pageId: null,
      order: hasCoverFrontMatter ? 0.5 : 0,
      prompt: dedicationPrompt,
      text: '',
      pageType: 'dedication',
      status: 'queued',
      progress: 0,
      events: [createEvent('page-queued', 'Dedication page queued for generation')],
    });
  }

  const storyPages = (book.pages || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((page) => ({
      pageId: page._id,
      order: page.order,
      prompt: resolvePromptByGender(page, readerGender),
      text: page.text || '',
      backgroundImage: page.backgroundImage,
      pageType: page.pageType === 'cover' ? 'cover' : 'story',
      status: 'queued',
      progress: 0,
      events: [createEvent('page-queued', 'Page queued for generation')],
    }))
    .filter((page) => {
      const hasPrompt = Boolean(page.prompt && page.prompt.trim());
      const hasText = Boolean(page.text && page.text.trim());
      const hasBackgroundImage = Boolean(page.backgroundImage);
      const isValid = hasPrompt || hasText || hasBackgroundImage;

      if (!isValid) {
        console.warn(`[storybook] Skipping page ${page.order} - no content. prompt: ${hasPrompt}, text: ${hasText}, backgroundImage: ${hasBackgroundImage}`);
      } else {
        console.log(`[storybook] Including page ${page.order} - prompt: ${hasPrompt}, text: ${hasText}, backgroundImage: ${hasBackgroundImage}`);
      }
      return isValid;
    });

  return [...jobPages, ...storyPages];
};

const startStorybookAutomation = async ({
  bookId,
  trainingId,
  userId,
  readerId,
  readerName,
  readerGender,
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

  if (resolvedReaderId) {
    const readerDoc = await User.findById(resolvedReaderId).select('name gender');
    if (readerDoc) {
      if (!resolvedReaderName && readerDoc.name) {
        resolvedReaderName = readerDoc.name;
      }
      if (!resolvedReaderGender && readerDoc.gender) {
        resolvedReaderGender = normalizeGenderValue(readerDoc.gender);
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

const listStorybookJobsForBook = async (bookId, limit = 10) => {
  const jobs = await StorybookJob.find({ bookId })
    .sort({ createdAt: -1 })
    .limit(limit);
  return jobs.map((job) => {
    const snapshot = job.toObject({ depopulate: true });
    snapshot.progress = computeJobProgress(snapshot);
    snapshot.estimatedSecondsRemaining = computeEtaSeconds(snapshot, snapshot.progress);
    return snapshot;
  });
};

const regenerateStorybookPage = async ({
  bookId,
  assetId = null,
  pageOrder,
  trainingId,
  userId,
  readerId,
  readerName,
  readerGender,
}) => {
  if (!bookId) {
    throw new Error('Book ID is required for regeneration');
  }
  if (!trainingId) {
    throw new Error('Training ID is required to regenerate a page');
  }
  if (!userId) {
    throw new Error('User context is required to regenerate a page');
  }

  const book = await Book.findById(bookId);
  if (!book) {
    throw new Error('Book not found');
  }

  const normalisedToken =
    typeof pageOrder === 'string' ? pageOrder.trim().toLowerCase() : '';
  const numericOrder = Number(pageOrder);
  const isNumericOrder = Number.isFinite(numericOrder);
  const approxEq = (value, target) => Math.abs(value - target) < 1e-3;

  let targetPage = null;
  let targetOrder = null;
  let pageType = 'story';

  if (normalisedToken === 'cover' || (isNumericOrder && approxEq(numericOrder, 0))) {
    pageType = 'cover';
    targetOrder = 0;
  } else if (
    normalisedToken === 'dedication' ||
    (isNumericOrder && approxEq(numericOrder, 0.5))
  ) {
    pageType = 'dedication';
    targetOrder = 0.5;
  } else {
    if (isNumericOrder && numericOrder > 0) {
      targetPage = book.pages.find((page) => page.order === numericOrder) || null;
      if (targetPage) {
        targetOrder = numericOrder;
      }
    }
    if (!targetPage && mongoose.Types.ObjectId.isValid(pageOrder)) {
      const pageDoc = book.pages.id(pageOrder);
      if (pageDoc) {
        targetPage = pageDoc;
        targetOrder = pageDoc.order;
      }
    }
    if (!targetPage) {
      throw new Error('Requested page was not found in this book');
    }
    if (!targetOrder) {
      targetOrder = targetPage.order;
    }
    pageType = targetPage.pageType === 'cover' ? 'cover' : 'story';
  }

  if (pageType === 'cover' && !book.coverPage) {
    throw new Error('Cover page is not configured for this book');
  }
  if (pageType === 'dedication' && !book.dedicationPage) {
    throw new Error('Dedication page is not configured for this book');
  }

  const training = await Training.findById(trainingId);
  if (!training) {
    throw new Error('Training not found for regeneration');
  }
  if (training.status !== 'succeeded' || !training.modelVersion) {
    throw new Error('Training must be completed successfully before regenerating a page');
  }

  const resolvedReaderId = readerId || null;
  let resolvedReaderName = readerName || '';
  let resolvedReaderGender = readerGender || '';
  if ((!resolvedReaderName || !resolvedReaderGender) && resolvedReaderId) {
    const readerDoc = await User.findById(resolvedReaderId).select('name gender').lean();
    if (readerDoc?.name && !resolvedReaderName) {
      resolvedReaderName = readerDoc.name;
    }
    if (readerDoc?.gender && !resolvedReaderGender) {
      resolvedReaderGender = readerDoc.gender;
    }
  }

  const safeTextValue = (value) => (typeof value === 'string' ? value : '');

  let promptSource = '';
  let fallbackText = '';

  if (targetPage) {
    promptSource = resolvePromptByGender(targetPage, resolvedReaderGender);
    fallbackText = safeTextValue(targetPage.text);
  } else if (pageType === 'cover') {
    const coverCfg = book.coverPage || {};
    promptSource = resolvePromptByGender(coverCfg, resolvedReaderGender);
    if (!promptSource) {
      fallbackText = safeTextValue(coverCfg.leftSide?.content);
    }
  } else if (pageType === 'dedication') {
    const dedicationCfg = book.dedicationPage || {};
    promptSource = resolvePromptByGender(dedicationCfg, resolvedReaderGender);
    if (!promptSource) {
      fallbackText =
        safeTextValue(dedicationCfg.title) || safeTextValue(dedicationCfg.secondTitle);
    }
  }

  const rawPrompt = promptSource || fallbackText;
  if (!rawPrompt) {
    throw new Error('Unable to determine a character prompt for this page');
  }

  const generationPrompt = replaceReaderPlaceholders(rawPrompt, resolvedReaderName, resolvedReaderGender);

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
    pageOrder: targetOrder,
  };

  const createdAt = new Date();
  const generation = await Generation.create({
    userId,
    trainingId: training._id,
    modelVersion: training.modelVersion,
    prompt: generationPrompt,
    generationConfig: {
      model: 'ranked',
      mode: 'ranked',
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
      pageOrder: targetOrder,
      pageType,
    },
    status: 'queued',
    progress: 0,
    attempts: 0,
    replicateInput: generationInput,
    storybookContext: {
      bookId,
      pageId: targetPage?._id || null,
      pageOrder: targetOrder,
      pageType,
      runType: 'storybook-regenerate',
    },
    events: [
      {
        type: 'created',
        message: 'Storybook page regeneration queued',
        metadata: {
          bookId,
          pageOrder: targetOrder,
        },
        timestamp: createdAt,
      },
    ],
  });

  await broadcastGeneration(generation._id);

  const generationPromise = waitForStandaloneGeneration(generation._id);

  try {
    await dispatchGenerationAttempt({
      generationId: generation._id,
      modelVersion: training.modelVersion,
      input: generationInput,
      reason: 'storybook-page-regenerate',
    });
  } catch (error) {
    await Generation.findByIdAndUpdate(generation._id, {
      status: 'failed',
      error: error.message,
      completedAt: new Date(),
    });
    throw error;
  }

  await generationPromise.catch(async (error) => {
    await Generation.findByIdAndUpdate(generation._id, {
      status: 'failed',
      error: error.message,
      completedAt: new Date(),
    });
    throw error;
  });

  const populatedGeneration = await populateForClient(generation._id);
  const winner = deriveWinnerAsset(populatedGeneration);
  if (!winner || !winner.asset) {
    throw new Error('No winning asset found for regenerated page');
  }

  const pageContext = {
    pageId: targetPage?._id || null,
    order: targetOrder,
    pageType,
  };

  const bookCharacterAsset = await copyAssetToBookCharacterSlot({
    book,
    page: pageContext,
    asset: winner.asset,
  });

  if (!bookCharacterAsset) {
    throw new Error(`Cannot regenerate page ${targetOrder} - generated asset file not found in S3 (key: ${winner.asset.key})`);
  }

  const sanitizedOriginalAsset = sanitizeAssetForSnapshot(winner.asset);
  const candidateAssetsSnapshot = sanitizeAssetListForSnapshot(
    populatedGeneration?.imageAssets || []
  );

  await updateBookCharacterImage({
    bookId,
    page: pageContext,
    newAsset: bookCharacterAsset,
    originalAsset: sanitizedOriginalAsset,
  });

  const timestamp = new Date();
  if (assetId) {
    const sanitizedCharacter = sanitizeAssetForSnapshot(bookCharacterAsset);
    const assetFilter = mongoose.Types.ObjectId.isValid(assetId)
      ? { 'asset._id': new mongoose.Types.ObjectId(assetId) }
      : { 'asset.key': assetId };
    await Book.updateOne(
      { _id: bookId },
      {
        $set: {
          'pdfAssets.$[asset].pages.$[page].character': sanitizedCharacter,
          'pdfAssets.$[asset].pages.$[page].characterOriginal': sanitizedOriginalAsset,
          'pdfAssets.$[asset].pages.$[page].rankingSummary': winner.summary || '',
          'pdfAssets.$[asset].pages.$[page].rankingNotes': winner.notes || [],
          'pdfAssets.$[asset].pages.$[page].candidateAssets': candidateAssetsSnapshot,
          'pdfAssets.$[asset].pages.$[page].generationId': generation._id,
          'pdfAssets.$[asset].pages.$[page].selectedCandidateIndex': winner.winner,
          'pdfAssets.$[asset].pages.$[page].updatedAt': timestamp,
          'pdfAssets.$[asset].updatedAt': timestamp,
        },
      },
      {
        arrayFilters: [assetFilter, { 'page.order': targetOrder }],
      }
    ).catch((error) => {
      console.warn(
        `[storybook] failed to update PDF asset snapshot for regeneration:`,
        error.message
      );
    });
  }

  const refreshedBook = await Book.findById(bookId);
  const refreshedPage =
    targetPage && refreshedBook
      ? refreshedBook.pages.id(targetPage._id) ||
        refreshedBook.pages.find((page) => page.order === targetOrder) ||
        null
      : null;

  let refreshedPdfAssetPage = null;
  if (assetId && refreshedBook) {
    const candidateAsset =
      (mongoose.Types.ObjectId.isValid(assetId) && refreshedBook.pdfAssets.id(assetId)) ||
      refreshedBook.pdfAssets.find((asset) => asset.key === assetId);
    if (candidateAsset && Array.isArray(candidateAsset.pages)) {
      refreshedPdfAssetPage =
        candidateAsset.pages.find((page) => page.order === targetOrder) || null;
    }
  }

  let refreshedCoverPage = null;
  let refreshedDedicationPage = null;
  if (pageType === 'cover') {
    refreshedCoverPage = sanitizeCoverPageForSnapshot(refreshedBook.coverPage);
  } else if (pageType === 'dedication') {
    refreshedDedicationPage = sanitizeDedicationForSnapshot(refreshedBook.dedicationPage);
  }

  return {
    page: refreshedPage ? refreshedPage.toObject({ depopulate: true }) : null,
    pdfAssetPage: refreshedPdfAssetPage
      ? refreshedPdfAssetPage.toObject
        ? refreshedPdfAssetPage.toObject({ depopulate: true })
        : refreshedPdfAssetPage
      : null,
    characterAsset: bookCharacterAsset,
    winner,
    generation: populatedGeneration ? populatedGeneration.toObject({ depopulate: true }) : null,
    coverPage: refreshedCoverPage,
    dedicationPage: refreshedDedicationPage,
    pageType,
    order: targetOrder,
  };
};

const applyStorybookCandidateSelection = async ({
  bookId,
  assetId,
  pageOrder,
  candidateIndex,
}) => {
  if (!bookId) {
    throw new Error('Book ID is required');
  }
  if (!assetId) {
    throw new Error('Storybook asset identifier is required');
  }

  const parsedIndex = Number(candidateIndex);
  if (!Number.isFinite(parsedIndex) || parsedIndex < 1) {
    throw new Error('Candidate index must be a positive number');
  }

  const book = await Book.findById(bookId);
  if (!book) {
    throw new Error('Book not found');
  }

  const pdfAsset =
    (mongoose.Types.ObjectId.isValid(assetId) && book.pdfAssets.id(assetId)) ||
    book.pdfAssets.find((asset) => asset.key === assetId);

  if (!pdfAsset) {
    throw new Error('Storybook asset not found');
  }

  const normalisedToken =
    typeof pageOrder === 'string' ? pageOrder.trim().toLowerCase() : '';
  const numericOrder = Number(pageOrder);
  const isNumericOrder = Number.isFinite(numericOrder);
  const approxEq = (value, target) => Math.abs(value - target) < 1e-3;

  let pageType = 'story';
  let targetOrder = null;
  let bookPage = null;

  if (normalisedToken === 'cover' || (isNumericOrder && approxEq(numericOrder, 0))) {
    pageType = 'cover';
    targetOrder = 0;
  } else if (
    normalisedToken === 'dedication' ||
    (isNumericOrder && approxEq(numericOrder, 0.5))
  ) {
    pageType = 'dedication';
    targetOrder = 0.5;
  } else {
    if (isNumericOrder && numericOrder > 0) {
      bookPage = book.pages.find((page) => page.order === numericOrder) || null;
      if (bookPage) {
        targetOrder = numericOrder;
      }
    }
    if (!bookPage && mongoose.Types.ObjectId.isValid(pageOrder)) {
      const pageDoc = book.pages.id(pageOrder);
      if (pageDoc) {
        bookPage = pageDoc;
        targetOrder = pageDoc.order;
      }
    }
    if (!bookPage) {
      throw new Error('Requested page was not found');
    }
    if (!targetOrder) {
      targetOrder = bookPage.order;
    }
    pageType = bookPage.pageType === 'cover' ? 'cover' : 'story';
  }

  if (pageType === 'cover' && !book.coverPage) {
    throw new Error('Cover page is not configured for this book');
  }
  if (pageType === 'dedication' && !book.dedicationPage) {
    throw new Error('Dedication page is not configured for this book');
  }

  const pageIndex = pdfAsset.pages.findIndex((page) => page.order === targetOrder);
  if (pageIndex === -1) {
    throw new Error('Storybook page snapshot missing');
  }

  const pdfPage = pdfAsset.pages[pageIndex] || {};

  let candidateAssets = Array.isArray(pdfPage.candidateAssets)
    ? pdfPage.candidateAssets.slice()
    : [];
  let resolvedGenerationId = pdfPage.generationId || null;

  if (!candidateAssets.length && pdfPage.generationId) {
    const generationDoc = await populateForClient(pdfPage.generationId);
    if (generationDoc) {
      candidateAssets = sanitizeAssetListForSnapshot(generationDoc.imageAssets || []);
      resolvedGenerationId = generationDoc._id || resolvedGenerationId;
    }
  }

  if (!candidateAssets.length) {
    throw new Error('No candidate images are available for this page');
  }

  const zeroIndex = Math.floor(parsedIndex) - 1;
  if (zeroIndex < 0 || zeroIndex >= candidateAssets.length) {
    throw new Error('Selected candidate index is out of range');
  }

  const candidateAsset = candidateAssets[zeroIndex];
  if (!candidateAsset?.key) {
    throw new Error('Candidate image is missing required metadata');
  }

  const appliedAsset = await copyAssetToBookCharacterSlot({
    book,
    page: {
      pageId: bookPage?._id || null,
      order: targetOrder,
      pageType,
    },
    asset: candidateAsset,
  });

  if (!appliedAsset) {
    throw new Error(`Cannot apply candidate image - selected asset file not found in S3 (key: ${candidateAsset.key})`);
  }

  const sanitizedCharacter = sanitizeAssetForSnapshot(appliedAsset);
  const sanitizedOriginal = sanitizeAssetForSnapshot(candidateAsset);

  await updateBookCharacterImage({
    bookId,
    page: {
      pageId: bookPage?._id || null,
      order: targetOrder,
      pageType,
    },
    newAsset: appliedAsset,
    originalAsset: sanitizedOriginal,
  });

  const timestamp = new Date();
  const sanitizedCandidateAssets = sanitizeAssetListForSnapshot(candidateAssets);
  const assetFilter = mongoose.Types.ObjectId.isValid(assetId)
    ? { 'asset._id': new mongoose.Types.ObjectId(assetId) }
    : { 'asset.key': assetId };

  await Book.updateOne(
    { _id: bookId },
    {
      $set: {
        'pdfAssets.$[asset].pages.$[page].character': sanitizedCharacter,
        'pdfAssets.$[asset].pages.$[page].characterOriginal': sanitizedOriginal,
        'pdfAssets.$[asset].pages.$[page].candidateAssets': sanitizedCandidateAssets,
        'pdfAssets.$[asset].pages.$[page].selectedCandidateIndex': parsedIndex,
        'pdfAssets.$[asset].pages.$[page].updatedAt': timestamp,
        'pdfAssets.$[asset].pages.$[page].generationId': resolvedGenerationId,
        'pdfAssets.$[asset].updatedAt': timestamp,
      },
    },
    {
      arrayFilters: [assetFilter, { 'page.order': targetOrder }],
    }
  ).catch((error) => {
    console.warn('[storybook] Failed to persist candidate selection on PDF snapshot:', error);
  });

  const refreshedBook = await Book.findById(bookId);
  const refreshedPage =
    pageType === 'story'
      ? refreshedBook?.pages.find((page) => page.order === targetOrder) || null
      : null;
  const refreshedCoverPage =
    pageType === 'cover' ? sanitizeCoverPageForSnapshot(refreshedBook.coverPage) : null;
  const refreshedDedicationPage =
    pageType === 'dedication'
      ? sanitizeDedicationForSnapshot(refreshedBook.dedicationPage)
      : null;
  let refreshedPdfAssetPage = null;
  if (refreshedBook) {
    const refreshedPdfAsset =
      (mongoose.Types.ObjectId.isValid(assetId) && refreshedBook.pdfAssets.id(assetId)) ||
      refreshedBook.pdfAssets.find((asset) => asset.key === assetId);
    if (refreshedPdfAsset && Array.isArray(refreshedPdfAsset.pages)) {
      refreshedPdfAssetPage = refreshedPdfAsset.pages.find((page) => page.order === targetOrder);
    }
  }

  return {
    page: refreshedPage ? refreshedPage.toObject({ depopulate: true }) : null,
    pdfAssetPage: refreshedPdfAssetPage
      ? refreshedPdfAssetPage.toObject
        ? refreshedPdfAssetPage.toObject({ depopulate: true })
        : refreshedPdfAssetPage
      : null,
    characterAsset: appliedAsset,
    candidateIndex: parsedIndex,
    coverPage: refreshedCoverPage,
    dedicationPage: refreshedDedicationPage,
    pageType,
    order: targetOrder,
  };
};

module.exports = {
  startStorybookAutomation,
  getStorybookJobById,
  listStorybookJobsForBook,
  regenerateStorybookPage,
  applyStorybookCandidateSelection,
  buildCoverPageContent,
  buildDedicationPageContent,
};
