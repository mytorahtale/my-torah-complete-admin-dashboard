import { evalAPI } from '@/services/api';

export const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || '';
      const base64 = typeof result === 'string' ? result.split(',')[1] || '' : '';
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });

export async function evaluateImageFile(file) {
  const base64 = await toBase64(file);
  const payload = {
    image: {
      name: file.name,
      base64,
      mimeType: file.type || 'image/png',
    },
  };

  const evaluationResponse = await evalAPI.evaluate(payload);
  const evaluation =
    evaluationResponse?.data?.evaluation ||
    evaluationResponse?.evaluation ||
    evaluationResponse?.data ||
    evaluationResponse;

  if (!evaluation || typeof evaluation !== 'object') {
    throw new Error('Evaluator returned malformed response');
  }

  return evaluation;
}
