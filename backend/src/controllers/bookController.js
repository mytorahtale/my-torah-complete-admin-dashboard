const mongoose = require('mongoose');
const path = require('path');
const { validationResult } = require('express-validator');
const Book = require('../models/Book');
const User = require('../models/User');
const StorybookJob = require('../models/StorybookJob');
const Generation = require('../models/Generation');
const {
  uploadBufferToS3,
  deleteFromS3,
  generateBookCoverKey,
  generateBookPageImageKey,
  generateBookCharacterOverlayKey,
  generateBookQrCodeKey,
  generateBookPdfKey,
  getSignedUrlForKey,
  downloadFromS3,
} = require('../config/s3');
const {
  buildCoverPageContent,
  buildDedicationPageContent,
} = require('../services/storybookWorkflow');

const slugify = (value) =>
  (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const sanitizeFileName = (value, fallback = 'asset') => {
  const safeFallback = fallback || 'asset';
  if (!value || typeof value !== 'string') {
    return `${safeFallback}-${Date.now()}`;
  }
  return path
    .basename(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase();
};

const buildCoverPageAssetKey = (bookSlug, type, originalName) => {
  const safeName = sanitizeFileName(originalName, `${type || 'asset'}.png`);
  return `books/${bookSlug}/cover-page/${type || 'asset'}-${Date.now()}-${safeName}`;
};

const buildDedicationPageAssetKey = (bookSlug, type, originalName) => {
  const safeName = sanitizeFileName(originalName, `${type || 'asset'}.png`);
  return `books/${bookSlug}/dedication-page/${type || 'asset'}-${Date.now()}-${safeName}`;
};

const parsePagesPayload = (pages) => {
  if (!pages) return [];
  if (Array.isArray(pages)) return pages;
  try {
    const parsed = JSON.parse(pages);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
};

const normalizeBoolean = (value) =>
  typeof value === 'string' ? value === 'true' || value === '1' : Boolean(value);

const normalizeString = (value) =>
  typeof value === 'string' ? value.trim() : '';

const normalizeGenderValue = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const normalizeCharacterPosition = (value, fallback = null) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'left' || normalized === 'right') {
      return normalized;
    }
  }
  return fallback;
};

const extractPromptFields = (payload = {}) => {
  const promptMale =
    normalizeString(payload.promptMale) || normalizeString(payload.characterPromptMale);
  const promptFemale =
    normalizeString(payload.promptFemale) || normalizeString(payload.characterPromptFemale);
  const prompt =
    normalizeString(payload.prompt) ||
    normalizeString(payload.characterPrompt) ||
    promptMale ||
    promptFemale;

  return {
    prompt,
    promptMale,
    promptFemale,
  };
};

const resolvePromptByGender = (source = {}, gender = '') => {
  const normalizedGender = normalizeGenderValue(gender);
  const promptMale =
    normalizeString(source.promptMale) || normalizeString(source.characterPromptMale);
  const promptFemale =
    normalizeString(source.promptFemale) || normalizeString(source.characterPromptFemale);
  const promptNeutral =
    normalizeString(source.prompt) || normalizeString(source.characterPrompt);

  if (normalizedGender === 'male' && promptMale) {
    return promptMale;
  }
  if (normalizedGender === 'female' && promptFemale) {
    return promptFemale;
  }

  if (promptNeutral) {
    return promptNeutral;
  }

  if (normalizedGender === 'male' && promptFemale) {
    return promptFemale;
  }
  if (normalizedGender === 'female' && promptMale) {
    return promptMale;
  }

  return promptNeutral || '';
};

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
  if (!value || typeof value !== 'string') {
    return value || '';
  }
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

const clonePlainObject = (value) => {
  if (!value || typeof value !== 'object') return null;
  return JSON.parse(JSON.stringify(value));
};

const safeText = (value) => (typeof value === 'string' ? value : '');

const cloneCoverConfig = (config) => clonePlainObject(config);

const mergeCoverConfig = (existing, incoming) => {
  if (!incoming || typeof incoming !== 'object') {
    return existing ? cloneCoverConfig(existing) : null;
  }

  const base = existing ? cloneCoverConfig(existing) : {};
  const headline = normalizeString(incoming.headline);
  const footer = normalizeString(incoming.footer);
  const bodyOverride = normalizeString(incoming.bodyOverride);

  if (headline !== undefined) {
    base.headline = headline;
  }
  if (footer !== undefined) {
    base.footer = footer;
  }
  if (bodyOverride !== undefined) {
    base.bodyOverride = bodyOverride;
  }

  if (typeof incoming.uppercaseName !== 'undefined') {
    base.uppercaseName = normalizeBoolean(incoming.uppercaseName);
  } else if (typeof base.uppercaseName === 'undefined') {
    base.uppercaseName = true;
  }

  base.headline = normalizeString(base.headline) || '';
  base.footer = normalizeString(base.footer) || '';
  base.bodyOverride = normalizeString(base.bodyOverride) || '';
  if (typeof base.uppercaseName === 'undefined') {
    base.uppercaseName = true;
  }

  if (incoming.qrCodeImage) {
    base.qrCodeImage = clonePlainObject(incoming.qrCodeImage);
  } else if (!base.qrCodeImage) {
    base.qrCodeImage = null;
  }

  return base;
};

const buildImageResponse = (file, key, url) => ({
  key,
  url,
  size: file.size,
  contentType: file.mimetype,
  uploadedAt: new Date(),
  originalName: file.originalname,
});

const cleanupKeys = async (keys = []) => {
  if (!Array.isArray(keys) || keys.length === 0) return;
  await Promise.all(
    keys.map((key) =>
      deleteFromS3(key).catch((error) =>
        console.warn(`⚠️  Failed to cleanup S3 asset ${key}: ${error.message}`)
      )
    )
  );
};

const duplicateAssetFromS3 = async ({
  asset,
  buildKey,
  fallbackName,
  fallbackContentType = 'application/octet-stream',
  uploadedKeys = [],
}) => {
  if (!asset || !asset.key || typeof buildKey !== 'function') {
    return null;
  }

  let buffer;
  try {
    buffer = await downloadFromS3(asset.key);
  } catch (error) {
    throw new Error(`Failed to download asset ${asset.key}: ${error.message}`);
  }

  if (!buffer || !buffer.length) {
    throw new Error(`Empty buffer when duplicating asset ${asset.key}`);
  }

  const originalName = sanitizeFileName(
    asset.originalName || path.basename(asset.key),
    fallbackName || 'asset'
  );
  const contentType = asset.contentType || fallbackContentType;
  const key = buildKey(originalName);
  const { url } = await uploadBufferToS3(buffer, key, contentType, { acl: 'public-read' });
  uploadedKeys.push(key);
  const signedUrl = await getSignedUrlForKey(key).catch(() => null);

  return {
    key,
    url,
    signedUrl: signedUrl || asset.signedUrl || null,
    downloadUrl: url,
    size: buffer.length,
    contentType,
    uploadedAt: new Date(),
    originalName,
    backgroundRemoved: Boolean(asset.backgroundRemoved),
  };
};

