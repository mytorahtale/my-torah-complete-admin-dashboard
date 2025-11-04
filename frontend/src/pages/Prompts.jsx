import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Sparkles,
  UploadCloud,
  Loader2,
  Trash2,
  Maximize2,
  ClipboardCopy,
  Check,
  ArrowLeft,
  ArrowRight,
  Image as ImageIcon,
  Tag,
  CheckCircle2,
  SlidersHorizontal,
  Save,
  Pencil,
} from 'lucide-react';
import { promptAPI } from '@/services/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import ImageViewer from '@/components/ImageViewer';
import { cn } from '@/lib/utils';
import { formatFileSize } from '@/utils/file';
import { Skeleton } from '@/components/ui/skeleton';

const HISTORY_PAGE_SIZE_OPTIONS = [10, 20, 50];
const QUALITY_FILTER_OPTIONS = [
  { value: 'all', label: 'All prompts' },
  { value: 'good', label: 'Confirmed' },
  { value: 'neutral', label: 'Needs review' },
];
const SORT_OPTIONS = [
  { value: 'createdAt:desc', label: 'Newest first' },
  { value: 'createdAt:asc', label: 'Oldest first' },
  { value: 'fileName:asc', label: 'File name A–Z' },
  { value: 'fileName:desc', label: 'File name Z–A' },
];

const formatTimestamp = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
};

const getModelLabel = (provider, model) => {
  if (model && typeof model === 'string' && model.trim()) {
    return model;
  }
  if (provider && typeof provider === 'string' && provider.trim()) {
    return provider;
  }
  return 'Unknown';
};

const createUploadItem = (file) => ({
  id: `${file.name}-${file.lastModified}-${Math.random().toString(16).slice(2)}`,
  file,
  preview: URL.createObjectURL(file),
  status: 'ready',
  prompt: '',
  error: null,
  copied: false,
  recordId: null,
  lastSavedPrompt: '',
  isSaving: false,
  additionalContext: '',
});

