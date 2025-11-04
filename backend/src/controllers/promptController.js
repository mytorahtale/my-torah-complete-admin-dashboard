const fetch = require('node-fetch');
const { validationResult } = require('express-validator');
const Prompt = require('../models/Prompt');
const {
  uploadBufferToS3,
  deleteFromS3,
  generatePromptImageKey,
} = require('../config/s3');

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-4o-mini-2024-07-18';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_APP_URL = process.env.OPENROUTER_APP_URL || 'https://example.com';
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'AI Book Story';

const SYSTEM_INSTRUCTION = `
You are an expert visual prompt engineer. Given a single reference image of a child, produce a clean, photorealistic prompt that can regenerate the same child for fine-tuning.

Output requirements:
- Compose the response as 2–3 sentences that each begin with a strong action verb such as "Generate", "Create", or "Capture", followed by a final sentence that begins with "Do not include".
- The descriptive sentences must cover only what is visibly present (pose, facing direction, expression, detailed wardrobe with colours and textures, held items, lighting, framing, camera angle, setting cues). Combine related details naturally rather than repeating rigid prefixes.
- If the child is interacting with notable props (holding an item, sitting on or riding something, leaning against an object), describe that interaction accurately in the same sentence as the relevant pose details.
- If the image clearly conveys cultural or regional cues tied to Israel, Jerusalem, or related traditions (buildings, attire, ceremonial items, landscapes), weave those into the description naturally.
- One descriptive sentence must clearly state that the background is completely absent (transparent alpha channel or featureless neutral void) so the subject can be composited elsewhere.
- If the reference image shows a kippah (skullcap), explicitly mention it.
- If the reference image shows notable garments, uniforms, accessories, jewellery, fabric patterns, or modern/casual dress cues, describe them precisely, including the exact garment type (e.g. t-shirt, button-up shirt, kurta, dress), colours, textures, and whether the look is formal, casual, sporty, traditional, etc.
- If the child is interacting with notable props (holding an item, sitting on or riding something, leaning against an object), describe that interaction accurately in the same sentence as the relevant pose details, naming the object clearly.
- Never mention or speculate about hair colour, eye colour, skin tone, ethnicity, or age. Do not fabricate traits that aren’t visible in the reference.
- Do not reference other people, animals, props, or scenery unless they genuinely appear in the image.
- The final "Do not include" sentence must list all exclusions in a natural way (e.g. “Do not include any background elements, additional people, animals, props, harsh shadows, painterly styles, or blur beyond the neutral void.”).
- Return strictly valid JSON with a single key "prompt" whose value is the multi-sentence text described above. All wording must be generated fresh from the visual cues—avoid stock phrasing.
`;

const parseApiResponse = (content) => {
  if (!content) {
    throw new Error('LLM returned an empty response');
  }

  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
      ? content
          .map((segment) =>
            typeof segment === 'string' ? segment : segment?.text || ''
          )
          .join('\n')
      : '';

  if (!raw.trim()) {
    throw new Error('LLM returned an empty response');
  }

  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const jsonString = jsonMatch ? jsonMatch[1] : raw;

  try {
    const payload = JSON.parse(jsonString);
    if (!payload.prompt) {
      throw new Error('Missing "prompt" key in LLM response');
    }
    return {
      prompt: payload.prompt,
      negative_prompt: payload.negative_prompt || '',
    };
  } catch (error) {
    throw new Error(`Failed to parse LLM response: ${error.message}`);
  }
};

const escapeRegex = (value) =>
  typeof value === 'string' ? value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';

const toPositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const normalizeTags = (tags) => {
    if (!tags) return [];
    const source = Array.isArray(tags) ? tags : [tags];
    const seen = new Set();
    const result = [];
    source.forEach((entry) => {
    if (typeof entry !== 'string') return;
      const trimmed = entry.trim();
      if (!trimmed) return;
      const lower = trimmed.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      result.push(lower);
    });
    return result.slice(0, 12);
  };