const buildAssetPayload = async (asset) => {
  if (!asset) return null;
  const signedUrl = await getSignedUrlForKey(asset.key).catch(() => null);
  return {
    key: asset.key,
    url: asset.url,
    signedUrl,
    downloadUrl: asset.url || signedUrl || asset.downloadUrl || null,
    size: asset.size,
    contentType: asset.contentType,
    uploadedAt: asset.uploadedAt,
    originalName: asset.originalName,
    backgroundRemoved: Boolean(asset.backgroundRemoved),
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

const sanitizeCoverConfigForSnapshot = (cover) => {
  if (!cover || typeof cover !== 'object') return null;
  const cloned = clonePlainObject(cover) || {};
  const uppercaseName =
    typeof cloned.uppercaseName === 'undefined'
      ? true
      : normalizeBoolean(cloned.uppercaseName);

  const fromSegments = () => {
    if (!Array.isArray(cloned.textSegments)) return { headline: '', body: '', footer: '' };
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
    return {
      headline: normalizeString(headlineSegment),
      footer: normalizeString(footerSegment),
      body: normalizeString(body),
    };
  };

  const legacy = fromSegments();
  const headline = normalizeString(cloned.headline) || legacy.headline || '';
  const footer = normalizeString(cloned.footer) || legacy.footer || '';
  const bodyOverride = normalizeString(cloned.bodyOverride) || legacy.body || '';

  return {
    headline,
    footer,
    bodyOverride,
    uppercaseName,
    qrCodeImage: cloned.qrCodeImage ? sanitizeAssetForSnapshot(cloned.qrCodeImage) : null,
    childName: typeof cloned.childName === 'string' ? cloned.childName : '',
  };
};

const cloneDocument = (value) =>
  value && typeof value.toObject === 'function'
    ? value.toObject({ depopulate: true })
    : value
    ? JSON.parse(JSON.stringify(value))
    : null;

const attachFreshSignedUrl = async (asset) => {
  if (!asset) return null;
  const cloned = cloneDocument(asset) || {};
  if (!cloned.key) {
    cloned.backgroundRemoved = Boolean(cloned.backgroundRemoved);
    return cloned;
  }

  const signedUrl = await getSignedUrlForKey(cloned.key).catch(() => null);
  cloned.signedUrl = signedUrl || cloned.signedUrl || null;
  cloned.downloadUrl = cloned.url || cloned.downloadUrl || signedUrl || null;
  cloned.backgroundRemoved = Boolean(cloned.backgroundRemoved);
  return cloned;
};

const attachFreshSignedUrlsToPages = async (pages = [], options = {}) => {
  const {
    bookPages = [],
    preferSnapshotAssets = false,
    strictSnapshotAssets = false,
  } = options;
  const bookPagesArray = Array.isArray(bookPages) ? bookPages : [];
  const bookPagesById = new Map();
  const bookPagesByOrder = new Map();

  if (!strictSnapshotAssets) {
    bookPagesArray.forEach((page) => {
      const cloned = cloneDocument(page) || {};
      if (cloned._id) {
        bookPagesById.set(String(cloned._id), cloned);
      }
      const orderValue = Number(cloned.order);
      if (Number.isFinite(orderValue)) {
        bookPagesByOrder.set(orderValue, cloned);
      }
    });
  }

  const hydrations = await Promise.all(
    (pages || []).map(async (page) => {
      if (!page) return null;
      const clonedPage = cloneDocument(page) || {};
      const pageId = clonedPage._id || clonedPage.pageId;
      const pageOrder = Number(clonedPage.order);
      const bookPageCandidate =
        strictSnapshotAssets
          ? null
          : (pageId && bookPagesById.get(String(pageId))) ||
            (Number.isFinite(pageOrder) && bookPagesByOrder.get(pageOrder)) ||
            null;

  const pickAsset = (snapshotValue, bookValue) => {
    if (strictSnapshotAssets) {
      return snapshotValue || null;
    }
    return preferSnapshotAssets ? snapshotValue || bookValue : bookValue || snapshotValue;
  };

      const backgroundSource = pickAsset(
        clonedPage.background,
        bookPageCandidate?.backgroundImage
      );
      const resolvedBackground = await attachFreshSignedUrl(backgroundSource);

      const candidateAssets = Array.isArray(clonedPage.candidateAssets)
        ? clonedPage.candidateAssets
        : [];
      const selectedCandidate = (() => {
        const rawIndex = Number(clonedPage.selectedCandidateIndex);
        if (!Number.isFinite(rawIndex)) return null;
        const zeroBased = rawIndex > 0 ? rawIndex - 1 : rawIndex;
        if (zeroBased >= 0 && zeroBased < candidateAssets.length) {
          return candidateAssets[zeroBased];
        }
        return null;
      })();

      let characterSource = null;
      if (strictSnapshotAssets) {
        characterSource = clonedPage.character || selectedCandidate || null;
      } else if (preferSnapshotAssets) {
        characterSource =
          clonedPage.character ||
          selectedCandidate ||
          bookPageCandidate?.characterImage ||
          null;
      } else if (bookPageCandidate?.characterImage) {
        characterSource = bookPageCandidate.characterImage;
      } else if (clonedPage.character) {
        characterSource = clonedPage.character;
      }

      const resolvedCharacter = await attachFreshSignedUrl(characterSource);

      const resolveOriginalSource = () => {
        if (strictSnapshotAssets) {
          if (clonedPage.characterOriginal) {
            return clonedPage.characterOriginal;
          }
          if (selectedCandidate && !selectedCandidate.backgroundRemoved) {
            return selectedCandidate;
          }
          if (clonedPage.character && !clonedPage.character.backgroundRemoved) {
            return clonedPage.character;
          }
          return null;
        }

        if (clonedPage.characterOriginal) {
          return clonedPage.characterOriginal;
        }
        if (bookPageCandidate?.characterImageOriginal) {
          return bookPageCandidate.characterImageOriginal;
        }
        if (preferSnapshotAssets) {
          if (clonedPage.character && !clonedPage.character.backgroundRemoved) {
            return clonedPage.character;
          }
          if (
            bookPageCandidate?.characterImage &&
            !bookPageCandidate.characterImage.backgroundRemoved
          ) {
            return bookPageCandidate.characterImage;
          }
          return null;
        }
        if (
          bookPageCandidate?.characterImage &&
          !bookPageCandidate.characterImage.backgroundRemoved
        ) {
          return bookPageCandidate.characterImage;
        }
        return null;
      };

      const originalSource = resolveOriginalSource();
      const resolvedCharacterOriginal = await attachFreshSignedUrl(originalSource);

      const resolvedCandidateAssets = Array.isArray(clonedPage.candidateAssets)
        ? await Promise.all(clonedPage.candidateAssets.map((asset) => attachFreshSignedUrl(asset)))
        : [];

      const coverSource = pickAsset(
        clonedPage.cover,
        strictSnapshotAssets ? null : bookPageCandidate?.cover || null
      );
      let resolvedCover = null;
      if (coverSource) {
        const coverClone = clonePlainObject(coverSource) || {};
        coverClone.headline = normalizeString(coverClone.headline) || '';
        coverClone.footer = normalizeString(coverClone.footer) || '';
        coverClone.bodyOverride = normalizeString(coverClone.bodyOverride) || '';
        coverClone.uppercaseName =
          typeof coverClone.uppercaseName === 'undefined'
            ? true
            : normalizeBoolean(coverClone.uppercaseName);
        if (coverClone.qrCodeImage) {
          coverClone.qrCodeImage = await attachFreshSignedUrl(coverClone.qrCodeImage);
        }
        resolvedCover = coverClone;
      }

      clonedPage.background = resolvedBackground;
      clonedPage.character = resolvedCharacter;
      clonedPage.characterOriginal = resolvedCharacterOriginal;
      clonedPage.candidateAssets = resolvedCandidateAssets.filter(Boolean);
      clonedPage.cover = resolvedCover;
      let resolvedCoverPage = null;
      if (clonedPage.coverPage) {
        const coverPageClone = clonePlainObject(clonedPage.coverPage) || {};
        coverPageClone.backgroundImage = await attachFreshSignedUrl(
          coverPageClone.backgroundImage
        );
        coverPageClone.characterImage = await attachFreshSignedUrl(
          coverPageClone.characterImage
        );
        coverPageClone.characterImageOriginal = await attachFreshSignedUrl(
            coverPageClone.characterImageOriginal
          );
          coverPageClone.qrCode = await attachFreshSignedUrl(coverPageClone.qrCode);
          coverPageClone.characterPrompt = safeText(coverPageClone.characterPrompt);
          coverPageClone.characterPromptMale = safeText(coverPageClone.characterPromptMale);
          coverPageClone.characterPromptFemale = safeText(coverPageClone.characterPromptFemale);
          coverPageClone.leftSide = {
            title: safeText(coverPageClone.leftSide?.title),
            content: safeText(coverPageClone.leftSide?.content),
            bottomText: safeText(coverPageClone.leftSide?.bottomText),
          };
          coverPageClone.rightSide = {
            mainTitle: safeText(coverPageClone.rightSide?.mainTitle),
            subtitle: safeText(coverPageClone.rightSide?.subtitle),
          };
          resolvedCoverPage = coverPageClone;
      }

      let resolvedDedicationPage = null;
      if (clonedPage.dedicationPage) {
        const dedicationClone = clonePlainObject(clonedPage.dedicationPage) || {};
        dedicationClone.backgroundImage = await attachFreshSignedUrl(
          dedicationClone.backgroundImage
        );
        dedicationClone.kidImage = await attachFreshSignedUrl(dedicationClone.kidImage);
        dedicationClone.generatedImage = await attachFreshSignedUrl(
          dedicationClone.generatedImage
        );
        dedicationClone.generatedImageOriginal = await attachFreshSignedUrl(
            dedicationClone.generatedImageOriginal
          );
          dedicationClone.title = safeText(dedicationClone.title);
          dedicationClone.secondTitle = safeText(dedicationClone.secondTitle);
          dedicationClone.characterPrompt = safeText(dedicationClone.characterPrompt);
          dedicationClone.characterPromptMale = safeText(dedicationClone.characterPromptMale);
          dedicationClone.characterPromptFemale = safeText(
            dedicationClone.characterPromptFemale
          );
          resolvedDedicationPage = dedicationClone;
      }

      const resolvedRenderedImage = await attachFreshSignedUrl(clonedPage.renderedImage);

      clonedPage.coverPage = resolvedCoverPage;
      clonedPage.dedicationPage = resolvedDedicationPage;
      clonedPage.renderedImage = resolvedRenderedImage;
      clonedPage.pageType =
        clonedPage.pageType || (strictSnapshotAssets ? null : bookPageCandidate?.pageType) || 'story';
      const positionRaw =
        typeof clonedPage.characterPosition === 'string'
          ? clonedPage.characterPosition
          : typeof clonedPage.characterPositionResolved === 'string'
          ? clonedPage.characterPositionResolved
          : strictSnapshotAssets
          ? null
          : bookPageCandidate?.characterPosition || null;
      const resolvedPosition = normalizeCharacterPosition(positionRaw, null);
      clonedPage.characterPosition = resolvedPosition;
      clonedPage.characterPositionResolved = resolvedPosition;
      return clonedPage;
    })
  );

  return hydrations
    .filter(Boolean)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
};

const hydrateBookDocument = async (book) => {
  if (!book) return null;

  const clonedBook = cloneDocument(book);
  if (!clonedBook) return null;

  clonedBook.coverImage = await attachFreshSignedUrl(clonedBook.coverImage);
  if (clonedBook.coverPage) {
    const coverPageClone = clonePlainObject(clonedBook.coverPage) || {};
    coverPageClone.backgroundImage = await attachFreshSignedUrl(coverPageClone.backgroundImage);
    coverPageClone.characterImage = await attachFreshSignedUrl(coverPageClone.characterImage);
    coverPageClone.characterImageOriginal = await attachFreshSignedUrl(
      coverPageClone.characterImageOriginal
    );
    coverPageClone.qrCode = await attachFreshSignedUrl(coverPageClone.qrCode);
    coverPageClone.characterPrompt = safeText(coverPageClone.characterPrompt);
    coverPageClone.characterPromptMale = safeText(coverPageClone.characterPromptMale);
    coverPageClone.characterPromptFemale = safeText(coverPageClone.characterPromptFemale);
    coverPageClone.leftSide = {
      title: safeText(coverPageClone.leftSide?.title),
      content: safeText(coverPageClone.leftSide?.content),
      bottomText: safeText(coverPageClone.leftSide?.bottomText),
    };
    coverPageClone.rightSide = {
      mainTitle: safeText(coverPageClone.rightSide?.mainTitle),
      subtitle: safeText(coverPageClone.rightSide?.subtitle),
    };
    clonedBook.coverPage = coverPageClone;
  }

  if (clonedBook.dedicationPage) {
    const dedicationClone = clonePlainObject(clonedBook.dedicationPage) || {};
    dedicationClone.backgroundImage = await attachFreshSignedUrl(dedicationClone.backgroundImage);
    dedicationClone.kidImage = await attachFreshSignedUrl(dedicationClone.kidImage);
    dedicationClone.generatedImage = await attachFreshSignedUrl(dedicationClone.generatedImage);
    dedicationClone.generatedImageOriginal = await attachFreshSignedUrl(
      dedicationClone.generatedImageOriginal
    );
    dedicationClone.title = safeText(dedicationClone.title);
    dedicationClone.secondTitle = safeText(dedicationClone.secondTitle);
    dedicationClone.characterPrompt = safeText(dedicationClone.characterPrompt);
    dedicationClone.characterPromptMale = safeText(dedicationClone.characterPromptMale);
    dedicationClone.characterPromptFemale = safeText(dedicationClone.characterPromptFemale);
    clonedBook.dedicationPage = dedicationClone;
  }

  const hydratedPages = await Promise.all(
    (clonedBook.pages || []).map(async (page) => {
      const clonedPage = cloneDocument(page) || {};
      let cover = null;
      if (clonedPage.cover) {
        cover = clonePlainObject(clonedPage.cover) || {};
        cover.headline = normalizeString(cover.headline) || '';
        cover.footer = normalizeString(cover.footer) || '';
        cover.bodyOverride = normalizeString(cover.bodyOverride) || '';
        cover.uppercaseName =
          typeof cover.uppercaseName === 'undefined'
            ? true
            : normalizeBoolean(cover.uppercaseName);
        if (cover.qrCodeImage) {
          cover.qrCodeImage = await attachFreshSignedUrl(cover.qrCodeImage);
        }
      }
      return {
        ...clonedPage,
        pageType: clonedPage.pageType || 'story',
        characterPosition: normalizeCharacterPosition(clonedPage.characterPosition, null),
        cover,
        characterPrompt: safeText(clonedPage.characterPrompt),
        characterPromptMale: safeText(clonedPage.characterPromptMale),
        characterPromptFemale: safeText(clonedPage.characterPromptFemale),
        backgroundImage: await attachFreshSignedUrl(clonedPage.backgroundImage),
        characterImage: await attachFreshSignedUrl(clonedPage.characterImage),
        characterImageOriginal: await attachFreshSignedUrl(clonedPage.characterImageOriginal),
      };
    })
  );

  clonedBook.pages = hydratedPages
    .filter(Boolean)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  return clonedBook;
};

/**
 * @route GET /api/books
 */
const escapeRegex = (value) =>
  typeof value === 'string' ? value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : value;

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
};

const VALID_BOOK_SORT_FIELDS = new Set(['createdAt', 'updatedAt', 'name', 'status']);

const buildEditableBookResponse = (book) => {
  if (!book) return null;

  return {
    _id: book._id,
    name: safeText(book.name),
    description: safeText(book.description),
    status: book.status || 'active',
    slug: safeText(book.slug),
    coverImage:
      book.coverPage && book.coverPage.backgroundImage
        ? clonePlainObject(book.coverPage.backgroundImage)
        : null,
    pages: Array.isArray(book.pages)
      ? book.pages.map((page) => clonePlainObject(page) || null).filter(Boolean)
      : [],
    coverPage: clonePlainObject(book.coverPage),
    dedicationPage: clonePlainObject(book.dedicationPage),
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
};

exports.getAllBooks = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      status,
      search = '',
      from,
      to,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      minimal,
    } = req.query;

    const isMinimal = typeof minimal === 'string' && minimal.toLowerCase() === 'true';
    console.log(`[getAllBooks] minimal=${minimal}, isMinimal=${isMinimal}, query params:`, req.query);

    const filter = {};

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (search && typeof search === 'string') {
      const expression = new RegExp(escapeRegex(search.trim()), 'i');
      filter.$or = [{ name: expression }, { description: expression }, { slug: expression }];
    }

    if (from || to) {
      const dateFilter = {};
      if (from) {
        const fromDate = new Date(from);
        if (!Number.isNaN(fromDate.getTime())) {
          dateFilter.$gte = fromDate;
        }
      }
      if (to) {
        const toDate = new Date(to);
        if (!Number.isNaN(toDate.getTime())) {
          dateFilter.$lte = toDate;
        }
      }
      if (Object.keys(dateFilter).length > 0) {
        filter.createdAt = dateFilter;
      }
    }

    const numericLimit = toPositiveInteger(limit, 10);
    const rawPage = toPositiveInteger(page, 1) || 1;

    const sortField = VALID_BOOK_SORT_FIELDS.has(sortBy) ? sortBy : 'createdAt';
    const sortDirection = sortOrder === 'asc' ? 1 : -1;
    const sort = { [sortField]: sortDirection, _id: sortDirection };

    const totalBooks = await Book.countDocuments(filter);
    const totalPages =
      numericLimit > 0 && totalBooks > 0
        ? Math.ceil(totalBooks / numericLimit)
        : totalBooks > 0
        ? 1
        : 0;
    const effectivePage =
      numericLimit > 0
        ? Math.min(Math.max(rawPage, 1), Math.max(totalPages, 1))
        : 1;
    const skip = numericLimit > 0 ? (effectivePage - 1) * numericLimit : 0;

    let books = [];
    if (isMinimal) {
      const pipeline = [{ $match: filter }, { $sort: sort }];
      if (numericLimit > 0) {
        pipeline.push({ $skip: skip }, { $limit: numericLimit });
      }
      pipeline.push({
        $project: {
          _id: 1,
          name: 1,
          description: 1,
          status: 1,
          createdAt: 1,
          coverImage: '$coverPage.backgroundImage',
          pageCount: {
            $size: {
              $ifNull: ['$pages', []],
            },
          },
          highlightedPageCount: {
            $size: {
              $filter: {
                input: { $ifNull: ['$pages', []] },
                as: 'page',
                cond: {
                  $or: [
                    { $ne: [{ $ifNull: ['$$page.backgroundImage.url', null] }, null] },
                    { $ne: [{ $ifNull: ['$$page.characterImage.url', null] }, null] },
                  ],
                },
              },
            },
          },
        },
      });
      books = await Book.aggregate(pipeline);
    } else {
      const query = Book.find(filter).sort(sort).allowDiskUse(true);
      if (numericLimit > 0) {
        query.skip(skip).limit(numericLimit);
      }
      books = await query.exec();
    }

    let statsSummary = null;
    if (!isMinimal) {
      const aggregation = await Book.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalBooks: { $sum: 1 },
            totalPages: { $sum: { $size: { $ifNull: ['$pages', []] } } },
            active: {
              $sum: {
                $cond: [{ $eq: ['$status', 'active'] }, 1, 0],
              },
            },
            inactive: {
              $sum: {
                $cond: [{ $eq: ['$status', 'inactive'] }, 1, 0],
              },
            },
          },
        },
      ]);

      statsSummary = aggregation.length
        ? {
            totalBooks: aggregation[0].totalBooks || 0,
            totalPages: aggregation[0].totalPages || 0,
            byStatus: {
              active: aggregation[0].active || 0,
              inactive: aggregation[0].inactive || 0,
            },
            byGender: null,
          }
        : {
            totalBooks: 0,
            totalPages: 0,
            byStatus: { active: 0, inactive: 0 },
            byGender: null,
          };
    }

    res.status(200).json({
      success: true,
      count: books.length,
      data: books,
      pagination: {
        page: totalPages === 0 ? 1 : effectivePage,
        limit: numericLimit,
        total: totalBooks,
        totalPages,
        hasNextPage: numericLimit > 0 && effectivePage < totalPages,
        hasPrevPage: numericLimit > 0 && effectivePage > 1,
      },
        filters: {
          search: typeof search === 'string' ? search : '',
          status: status || 'all',
          from: from || '',
          to: to || '',
        sortBy: sortField,
        sortOrder: sortDirection === 1 ? 'asc' : 'desc',
      },
      stats: statsSummary,
    });
  } catch (error) {
    console.error('Error fetching books:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch books',
      error: error.message,
    });
  }
};