function Prompts() {
  const [uploads, setUploads] = useState([]);
  const [viewerImage, setViewerImage] = useState(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [additionalContext, setAdditionalContext] = useState('');
  const [historyItems, setHistoryItems] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [initialHistoryLoad, setInitialHistoryLoad] = useState(true);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE_SIZE_OPTIONS[0]);
  const [historyPagination, setHistoryPagination] = useState({
    page: 1,
    totalPages: 0,
    total: 0,
    limit: HISTORY_PAGE_SIZE_OPTIONS[0],
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [copiedHistoryId, setCopiedHistoryId] = useState(null);
  const historyCopyTimerRef = useRef(null);
  const [qualityFilter, setQualityFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState([]);
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortOrder, setSortOrder] = useState('desc');
  const [historyStats, setHistoryStats] = useState({
    totalGood: 0,
    totalNeutral: 0,
    totalTracked: 0,
  });
  const [qualityUpdatingId, setQualityUpdatingId] = useState(null);
  const [tagEditor, setTagEditor] = useState({
    id: null,
    value: '',
    saving: false,
  });
  const [promptEditor, setPromptEditor] = useState({
    id: null,
    value: '',
    saving: false,
  });
  const [isDeletingId, setIsDeletingId] = useState(null);

  useEffect(() => {
    return () => {
      uploads.forEach((item) => {
        if (item.preview?.startsWith('blob:')) {
          URL.revokeObjectURL(item.preview);
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (historyCopyTimerRef.current) {
        clearTimeout(historyCopyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm.trim());
    }, 400);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const tagFilterKey = useMemo(() => {
    if (!Array.isArray(tagFilter) || tagFilter.length === 0) return '';
    return [...tagFilter].sort().join('|');
  }, [tagFilter]);

  useEffect(() => {
    setHistoryPage(1);
  }, [debouncedSearch, historyLimit, qualityFilter, tagFilterKey, sortBy, sortOrder]);

  const totalSize = useMemo(
    () => uploads.reduce((sum, item) => sum + (item.file?.size || 0), 0),
    [uploads]
  );

  const fetchPromptHistory = useCallback(
    async ({ withSpinner = true, page: pageOverride, limit: limitOverride } = {}) => {
      const pageToUse = pageOverride ?? historyPage;
      const limitToUse = limitOverride ?? historyLimit;

      try {
        if (withSpinner) {
          setHistoryLoading(true);
        }

        const params = {
          page: pageToUse,
          limit: limitToUse,
        };

        if (debouncedSearch) {
          params.search = debouncedSearch;
        }
        if (qualityFilter && qualityFilter !== 'all') {
          params.quality = qualityFilter;
        }
        if (Array.isArray(tagFilter) && tagFilter.length > 0) {
          params.tags = tagFilter.join(',');
        }
        if (sortBy) {
          params.sortBy = sortBy;
        }
        if (sortOrder) {
          params.sortOrder = sortOrder;
        }

        const response = await promptAPI.list(params);
        const items = Array.isArray(response?.data) ? response.data : [];

        const responsePagination = response?.pagination || {};
        const nextPage = responsePagination.page ?? pageToUse;
        const nextLimit = responsePagination.limit ?? limitToUse;
        const nextTotal =
          typeof responsePagination.total === 'number'
            ? responsePagination.total
            : items.length;
        const nextTotalPages =
          typeof responsePagination.totalPages === 'number'
            ? responsePagination.totalPages
            : nextLimit > 0 && nextTotal > 0
            ? Math.ceil(nextTotal / nextLimit)
            : nextTotal > 0
            ? 1
            : 0;
        const computedHasNext =
          typeof responsePagination.hasNextPage === 'boolean'
            ? responsePagination.hasNextPage
            : nextPage < nextTotalPages;
        const computedHasPrev =
          typeof responsePagination.hasPrevPage === 'boolean'
            ? responsePagination.hasPrevPage
            : nextPage > 1;

        setHistoryPagination({
          page: nextTotalPages === 0 ? 1 : nextPage,
          limit: nextLimit,
          total: nextTotal,
          totalPages: nextTotalPages,
          hasNextPage: nextTotalPages > 0 && computedHasNext,
          hasPrevPage: nextTotalPages > 0 && computedHasPrev,
        });

        if (historyPage !== nextPage) {
          setHistoryPage(nextPage);
        }

        if (historyLimit !== nextLimit) {
          setHistoryLimit(nextLimit);
        }

        if (response?.stats) {
          setHistoryStats({
            totalGood: response.stats.totalGood || 0,
            totalNeutral: response.stats.totalNeutral || 0,
            totalTracked: response.stats.totalTracked || 0,
          });
        } else {
          setHistoryStats({
            totalGood: 0,
            totalNeutral: 0,
            totalTracked: 0,
          });
        }

        setHistoryItems(items);
        if (initialHistoryLoad) {
          setInitialHistoryLoad(false);
        }
      } catch (error) {
        toast.error(error.message || 'Failed to load prompt history');
      } finally {
        setHistoryLoading(false);
      }
    },
    [historyPage, historyLimit, debouncedSearch, qualityFilter, tagFilterKey, sortBy, sortOrder]
  );

  useEffect(() => {
    fetchPromptHistory();
  }, [fetchPromptHistory]);

  const handleFileInput = (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const mapped = files.map(createUploadItem);
    setUploads((prev) => [...prev, ...mapped]);
    event.target.value = '';
  };

  const removeUpload = (id) => {
    setUploads((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.preview?.startsWith('blob:')) {
        URL.revokeObjectURL(target.preview);
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const clearAll = () => {
    uploads.forEach((item) => {
      if (item.preview?.startsWith('blob:')) {
        URL.revokeObjectURL(item.preview);
      }
    });
    setUploads([]);
    setAdditionalContext('');
    setViewerImage(null);
  };

  const copyToClipboard = async (id) => {
    const target = uploads.find((item) => item.id === id);
    if (!target || !target.prompt) return;
    try {
      await navigator.clipboard.writeText(target.prompt);
      setUploads((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, copied: true } : item
        )
      );
      setTimeout(() => {
        setUploads((prev) =>
          prev.map((item) =>
            item.id === id ? { ...item, copied: false } : item
          )
        );
      }, 2000);
    } catch (error) {
      toast.error('Unable to copy to clipboard');
    }
  };

  const handleGeneratedPromptChange = useCallback((id, value) => {
    setUploads((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              prompt: value,
              copied: false,
            }
          : item
      )
    );
  }, []);

  const handleHistoryPageSizeChange = useCallback((value) => {
    const numericValue = Number.parseInt(value, 10);
    const fallback = HISTORY_PAGE_SIZE_OPTIONS[0];
    setHistoryLimit(Number.isNaN(numericValue) ? fallback : numericValue);
  }, []);

  const goToPrevHistoryPage = useCallback(() => {
    if (!historyPagination.hasPrevPage || historyLoading) return;
    setHistoryPage((prev) => Math.max(prev - 1, 1));
  }, [historyPagination.hasPrevPage, historyLoading]);

  const goToNextHistoryPage = useCallback(() => {
    if (!historyPagination.hasNextPage || historyLoading) return;
    setHistoryPage((prev) => prev + 1);
  }, [historyPagination.hasNextPage, historyLoading]);

  const handleQualityFilterChange = useCallback((value) => {
    setQualityFilter(value);
  }, []);

  const handleTagFilterToggle = useCallback((tag) => {
    if (!tag) return;
    setTagFilter((prev) =>
      prev.includes(tag) ? prev.filter((entry) => entry !== tag) : [...prev, tag]
    );
  }, []);

  const clearTagFilters = useCallback(() => {
    setTagFilter([]);
  }, []);

  const handleCopyHistory = useCallback(
    async (item) => {
      if (!item?.prompt) return;
      try {
        await navigator.clipboard.writeText(item.prompt);
        setCopiedHistoryId(item.id);
        if (historyCopyTimerRef.current) {
          clearTimeout(historyCopyTimerRef.current);
        }
        historyCopyTimerRef.current = setTimeout(() => {
          setCopiedHistoryId(null);
          historyCopyTimerRef.current = null;
        }, 2000);
      } catch (error) {
        toast.error('Unable to copy to clipboard');
      }
    },
    [historyCopyTimerRef, setCopiedHistoryId]
  );

  const handleHistoryPreview = useCallback(
    (item) => {
      if (!item?.imageUrl) return;
      setViewerImage({
        src: item.imageUrl,
        title: item.fileName,
        sizeLabel: item.size ? formatFileSize(item.size) : undefined,
        downloadUrl: item.imageUrl,
      });
    },
    [setViewerImage]
  );

  const togglePromptQuality = useCallback(
    async (item) => {
      if (!item?.id) return;
      const nextQuality = item.quality === 'good' ? 'neutral' : 'good';
      setQualityUpdatingId(item.id);
      try {
        await promptAPI.updateQuality(item.id, nextQuality);
        setHistoryItems((prev) =>
          prev.map((entry) =>
            entry.id === item.id ? { ...entry, quality: nextQuality } : entry
          )
        );
        await fetchPromptHistory({ withSpinner: false });
        toast.success(
          nextQuality === 'good' ? 'Marked as favourite prompt' : 'Prompt reset to neutral'
        );
      } catch (error) {
        toast.error(error.message || 'Unable to update prompt quality');
      } finally {
        setQualityUpdatingId(null);
      }
    },
    [fetchPromptHistory]
  );

  const parseTags = useCallback((value) => {
    if (typeof value !== 'string') return [];
    const parts = value
      .split(',')
      .map((part) => part.trim())
      .filter((part, index, arr) => part && arr.indexOf(part) === index);
    return parts.slice(0, 12);
  }, []);

  const startTagEdit = useCallback((item) => {
    setTagEditor({
      id: item.id,
      value: Array.isArray(item.tags) && item.tags.length > 0 ? item.tags.join(', ') : '',
      saving: false,
    });
  }, []);

  const cancelTagEdit = useCallback(() => {
    setTagEditor({
      id: null,
      value: '',
      saving: false,
    });
  }, []);

  const saveTags = useCallback(async () => {
    if (!tagEditor.id) return;
    const tags = parseTags(tagEditor.value);
    setTagEditor((prev) => ({ ...prev, saving: true }));
    try {
      await promptAPI.updateTags(tagEditor.id, tags);
      setHistoryItems((prev) =>
        prev.map((entry) => (entry.id === tagEditor.id ? { ...entry, tags } : entry))
      );
      await fetchPromptHistory({ withSpinner: false });
      toast.success('Tags updated');
      cancelTagEdit();
    } catch (error) {
      toast.error(error.message || 'Unable to update tags');
      setTagEditor((prev) => ({ ...prev, saving: false }));
    }
  }, [tagEditor, parseTags, fetchPromptHistory, cancelTagEdit]);

  const handleTagInputChange = useCallback((event) => {
    setTagEditor((prev) => ({
      ...prev,
      value: event?.target?.value ?? '',
    }));
  }, []);

  const startPromptEdit = useCallback((item) => {
    setPromptEditor({
      id: item.id,
      value: item.prompt || '',
      saving: false,
    });
  }, []);

  const cancelPromptEdit = useCallback(() => {
    setPromptEditor({
      id: null,
      value: '',
      saving: false,
    });
  }, []);

  const handlePromptEditorChange = useCallback((event) => {
    setPromptEditor((prev) => ({
      ...prev,
      value: event?.target?.value ?? '',
    }));
  }, []);

  const savePromptEdit = useCallback(async () => {
    if (!promptEditor.id) return;
    const trimmed = promptEditor.value.trim();
    if (!trimmed) {
      toast.error('Prompt text cannot be empty');
      return;
    }

    setPromptEditor((prev) => ({ ...prev, saving: true }));
    try {
      const response = await promptAPI.update(promptEditor.id, {
        prompt: trimmed,
      });
      const updated = response?.data ?? response;
      setHistoryItems((prev) =>
        prev.map((entry) =>
          entry.id === promptEditor.id
            ? { ...entry, prompt: updated?.prompt ?? trimmed }
            : entry
        )
      );
      toast.success('Prompt updated');
      await fetchPromptHistory({ withSpinner: false });
      setPromptEditor({
        id: null,
        value: '',
        saving: false,
      });
    } catch (error) {
      toast.error(error.message || 'Unable to update prompt');
      setPromptEditor((prev) => ({ ...prev, saving: false }));
    }
  }, [promptEditor, fetchPromptHistory]);

  const handleDeletePrompt = useCallback(
    async (item) => {
      if (!item?.id) return;
      const confirmed = window.confirm('Delete this stored prompt? This action cannot be undone.');
      if (!confirmed) return;
      setIsDeletingId(item.id);
      try {
        await promptAPI.delete(item.id);
        setHistoryItems((prev) => prev.filter((entry) => entry.id !== item.id));
        if (tagEditor.id === item.id) {
          cancelTagEdit();
        }
        if (promptEditor.id === item.id) {
          cancelPromptEdit();
        }
        await fetchPromptHistory({ withSpinner: false });
        toast.success('Prompt deleted');
      } catch (error) {
        toast.error(error.message || 'Unable to delete prompt');
      } finally {
        setIsDeletingId(null);
      }
    },
    [fetchPromptHistory, tagEditor.id, cancelTagEdit, promptEditor.id, cancelPromptEdit]
  );

  const generatePrompts = async () => {
    if (!uploads.length) {
      toast.error('Upload one or more images first');
      return;
    }

    const pending = uploads.filter((item) => item.status !== 'complete');
    if (!pending.length) {
      toast('All prompts already generated');
      return;
    }

    const trimmedAdditionalContext = additionalContext.trim();
    const formData = new FormData();
    uploads.forEach((item) => {
      formData.append('images', item.file);
    });
    if (trimmedAdditionalContext) {
      formData.append('additionalContext', trimmedAdditionalContext);
    }

    setIsGenerating(true);
    setUploads((prev) =>
      prev.map((item) => ({
        ...item,
        status: item.status === 'complete' ? 'complete' : 'processing',
        error: null,
      }))
    );

    try {
      const response = await promptAPI.generate(formData);
      const results = Array.isArray(response?.data) ? response.data : response?.data ?? [];

      setUploads((prev) =>
        prev.map((item, idx) => {
          const result = results.find((entry) => entry.position === idx);
          if (!result) {
            return {
              ...item,
              status: 'error',
              error: 'No prompt returned for this image',
              isSaving: false,
            };
          }
          return {
            ...item,
            status: 'complete',
            prompt: result.prompt,
            error: null,
            copied: false,
            isSaving: false,
            additionalContext:
              typeof result.additionalContext === 'string'
                ? result.additionalContext
                : item.additionalContext || trimmedAdditionalContext || '',
          };
        })
      );
      toast.success('Prompts generated. Review and save to add them to history.');
    } catch (error) {
      console.error('Prompt generation failed:', error);
      toast.error(error.message || 'Failed to generate prompts');
      setUploads((prev) =>
        prev.map((item) =>
          item.status === 'processing'
            ? { ...item, status: 'error', error: error.message || 'Failed to generate prompt' }
            : item
        )
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSaveGeneratedPrompt = useCallback(
    async (id) => {
      const target = uploads.find((item) => item.id === id);
      if (!target) return;

      if (target.isSaving) return;

      const trimmedPrompt = target.prompt?.trim?.() || '';
      if (!trimmedPrompt) {
        toast.error('Add prompt text before saving');
        return;
      }

      if (target.recordId && target.lastSavedPrompt === target.prompt) {
        toast('No changes to save');
        return;
      }

      if (!target.recordId && !target.file) {
        toast.error('Missing reference image for this prompt');
        return;
      }

      setUploads((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                isSaving: true,
              }
            : item
        )
      );

      try {
        if (target.recordId) {
          const payload = {
            prompt: trimmedPrompt,
          };
          if (typeof target.additionalContext === 'string') {
            payload.additionalContext = target.additionalContext;
          }
          const response = await promptAPI.update(target.recordId, payload);
          const saved = response?.data ?? response;

          setUploads((prev) =>
            prev.map((item) =>
              item.id === id
                ? {
                    ...item,
                    prompt: saved?.prompt ?? trimmedPrompt,
                    lastSavedPrompt: saved?.prompt ?? trimmedPrompt,
                    additionalContext:
                      typeof saved?.additionalContext === 'string'
                        ? saved.additionalContext
                        : item.additionalContext,
                    isSaving: false,
                  }
                : item
            )
          );
          toast.success('Prompt updated');
        } else {
          const formData = new FormData();
          formData.append('image', target.file);
          formData.append('prompt', trimmedPrompt);
          if (typeof target.additionalContext === 'string' && target.additionalContext.trim()) {
            formData.append('additionalContext', target.additionalContext.trim());
          }
          const response = await promptAPI.create(formData);
          const saved = response?.data ?? response;

          setUploads((prev) =>
            prev.map((item) =>
              item.id === id
                ? {
                    ...item,
                    recordId: saved?.id || saved?.promptId || item.recordId,
                    prompt: saved?.prompt ?? trimmedPrompt,
                    lastSavedPrompt: saved?.prompt ?? trimmedPrompt,
                    additionalContext:
                      typeof saved?.additionalContext === 'string'
                        ? saved.additionalContext
                        : item.additionalContext,
                    isSaving: false,
                  }
                : item
            )
          );
          toast.success('Prompt saved');
        }

        await fetchPromptHistory({ withSpinner: false, page: 1 });
      } catch (error) {
        toast.error(
          error.message ||
            (target.recordId ? 'Failed to update prompt' : 'Failed to save prompt')
        );
        setUploads((prev) =>
          prev.map((item) =>
            item.id === id
              ? {
                  ...item,
                  isSaving: false,
                }
              : item
          )
        );
      }
    },
    [uploads, fetchPromptHistory]
  );

  const handleViewerClose = useCallback(() => {
    setViewerImage(null);
  }, []);

  const totalPrompts = historyPagination.total || 0;
  const effectiveHistoryLimit =
    historyPagination.limit && historyPagination.limit > 0
      ? historyPagination.limit
      : historyLimit || HISTORY_PAGE_SIZE_OPTIONS[0];
  const effectiveHistoryPage =
    historyPagination.totalPages && historyPagination.totalPages > 0
      ? historyPagination.page
      : totalPrompts > 0
      ? 1
      : 1;
  const totalHistoryPages =
    historyPagination.totalPages && historyPagination.totalPages > 0
      ? historyPagination.totalPages
      : totalPrompts > 0
      ? Math.ceil(totalPrompts / effectiveHistoryLimit)
      : 1;
  const historyRangeStart =
    !historyLoading && totalPrompts > 0
      ? (effectiveHistoryPage - 1) * effectiveHistoryLimit + 1
      : 0;
  const historyRangeEnd =
    !historyLoading && totalPrompts > 0
      ? Math.min(historyRangeStart + historyItems.length - 1, totalPrompts)
      : 0;
  const hasHistory = historyItems.length > 0;
  const showHistoryEmptyState = !historyLoading && !hasHistory;
  const favouriteCount = historyStats.totalGood || 0;
  const neutralCount = historyStats.totalNeutral || 0;
  const totalTracked = historyStats.totalTracked || 0;
  const favouriteShare =
    totalTracked > 0 ? Math.round((favouriteCount / totalTracked) * 100) : 0;
  const availableTags = useMemo(() => {
    const values = new Set();
    historyItems.forEach((item) => {
      if (Array.isArray(item.tags)) {
        item.tags.forEach((tag) => {
          if (typeof tag === 'string' && tag.trim()) {
            values.add(tag.trim());
          }
        });
      }
    });
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [historyItems]);

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" />
            Prompt Studio
          </div>
          <div className="space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">
              Build and curate consistent character prompts
            </h1>
            <p className="max-w-2xl text-sm text-muted-foreground sm:text-base">
              Upload reference shots, capture reusable descriptions, and keep a shortlist of “go-to” prompts ready for future training runs.
            </p>
          </div>
        </div>
        <div className="grid w-full gap-3 sm:grid-cols-3 lg:max-w-xl">
          <div className="rounded-lg border border-border/70 bg-background p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Total prompts</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{totalTracked}</p>
            <p className="text-xs text-muted-foreground">Stored in the library</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Confirmed</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{favouriteCount}</p>
            <p className="text-xs text-muted-foreground">{favouriteShare}% approved</p>
          </div>
          <div className="rounded-lg border border-border/70 bg-background p-4 shadow-sm">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Needs review</p>
            <p className="mt-2 text-2xl font-semibold text-foreground">{neutralCount}</p>
            <p className="text-xs text-muted-foreground">Not yet confirmed</p>
          </div>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardHeader className="space-y-1">
          <CardTitle className="text-lg font-semibold">Prompt Builder</CardTitle>
          <CardDescription>
            Upload reference images, optionally add context, then generate consistent descriptions for reuse.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-3">
            <Label className="text-sm font-medium text-foreground">Additional Context (Optional)</Label>
            <Textarea
              rows={4}
              placeholder="e.g., Soft studio lighting, front-facing portrait, neutral background."
              value={additionalContext}
              onChange={(event) => setAdditionalContext(event.target.value)}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground">
              This description is applied to every prompt generated in this batch.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" className="bg-background px-3 py-1 text-muted-foreground">
                {uploads.length} queued {uploads.length === 1 ? 'image' : 'images'}
              </Badge>
              <Badge variant="outline" className="bg-background px-3 py-1 text-muted-foreground">
                {formatFileSize(totalSize)} total
              </Badge>
              <Badge variant="outline" className="bg-background px-3 py-1 text-muted-foreground">
                {favouriteCount} favourites saved
              </Badge>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                type="button"
                variant="ghost"
                className="gap-2 text-muted-foreground hover:text-destructive"
                onClick={clearAll}
                disabled={!uploads.length}
              >
                Reset session
              </Button>
              <Button
                type="button"
                variant="outline"
                className="gap-2"
                onClick={() => document.getElementById('prompt-studio-input')?.click()}
              >
                <UploadCloud className="h-4 w-4" />
                Add images
              </Button>
              <input
                id="prompt-studio-input"
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFileInput}
              />
              <Button
                type="button"
                className="gap-2 bg-foreground text-background hover:bg-foreground/90"
                onClick={generatePrompts}
                disabled={!uploads.length || isGenerating}
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    Generate prompts
                  </>
                )}
              </Button>
            </div>
          </div>

          {uploads.length > 0 ? (
            <div className="grid gap-5 sm:grid-cols-2">
              {uploads.map((item, index) => {
                const trimmedPrompt = item.prompt?.trim?.() || '';
                const isSaved = Boolean(item.recordId);
                const hasUnsavedChanges = isSaved
                  ? item.prompt !== item.lastSavedPrompt
                  : Boolean(trimmedPrompt);
                const statusLabel = item.isSaving
                  ? 'Saving...'
                  : !isSaved
                  ? 'Not saved yet'
                  : hasUnsavedChanges
                  ? 'Unsaved changes'
                  : 'Saved to history';
                const saveButtonDisabled =
                  item.isSaving || !trimmedPrompt || (isSaved && !hasUnsavedChanges);
                const saveButtonLabel = item.isSaving
                  ? 'Saving...'
                  : !isSaved
                  ? 'Save prompt'
                  : hasUnsavedChanges
                  ? 'Update prompt'
                  : 'Saved';

                return (
                  <Card key={item.id} className="overflow-hidden border border-border/70 shadow-sm">
                    <CardContent className="p-0">
                      <div className="relative">
                        <button
                          type="button"
                          className="group relative w-full aspect-square overflow-hidden bg-secondary"
                          onClick={() =>
                            setViewerImage({
                              src: item.preview,
                              title: item.file.name,
                              sizeLabel: formatFileSize(item.file.size),
                              downloadUrl: item.preview,
                            })
                          }
                        >
                          <img
                            src={item.preview}
                            alt={item.file.name}
                            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                          />
                          <div className="absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/15" />
                          <span className="absolute left-3 top-3 rounded-md bg-black/70 px-2 py-1 text-xs font-semibold text-white">
                            #{index + 1}
                          </span>
                          <Maximize2 className="absolute right-3 top-3 h-5 w-5 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
                        </button>
                      </div>

                      <div className="space-y-3 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium text-foreground">{item.file.name}</p>
                            <p className="text-xs text-muted-foreground">{formatFileSize(item.file.size)}</p>
                          </div>
                          <div className="flex flex-shrink-0 items-center gap-2">
                            <Badge
                              variant={
                                item.status === 'complete'
                                  ? 'success'
                                  : item.status === 'error'
                                  ? 'destructive'
                                  : item.status === 'processing'
                                  ? 'secondary'
                                  : 'outline'
                              }
                              className="capitalize"
                            >
                              {item.status}
                            </Badge>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-destructive"
                              onClick={() => removeUpload(item.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>

                        {item.error ? (
                          <div className="rounded-lg border border-destructive/60 bg-destructive/10 px-3 py-2">
                            <p className="text-xs text-destructive">{item.error}</p>
                          </div>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Label className="text-sm font-medium text-foreground">Generated prompt</Label>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 gap-1.5"
                              disabled={!item.prompt}
                              onClick={() => copyToClipboard(item.id)}
                            >
                              {item.copied ? (
                                <>
                                  <Check className="h-3.5 w-3.5" />
                                  Copied
                                </>
                              ) : (
                                <>
                                  <ClipboardCopy className="h-3.5 w-3.5" />
                                  Copy
                                </>
                              )}
                            </Button>
                          </div>
                          <Textarea
                            value={item.prompt || ''}
                            onChange={(event) => handleGeneratedPromptChange(item.id, event.target.value)}
                            placeholder="Generated prompt will appear here..."
                            className="min-h-[110px] resize-y text-sm"
                            disabled={item.status !== 'complete'}
                          />
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-xs text-muted-foreground">{statusLabel}</span>
                            <Button
                              type="button"
                              size="sm"
                              className="gap-1.5"
                              onClick={() => handleSaveGeneratedPrompt(item.id)}
                              disabled={saveButtonDisabled}
                            >
                              {item.isSaving ? (
                                <>
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  Saving...
                                </>
                              ) : saveButtonDisabled && isSaved && !hasUnsavedChanges ? (
                                <>
                                  <Check className="h-3.5 w-3.5" />
                                  Saved
                                </>
                              ) : (
                                <>
                                  <Save className="h-3.5 w-3.5" />
                                  {saveButtonLabel}
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          ) : (
            <Card className="border border-dashed border-border/70">
              <CardContent className="py-12">
                <div className="flex flex-col items-center gap-4 text-center">
                  <div className="rounded-full bg-muted p-4">
                    <UploadCloud className="h-10 w-10 text-muted-foreground" />
                  </div>
                  <div>
                    <h3 className="text-lg font-semibold text-foreground">No images yet</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Upload references to start building prompt descriptions.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-2 gap-2"
                    onClick={() => document.getElementById('prompt-studio-input')?.click()}
                  >
                    <UploadCloud className="h-4 w-4" />
                    Upload images
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-sm">
        <CardHeader className="space-y-4">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-lg font-semibold">Prompt History</CardTitle>
              <CardDescription>
                Browse source references, reuse descriptions, and curate favourites for long-term storage.
              </CardDescription>
            </div>
            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
              <Input
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search prompts or filenames..."
                className="w-full sm:w-64"
              />
              <div className="flex items-center gap-2">
                <Select
                  value={`${sortBy}:${sortOrder}`}
                  onValueChange={(value) => {
                    const [nextSortBy, nextSortOrder] = value.split(':');
                    setSortBy(nextSortBy || 'createdAt');
                    setSortOrder(nextSortOrder || 'desc');
                  }}
                >
                  <SelectTrigger className="w-[170px]">
                    <SelectValue placeholder="Sort prompts" />
                  </SelectTrigger>
                  <SelectContent>
                    {SORT_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={String(historyLimit)} onValueChange={handleHistoryPageSizeChange}>
                  <SelectTrigger className="w-[150px]">
                    <SelectValue placeholder="Items per page" />
                  </SelectTrigger>
                  <SelectContent>
                    {HISTORY_PAGE_SIZE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {option} / page
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Badge variant="outline" className="bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground">
                  {totalPrompts} total
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Filters
            </span>
            {QUALITY_FILTER_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant="outline"
                className={cn(
                  'h-8 rounded-full border border-border/60 px-3 text-xs font-medium transition-colors',
                  qualityFilter === option.value
                    ? 'bg-foreground text-background hover:bg-foreground/90'
                    : 'bg-background text-muted-foreground hover:text-foreground'
                )}
                onClick={() => handleQualityFilterChange(option.value)}
              >
                {option.value === 'good' ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> : null}
                {option.label}
              </Button>
            ))}
            {availableTags.length > 0 ? (
              <>
                <span className="mx-1 text-xs text-muted-foreground">|</span>
                <span className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-background px-3 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <Tag className="h-3.5 w-3.5" />
                  Tags
                </span>
                {availableTags.map((tag) => {
                  const isActive = tagFilter.includes(tag);
                  return (
                    <Button
                      key={tag}
                      type="button"
                      variant="outline"
                      className={cn(
                        'h-8 rounded-full border px-3 text-xs font-medium transition-colors',
                        isActive
                          ? 'border-foreground bg-foreground text-background hover:bg-foreground/90'
                          : 'border-border/60 bg-background text-muted-foreground hover:text-foreground'
                      )}
                      onClick={() => handleTagFilterToggle(tag)}
                    >
                      {tag}
                    </Button>
                  );
                })}
                {tagFilter.length > 0 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-8 px-3 text-xs text-muted-foreground hover:text-foreground"
                    onClick={clearTagFilters}
                  >
                    Clear tags
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <div className="px-4 sm:px-6">
            {initialHistoryLoad ? (
              <div className="space-y-4 py-8">
                {[0, 1, 2].map((index) => (
                  <Card key={index} className="border border-border/60">
                    <CardContent className="grid gap-4 p-4 sm:grid-cols-[auto_1fr]">
                      <Skeleton className="h-20 w-20 rounded-md" />
                      <div className="space-y-3">
                        <Skeleton className="h-4 w-1/3" />
                        <Skeleton className="h-3 w-full" />
                        <div className="flex gap-2">
                          <Skeleton className="h-6 w-16" />
                          <Skeleton className="h-6 w-24" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : historyLoading && !hasHistory ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Loading prompt history...
              </div>
            ) : showHistoryEmptyState ? (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted-foreground">
                <div className="rounded-full bg-muted p-4">
                  <ImageIcon className="h-8 w-8" />
                </div>
                <div>
                  <p className="text-sm font-medium text-foreground">No prompts stored yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Generated prompts will appear here with their source images for future reuse.
                  </p>
                </div>
              </div>
            ) : (
              <div className="relative space-y-4">
                {historyLoading && hasHistory ? (
                  <div className="absolute inset-x-0 -top-6 z-10 flex items-center justify-center py-2 text-xs text-muted-foreground">
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Updating…
                  </div>
                ) : null}

                {historyItems.map((item) => (
                  <Card key={item.id} className="border border-border/60">
                    <CardContent className="grid gap-4 p-4 sm:grid-cols-[auto_1fr]">
                      <button
                        type="button"
                        className="group relative h-20 w-20 overflow-hidden rounded-md border border-border bg-muted disabled:cursor-not-allowed"
                        onClick={() => handleHistoryPreview(item)}
                        disabled={!item.imageUrl}
                      >
                        {item.imageUrl ? (
                          <img
                            src={item.imageUrl}
                            alt={item.fileName}
                            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center bg-muted">
                            <ImageIcon className="h-6 w-6 text-muted-foreground" />
                          </div>
                        )}
                        <span className="absolute inset-0 bg-black/0 transition-colors duration-200 group-hover:bg-black/15" />
                      </button>

                      <div className="space-y-3">
                        <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-1">
                            <p className="text-sm font-medium text-foreground">{item.fileName}</p>
                            <p className="text-xs text-muted-foreground">
                              {item.size ? formatFileSize(item.size) : 'Size unavailable'} • {formatTimestamp(item.createdAt)}
                            </p>
                          </div>
                          <Badge variant="outline" className="px-2 py-0.5 text-[11px] uppercase tracking-wide">
                            {getModelLabel(item.provider, item.model)}
                          </Badge>
                        </div>

                        {promptEditor.id === item.id ? (
                          <div className="space-y-2">
                            <Textarea
                              value={promptEditor.value}
                              onChange={handlePromptEditorChange}
                              rows={5}
                              className="resize-y text-sm"
                            />
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                className="gap-1.5"
                                onClick={savePromptEdit}
                                disabled={promptEditor.saving}
                              >
                                {promptEditor.saving ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Check className="h-3.5 w-3.5" />
                                )}
                                Save
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={cancelPromptEdit}
                                disabled={promptEditor.saving}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{item.prompt}</p>
                        )}

                        {item.additionalContext ? (
                          <div className="rounded-md border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground">
                            {item.additionalContext}
                          </div>
                        ) : null}

                        <div className="flex flex-wrap gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className={cn(
                              'gap-1.5 border-border/70 text-xs font-semibold',
                              item.quality === 'good'
                                ? 'border-foreground/40 text-foreground'
                                : 'text-muted-foreground hover:text-foreground'
                            )}
                            onClick={() => togglePromptQuality(item)}
                            disabled={qualityUpdatingId === item.id}
                          >
                            {qualityUpdatingId === item.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <CheckCircle2 className="h-3.5 w-3.5" />
                            )}
                            {item.quality === 'good' ? 'Confirmed' : 'Mark confirmed'}
                          </Button>

                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => handleCopyHistory(item)}
                          >
                            {copiedHistoryId === item.id ? <Check className="h-3.5 w-3.5" /> : <ClipboardCopy className="h-3.5 w-3.5" />}
                            Copy prompt
                          </Button>

                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => startPromptEdit(item)}
                            disabled={promptEditor.id === item.id}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit prompt
                          </Button>

                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                            onClick={() => startTagEdit(item)}
                          >
                            <Tag className="h-3.5 w-3.5" />
                            Edit tags
                          </Button>

                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1.5 text-xs text-destructive hover:text-destructive"
                            onClick={() => handleDeletePrompt(item)}
                            disabled={isDeletingId === item.id}
                          >
                            {isDeletingId === item.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                            Delete
                          </Button>
                        </div>

                        <div className="flex flex-wrap gap-1.5">
                          {Array.isArray(item.tags) && item.tags.length > 0 ? (
                            item.tags.map((tag) => (
                              <Badge key={`${item.id}-${tag}`} variant="outline" className="bg-background px-2 py-0.5 text-[11px]">
                                {tag}
                              </Badge>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground/70">No tags</span>
                          )}
                        </div>

                        {tagEditor.id === item.id ? (
                          <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/30 p-3">
                            <Input
                              value={tagEditor.value}
                              onChange={handleTagInputChange}
                              placeholder="Comma separated tags (e.g. hero, close-up)"
                              className="h-9 text-sm"
                            />
                            <div className="flex items-center gap-2">
                              <Button
                                type="button"
                                size="sm"
                                className="gap-1.5"
                                onClick={saveTags}
                                disabled={tagEditor.saving}
                              >
                                {tagEditor.saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                                Save
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="text-muted-foreground hover:text-foreground"
                                onClick={cancelTagEdit}
                                disabled={tagEditor.saving}
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-muted-foreground">
            {historyLoading
              ? 'Loading prompt history...'
              : totalPrompts === 0
              ? 'No prompts stored yet'
              : `Showing ${historyRangeStart}-${historyRangeEnd} of ${totalPrompts} prompts`}
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={goToPrevHistoryPage}
              disabled={!historyPagination.hasPrevPage || historyLoading}
            >
              <ArrowLeft className="h-4 w-4" />
              Prev
            </Button>
            <div className="text-sm font-medium text-foreground">
              Page {Math.max(effectiveHistoryPage, 1)} of {Math.max(totalHistoryPages, 1)}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={goToNextHistoryPage}
              disabled={!historyPagination.hasNextPage || historyLoading}
            >
              Next
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </CardFooter>
      </Card>

      <ImageViewer open={Boolean(viewerImage)} image={viewerImage} onClose={handleViewerClose} />
    </div>
  );
}

export default Prompts;