const serializePrompt = (doc) => {
  if (!doc) return null;
  return {
    id: doc.id,
    promptId: doc.id,
    fileName: doc.fileName,
    prompt: doc.prompt,
    negativePrompt: doc.negativePrompt,
    additionalContext: doc.additionalContext,
    imageUrl: doc.s3Url,
    mimeType: doc.mimeType,
    size: doc.size,
    provider: doc.provider,
    model: doc.model,
    status: doc.status,
    quality: doc.quality,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

exports.createPrompt = async (req, res) => {
  const file = req.file;
  const promptRaw = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';

  if (!file) {
    return res.status(400).json({
      success: false,
      message: 'Upload a reference image to save the prompt.',
    });
  }

  if (!promptRaw) {
    return res.status(400).json({
      success: false,
      message: 'Provide prompt text before saving.',
    });
  }

  const additionalContextRaw =
    typeof req.body?.additionalContext === 'string'
      ? req.body.additionalContext.trim()
      : '';
  const negativePromptRaw =
    typeof req.body?.negativePrompt === 'string'
      ? req.body.negativePrompt.trim()
      : '';
  const providerRaw =
    typeof req.body?.provider === 'string' ? req.body.provider.trim() : '';
  const modelRaw =
    typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  const qualityRaw =
    typeof req.body?.quality === 'string' ? req.body.quality.trim().toLowerCase() : '';

  const normalizedAdditionalContext = additionalContextRaw || null;
  const normalizedNegativePrompt = negativePromptRaw || null;
  const resolvedProvider = providerRaw || 'openrouter';
  const resolvedModel = modelRaw || OPENROUTER_MODEL;
  const allowedQualities = new Set(['neutral', 'good']);
  const resolvedQuality = allowedQualities.has(qualityRaw)
    ? qualityRaw
    : 'neutral';

  const tagsRaw = req.body?.tags;
  const normalizedTags = normalizeTags(tagsRaw);

  const mimeType = file.mimetype || 'image/jpeg';
  const size = file.size || 0;

  let uploadResult = null;

  try {
    const uploadKey = generatePromptImageKey(file.originalname);
    uploadResult = await uploadBufferToS3(file.buffer, uploadKey, mimeType);

    const promptDocument = await Prompt.create({
      fileName: file.originalname,
      mimeType,
      size,
      prompt: promptRaw,
      negativePrompt: normalizedNegativePrompt,
      additionalContext: normalizedAdditionalContext,
      s3Key: uploadResult.key,
      s3Url: uploadResult.url,
      provider: resolvedProvider,
      model: resolvedModel,
      status: 'succeeded',
      quality: resolvedQuality,
      tags: normalizedTags,
      requestContext: {
        source: 'manual-save',
      },
    });

    res.status(201).json({
      success: true,
      data: serializePrompt(promptDocument),
    });
  } catch (error) {
    if (uploadResult?.key) {
      await deleteFromS3(uploadResult.key).catch((cleanupError) =>
        console.warn(
          `Failed to clean up prompt asset ${uploadResult.key}: ${cleanupError.message}`
        )
      );
    }

    console.error('Error saving prompt:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save prompt',
      error: error.message,
    });
  }
};

exports.generatePrompts = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array(),
    });
  }

  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({
      success: false,
      message:
        'OPENROUTER_API_KEY is not configured. Add it to the environment before generating prompts.',
    });
  }

  const files = Array.isArray(req.files) ? req.files : [];
  if (!files.length) {
    return res.status(400).json({
      success: false,
      message: 'Upload at least one image to generate prompts.',
    });
  }

  try {
    const additionalContextRaw =
      typeof req.body.additionalContext === 'string'
        ? req.body.additionalContext
        : '';
    const normalizedAdditionalContext = additionalContextRaw.trim() || null;

    const results = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const mime = file.mimetype || 'image/jpeg';

      const base64 = file.buffer.toString('base64');
      const dataUrl = `data:${mime};base64,${base64}`;

      const userContent = [];

      if (normalizedAdditionalContext) {
        userContent.push({
          type: 'text',
          text: normalizedAdditionalContext,
        });
      }

      userContent.push({
        type: 'text',
        text: 'Use the following reference image to extract visual details. Do not fabricate traits that are not visible.',
      });

      userContent.push({
        type: 'image_url',
        image_url: {
          url: dataUrl,
        },
      });

      const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': OPENROUTER_APP_URL,
          'X-Title': OPENROUTER_APP_NAME,
        },
        body: JSON.stringify({
          model: OPENROUTER_MODEL,
          messages: [
            {
              role: 'system',
              content: SYSTEM_INSTRUCTION,
            },
            {
              role: 'user',
              content: userContent,
            },
          ],
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        const errorPayload = await response.text();
        throw new Error(
          `OpenRouter request failed (${response.status}): ${errorPayload}`
        );
      }

      const payload = await response.json();
      const choice = payload?.choices?.[0]?.message;
      const parsed = parseApiResponse(choice?.content);
      const trimmedPrompt = parsed.prompt?.trim?.() || '';
      const trimmedNegative = parsed.negative_prompt?.trim?.() || '';
      const mergedPrompt =
        trimmedNegative && trimmedNegative.length > 0
          ? `${trimmedPrompt}${trimmedPrompt.endsWith('.') ? '' : '.'}\nDo not: ${trimmedNegative}`
          : trimmedPrompt;

      results.push({
        position: index,
        fileName: file.originalname,
        mimeType: mime,
        size: file.size || 0,
        prompt: mergedPrompt,
        negativePrompt: trimmedNegative || null,
        additionalContext: normalizedAdditionalContext,
      });
    }

    res.status(200).json({
      success: true,
      count: results.length,
      data: results,
    });
  } catch (error) {
    console.error('Error generating prompts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate prompts',
      error: error.message,
    });
  }
};