/**
 * @route GET /api/books/:id
 */
exports.getBookById = async (req, res) => {
  try {
    const { minimal } = req.query;
    const isMinimal = typeof minimal === 'string' && minimal.toLowerCase() === 'true';

    if (isMinimal) {
      const book = await Book.findById(req.params.id)
        .select('_id name description status coverPage createdAt updatedAt pages')
        .lean();

      if (!book) {
        return res.status(404).json({
          success: false,
          message: 'Book not found',
        });
      }

      const pageCount = Array.isArray(book.pages) ? book.pages.length : 0;

      const { pages: _, ...bookWithoutPages } = book;

      return res.status(200).json({
        success: true,
        data: {
          ...bookWithoutPages,
          coverImage:
            book.coverPage && book.coverPage.backgroundImage
              ? book.coverPage.backgroundImage
              : null,
          pageCount,
        },
      });
    }

    const book = await Book.findById(req.params.id);

    if (!book) {
      return res.status(404).json({
        success: false,
        message: 'Book not found',
      });
    }

    const hydratedBook = await hydrateBookDocument(book);

    res.status(200).json({
      success: true,
      data: hydratedBook || book,
    });
  } catch (error) {
    console.error('Error fetching book:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch book',
      error: error.message,
    });
  }
};

/**
 * @route GET /api/books/:id/editable
 */
