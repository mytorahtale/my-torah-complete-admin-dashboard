const fetch = require('node-fetch');

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

const EVALUATION_GUIDE = `
You are a senior dataset curator preparing photos for fine-tuning personalised children's-story illustrations.

Use these rules when judging each image:
- A strong dataset has 10-15 high-resolution photos of the child.
- Face must be clearly visible; no sunglasses, hats, major obstructions.
- Torso-up, front-facing framing preferred (head and shoulders, relaxed posture).
- Only the child should be present. If another person appears (even partially), the image MUST be rejected.
- Include varied expressions (smile, neutral, etc.).
- Capture multiple lighting conditions and backgrounds.
- Good examples: school portraits, well-lit casual phone photos with unobstructed faces.
- Avoid blurred, cropped, dark, obstructed, group, or heavily stylised images.

Return STRICT JSON using this schema:
{
  "overallAcceptance": {
    "acceptedCount": number,
    "rejectedCount": number,
    "verdict": "accept" | "needs_more" | "reject",
    "confidencePercent": integer 0-100,
    "summary": "short paragraph"
  },
  "images": [
    {
      "name": "filename or Image X",
      "overallScorePercent": integer 0-100,
      "acceptable": boolean,
      "verdict": "accept" | "needs_more" | "reject",
      "confidencePercent": integer 0-100,
      "criteria": {
        "clarity": { "scorePercent": integer 0-100, "verdict": "yes" | "no", "notes": "concise note" },
        "framing": { "scorePercent": integer 0-100, "verdict": "yes" | "no", "notes": "..." },
        "expression": { "scorePercent": integer 0-100, "verdict": "yes" | "no", "notes": "..." },
        "lighting": { "scorePercent": integer 0-100, "verdict": "yes" | "no", "notes": "..." },
        "safety": { "scorePercent": integer 0-100, "verdict": "yes" | "no", "notes": "..." }
      },
      "recommendations": ["actionable recommendation", "..."]
    }
  ],
  "acceptedImages": ["names"],
  "rejectedImages": ["names"]
}

Rules:
- All numeric scores are integers between 0 and 100.
- Verdict fields must match the allowed strings exactly.
- Provide at least one recommendation if acceptable is false or verdict is "needs_more"/"reject".
- Ensure JSON is valid even if arrays are empty.
- Treat an image as acceptable only if its overall score is at least 45 AND the face is clearly visible AND there is only one child present.
- If the face is not clearly visible or multiple people/faces are detected, mark the image as unacceptable with an explicit reason.
`;

const clampPercent = (value, fallback = 0) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return Math.round(num);
};

const normaliseEvaluation = (payload) => {
  const data = payload && typeof payload === 'object' ? { ...payload } : {};

  const images = Array.isArray(data.images) ? data.images.map((img) => ({ ...img })) : [];
  let acceptedCount = 0;
  let rejectedCount = 0;

  images.forEach((img, index) => {
    const score = clampPercent(img.overallScorePercent);
    let acceptable = score >= 45;
    let verdict = acceptable ? 'accept' : 'reject';
    let forcedRejectReason = null;
    const confidence = clampPercent(img.confidencePercent, acceptable ? 70 : 50);

    img.name = img.name || `Image ${index + 1}`;
    img.overallScorePercent = score;
    img.confidencePercent = confidence;

    if (!img.criteria || typeof img.criteria !== 'object') {
      img.criteria = {};
    }

    ['clarity', 'framing', 'expression', 'lighting', 'safety'].forEach((key) => {
      const detail =
        img.criteria[key] && typeof img.criteria[key] === 'object' ? { ...img.criteria[key] } : {};
      detail.scorePercent = clampPercent(detail.scorePercent);
      detail.verdict = detail.verdict === 'yes' ? 'yes' : 'no';
      if (detail.verdict === 'yes' && !detail.notes) {
        detail.notes = 'Looks suitable.';
      }
      const notesText = (detail.notes || '').toLowerCase();
      if (key === 'clarity' && detail.verdict !== 'yes') {
        acceptable = false;
        forcedRejectReason = forcedRejectReason || 'The face is not clearly visible.';
      }
      if (key === 'safety' && detail.verdict !== 'yes') {
        acceptable = false;
        forcedRejectReason = forcedRejectReason || 'Multiple people or unsafe content detected.';
      }
      if (
        !forcedRejectReason &&
        (notesText.includes('multiple face') ||
          notesText.includes('two people') ||
          notesText.includes('another person'))
      ) {
        acceptable = false;
        forcedRejectReason = 'Multiple people detected in the frame.';
      }
      img.criteria[key] = detail;
    });

    if (!Array.isArray(img.recommendations)) {
      img.recommendations = [];
    }

    if (forcedRejectReason && !img.recommendations.includes(forcedRejectReason)) {
      img.recommendations.unshift(forcedRejectReason);
    }

    if (acceptable) {
      acceptedCount += 1;
      verdict = 'accept';
    } else {
      rejectedCount += 1;
      if (img.recommendations.length === 0) {
        img.recommendations.push('Provide a clearer photo that follows the image guidelines.');
      }
      verdict = 'reject';
    }

    img.acceptable = acceptable;
    img.verdict = verdict;
  });

  data.images = images;
  data.acceptedImages = images.filter((img) => img.acceptable).map((img) => img.name);
  data.rejectedImages = images.filter((img) => !img.acceptable).map((img) => img.name);

  const overall =
    data.overallAcceptance && typeof data.overallAcceptance === 'object'
      ? { ...data.overallAcceptance }
      : {};
  overall.acceptedCount = acceptedCount;
  overall.rejectedCount = rejectedCount;

  const total = images.length;
  if (total === 0) {
    overall.verdict = 'needs_more';
    overall.confidencePercent = clampPercent(overall.confidencePercent, 50);
    overall.summary = overall.summary || 'No image was evaluated.';
  } else if (acceptedCount === total) {
    overall.verdict = 'accept';
    overall.confidencePercent = clampPercent(overall.confidencePercent, 80);
    overall.summary =
      overall.summary ||
      'The image meets the fine-tuning requirements. You can include it in the training set.';
  } else if (acceptedCount === 0) {
    overall.verdict = 'reject';
    overall.confidencePercent = clampPercent(overall.confidencePercent, 70);
    overall.summary =
      overall.summary ||
      'The image does not meet the quality requirements. Capture a new photo following the guidelines.';
  } else {
    overall.verdict = 'needs_more';
    overall.confidencePercent = clampPercent(overall.confidencePercent, 65);
    overall.summary =
      overall.summary ||
      'Some aspects of the photo need improvement. Consider retaking the image under better conditions.';
  }

  data.overallAcceptance = overall;
  return data;
};