exports.listPrompts = async (req, res) => {
  try {
    const rawPage = toPositiveInteger(req.query.page, 1);
    const rawLimit = toPositiveInteger(req.query.limit, 10);
    const limit = Math.min(rawLimit, 100);
    const searchRaw = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const allowedSortFields = new Set(['createdAt', 'fileName']);
    const requestedSortBy = typeof req.query.sortBy === 'string' ? req.query.sortBy : 'createdAt';
    const resolvedSortField = allowedSortFields.has(requestedSortBy) ? requestedSortBy : 'createdAt';
    const sortOrderRaw = req.query.sortOrder === 'asc' ? 1 : -1;

    const filters = {};
    if (searchRaw) {
      const expression = new RegExp(escapeRegex(searchRaw), 'i');
      filters.$or = [
        { prompt: expression },
        { fileName: expression },
        { additionalContext: expression },
      ];
    }
    if (typeof req.query.quality === 'string' && req.query.quality !== 'all') {
      const quality = req.query.quality.trim().toLowerCase();
      if (['neutral', 'good'].includes(quality)) {
        filters.quality = quality;
      }
    }
    if (typeof req.query.tags === 'string' && req.query.tags.trim()) {
      const parsedTags = normalizeTags(req.query.tags.split(','));
      if (parsedTags.length > 0) {
        filters.tags = { $all: parsedTags };
      }
    }

    const [total, qualityStats] = await Promise.all([
      Prompt.countDocuments(filters),
      Prompt.aggregate([
        {
          $group: {
            _id: '$quality',
            count: { $sum: 1 },
          },
        },
      ]),
    ]);
    const totalPages =
      limit > 0 && total > 0 ? Math.ceil(total / limit) : total > 0 ? 1 : 0;

    const effectivePage =
      limit > 0 && totalPages > 0
        ? Math.min(Math.max(rawPage, 1), totalPages)
        : 1;

    const skip = limit > 0 ? (effectivePage - 1) * limit : 0;

    const sort = { [resolvedSortField]: sortOrderRaw, _id: sortOrderRaw };
    const query = Prompt.find(filters).sort(sort);
    if (limit > 0) {
      query.skip(skip).limit(limit);
    }

    const items = await query.lean();

    const data = items.map((item) => ({
      id: item._id.toString(),
      promptId: item._id.toString(),
      fileName: item.fileName,
      prompt: item.prompt,
      negativePrompt: item.negativePrompt,
      additionalContext: item.additionalContext,
      imageUrl: item.s3Url,
      mimeType: item.mimeType,
      size: item.size,
      provider: item.provider,
      model: item.model,
      status: item.status,
      quality: item.quality,
      tags: Array.isArray(item.tags) ? item.tags : [],
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));

    res.status(200).json({
      success: true,
      count: data.length,
      data,
      pagination: {
        page: totalPages === 0 ? 1 : effectivePage,
        limit,
        total,
        totalPages,
        hasNextPage: limit > 0 && effectivePage < totalPages,
        hasPrevPage: limit > 0 && effectivePage > 1,
      },
      filters: {
        search: searchRaw,
        quality:
          typeof filters.quality === 'string' ? filters.quality : 'all',
        tags: Array.isArray(filters?.tags?.$all) ? filters.tags.$all : [],
        sortBy: resolvedSortField,
        sortOrder: sortOrderRaw === 1 ? 'asc' : 'desc',
      },
      stats: qualityStats.reduce(
        (acc, item) => {
          if (item?._id === 'good') {
            acc.totalGood = item.count;
          } else if (item?._id === 'neutral') {
            acc.totalNeutral = item.count;
          }
          acc.totalTracked += item.count;
          return acc;
        },
        { totalGood: 0, totalNeutral: 0, totalTracked: 0 }
      ),
    });
  } catch (error) {
    console.error('Error fetching prompts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch prompts',
      error: error.message,
    });
  }
};