exports.getBookForEdit = async (req, res) => {
  try {
    const book = await Book.findById(req.params.id);

    if (!book) {
      return res.status(404).json({
        success: false,
        message: 'Book not found',
      });
    }

    const hydratedBook = await hydrateBookDocument(book);
    const payload = buildEditableBookResponse(hydratedBook);

    res.status(200).json({
      success: true,
      data: payload,
    });
  } catch (error) {
    console.error('Error fetching editable book:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch editable book',
      error: error.message,
    });
  }
};

exports.duplicateBook = async (req, res) => {
  const uploadedKeys = [];
  try {
    const { id } = req.params;
    const newName = normalizeString(req.body.name);
    const requestedStatus = normalizeString(req.body.status);
    const descriptionOverride =
      typeof req.body.description === 'string' ? req.body.description : undefined;

    if (!newName) {
      return res.status(400).json({
        success: false,
        message: 'Provide a name for the duplicated book',
      });
    }

    const sourceBook = await Book.findById(id);
    if (!sourceBook) {
      return res.status(404).json({
        success: false,
        message: 'Source book not found',
      });
    }

    if (!Array.isArray(sourceBook.pages) || sourceBook.pages.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Source book has no pages to duplicate',
      });
    }

    const slug = `${slugify(newName)}-${Date.now()}`;
    const normalizedStatus = ['active', 'inactive'].includes(requestedStatus)
      ? requestedStatus
      : sourceBook.status || 'active';
    const resolvedDescription =
      typeof descriptionOverride === 'string'
        ? descriptionOverride
        : sourceBook.description || '';

    const duplicateCoverPage = async () => {
      if (!sourceBook.coverPage) return null;

      const backgroundImage = await duplicateAssetFromS3({
        asset: sourceBook.coverPage.backgroundImage,
        buildKey: (originalName) =>
          buildCoverPageAssetKey(slug, 'background', originalName),
        fallbackName: 'background.jpg',
        fallbackContentType:
          sourceBook.coverPage.backgroundImage?.contentType || 'image/jpeg',
        uploadedKeys,
      });

      const qrCode = await duplicateAssetFromS3({
        asset: sourceBook.coverPage.qrCode,
        buildKey: (originalName) => buildCoverPageAssetKey(slug, 'qr', originalName),
        fallbackName: 'qr.png',
        fallbackContentType: 'image/png',
        uploadedKeys,
      });

      return {
        backgroundImage,
        characterPromptMale: safeText(sourceBook.coverPage.characterPromptMale),
        characterPromptFemale: safeText(sourceBook.coverPage.characterPromptFemale),
        leftSide: {
          title: safeText(sourceBook.coverPage.leftSide?.title),
          content: safeText(sourceBook.coverPage.leftSide?.content),
          bottomText: safeText(sourceBook.coverPage.leftSide?.bottomText),
        },
        qrCode,
        rightSide: {
          mainTitle: safeText(sourceBook.coverPage.rightSide?.mainTitle),
          subtitle: safeText(sourceBook.coverPage.rightSide?.subtitle),
        },
      };
    };

    const duplicateDedicationPage = async () => {
      if (!sourceBook.dedicationPage) return null;

      const backgroundImage = await duplicateAssetFromS3({
        asset: sourceBook.dedicationPage.backgroundImage,
        buildKey: (originalName) =>
          buildDedicationPageAssetKey(slug, 'background', originalName),
        fallbackName: 'background.jpg',
        fallbackContentType:
          sourceBook.dedicationPage.backgroundImage?.contentType || 'image/jpeg',
        uploadedKeys,
      });

      return {
        backgroundImage,
        title: safeText(sourceBook.dedicationPage.title),
        secondTitle: safeText(sourceBook.dedicationPage.secondTitle),
        characterPromptMale: safeText(sourceBook.dedicationPage.characterPromptMale),
        characterPromptFemale: safeText(sourceBook.dedicationPage.characterPromptFemale),
      };
    };

    const sortedPages = [...(sourceBook.pages || [])].sort(
      (a, b) => (a.order || 0) - (b.order || 0)
    );

    const pages = [];
    for (let index = 0; index < sortedPages.length; index += 1) {
      const page = sortedPages[index];
      const order = Number(page.order) || index + 1;
      const backgroundImage = await duplicateAssetFromS3({
        asset: page.backgroundImage || null,
        buildKey: (originalName) =>
          generateBookPageImageKey(slug, order, originalName || `page-${order}.jpg`),
        fallbackName: `page-${order}.jpg`,
        fallbackContentType: page.backgroundImage?.contentType || 'image/jpeg',
        uploadedKeys,
      });

      pages.push({
        order,
        text: safeText(page.text),
        characterPromptMale: safeText(page.characterPromptMale),
        characterPromptFemale: safeText(page.characterPromptFemale),
        characterPosition: normalizeCharacterPosition(page.characterPosition, null),
        backgroundImage,
      });
    }

    const [coverPage, dedicationPage] = await Promise.all([
      duplicateCoverPage(),
      duplicateDedicationPage(),
    ]);

    const duplicatedBook = await Book.create({
      name: newName,
      description: resolvedDescription,
      status: normalizedStatus,
      slug,
      pages,
      coverPage,
      dedicationPage,
    });

    const hydratedCopy = await hydrateBookDocument(duplicatedBook);
    const editablePayload = buildEditableBookResponse(hydratedCopy);

    res.status(201).json({
      success: true,
      message: 'Book duplicated successfully',
      data: editablePayload,
      meta: {
        sourceBookId: sourceBook._id.toString(),
      },
    });
  } catch (error) {
    console.error('Error duplicating book:', error);
    await cleanupKeys(uploadedKeys);
    res.status(500).json({
      success: false,
      message: 'Failed to duplicate book',
      error: error.message,
    });
  }
};

