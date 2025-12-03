import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Sparkles,
  Images,
  Download,
  Workflow,
  AlertTriangle,
  Loader2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { userAPI, trainingAPI, generationAPI } from '@/services/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Skeleton } from '@/components/ui/skeleton';
import { SearchableSelect } from '@/components/ui/searchable-select';

const DEFAULT_CONFIG = Object.freeze({
  numOutputs: 1,
  aspectRatio: '1:1',
  outputFormat: 'webp',
  guidanceScale: 3,
  outputQuality: 80,
});

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001/api';
const MAX_GENERATION_ATTEMPTS = Number(import.meta.env.VITE_GENERATION_MAX_ATTEMPTS || 3);
const GENERATION_PAGE_SIZES = [10, 20, 50];

const sortByCreatedAtDesc = (a, b) =>
  new Date(b?.createdAt || 0) - new Date(a?.createdAt || 0);

const formatTimestamp = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
};

const STATUS_LABEL = {
  queued: { label: 'Queued', variant: 'warning' },
  processing: { label: 'Processing', variant: 'default' },
  succeeded: { label: 'Succeeded', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
};

function Generate() {
  const [users, setUsers] = useState([]);
  const [trainings, setTrainings] = useState([]);
  const [generations, setGenerations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isFetchingGenerations, setIsFetchingGenerations] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState(() => ({
    userId: '',
    trainingId: '',
    prompt: '',
    config: { ...DEFAULT_CONFIG },
  }));
  const [generationPage, setGenerationPage] = useState(1);
  const [generationLimit, setGenerationLimit] = useState(GENERATION_PAGE_SIZES[0]);
  const [generationSearch, setGenerationSearch] = useState('');
  const [debouncedGenerationSearch, setDebouncedGenerationSearch] = useState('');
  const [generationStatus, setGenerationStatus] = useState('all');
  const [generationUser, setGenerationUser] = useState('');
  const [generationPagination, setGenerationPagination] = useState({
    page: 1,
    totalPages: 0,
    total: 0,
    limit: GENERATION_PAGE_SIZES[0],
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [generationStatsMeta, setGenerationStatsMeta] = useState({
    total: 0,
    byStatus: {},
  });

  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const generationRefreshTimeoutRef = useRef(null);
  const hasInitialisedRef = useRef(false);
  const [isStreamConnected, setIsStreamConnected] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedGenerationSearch(generationSearch.trim());
    }, 400);
    return () => clearTimeout(timer);
  }, [generationSearch]);

  useEffect(() => {
    setGenerationPage(1);
  }, [debouncedGenerationSearch, generationStatus, generationUser, generationLimit]);

  const fetchUsersList = useCallback(async () => {
    try {
      const response = await userAPI.getAll({ limit: 0 });
      const resolvedUsers = Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response)
        ? response
        : [];
      setUsers(resolvedUsers);
    } catch (error) {
      setUsers([]);
      throw error;
    }
  }, []);

  const fetchGenerations = useCallback(
    async ({ silent = false } = {}) => {
      try {
        if (generationRefreshTimeoutRef.current) {
          clearTimeout(generationRefreshTimeoutRef.current);
          generationRefreshTimeoutRef.current = null;
        }

        if (!silent) {
          setIsFetchingGenerations(true);
        }

        const params = {
          page: generationPage,
          limit: generationLimit,
        };

        if (debouncedGenerationSearch) {
          params.search = debouncedGenerationSearch;
        }
        if (generationStatus !== 'all') {
          params.status = generationStatus;
        }
        if (generationUser) {
          params.userId = generationUser;
        }

        const response = await generationAPI.getAll(params);
        const fetchedGenerations = Array.isArray(response?.data)
          ? response.data
          : Array.isArray(response)
          ? response
          : [];

        const sortedGenerations = fetchedGenerations.slice().sort(sortByCreatedAtDesc);
        setGenerations(sortedGenerations);

        const responsePagination = response?.pagination || {};
        const responseStats = response?.stats || {};

        const nextPage = responsePagination.page ?? generationPage;
        const nextTotalPages = responsePagination.totalPages ?? 0;
        const nextTotal = responsePagination.total ?? sortedGenerations.length;
        const nextLimit = responsePagination.limit ?? generationLimit;

        const computedHasNext =
          typeof responsePagination.hasNextPage === 'boolean'
            ? responsePagination.hasNextPage
            : nextTotalPages > 0 && nextPage < nextTotalPages;
        const computedHasPrev =
          typeof responsePagination.hasPrevPage === 'boolean'
            ? responsePagination.hasPrevPage
            : nextPage > 1;

        setGenerationPagination({
          page: nextPage,
          totalPages: nextTotalPages,
          total: nextTotal,
          limit: nextLimit,
          hasNextPage: computedHasNext,
          hasPrevPage: computedHasPrev,
        });

        setGenerationStatsMeta({
          total:
            typeof responseStats.total === 'number'
              ? responseStats.total
              : nextTotal,
          byStatus: responseStats.byStatus || {},
        });

        if (responsePagination.page && responsePagination.page !== generationPage) {
          setGenerationPage(responsePagination.page);
        }
      } catch (error) {
        if (!silent) {
          toast.error(`Failed to fetch generations: ${error.message}`);
        }
        throw error;
      } finally {
        if (!silent) {
          setIsFetchingGenerations(false);
        }
      }
    },
    [
      generationPage,
      generationLimit,
      debouncedGenerationSearch,
      generationStatus,
      generationUser,
    ]
  );

  const scheduleGenerationRefresh = useCallback(() => {
    if (generationRefreshTimeoutRef.current) return;
    generationRefreshTimeoutRef.current = setTimeout(async () => {
      try {
        await fetchGenerations({ silent: true });
      } catch (error) {
        console.warn('Failed to refresh generations feed', error);
      } finally {
        generationRefreshTimeoutRef.current = null;
      }
    }, 600);
  }, [fetchGenerations]);

  const applyGenerationUpdate = useCallback(() => {
    scheduleGenerationRefresh();
  }, [scheduleGenerationRefresh]);

  const fetchData = useCallback(
    async ({ withSpinner = true } = {}) => {
      try {
        if (withSpinner) {
          setLoading(true);
        }
        await Promise.all([fetchUsersList(), fetchGenerations({ silent: true })]);
        hasInitialisedRef.current = true;
      } catch (error) {
        toast.error(`Failed to fetch data: ${error.message}`);
      } finally {
        if (withSpinner) {
          setLoading(false);
        }
      }
    },
    [fetchUsersList, fetchGenerations]
  );

  const connectEventStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    const streamUrl = `${API_BASE_URL}/generations/stream/live`;
    const source = new EventSource(streamUrl);
    eventSourceRef.current = source;

    source.onopen = () => {
      setIsStreamConnected(true);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    source.onmessage = (event) => {
      if (!event?.data) return;
      try {
        JSON.parse(event.data);
      } catch (parseError) {
        console.error('Failed to parse generation stream payload', parseError);
        return;
      }
      applyGenerationUpdate();
    };

    source.onerror = (error) => {
      console.warn('Generation stream error, retrying in 4s…', error);
      setIsStreamConnected(false);
      source.close();
      eventSourceRef.current = null;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      reconnectTimeoutRef.current = setTimeout(() => {
        connectEventStream();
      }, 4000);
    };
  }, [applyGenerationUpdate]);

  useEffect(() => {
    fetchData({ withSpinner: true });
  }, [fetchData]);

  useEffect(() => {
    if (!hasInitialisedRef.current) {
      return;
    }
    fetchGenerations();
  }, [fetchGenerations]);

  useEffect(() => {
    connectEventStream();
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (generationRefreshTimeoutRef.current) {
        clearTimeout(generationRefreshTimeoutRef.current);
        generationRefreshTimeoutRef.current = null;
      }
      setIsStreamConnected(false);
    };
  }, [connectEventStream]);

  const totalGenerations =
    typeof generationStatsMeta.total === 'number'
      ? generationStatsMeta.total
      : generationPagination.total || 0;
  const successfulGenerations = useMemo(
    () =>
      generationStatsMeta.byStatus && typeof generationStatsMeta.byStatus.succeeded === 'number'
        ? generationStatsMeta.byStatus.succeeded
        : generations.filter((item) => item.status === 'succeeded').length,
    [generationStatsMeta, generations]
  );
  const totalGenerationPages =
    generationPagination.totalPages && generationPagination.totalPages > 0
      ? generationPagination.totalPages
      : generationPagination.total > 0
      ? 1
      : 1;
  const currentGenerationPage =
    generationPagination.totalPages && generationPagination.totalPages > 0
      ? generationPagination.page
      : 1;
  const generationPageSize =
    generationPagination.limit && generationPagination.limit > 0
      ? generationPagination.limit
      : generationLimit;
  const generationPageStart =
    generationPagination.total === 0 ? 0 : (currentGenerationPage - 1) * generationPageSize + 1;
  const generationPageEnd =
    generationPagination.total === 0
      ? 0
      : Math.min(currentGenerationPage * generationPageSize, generationPagination.total);
  const hasGenerationFilters =
    Boolean(generationSearch) ||
    generationStatus !== 'all' ||
    Boolean(generationUser) ||
    generationLimit !== GENERATION_PAGE_SIZES[0];
  const canGoPrevGeneration = generationPagination.hasPrevPage && !isFetchingGenerations;
  const canGoNextGeneration = generationPagination.hasNextPage && !isFetchingGenerations;

  const fetchTrainingsForUser = async (userId, setter) => {
    if (!userId) {
      setter([]);
      return;
    }
    try {
      const response = await trainingAPI.getUserSuccessful(userId);
      setter(response.data);
    } catch (error) {
      setter([]);
      throw error;
    }
  };

  const handleUserChange = async (userId) => {
    setFormData((prev) => ({
      ...prev,
      userId,
      trainingId: '',
    }));

    if (!userId) {
      setTrainings([]);
      return;
    }

    try {
      await fetchTrainingsForUser(userId, setTrainings);
    } catch (error) {
      toast.error(`Failed to fetch trainings: ${error.message}`);
    }
  };

  const handleConfigUpdate = (key, value) => {
    setFormData((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        [key]: value,
      },
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    try {
      await generationAPI.create(formData);
      toast.success('Generation started! Check the feed below.');
      resetForm();
      fetchGenerations({ silent: true }).catch((error) =>
        console.warn('Failed to refresh generations after create', error)
      );
    } catch (error) {
      toast.error(`Failed to generate image: ${error.message}`);
    }
  };

  const handleDownload = async (id) => {
    try {
      await generationAPI.download(id);
      toast.success('Download triggered');
    } catch (error) {
      toast.error(`Failed to download: ${error.message}`);
    }
  };

  const resetForm = () => {
    setFormData({
      userId: '',
      trainingId: '',
      prompt: '',
      config: { ...DEFAULT_CONFIG },
    });
    setTrainings([]);
    setShowForm(false);
  };

  const handleGenerationResetFilters = useCallback(() => {
    setGenerationSearch('');
    setGenerationStatus('all');
    setGenerationUser('');
    setGenerationLimit(GENERATION_PAGE_SIZES[0]);
    setGenerationPage(1);
  }, []);

  const handleGenerationPreviousPage = useCallback(() => {
    if (!generationPagination.hasPrevPage) return;
    setGenerationPage((prev) => Math.max(prev - 1, 1));
  }, [generationPagination.hasPrevPage]);

  const handleGenerationNextPage = useCallback(() => {
    if (!generationPagination.hasNextPage) return;
    setGenerationPage((prev) => prev + 1);
  }, [generationPagination.hasNextPage]);

  if (loading) {
    return (
      <div className="space-y-8">
        {/* Header skeleton */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-4 w-96" />
          </div>
          <div className="flex items-center gap-2">
            <Skeleton className="h-10 w-32" />
            <Skeleton className="h-10 w-40" />
          </div>
        </div>

        {/* Feed skeleton */}
        <div className="space-y-4">
          <Skeleton className="h-6 w-40" />
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-2">
                    <Skeleton className="h-6 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-6 w-20" />
                </div>
                <Skeleton className="h-16 w-full" />
              </CardHeader>
              <CardContent className="space-y-4">
                <Skeleton className="h-24 w-full" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Skeleton className="h-48 w-full" />
                  <Skeleton className="h-48 w-full" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Image Generation
          </h2>
          <p className="mt-1 text-sm text-foreground/60">
            Turn your fine-tuned checkpoints into story-worthy visuals.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="hidden sm:inline-flex bg-foreground/10 text-foreground/70">
            {totalGenerations} prompts
          </Badge>
          <Badge className="hidden sm:inline-flex bg-foreground/10 text-foreground/70">
            {successfulGenerations} completed
          </Badge>
          <Badge className="hidden sm:inline-flex bg-foreground/10 text-foreground/70">
            Page {currentGenerationPage} / {totalGenerationPages}
          </Badge>
          <Badge
            variant={isStreamConnected ? 'success' : 'outline'}
            className="hidden sm:inline-flex"
          >
            {isStreamConnected ? 'Live updates' : 'Reconnecting…'}
          </Badge>
          <Button className="gap-2" onClick={() => setShowForm((prev) => !prev)}>
            <Sparkles className="h-4 w-4" />
            {showForm ? 'Close form' : 'Generate images'}
          </Button>
        </div>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>Create new generation</CardTitle>
            <CardDescription>
              Choose a trained model and describe the scene. Adjust settings to control the output quality.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label>User *</Label>
                  <SearchableSelect
                    value={formData.userId}
                    onValueChange={handleUserChange}
                    options={users.map((user) => ({
                      value: user._id,
                      label: `${user.name} · ${user.email}`,
                      searchText: `${user.name} ${user.email}`,
                    }))}
                    placeholder="Select user"
                    searchPlaceholder="Search users..."
                    emptyText="No users found."
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Trained model *</Label>
                  <SearchableSelect
                    value={formData.trainingId}
                    onValueChange={(value) => setFormData((prev) => ({ ...prev, trainingId: value }))}
                    options={trainings.map((training) => ({
                      value: training._id,
                      label: `${training.modelName} · ${new Date(training.completedAt).toLocaleDateString()}`,
                      searchText: `${training.modelName} ${new Date(training.completedAt).toLocaleDateString()}`,
                    }))}
                    placeholder={formData.userId ? 'Select model' : 'Pick a user first'}
                    searchPlaceholder="Search models..."
                    emptyText="No models found."
                    disabled={!formData.userId || trainings.length === 0}
                  />
                  {formData.userId && trainings.length === 0 && (
                    <p className="text-xs text-foreground/60">
                      No successful trainings found for this user yet.
                    </p>
                  )}
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="prompt">Prompt *</Label>
                <Textarea
                  id="prompt"
                  value={formData.prompt}
                  onChange={(event) =>
                    setFormData((prev) => ({ ...prev, prompt: event.target.value }))
                  }
                  rows={4}
                  placeholder="Describe the scene, mood, style or camera details..."
                  required
                />
              </div>

              <div className="space-y-4 rounded-xl border border-border/60 bg-muted p-4">
                <h4 className="text-sm font-semibold text-foreground/70">
                  Generation settings
                </h4>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="grid gap-2">
                    <Label>Outputs</Label>
                    <Select
                      value={String(formData.config.numOutputs)}
                      onValueChange={(value) => handleConfigUpdate('numOutputs', Number(value))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {[1, 2, 3, 4].map((count) => (
                          <SelectItem key={count} value={String(count)}>
                            {count}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Aspect ratio</Label>
                    <Select
                      value={formData.config.aspectRatio}
                      onValueChange={(value) => handleConfigUpdate('aspectRatio', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1:1">1:1 Square</SelectItem>
                        <SelectItem value="16:9">16:9 Landscape</SelectItem>
                        <SelectItem value="9:16">9:16 Portrait</SelectItem>
                        <SelectItem value="4:3">4:3</SelectItem>
                        <SelectItem value="3:4">3:4</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Format</Label>
                    <Select
                      value={formData.config.outputFormat}
                      onValueChange={(value) => handleConfigUpdate('outputFormat', value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="webp">WebP</SelectItem>
                        <SelectItem value="jpg">JPG</SelectItem>
                        <SelectItem value="png">PNG</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-6 sm:grid-cols-2">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Guidance scale</Label>
                      <span className="text-sm font-medium text-foreground">{formData.config.guidanceScale.toFixed(1)}</span>
                    </div>
                    <Slider
                      value={[formData.config.guidanceScale]}
                      min={0}
                      max={10}
                      step={0.5}
                      onValueChange={(value) => handleConfigUpdate('guidanceScale', value[0])}
                    />
                    <p className="text-xs text-muted-foreground">
                      Higher values enforce the prompt more strictly.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Output quality</Label>
                      <span className="text-sm font-medium text-foreground">{formData.config.outputQuality}%</span>
                    </div>
                    <Slider
                      value={[formData.config.outputQuality]}
                      min={0}
                      max={100}
                      step={5}
                      onValueChange={(value) => handleConfigUpdate('outputQuality', value[0])}
                    />
                    <p className="text-xs text-muted-foreground">
                      Balance fidelity against generation speed.
                    </p>
                  </div>
                </div>
              </div>

              <CardFooter className="flex flex-col-reverse gap-3 border-none bg-transparent p-0 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" onClick={resetForm}>
                  Cancel
                </Button>
                <Button type="submit" className="gap-2">
                  <Sparkles className="h-4 w-4" />
                  Generate
                </Button>
              </CardFooter>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">Generation feed</h3>
          <span className="hidden text-xs uppercase tracking-[0.25em] text-foreground/45 sm:inline">
            Webhook powered
          </span>
        </div>

        <div className="grid gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
          <div className="space-y-2">
            <Label htmlFor="generation-search">Search prompts</Label>
            <Input
              id="generation-search"
              type="search"
              placeholder="Search by prompt or notes"
              value={generationSearch}
              onChange={(event) => setGenerationSearch(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={generationStatus} onValueChange={setGenerationStatus}>
              <SelectTrigger>
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="queued">Queued</SelectItem>
                <SelectItem value="processing">Processing</SelectItem>
                <SelectItem value="succeeded">Succeeded</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>User</Label>
            <SearchableSelect
              value={generationUser}
              onValueChange={setGenerationUser}
              options={users.map((user) => ({
                value: user._id,
                label: `${user.name} · ${user.email}`,
                searchText: `${user.name} ${user.email}`,
              }))}
              placeholder="All users"
              searchPlaceholder="Search users..."
              emptyText="No users found."
            />
          </div>
          <div className="space-y-2">
            <Label>Per page</Label>
            <Select
              value={String(generationLimit)}
              onValueChange={(value) => setGenerationLimit(Number(value))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Results per page" />
              </SelectTrigger>
              <SelectContent>
                {GENERATION_PAGE_SIZES.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size} / page
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end justify-end">
            <Button
              type="button"
              variant="ghost"
              onClick={handleGenerationResetFilters}
              disabled={!hasGenerationFilters}
              className="justify-center"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Reset
            </Button>
          </div>
        </div>

        {isFetchingGenerations && (
          <div className="flex items-center gap-2 text-sm text-foreground/60">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            Refreshing feed…
          </div>
        )}

        <div className="grid gap-4">
          {generations.map((generation) => {
            const statusMeta = STATUS_LABEL[generation.status] ?? STATUS_LABEL.processing;
            const rawAssets = generation.imageAssets?.length
              ? generation.imageAssets
              : generation.imageUrls?.map((url) => ({ url })) || [];
            const imageItems = rawAssets;

            const hasProgress =
              typeof generation.progress === 'number' && Number.isFinite(generation.progress);
            const progressValue = hasProgress
              ? Math.min(100, Math.max(0, generation.progress))
              : null;
            const progressLabel =
              progressValue !== null
                ? progressValue % 1 === 0
                  ? progressValue.toString()
                  : progressValue.toFixed(1)
                : null;
            const attemptCount = generation.attempts ?? 0;
            const attemptLabel = `${attemptCount}/${MAX_GENERATION_ATTEMPTS}`;
            const recentEvents = Array.isArray(generation.events)
              ? [...generation.events].slice(-5).reverse()
              : [];
            const recentLogs = Array.isArray(generation.logs)
              ? [...generation.logs].slice(-8)
              : [];
            const awaitingOutputs =
              generation.status === 'queued' || generation.status === 'processing';

            return (
              <Card key={generation._id} className="flex flex-col">
                <CardHeader className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-xl">{generation.userId?.name}</CardTitle>
                      <CardDescription className="text-xs text-foreground/45">
                        {generation.trainingId?.modelName ?? 'Unknown model'}
                      </CardDescription>
                    </div>
                    <Badge variant={statusMeta.variant}>{statusMeta.label}</Badge>
                  </div>
                  <div className="rounded-lg bg-muted p-3 text-xs text-foreground/65 break-words">
                    <span className="font-semibold text-foreground/70">Prompt: </span>
                    {generation.prompt}
                  </div>
                  <div className="flex flex-wrap gap-3 text-xs text-foreground/45">
                    <span>Created {new Date(generation.createdAt).toLocaleString()}</span>
                    {generation.completedAt && (
                      <span>Completed {new Date(generation.completedAt).toLocaleString()}</span>
                    )}
                  </div>
                </CardHeader>

                <CardContent className="space-y-4">
                  <div className="grid gap-3 text-xs text-foreground/60">
                    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
                      <div className="flex items-center justify-between">
                        <span className="uppercase tracking-[0.25em] text-foreground/45">
                          Attempts
                        </span>
                        <span className="font-mono text-foreground">{attemptLabel}</span>
                      </div>
                      {progressValue !== null ? (
                        <>
                          <div className="mt-2 h-2 w-full rounded-full bg-foreground/10">
                            <div
                              className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                              style={{ width: `${progressValue}%` }}
                            />
                          </div>
                          <div className="mt-2 flex items-center justify-between text-[11px] text-foreground/55">
                            <span>{progressLabel}% complete</span>
                            <span>
                              {generation.status === 'queued'
                                ? 'Queued'
                                : generation.status === 'processing'
                                ? 'Processing'
                                : statusMeta.label}
                            </span>
                          </div>
                        </>
                      ) : (
                        <p className="mt-2 text-foreground/55">
                          {awaitingOutputs
                            ? 'Awaiting progress metrics from Replicate…'
                            : 'Progress metrics unavailable.'}
                        </p>
                      )}
                    </div>

                    {recentEvents.length > 0 && (
                      <div className="rounded-lg border border-border/60 bg-card/70 p-3">
                        <p className="text-xs uppercase tracking-[0.25em] text-foreground/45">
                          Activity
                        </p>
                        <ul className="mt-2 space-y-1">
                          {recentEvents.map((event) => (
                            <li
                              key={`${event.timestamp || event.type}-${event.message}`}
                              className="flex items-start gap-2 text-xs text-foreground/65"
                            >
                              <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
                              <span>
                                <span className="font-medium text-foreground/75">
                                  {formatTimestamp(event.timestamp)}
                                  {event.type ? ` · ${event.type}` : ''}
                                </span>
                                {event.message ? (
                                  <span className="block text-foreground/60">{event.message}</span>
                                ) : null}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {recentLogs.length > 0 && (
                      <div className="rounded-lg border border-border/60 bg-card/60 p-3">
                        <p className="text-xs uppercase tracking-[0.25em] text-foreground/45">
                          Logs
                        </p>
                        <div className="mt-2 max-h-32 space-y-1 overflow-y-auto pr-1 font-mono text-[11px] text-foreground/65">
                          {recentLogs.map((log, index) => (
                            <div key={`${log.timestamp || index}-${log.message}`}>
                              <span className="text-foreground/40">
                                {formatTimestamp(log.timestamp)} ·
                              </span>{' '}
                              {log.message}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {generation.status === 'failed' && (
                    <div className="rounded-lg border border-red-500/50 bg-red-500/10 p-3 text-sm text-red-200">
                      <div className="flex items-center gap-2 font-medium">
                        <AlertTriangle className="h-4 w-4" />
                        Generation failed
                      </div>
                      {generation.error && (
                        <p className="mt-1 text-xs text-red-100">{generation.error}</p>
                      )}
                    </div>
                  )}

                  {imageItems.length > 0 && (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {imageItems.map((image, index) => (
                        <div
                          key={`${generation._id}-${index}`}
                          className="overflow-hidden rounded-xl border border-border/70 bg-card"
                        >
                          <img
                            src={image.url}
                            alt={`Generation ${index + 1}`}
                            className="h-48 w-full object-cover"
                            loading="lazy"
                          />
                          <div className="flex items-center justify-between px-3 py-2 text-xs text-foreground/60">
                            <span className="flex items-center gap-1 font-medium text-foreground/75">
                              Output {index + 1}
                            </span>
                            <a
                              href={image.downloadUrl || image.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-accent hover:text-accent/80"
                            >
                              <Images className="h-3.5 w-3.5" />
                              View
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {!imageItems.length && generation.status !== 'failed' && (
                    <div className="rounded-lg border border-border/60 bg-card p-3 text-sm text-foreground/50">
                      {generation.status === 'queued'
                        ? 'Queued on Replicate—waiting for worker to pick up the job.'
                        : 'Generating images...'}
                    </div>
                  )}
                </CardContent>

                <CardFooter className="flex items-center justify-end gap-2 border-t border-border/60 bg-card py-4">
                  {generation.status === 'succeeded' ? (
                    <Button
                      variant="success"
                      size="sm"
                      className="gap-1"
                      onClick={() => handleDownload(generation._id)}
                    >
                      <Download className="h-4 w-4" />
                      Download
                    </Button>
                  ) : (
                    <span className="text-[11px] uppercase tracking-[0.2em] text-foreground/45">
                      Listening for webhook events…
                    </span>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>

        {generations.length === 0 && !isFetchingGenerations && (
          <Card className="border-dashed border-border/50 bg-card text-center">
            <CardContent className="space-y-3 py-14">
              <Workflow className="mx-auto h-10 w-10 text-foreground/30" />
              <h3 className="text-lg font-medium text-foreground">
                {hasGenerationFilters ? 'No generations match your filters' : 'No generations yet'}
              </h3>
              <p className="text-sm text-foreground/55">
                {hasGenerationFilters
                  ? 'Update your filters or search terms to reveal matching generations.'
                  : 'Kick off a generation above to see outputs appear here.'}
              </p>
              {hasGenerationFilters ? (
                <Button onClick={handleGenerationResetFilters} className="mt-3">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Clear filters
                </Button>
              ) : (
                <Button onClick={() => setShowForm(true)} className="mt-3">
                  <Sparkles className="mr-2 h-4 w-4" />
                  Generate images
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/20 p-4 sm:flex-row">
          <p className="text-sm text-foreground/60">
            {generationPagination.total === 0
              ? 'No generations found'
              : `Showing ${generationPageStart}-${generationPageEnd} of ${generationPagination.total} generations`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGenerationPreviousPage}
              disabled={!canGoPrevGeneration}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="text-sm font-medium text-foreground">
              Page {currentGenerationPage} / {totalGenerationPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleGenerationNextPage}
              disabled={!canGoNextGeneration}
              className="gap-1"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Generate;