exports.getPromptById = async (req, res) => {
  try {
    const prompt = await Prompt.findById(req.params.id);

    if (!prompt) {
      return res.status(404).json({
        success: false,
        message: 'Prompt not found',
      });
    }

    res.status(200).json({
      success: true,
      data: serializePrompt(prompt),
    });
  } catch (error) {
    console.error('Error fetching prompt:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? 'Invalid prompt identifier' : 'Failed to fetch prompt',
      error: status === 400 ? undefined : error.message,
    });
  }
};

exports.updatePrompt = async (req, res) => {
  const promptId = req.params.id;
  const promptRaw =
    typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : undefined;
  const additionalContextRaw =
    typeof req.body?.additionalContext === 'string'
      ? req.body.additionalContext.trim()
      : undefined;
  const negativePromptRaw =
    typeof req.body?.negativePrompt === 'string'
      ? req.body.negativePrompt.trim()
      : undefined;

  if (
    promptRaw === undefined &&
    additionalContextRaw === undefined &&
    negativePromptRaw === undefined
  ) {
    return res.status(400).json({
      success: false,
      message: 'Provide prompt text or additional context to update.',
    });
  }

  if (promptRaw !== undefined && !promptRaw) {
    return res.status(400).json({
      success: false,
      message: 'Prompt text cannot be empty.',
    });
  }

  const updatePayload = {};
  if (promptRaw !== undefined) {
    updatePayload.prompt = promptRaw;
  }
  if (additionalContextRaw !== undefined) {
    updatePayload.additionalContext = additionalContextRaw || null;
  }
  if (negativePromptRaw !== undefined) {
    updatePayload.negativePrompt = negativePromptRaw || null;
  }

  try {
    const prompt = await Prompt.findByIdAndUpdate(promptId, updatePayload, {
      new: true,
      runValidators: true,
    });

    if (!prompt) {
      return res.status(404).json({
        success: false,
        message: 'Prompt not found',
      });
    }

    res.status(200).json({
      success: true,
      data: serializePrompt(prompt),
    });
  } catch (error) {
    console.error('Error updating prompt:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? 'Invalid prompt identifier' : 'Failed to update prompt',
      error: status === 400 ? undefined : error.message,
    });
  }
};

exports.updatePromptQuality = async (req, res) => {
  try {
    const { quality } = req.body || {};
    const allowed = ['neutral', 'good'];

    if (!quality || !allowed.includes(String(quality).toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: 'Provide a valid quality value (neutral | good)',
      });
    }

    const prompt = await Prompt.findByIdAndUpdate(
      req.params.id,
      {
        quality: quality.toLowerCase(),
      },
      {
        new: true,
      }
    );

    if (!prompt) {
      return res.status(404).json({
        success: false,
        message: 'Prompt not found',
      });
    }

    res.status(200).json({
      success: true,
      data: serializePrompt(prompt),
    });
  } catch (error) {
    console.error('Error updating prompt quality:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? 'Invalid prompt identifier' : 'Failed to update prompt quality',
      error: status === 400 ? undefined : error.message,
    });
  }
};

exports.updatePromptTags = async (req, res) => {
  try {
    const normalizedTags = normalizeTags(req.body?.tags);

    const prompt = await Prompt.findByIdAndUpdate(
      req.params.id,
      {
        tags: normalizedTags,
      },
      {
        new: true,
      }
    );

    if (!prompt) {
      return res.status(404).json({
        success: false,
        message: 'Prompt not found',
      });
    }

    res.status(200).json({
      success: true,
      data: serializePrompt(prompt),
    });
  } catch (error) {
    console.error('Error updating prompt tags:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? 'Invalid prompt identifier' : 'Failed to update prompt tags',
      error: status === 400 ? undefined : error.message,
    });
  }
};

exports.deletePrompt = async (req, res) => {
  try {
    const prompt = await Prompt.findById(req.params.id);
    if (!prompt) {
      return res.status(404).json({
        success: false,
        message: 'Prompt not found',
      });
    }

    if (prompt.s3Key) {
      await deleteFromS3(prompt.s3Key).catch((error) =>
        console.warn(`Failed to remove prompt asset ${prompt.s3Key}: ${error.message}`)
      );
    }

    await prompt.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Prompt deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting prompt:', error);
    const status = error.name === 'CastError' ? 400 : 500;
    res.status(status).json({
      success: false,
      message: status === 400 ? 'Invalid prompt identifier' : 'Failed to delete prompt',
      error: status === 400 ? undefined : error.message,
    });
  }
};