/**
 * @route POST /api/books
 */
exports.createBook = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array(),
    });
  }

  const uploadedKeys = [];

  try {
    const { name, description, status } = req.body;
    const pagesRaw = parsePagesPayload(req.body.pages);

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Book name is required',
      });
    }

  const pagesPayload = pagesRaw.map((page, index) => {
    const promptFields = extractPromptFields(page || {});
    const pageType = page?.pageType === 'cover' ? 'cover' : 'story';
    const base = {
      order: Number(page.order) || index + 1,
      text: typeof page.text === 'string' ? page.text : '',
      characterPrompt: promptFields.prompt,
      characterPromptMale: promptFields.promptMale,
      characterPromptFemale: promptFields.promptFemale,
      hasNewImage: normalizeBoolean(page.hasNewImage),
      removeImage: normalizeBoolean(page.removeImage),
      pageType,
    };
    base.characterPosition = normalizeCharacterPosition(page?.characterPosition, null);

    if (pageType === 'cover') {
      base.cover = mergeCoverConfig(null, page.cover || {});
      base.hasNewQrImage = normalizeBoolean(page.hasNewQrImage);
      base.removeQrImage = normalizeBoolean(page.removeQrImage);
      }

      return base;
    });

    if (!pagesPayload.length) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one page for the book',
      });
    }

    const slug = `${slugify(name)}-${Date.now()}`;
    const pageImageFiles = req.files?.pageImages || [];
    const pageQrFiles = req.files?.pageQrImages || [];

    let pageImageCursor = 0;
    let pageQrImageCursor = 0;
    const pages = [];

    for (let index = 0; index < pagesPayload.length; index += 1) {
      const pageDefinition = pagesPayload[index];
      const promptFields = extractPromptFields(pageDefinition || {});
      const pageData = {
        order: pageDefinition.order,
        text: pageDefinition.text,
        characterPrompt: promptFields.prompt,
        characterPromptMale: promptFields.promptMale,
        characterPromptFemale: promptFields.promptFemale,
        pageType: pageDefinition.pageType || 'story',
      };
      pageData.characterPosition = normalizeCharacterPosition(
        pageDefinition.characterPosition,
        null
      );
      let coverConfig = null;
      if (pageData.pageType === 'cover') {
        coverConfig = mergeCoverConfig(null, pageDefinition.cover || {});
      }

      if (pageDefinition.hasNewImage) {
        const file = pageImageFiles[pageImageCursor];
        if (!file) {
          throw new Error(`Missing background image for page at position ${index + 1}`);
        }
        pageImageCursor += 1;
        const key = generateBookPageImageKey(slug, pageData.order, file.originalname);
        const { url } = await uploadBufferToS3(file.buffer, key, file.mimetype, {
          acl: 'public-read',
        });
        uploadedKeys.push(key);
        pageData.backgroundImage = buildImageResponse(file, key, url);
      }

      if (coverConfig) {
        let qrCodeImage = coverConfig.qrCodeImage || null;

        if (pageDefinition.hasNewQrImage) {
          const file = pageQrFiles[pageQrImageCursor];
          if (!file) {
            throw new Error(`Missing QR code image for page at position ${index + 1}`);
          }
          pageQrImageCursor += 1;
          const key = generateBookQrCodeKey(slug, pageData.order, file.originalname);
          const { url } = await uploadBufferToS3(file.buffer, key, file.mimetype, {
            acl: 'public-read',
          });
          uploadedKeys.push(key);
          qrCodeImage = buildImageResponse(file, key, url);
        } else if (pageDefinition.removeQrImage) {
          qrCodeImage = null;
        }

        coverConfig.qrCodeImage = qrCodeImage;
        pageData.cover = coverConfig;
      } else {
        pageData.cover = null;
      }

      pages.push(pageData);
    }

    if (pageImageCursor !== pageImageFiles.length) {
      throw new Error(
        `Received ${pageImageFiles.length} page images but only ${
          pageImageCursor
        } were mapped. Ensure files align with pages.`
      );
    }

    if (pageQrImageCursor !== pageQrFiles.length) {
      throw new Error(
        `Received ${pageQrFiles.length} page QR images but only ${pageQrImageCursor} were mapped. Ensure files align with pages.`
      );
    }

    if (pageQrImageCursor !== pageQrFiles.length) {
      throw new Error(
        `Received ${pageQrFiles.length} page QR images but only ${pageQrImageCursor} were mapped. Ensure files align with pages.`
      );
    }

    // Handle cover page data
    let coverPageData = null;
    if (req.body.coverPage) {
      const coverPagePayload = typeof req.body.coverPage === 'string'
        ? JSON.parse(req.body.coverPage)
        : req.body.coverPage;

      const coverPageBgFile =
        req.files?.coverPageBackgroundImage?.[0] || req.files?.coverImage?.[0] || null;
      const coverPageQrFile = req.files?.coverPageQrCode?.[0];

      let backgroundImage = null;
      let qrCode = null;

      if (coverPageBgFile) {
        const bgKey = `books/${slug}/cover-page/background-${Date.now()}.${coverPageBgFile.originalname.split('.').pop()}`;
        const { url } = await uploadBufferToS3(coverPageBgFile.buffer, bgKey, coverPageBgFile.mimetype, {
          acl: 'public-read',
        });
        uploadedKeys.push(bgKey);
        backgroundImage = buildImageResponse(coverPageBgFile, bgKey, url);
      }

      if (coverPageQrFile) {
        const qrKey = `books/${slug}/cover-page/qr-${Date.now()}.${coverPageQrFile.originalname.split('.').pop()}`;
        const { url } = await uploadBufferToS3(coverPageQrFile.buffer, qrKey, coverPageQrFile.mimetype, {
          acl: 'public-read',
        });
        uploadedKeys.push(qrKey);
        qrCode = buildImageResponse(coverPageQrFile, qrKey, url);
      }

      const coverPromptFields = extractPromptFields(coverPagePayload || {});
      coverPageData = {
        backgroundImage,
        leftSide: {
          title: normalizeString(coverPagePayload.leftSide?.title),
          content: normalizeString(coverPagePayload.leftSide?.content),
          bottomText: normalizeString(coverPagePayload.leftSide?.bottomText),
        },
        qrCode,
        rightSide: {
          mainTitle: normalizeString(coverPagePayload.rightSide?.mainTitle),
          subtitle: normalizeString(coverPagePayload.rightSide?.subtitle),
        },
        characterPromptMale: coverPromptFields.promptMale,
        characterPromptFemale: coverPromptFields.promptFemale,
      };
    }

    // Handle dedication page
    let dedicationPageData = null;
    if (req.body.dedicationPage) {
      const dedicationPagePayload = JSON.parse(req.body.dedicationPage);

      const dedicationBgFile = req.files?.dedicationPageBackgroundImage?.[0];

      let dedicationBackgroundImage = null;

      if (dedicationBgFile) {
        const bgKey = `books/${slug}/dedication-page/background-${Date.now()}.${dedicationBgFile.originalname.split('.').pop()}`;
        const { url } = await uploadBufferToS3(dedicationBgFile.buffer, bgKey, dedicationBgFile.mimetype, {
          acl: 'public-read',
        });
        uploadedKeys.push(bgKey);
        dedicationBackgroundImage = buildImageResponse(dedicationBgFile, bgKey, url);
      }

      const dedicationPromptFields = extractPromptFields(dedicationPagePayload || {});
      dedicationPageData = {
        backgroundImage: dedicationBackgroundImage,
        title: normalizeString(dedicationPagePayload.title),
        secondTitle: normalizeString(dedicationPagePayload.secondTitle),
        characterPromptMale: dedicationPromptFields.promptMale,
        characterPromptFemale: dedicationPromptFields.promptFemale,
      };
    }

    const book = await Book.create({
      name,
      description,
      status: status || 'active',
      slug,
      pages,
      coverPage: coverPageData,
      dedicationPage: dedicationPageData,
    });

    res.status(201).json({
      success: true,
      message: 'Book created successfully',
      data: book,
    });
  } catch (error) {
    console.error('Error creating book:', error);
    await cleanupKeys(uploadedKeys);
    res.status(500).json({
      success: false,
      message: 'Failed to create book',
      error: error.message,
    });
  }
};

