import axios from 'axios';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001/api';

const api = axios.create({
  baseURL: API_BASE_URL,
});

// Request interceptor
api.interceptors.request.use(
  (config) => {
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
api.interceptors.response.use(
  (response) => {
    return response.data;
  },
  (error) => {
    const message = error.response?.data?.message || error.message || 'Something went wrong';
    return Promise.reject(new Error(message));
  }
);

// Book API
export const bookAPI = {
  getAll: (params) => api.get('/books', { params }),
  getById: (id) => api.get(`/books/${id}`),
  create: (data) => {
    if (data instanceof FormData) {
      return api.post('/books', data, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    }
    return api.post('/books', data);
  },
  update: (id, data) => {
    if (data instanceof FormData) {
      return api.put(`/books/${id}`, data, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    }
    return api.put(`/books/${id}`, data);
  },
  delete: (id) => api.delete(`/books/${id}`),
  updateStatus: (id, status) => api.patch(`/books/${id}/status`, { status }),
  generateStorybook: (id, data) =>
    api.post(`/books/${id}/storybooks`, data, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  startAutoStorybook: (id, data) => api.post(`/books/${id}/storybooks/auto`, data),
  getStorybookAssetPages: (bookId, assetId) =>
    api.get(`/books/${bookId}/storybooks/${assetId}/pages`),
  regenerateStorybookPage: (bookId, assetId, pageOrder, data = {}) =>
    api.post(`/books/${bookId}/storybooks/${assetId}/pages/${pageOrder}/regenerate`, data),
  regenerateStorybookPdf: (bookId, assetId, data = {}) =>
    api.post(`/books/${bookId}/storybooks/${assetId}/regenerate`, data),
  confirmStorybookPdf: (bookId, assetId, data = {}) =>
    api.post(`/books/${bookId}/storybooks/${assetId}/confirm`, data),
  selectStorybookPageCandidate: (bookId, assetId, pageOrder, data = {}) =>
    api.post(`/books/${bookId}/storybooks/${assetId}/pages/${pageOrder}/select`, data),
  getStorybookJobs: (id, params) => api.get(`/books/${id}/storybooks/jobs`, { params }),
  generateCoverPreview: (formData) =>
    api.post('/books/cover-preview', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  generateDedicationPreview: (formData) =>
    api.post('/books/dedication-preview', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
};

// User API
export const userAPI = {
  getAll: (params = {}) => api.get('/users', { params }),
  getById: (id) => api.get(`/users/${id}`),
  create: (data) => api.post('/users', data),
  update: (id, data) => api.put(`/users/${id}`, data),
  delete: (id) => api.delete(`/users/${id}`),
  uploadImage: (id, file, options = {}) => {
    const { onUploadProgress, override = false, evaluation } = options;
    const formData = new FormData();
    formData.append('image', file);
    if (override) {
      formData.append('override', 'true');
    }
    if (evaluation) {
      formData.append('evaluation', JSON.stringify(evaluation));
    }
    return api.post(`/users/${id}/images/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress,
    });
  },
  deleteImage: (id, assetId) => api.delete(`/users/${id}/images/${assetId}`),
};

// Training API
export const trainingAPI = {
  getAll: (params) => api.get('/trainings', { params }),
  getById: (id) => api.get(`/trainings/${id}`),
  create: (data) => {
    if (data instanceof FormData) {
      return api.post('/trainings', data, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    }
    return api.post('/trainings', data);
  },
  checkStatus: (id) => api.get(`/trainings/${id}/status`),
  cancel: (id) => api.post(`/trainings/${id}/cancel`),
  getUserSuccessful: (userId) => api.get(`/trainings/user/${userId}/successful`),
};

// Generation API
export const generationAPI = {
  getAll: (params) => api.get('/generations', { params }),
  getById: (id) => api.get(`/generations/${id}`),
  create: (data) => api.post('/generations', data),
  createRanked: (data) => api.post('/generations/ranked', data),
  download: (id) => api.post(`/generations/${id}/download`),
  getByUser: (userId) => api.get(`/generations/user/${userId}`),
};

// Evaluation API
export const evalAPI = {
  list: (params = {}) => api.get('/evals', { params }),
  evaluate: (data) => api.post('/evals', data),
  updateTags: (id, tags) => api.patch(`/evals/${id}/tags`, { tags }),
  updateDecision: (id, decision) => api.patch(`/evals/${id}/decision`, { decision }),
  delete: (id) => api.delete(`/evals/${id}`),
};

// Prompt API
export const promptAPI = {
  list: (params = {}) => api.get('/prompts', { params }),
  getById: (id) => api.get(`/prompts/${id}`),
  create: (formData) =>
    api.post('/prompts', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  update: (id, data) => api.patch(`/prompts/${id}`, data),
  updateQuality: (id, quality) =>
    api.patch(`/prompts/${id}/quality`, { quality }),
  updateTags: (id, tags) =>
    api.patch(`/prompts/${id}/tags`, { tags }),
  delete: (id) => api.delete(`/prompts/${id}`),
  generate: (formData) =>
    api.post('/prompts/generate', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
};

// Automation API
export const automationAPI = {
  start: (formData) =>
    api.post('/automation', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  getAll: (params) => api.get('/automation', { params }),
  getById: (id) => api.get(`/automation/${id}`),
};

// Dashboard API
export const dashboardAPI = {
  getOverview: () => api.get('/dashboard/overview'),
};

export default api;