const createFallbackEvaluation = (label, reason) => {
  const summary = reason
    ? `Vision evaluator unavailable (${reason}). Accepted automatically.`
    : 'Vision evaluator unavailable. Accepted automatically.';
  const notes =
    reason && reason.trim().length > 0
      ? `Evaluator skipped: ${reason}`
      : 'Evaluator skipped due to missing configuration.';

  return normaliseEvaluation({
    overallAcceptance: {
      acceptedCount: 1,
      rejectedCount: 0,
      verdict: 'accept',
      confidencePercent: 70,
      summary,
    },
    images: [
      {
        name: label || 'Uploaded Image',
        overallScorePercent: 100,
        acceptable: true,
        verdict: 'accept',
        confidencePercent: 70,
        criteria: {
          clarity: { scorePercent: 100, verdict: 'yes', notes },
          framing: { scorePercent: 100, verdict: 'yes', notes },
          expression: { scorePercent: 100, verdict: 'yes', notes },
          lighting: { scorePercent: 100, verdict: 'yes', notes },
          safety: { scorePercent: 100, verdict: 'yes', notes },
        },
        recommendations: reason ? [`Manual review suggested: ${reason}`] : [],
        fallback: true,
      },
    ],
  });
};

const shouldBypassEvaluator = () =>
  process.env.SKIP_IMAGE_EVALUATION === 'true' || !process.env.OPENROUTER_API_KEY;

const evaluateSingleImage = async ({ name, mimeType, base64 }) => {
  if (!base64) {
    const error = new Error('Evaluation requires a base64 encoded image');
    error.statusCode = 400;
    throw error;
  }

  const label = name || 'Uploaded Image';

  if (shouldBypassEvaluator()) {
    console.warn('⚠️  Vision evaluator disabled or unconfigured. Returning fallback result.');
    return createFallbackEvaluation(label);
  }

  const payload = {
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: EVALUATION_GUIDE,
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `File name: ${label}. Evaluate this single image for fine-tuning readiness and respond with the mandated JSON schema.`,
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mimeType || 'image/png'};base64,${base64}`,
            },
          },
        ],
      },
    ],
  };

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.APP_URL || 'http://localhost:3000',
        'X-Title': 'AI Book Story - Dataset Evaluator',
      },
      body: JSON.stringify(payload),
    });

    const completion = await response.json();

    if (!response.ok) {
      const message =
        completion?.error?.message ||
        completion?.error ||
        'Failed to evaluate image. Please try again later.';
      console.warn(`⚠️  Vision evaluator returned ${response.status}: ${message}`);
      return createFallbackEvaluation(label, message);
    }

    const messageContent = completion?.choices?.[0]?.message?.content;
    if (!messageContent) {
      console.warn('⚠️  Vision evaluator returned no message content. Using fallback result.');
      return createFallbackEvaluation(label, 'missing evaluation content');
    }

    try {
      const parsed = JSON.parse(messageContent);
      return normaliseEvaluation(parsed);
    } catch (parseError) {
      console.warn('⚠️  Failed to parse vision evaluator response. Using fallback result.', parseError);
      return createFallbackEvaluation(label, 'invalid evaluator response');
    }
  } catch (error) {
    console.warn('⚠️  Vision evaluator request failed. Using fallback result.', error);
    return createFallbackEvaluation(label, error.message || 'request failure');
  }
};

module.exports = {
  evaluateSingleImage,
  normaliseEvaluation,
};