/**
 * @route PUT /api/books/:id
 */
exports.updateBook = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array(),
    });
  }

  const uploadedKeys = [];
  const keysToDelete = [];

  try {
    const { id } = req.params;
    const { name, description, status } = req.body;
    const coverAction = (req.body.coverAction || 'keep').toLowerCase();

    const book = await Book.findById(id);
    if (!book) {
      return res.status(404).json({
        success: false,
        message: 'Book not found',
      });
    }

    const slug = book.slug || `${slugify(book.name)}-${Date.now()}`;
    const pageImageFiles = req.files?.pageImages || [];
    const pageQrFiles = req.files?.pageQrImages || [];

    const pagesRaw = parsePagesPayload(req.body.pages);
    if (!pagesRaw.length) {
      return res.status(400).json({
        success: false,
        message: 'Provide at least one page for the book',
      });
    }

    const existingPagesMap = new Map(
      book.pages.map((page) => [page._id.toString(), page.toObject()])
    );
    const providedPageIds = new Set();
    const pages = [];
    let pageImageCursor = 0;
    let pageQrImageCursor = 0;

    for (let index = 0; index < pagesRaw.length; index += 1) {
      const incoming = pagesRaw[index];
      const pageId = incoming.id || incoming._id;
      const hasNewImage = normalizeBoolean(incoming.hasNewImage);
      const removeImage = normalizeBoolean(incoming.removeImage);
      const order = Number(incoming.order) || index + 1;
      const text = typeof incoming.text === 'string' ? incoming.text : '';
      const existing = pageId ? existingPagesMap.get(pageId) : null;
      const existingPromptFields = extractPromptFields(existing || {});
      const incomingPromptFields = extractPromptFields(incoming || {});
      const resolvedPromptFields = {
        prompt: incomingPromptFields.prompt || existingPromptFields.prompt,
        promptMale: incomingPromptFields.promptMale || existingPromptFields.promptMale,
        promptFemale:
          incomingPromptFields.promptFemale || existingPromptFields.promptFemale,
      };

      if (pageId) {
        providedPageIds.add(pageId);
      }

      const requestedPageType = incoming.pageType === 'cover' ? 'cover' : incoming.pageType === 'story' ? 'story' : null;
      const pageType = requestedPageType || (existing?.pageType === 'cover' ? 'cover' : 'story');
      const pageData = {
        order,
        text,
        characterPrompt:
          resolvedPromptFields.prompt ||
          resolvedPromptFields.promptMale ||
          resolvedPromptFields.promptFemale,
        characterPromptMale: resolvedPromptFields.promptMale,
        characterPromptFemale: resolvedPromptFields.promptFemale,
        pageType,
      };

      if (pageId && existing) {
        pageData._id = existing._id;
      }

      const requestedPosition = normalizeCharacterPosition(
        incoming.characterPosition,
        null
      );
      const existingPosition = normalizeCharacterPosition(
        existing?.characterPosition,
        null
      );
      pageData.characterPosition =
        requestedPosition !== null ? requestedPosition : existingPosition;

      let backgroundImage = existing?.backgroundImage || existing?.characterImage || null;
      const hasNewQrImage = normalizeBoolean(incoming.hasNewQrImage);
      const removeQrImage = normalizeBoolean(incoming.removeQrImage);
      const existingCover = existing?.cover || null;
      const coverConfig =
        pageType === 'cover'
          ? mergeCoverConfig(existingCover, incoming.cover || {})
          : null;

      if (hasNewImage) {
        const file = pageImageFiles[pageImageCursor];
        if (!file) {
          throw new Error(`Missing background image for page at position ${index + 1}`);
        }
        pageImageCursor += 1;

        if (backgroundImage?.key) {
          keysToDelete.push(backgroundImage.key);
        }

        const key = generateBookPageImageKey(slug, order, file.originalname);
        const { url } = await uploadBufferToS3(file.buffer, key, file.mimetype, {
          acl: 'public-read',
        });
        uploadedKeys.push(key);
        backgroundImage = buildImageResponse(file, key, url);
      } else if (removeImage) {
        if (backgroundImage?.key) {
          keysToDelete.push(backgroundImage.key);
        }
        backgroundImage = null;
      } else if (!backgroundImage && existing?.characterImage) {
        backgroundImage = existing.characterImage; // compatibility fallback
      }

      if (backgroundImage) {
        pageData.backgroundImage = backgroundImage;
      } else {
        pageData.backgroundImage = null;
      }

      if (pageType === 'cover' && coverConfig) {
        let qrCodeImage = coverConfig.qrCodeImage || existingCover?.qrCodeImage || null;

        if (hasNewQrImage) {
          const file = pageQrFiles[pageQrImageCursor];
          if (!file) {
            throw new Error(`Missing QR code image for page at position ${index + 1}`);
          }
          pageQrImageCursor += 1;

          if (qrCodeImage?.key) {
            keysToDelete.push(qrCodeImage.key);
          }

          const key = generateBookQrCodeKey(slug, order, file.originalname);
          const { url } = await uploadBufferToS3(file.buffer, key, file.mimetype, {
            acl: 'public-read',
          });
          uploadedKeys.push(key);
          qrCodeImage = buildImageResponse(file, key, url);
        } else if (removeQrImage) {
          if (qrCodeImage?.key) {
            keysToDelete.push(qrCodeImage.key);
          }
          qrCodeImage = null;
        }

        coverConfig.qrCodeImage = qrCodeImage;
        pageData.cover = coverConfig;
      } else {
        if (existingCover?.qrCodeImage?.key) {
          keysToDelete.push(existingCover.qrCodeImage.key);
        }
        pageData.cover = null;
      }

      pages.push(pageData);
    }

    if (pageImageCursor !== pageImageFiles.length) {
      throw new Error(
        `Received ${pageImageFiles.length} page images but only ${
          pageImageCursor
        } were mapped. Ensure files align with pages.`
      );
    }

    for (const existingPage of book.pages) {
      const idString = existingPage._id.toString();
      if (!providedPageIds.has(idString)) {
      if (existingPage.backgroundImage?.key) {
        keysToDelete.push(existingPage.backgroundImage.key);
      } else if (existingPage.characterImage?.key) {
        keysToDelete.push(existingPage.characterImage.key);
      }
      if (existingPage.cover?.qrCodeImage?.key) {
        keysToDelete.push(existingPage.cover.qrCodeImage.key);
      }
    }
  }

    if (typeof name !== 'undefined') {
      book.name = name;
    }
    if (typeof description !== 'undefined') {
      book.description = description;
    }
    if (typeof status !== 'undefined') {
      book.status = status;
    }
    book.pages = pages;

    // Handle cover page data
    if (req.body.coverPage) {
      const coverPagePayload =
        typeof req.body.coverPage === 'string'
          ? JSON.parse(req.body.coverPage)
          : req.body.coverPage;

      const coverPageBgFile =
        req.files?.coverPageBackgroundImage?.[0] || req.files?.coverImage?.[0] || null;
      const coverPageQrFile = req.files?.coverPageQrCode?.[0];

      let backgroundImage = book.coverPage?.backgroundImage || null;
      let qrCode = book.coverPage?.qrCode || null;

      // Handle background image
      if (coverPageBgFile) {
        if (backgroundImage?.key) {
          keysToDelete.push(backgroundImage.key);
        }
        const bgKey = `books/${slug}/cover-page/background-${Date.now()}.${coverPageBgFile.originalname.split('.').pop()}`;
        const { url } = await uploadBufferToS3(
          coverPageBgFile.buffer,
          bgKey,
          coverPageBgFile.mimetype,
          {
            acl: 'public-read',
          }
        );
        uploadedKeys.push(bgKey);
        backgroundImage = buildImageResponse(coverPageBgFile, bgKey, url);
      } else if (coverPagePayload.removeBackgroundImage) {
        if (backgroundImage?.key) {
          keysToDelete.push(backgroundImage.key);
        }
        backgroundImage = null;
      }

      // Handle QR code
      if (coverPageQrFile) {
        if (qrCode?.key) {
          keysToDelete.push(qrCode.key);
        }
        const qrKey = `books/${slug}/cover-page/qr-${Date.now()}.${coverPageQrFile.originalname.split('.').pop()}`;
        const { url } = await uploadBufferToS3(
          coverPageQrFile.buffer,
          qrKey,
          coverPageQrFile.mimetype,
          {
            acl: 'public-read',
          }
        );
        uploadedKeys.push(qrKey);
        qrCode = buildImageResponse(coverPageQrFile, qrKey, url);
      } else if (coverPagePayload.removeQrCode) {
        if (qrCode?.key) {
          keysToDelete.push(qrCode.key);
        }
        qrCode = null;
      }

      const coverPromptFields = extractPromptFields(coverPagePayload || {});
      book.coverPage = {
        backgroundImage,
        leftSide: {
          title: normalizeString(coverPagePayload.leftSide?.title),
          content: normalizeString(coverPagePayload.leftSide?.content),
          bottomText: normalizeString(coverPagePayload.leftSide?.bottomText),
        },
        qrCode,
        rightSide: {
          mainTitle: normalizeString(coverPagePayload.rightSide?.mainTitle),
          subtitle: normalizeString(coverPagePayload.rightSide?.subtitle),
        },
        characterPromptMale: coverPromptFields.promptMale,
        characterPromptFemale: coverPromptFields.promptFemale,
      };
    }

    // Handle dedication page data
    if (req.body.dedicationPage) {
      const dedicationPagePayload = typeof req.body.dedicationPage === 'string'
        ? JSON.parse(req.body.dedicationPage)
        : req.body.dedicationPage;

      const dedicationBgFile = req.files?.dedicationPageBackgroundImage?.[0];

      let dedicationBackgroundImage = book.dedicationPage?.backgroundImage || null;

      // Handle background image
      if (dedicationBgFile) {
        if (dedicationBackgroundImage?.key) {
          keysToDelete.push(dedicationBackgroundImage.key);
        }
        const bgKey = `books/${slug}/dedication-page/background-${Date.now()}.${dedicationBgFile.originalname.split('.').pop()}`;
        const { url } = await uploadBufferToS3(dedicationBgFile.buffer, bgKey, dedicationBgFile.mimetype, {
          acl: 'public-read',
        });
        uploadedKeys.push(bgKey);
        dedicationBackgroundImage = buildImageResponse(dedicationBgFile, bgKey, url);
      } else if (dedicationPagePayload.removeBackgroundImage) {
        if (dedicationBackgroundImage?.key) {
          keysToDelete.push(dedicationBackgroundImage.key);
        }
        dedicationBackgroundImage = null;
      }

      const dedicationPromptFields = extractPromptFields(dedicationPagePayload || {});
      book.dedicationPage = {
        backgroundImage: dedicationBackgroundImage,
        title: normalizeString(dedicationPagePayload.title),
        secondTitle: normalizeString(dedicationPagePayload.secondTitle),
        characterPromptMale: dedicationPromptFields.promptMale,
        characterPromptFemale: dedicationPromptFields.promptFemale,
      };
    }

    // Save with version conflict handling
    let updatedBook;
    try {
      // Disable version checking for this complex update operation
      updatedBook = await book.save({ validateBeforeSave: true });
    } catch (versionError) {
      // If version error occurs, refetch and retry once
      if (versionError.name === 'VersionError') {
        console.log('Version conflict detected, retrying update...');

        // Refetch the book with the latest version
        const freshBook = await Book.findById(id);
        if (!freshBook) {
          throw new Error('Book not found during retry');
        }

        // Apply all the changes again to the fresh document
        freshBook.name = book.name;
        freshBook.description = book.description;
        freshBook.status = book.status;
        freshBook.pages = book.pages;
        freshBook.coverPage = book.coverPage;
        freshBook.dedicationPage = book.dedicationPage;
        freshBook.updatedAt = new Date();

        // Retry save without version checking
        updatedBook = await freshBook.save({ validateBeforeSave: true });
      } else {
        throw versionError;
      }
    }

    await cleanupKeys(keysToDelete);

    let responseData = updatedBook;
    if (req.returnEditablePayload) {
      const hydrated = await hydrateBookDocument(updatedBook);
      responseData = buildEditableBookResponse(hydrated);
    }

    res.status(200).json({
      success: true,
      message: 'Book updated successfully',
      data: responseData,
    });
  } catch (error) {
    console.error('Error updating book:', error);
    await cleanupKeys(uploadedKeys);
    res.status(500).json({
      success: false,
      message: 'Failed to update book',
      error: error.message,
    });
  }
};

/**
 * @route DELETE /api/books/:id
 */
exports.deleteBook = async (req, res) => {
  try {
    const { id } = req.params;
    const book = await Book.findById(id);

    if (!book) {
      return res.status(404).json({
        success: false,
        message: 'Book not found',
      });
    }

    const keysToDelete = new Set();

    const collectAssetKey = (asset) => {
      if (asset && asset.key && typeof asset.key === 'string') {
        keysToDelete.add(asset.key);
      }
    };

    const collectAssetListKeys = (assets) => {
      if (!Array.isArray(assets)) return;
      assets.forEach((asset) => collectAssetKey(asset));
    };

    // Book-level assets (authored content)
    if (Array.isArray(book.pages)) {
      book.pages.forEach((page) => {
        collectAssetKey(page.backgroundImage);
      });
    }

    if (book.coverPage) {
      collectAssetKey(book.coverPage.backgroundImage);
      collectAssetKey(book.coverPage.qrCode);
    }

    if (book.dedicationPage) {
      collectAssetKey(book.dedicationPage.backgroundImage);
    }

    // Storybook job assets for this book
    const jobs = await StorybookJob.find({ bookId: id }).lean();
    jobs.forEach((job) => {
      if (Array.isArray(job.pages)) {
        job.pages.forEach((page) => {
          collectAssetKey(page.characterAsset);
          collectAssetKey(page.characterAssetOriginal);
          collectAssetListKeys(page.candidateAssets);
        });
      }

      if (job.pdfAsset) {
        collectAssetKey(job.pdfAsset);
        if (Array.isArray(job.pdfAsset.pages)) {
          job.pdfAsset.pages.forEach((pdfPage) => {
            collectAssetKey(pdfPage.background);
            collectAssetKey(pdfPage.character);
            collectAssetKey(pdfPage.renderedImage);
          });
        }
      }
    });

    // Generation assets tied to this book's storybooks
    const generations = await Generation.find({
      'storybookContext.bookId': id,
    }).lean();

    generations.forEach((generation) => {
      collectAssetListKeys(generation.imageAssets);
    });

    // Delete DB documents
    await Promise.all([
      StorybookJob.deleteMany({ bookId: id }),
      Generation.deleteMany({ 'storybookContext.bookId': id }),
      Book.findByIdAndDelete(id),
    ]);

    // Best-effort S3 cleanup
    if (keysToDelete.size > 0) {
      await cleanupKeys(Array.from(keysToDelete));
    }

    res.status(200).json({
      success: true,
      message: 'Book deleted successfully',
      data: {},
    });
  } catch (error) {
    console.error('Error deleting book:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete book',
      error: error.message,
    });
  }
};

// Legacy book-level storybook endpoints have been removed in favour of StorybookJob-based APIs.

/**
 * @route POST /api/books/:id/storybooks
 */
exports.generateStorybook = async (req, res) => {
  return res.status(410).json({
    success: false,
    message:
      'Direct storybook generation via /books/:id/storybooks has been removed. Use /books/:id/storybooks/auto instead.',
  });
};

/**
 * @route POST /api/books/:id/storybooks/:assetId/pages/:pageOrder/regenerate
 */
exports.regenerateStorybookPage = async (req, res) => {
  return res.status(410).json({
    success: false,
    message:
      'Page regeneration via /books/:id/storybooks/:assetId/pages/:pageOrder/regenerate has been removed. Use StorybookJob automation instead.',
  });
};

exports.regenerateStorybookPdf = async (req, res) => {
  return res.status(410).json({
    success: false,
    message:
      'PDF regeneration via /books/:id/storybooks/:assetId/regenerate has been removed. Use StorybookJob.pdfAsset instead.',
  });
};

exports.confirmStorybookPdf = async (req, res) => {
  return res.status(410).json({
    success: false,
    message:
      'Storybook confirmation and split PDF generation are no longer stored on books. Use StorybookJob.pdfAsset directly.',
  });
};

exports.selectStorybookPageCandidate = async (req, res) => {
  return res.status(410).json({
    success: false,
    message:
      'Candidate selection is now handled via StorybookJob APIs.',
  });
};

/**
 * @route PATCH /api/books/:id/status
 */
exports.updateBookStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['active', 'inactive'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Status must be active or inactive',
      });
    }

    const book = await Book.findByIdAndUpdate(
      id,
      { status },
      { new: true, runValidators: true }
    );

    if (!book) {
      return res.status(404).json({
        success: false,
        message: 'Book not found',
      });
    }

    res.status(200).json({
      success: true,
      message: `Book ${status === 'active' ? 'activated' : 'deactivated'} successfully`,
      data: book,
    });
  } catch (error) {
    console.error('Error updating book status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update book status',
      error: error.message,
    });
  }
};

exports.generateCoverPreview = async (req, res) => {
  try {
    const { leftSide, rightSide, backgroundImageUrl, qrCodeUrl } = req.body;
    const files = req.files || {};

    // Parse JSON data
    const leftSideData = leftSide ? JSON.parse(leftSide) : {};
    const rightSideData = rightSide ? JSON.parse(rightSide) : {};

    // Get background image (either from file upload or URL)
    let backgroundImageBuffer;
    if (files.backgroundImage && files.backgroundImage[0]) {
      backgroundImageBuffer = files.backgroundImage[0].buffer;
    } else if (backgroundImageUrl) {
      // If URL is provided, we'll pass it to the generator
      // The generator can handle fetching from S3 signed URL
    } else {
      return res.status(400).json({
        success: false,
        message: 'Background image is required',
      });
    }

    // Get QR code image (optional)
    let qrCodeBuffer;
    if (files.qrCode && files.qrCode[0]) {
      qrCodeBuffer = files.qrCode[0].buffer;
    }

    // Import the cover generator
    const { generateCoverPage } = require('../utils/coverGenerator');

    // Generate the cover preview
    const previewChildName =
      typeof req.body?.childName === 'string' && req.body.childName.trim()
        ? req.body.childName.trim()
        : typeof leftSideData.childName === 'string' && leftSideData.childName.trim()
        ? leftSideData.childName.trim()
        : '';

    const previewBuffer = await generateCoverPage({
      backgroundImage: backgroundImageBuffer || backgroundImageUrl,
      characterImage: null,
      leftSide: leftSideData,
      rightSide: rightSideData,
      qrCode: qrCodeBuffer || qrCodeUrl,
      childName: previewChildName,
      usePreviewMargin: true, // Enable 1 inch margin for preview
    });

    // Upload to S3 temporarily with a preview key
    const previewKey = `temp/cover-previews/${Date.now()}-${Math.random().toString(36).substring(7)}.png`;
    await uploadBufferToS3(previewBuffer, previewKey, 'image/png');

    // Get a signed URL for the preview (expires in 1 hour)
    const previewUrl = await getSignedUrlForKey(previewKey, 3600);

    res.status(200).json({
      success: true,
      message: 'Cover preview generated successfully',
      data: {
        previewUrl,
        previewKey,
      },
    });
  } catch (error) {
    console.error('Error generating cover preview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate cover preview',
      error: error.message,
    });
  }
};

exports.generateDedicationPreview = async (req, res) => {
  try {
    const { title, secondTitle, backgroundImageUrl } = req.body;
    const files = req.files || {};

    // Get background image (either from file upload or URL)
    let backgroundImageSource;
    if (files.backgroundImage && files.backgroundImage[0]) {
      backgroundImageSource = files.backgroundImage[0].buffer;
    } else if (backgroundImageUrl) {
      backgroundImageSource = backgroundImageUrl;
    } else {
      return res.status(400).json({
        success: false,
        message: 'Background image is required',
      });
    }

    // Import the dedication generator
    const { generateDedicationPage } = require('../utils/dedicationGenerator');

    // Generate the dedication preview
    const previewBuffer = await generateDedicationPage({
      backgroundImage: backgroundImageSource,
      kidImage: null,
      title: title || '',
      secondTitle: secondTitle || '',
    });

    // Upload to S3 temporarily with a preview key
    const previewKey = `temp/dedication-previews/${Date.now()}-${Math.random().toString(36).substring(7)}.png`;
    await uploadBufferToS3(previewBuffer, previewKey, 'image/png');

    // Get a signed URL for the preview (expires in 1 hour)
    const previewUrl = await getSignedUrlForKey(previewKey, 3600);

    res.status(200).json({
      success: true,
      message: 'Dedication preview generated successfully',
      data: {
        previewUrl,
        previewKey,
      },
    });
  } catch (error) {
    console.error('Error generating dedication preview:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate dedication preview',
      error: error.message,
    });
  }
};
