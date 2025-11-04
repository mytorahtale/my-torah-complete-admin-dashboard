import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Boxes,
  CloudUpload,
  Rocket,
  Ban,
  DownloadCloud,
  ExternalLink,
  Maximize2,
  Loader2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { userAPI, trainingAPI } from '@/services/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import ImageViewer from '@/components/ImageViewer';
import { formatFileSize } from '@/utils/file';
import { SearchableSelect } from '@/components/ui/searchable-select';

const createInitialForm = () => ({
  userId: '',
  modelName: '',
  trainingConfig: {},
});

const STATUS_VARIANTS = {
  queued: { variant: 'warning', label: 'Queued' },
  starting: { variant: 'warning', label: 'Starting' },
  processing: { variant: 'default', label: 'Processing' },
  succeeded: { variant: 'success', label: 'Succeeded' },
  failed: { variant: 'destructive', label: 'Failed' },
  canceled: { variant: 'outline', label: 'Canceled' },
};

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5001/api';
const MAX_TRAINING_ATTEMPTS = Number(import.meta.env.VITE_TRAINING_MAX_ATTEMPTS || 1);

const TRAINING_PAGE_SIZES = [10, 20, 50];

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

const formatDuration = (milliseconds) => {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 1) {
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
  return `${seconds}s`;
};

function Training() {
  const [users, setUsers] = useState([]);
  const [trainings, setTrainings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isFetchingTrainings, setIsFetchingTrainings] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState(createInitialForm);
  const [viewerImage, setViewerImage] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const trainingRefreshTimeoutRef = useRef(null);
  const statusMapRef = useRef(new Map());
  const hasProcessedInitialStreamRef = useRef(false);
  const hasInitialisedRef = useRef(false);
  const [isStreamConnected, setIsStreamConnected] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [trainingPage, setTrainingPage] = useState(1);
  const [trainingLimit, setTrainingLimit] = useState(TRAINING_PAGE_SIZES[0]);
  const [trainingSearch, setTrainingSearch] = useState('');
  const [debouncedTrainingSearch, setDebouncedTrainingSearch] = useState('');
  const [trainingStatus, setTrainingStatus] = useState('all');
  const [trainingUserFilter, setTrainingUserFilter] = useState('');
  const [trainingPagination, setTrainingPagination] = useState({
    page: 1,
    totalPages: 0,
    total: 0,
    limit: TRAINING_PAGE_SIZES[0],
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [trainingStatsMeta, setTrainingStatsMeta] = useState({
    total: 0,
    byStatus: {},
  });
  const isFetchingTrainingsRef = useRef(false);
  const pendingFetchOptionsRef = useRef(null);
  const [trainingLogsState, setTrainingLogsState] = useState({});
  const trainingLogsStateRef = useRef(trainingLogsState);
  const userHydrationCacheRef = useRef(new Map());
  const userHydrationPromisesRef = useRef(new Map());
  const [selectedUserHydrating, setSelectedUserHydrating] = useState(false);
  const [selectedUserHydrationError, setSelectedUserHydrationError] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedTrainingSearch(trainingSearch.trim());
    }, 400);
    return () => clearTimeout(timer);
  }, [trainingSearch]);

  useEffect(() => {
    setTrainingPage(1);
  }, [debouncedTrainingSearch, trainingStatus, trainingUserFilter, trainingLimit]);

  useEffect(() => {
    users.forEach((user) => {
      if (user?._id && Array.isArray(user.imageAssets)) {
        userHydrationCacheRef.current.set(user._id, user);
      }
    });
  }, [users]);

  const ensureUserHydrated = useCallback(async (userId) => {
    if (!userId) return null;

    if (userHydrationCacheRef.current.has(userId)) {
      return userHydrationCacheRef.current.get(userId);
    }

    if (userHydrationPromisesRef.current.has(userId)) {
      return userHydrationPromisesRef.current.get(userId);
    }

    const fetchPromise = userAPI
      .getById(userId)
      .then((response) => {
        const payload = response?.data || response;
        const userPayload = payload?.data || payload;
        if (userPayload?._id) {
          userHydrationCacheRef.current.set(userId, userPayload);
          setUsers((prev) => {
            const index = prev.findIndex((user) => user._id === userId);
            if (index === -1) {
              return [...prev, userPayload];
            }
            const next = [...prev];
            next[index] = { ...next[index], ...userPayload };
            return next;
          });
        }
        userHydrationPromisesRef.current.delete(userId);
        return userPayload;
      })
      .catch((error) => {
        userHydrationPromisesRef.current.delete(userId);
        throw error;
      });

    userHydrationPromisesRef.current.set(userId, fetchPromise);
    return fetchPromise;
  }, [setUsers]);

  const fetchUsersList = useCallback(async () => {
    try {
      const response = await userAPI.getAll({ limit: 0, minimal: true });
      const resolvedUsers = Array.isArray(response?.data)
        ? response.data
        : Array.isArray(response)
        ? response
        : [];
      const enrichedUsers = resolvedUsers.map((user) => {
        if (!user?._id) return user;
        const cached = userHydrationCacheRef.current.get(user._id);
        return cached ? { ...user, ...cached } : user;
      });
      setUsers(enrichedUsers);
    } catch (error) {
      toast.error(`Failed to load users: ${error.message}`);
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    if (!formData.userId) {
      setSelectedUserHydrating(false);
      setSelectedUserHydrationError('');
      return;
    }

    const cached = userHydrationCacheRef.current.get(formData.userId);
    const userInState = users.find((candidate) => candidate._id === formData.userId);

    if (cached || (userInState && Array.isArray(userInState.imageAssets))) {
      setSelectedUserHydrating(false);
      setSelectedUserHydrationError('');
      return;
    }

    let cancelled = false;
    setSelectedUserHydrating(true);
    setSelectedUserHydrationError('');

    ensureUserHydrated(formData.userId)
      .then((payload) => {
        if (cancelled) return;
        setSelectedUserHydrating(false);
        if (!payload?._id) {
          setSelectedUserHydrationError('Unable to load user details for training.');
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setSelectedUserHydrating(false);
        setSelectedUserHydrationError(error?.message || 'Failed to load user details');
      });

    return () => {
      cancelled = true;
    };
  }, [formData.userId, users, ensureUserHydrated]);

  const fetchTrainings = useCallback(
    async ({ silent = false } = {}) => {
      try {
        if (trainingRefreshTimeoutRef.current) {
          clearTimeout(trainingRefreshTimeoutRef.current);
          trainingRefreshTimeoutRef.current = null;
        }

        if (isFetchingTrainingsRef.current) {
          pendingFetchOptionsRef.current = { silent };
          return;
        }
        isFetchingTrainingsRef.current = true;

        if (!silent) {
          setIsFetchingTrainings(true);
        }

        const params = {
          page: trainingPage,
          limit: trainingLimit,
        };

        if (debouncedTrainingSearch) {
          params.search = debouncedTrainingSearch;
        }
        if (trainingStatus !== 'all') {
          params.status = trainingStatus;
        }
        if (trainingUserFilter) {
          params.userId = trainingUserFilter;
        }

        const response = await trainingAPI.getAll({ ...params, minimal: true });
        const fetchedTrainings = Array.isArray(response?.data)
          ? response.data
          : Array.isArray(response)
          ? response
          : [];

        const sortedTrainings = fetchedTrainings.slice().sort(sortByCreatedAtDesc);
        setTrainings(sortedTrainings);

        const responsePagination = response?.pagination || {};
        const responseStats = response?.stats || {};

        const nextPage = responsePagination.page ?? trainingPage;
        const nextTotalPages = responsePagination.totalPages ?? 0;
        const nextTotal = responsePagination.total ?? sortedTrainings.length;
        const nextLimit = responsePagination.limit ?? trainingLimit;

        const computedHasNext =
          typeof responsePagination.hasNextPage === 'boolean'
            ? responsePagination.hasNextPage
            : nextTotalPages > 0 && nextPage < nextTotalPages;
        const computedHasPrev =
          typeof responsePagination.hasPrevPage === 'boolean'
            ? responsePagination.hasPrevPage
            : nextPage > 1;

        setTrainingPagination({
          page: nextPage,
          totalPages: nextTotalPages,
          total: nextTotal,
          limit: nextLimit,
          hasNextPage: computedHasNext,
          hasPrevPage: computedHasPrev,
        });

        setTrainingStatsMeta({
          total: typeof responseStats.total === 'number' ? responseStats.total : nextTotal,
          byStatus: responseStats.byStatus || {},
        });

        if (responsePagination.page && responsePagination.page !== trainingPage) {
          setTrainingPage(responsePagination.page);
        }

        const nextStatuses = new Map(statusMapRef.current);
        sortedTrainings.forEach((training) => {
          if (training?._id) {
            nextStatuses.set(training._id, training.status);
          }
        });
        statusMapRef.current = nextStatuses;
      } catch (error) {
        if (!silent) {
          toast.error(`Failed to fetch trainings: ${error.message}`);
        }
        throw error;
      } finally {
        isFetchingTrainingsRef.current = false;
        if (!silent) {
          setIsFetchingTrainings(false);
        }
        const pendingOptions = pendingFetchOptionsRef.current;
        pendingFetchOptionsRef.current = null;
        if (pendingOptions) {
          fetchTrainings(pendingOptions);
        }
      }
    },
    [
      trainingPage,
      trainingLimit,
      debouncedTrainingSearch,
      trainingStatus,
      trainingUserFilter,
    ]
  );

  const shouldSkipNextFetchRef = useRef(false);

  useEffect(() => {
    if (hasInitialisedRef.current) return;
    hasInitialisedRef.current = true;
    shouldSkipNextFetchRef.current = true;
    (async () => {
      try {
        setLoading(true);
        await Promise.all([fetchUsersList(), fetchTrainings({ silent: true })]);
      } catch (error) {
        // errors already surfaced via toast
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchUsersList, fetchTrainings]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hasInitialisedRef.current) return;
    if (shouldSkipNextFetchRef.current) {
      shouldSkipNextFetchRef.current = false;
      return;
    }
    fetchTrainings();
  }, [fetchTrainings]);

  const scheduleTrainingRefresh = useCallback(() => {
    if (trainingRefreshTimeoutRef.current) return;
    trainingRefreshTimeoutRef.current = setTimeout(async () => {
      try {
        await fetchTrainings({ silent: true });
      } catch (error) {
        console.warn('Failed to refresh trainings feed', error);
      } finally {
        trainingRefreshTimeoutRef.current = null;
      }
    }, 600);
  }, [fetchTrainings]);

  const handleTrainingStreamUpdate = useCallback(
    (payload) => {
      const items = Array.isArray(payload) ? payload : payload ? [payload] : [];
      let shouldRefresh = false;

      items.forEach((item) => {
        if (!item?._id || !item.status) {
          return;
        }
        const previousStatus = statusMapRef.current.get(item._id);
        if (previousStatus && previousStatus !== item.status) {
          if (item.status === 'succeeded') {
            toast.success(`Training "${item.modelName || 'model'}" completed`);
          } else if (item.status === 'failed') {
            toast.error(
              item.error
                ? `Training "${item.modelName || 'model'}" failed: ${item.error}`
                : `Training "${item.modelName || 'model'}" failed`
            );
          } else if (item.status === 'canceled') {
            toast(`Training "${item.modelName || 'model'}" canceled`, { icon: '⚠️' });
          }
        }
        if (!previousStatus || previousStatus !== item.status || typeof item.progress === 'number') {
          shouldRefresh = true;
        }
        statusMapRef.current.set(item._id, item.status);
      });

      if (!shouldRefresh) {
        return;
      }

      if (!hasProcessedInitialStreamRef.current) {
        hasProcessedInitialStreamRef.current = true;
        return;
      }

      scheduleTrainingRefresh();
    },
    [scheduleTrainingRefresh]
  );

  const connectEventStream = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
      console.warn('EventSource is not supported in this environment.');
      return;
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    hasProcessedInitialStreamRef.current = false;
    const streamUrl = `${API_BASE_URL}/trainings/stream/live`;
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
        const payload = JSON.parse(event.data);
        handleTrainingStreamUpdate(payload);
      } catch (parseError) {
        console.error('Failed to parse training stream payload', parseError);
      }
    };

    source.onerror = (error) => {
      console.warn('Training stream error, retrying in 4s…', error);
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
  }, [handleTrainingStreamUpdate]);

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
      if (trainingRefreshTimeoutRef.current) {
        clearTimeout(trainingRefreshTimeoutRef.current);
        trainingRefreshTimeoutRef.current = null;
      }
      hasProcessedInitialStreamRef.current = false;
      setIsStreamConnected(false);
    };
  }, [connectEventStream, handleTrainingStreamUpdate]);

  useEffect(() => {
    const nextStatuses = new Map(statusMapRef.current);
    trainings.forEach((training) => {
      if (training?._id) {
        nextStatuses.set(training._id, training.status);
      }
    });
    statusMapRef.current = nextStatuses;
  }, [trainings]);

  useEffect(() => {
    trainingLogsStateRef.current = trainingLogsState;
  }, [trainingLogsState]);

  useEffect(() => {
    setTrainingLogsState((prev) => {
      const next = {};
      trainings.forEach((training) => {
        if (training?._id && prev[training._id]) {
          next[training._id] = prev[training._id];
        }
      });
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [trainings]);

  const handleToggleTrainingLogs = useCallback(
    async (trainingId) => {
      const current = trainingLogsStateRef.current[trainingId];
      if (current?.loading) {
        return;
      }

      if (current?.data) {
        setTrainingLogsState((prev) => ({
          ...prev,
          [trainingId]: {
            ...current,
            open: !current.open,
          },
        }));
        return;
      }

      setTrainingLogsState((prev) => ({
        ...prev,
        [trainingId]: {
          open: true,
          loading: true,
          error: null,
          data: null,
        },
      }));

      try {
        const response = await trainingAPI.getById(trainingId);
        const payload = response?.data || response;
        const trainingData = payload?.data || payload;
        const logs = Array.isArray(trainingData?.logs) ? trainingData.logs : [];
        const logsData = {
          logs,
          logsUrl: trainingData?.logsUrl || null,
          logsCount: Array.isArray(logs) ? logs.length : 0,
        };

        setTrainingLogsState((prev) => ({
          ...prev,
          [trainingId]: {
            open: true,
            loading: false,
            error: null,
            data: logsData,
          },
        }));
      } catch (error) {
        toast.error(`Failed to load logs: ${error.message}`);
        setTrainingLogsState((prev) => ({
          ...prev,
          [trainingId]: {
            open: false,
            loading: false,
            error: error.message,
            data: null,
          },
        }));
      }
    },
    []
  );

  const modelCount =
    typeof trainingStatsMeta.total === 'number' && trainingStatsMeta.total >= 0
      ? trainingStatsMeta.total
      : trainings.length;
  const completedCount = useMemo(() => {
    if (typeof trainingStatsMeta.byStatus?.succeeded === 'number') {
      return trainingStatsMeta.byStatus.succeeded;
    }
    return trainings.filter((t) => t.status === 'succeeded').length;
  }, [trainingStatsMeta, trainings]);

  const totalTrainingPages =
    trainingPagination.totalPages && trainingPagination.totalPages > 0
      ? trainingPagination.totalPages
      : trainingPagination.total > 0
      ? 1
      : 1;
  const currentTrainingPage =
    trainingPagination.totalPages && trainingPagination.totalPages > 0
      ? trainingPagination.page
      : 1;
  const trainingPageSize =
    trainingPagination.limit && trainingPagination.limit > 0
      ? trainingPagination.limit
      : trainingLimit;
  const trainingPageStart =
    trainingPagination.total === 0 ? 0 : (currentTrainingPage - 1) * trainingPageSize + 1;
  const trainingPageEnd =
    trainingPagination.total === 0
      ? 0
      : Math.min(currentTrainingPage * trainingPageSize, trainingPagination.total);
  const hasTrainingFilters =
    Boolean(trainingSearch) ||
    trainingStatus !== 'all' ||
    Boolean(trainingUserFilter) ||
    trainingLimit !== TRAINING_PAGE_SIZES[0];
  const canGoPrevTraining = trainingPagination.hasPrevPage && !isFetchingTrainings;
  const canGoNextTraining = trainingPagination.hasNextPage && !isFetchingTrainings;

  const selectedUser = useMemo(() => {
    const base = users.find((candidate) => candidate._id === formData.userId);
    if (base) return base;
    return userHydrationCacheRef.current.get(formData.userId) || null;
  }, [users, formData.userId]);

  const selectedUserAssets = useMemo(() => {
    if (selectedUser && Array.isArray(selectedUser.imageAssets)) {
      return selectedUser.imageAssets;
    }
    const cached = formData.userId ? userHydrationCacheRef.current.get(formData.userId) : null;
    if (cached && Array.isArray(cached.imageAssets)) {
      return cached.imageAssets;
    }
    return [];
  }, [selectedUser, formData.userId]);
  const selectedUserAssetCount = selectedUserAssets.length;

  const totalDatasetSize = useMemo(
    () =>
      selectedUserAssets.reduce(
        (sum, asset) => sum + (typeof asset.size === 'number' ? asset.size : 0),
        0
      ),
    [selectedUserAssets]
  );

  const handleTrainingResetFilters = useCallback(() => {
    setTrainingSearch('');
    setTrainingStatus('all');
    setTrainingUserFilter('');
    setTrainingLimit(TRAINING_PAGE_SIZES[0]);
    setTrainingPage(1);
  }, []);

  const handleTrainingPreviousPage = useCallback(() => {
    if (!trainingPagination.hasPrevPage) return;
    setTrainingPage((prev) => Math.max(prev - 1, 1));
  }, [trainingPagination.hasPrevPage]);

  const handleTrainingNextPage = useCallback(() => {
    if (!trainingPagination.hasNextPage) return;
    setTrainingPage((prev) => prev + 1);
  }, [trainingPagination.hasNextPage]);

  const handleUserSelect = useCallback(
    (value) => {
      setSelectedUserHydrationError('');
      if (value && !userHydrationCacheRef.current.get(value)) {
        setSelectedUserHydrating(true);
      }
      setFormData((prev) => ({ ...prev, userId: value }));
    },
    [setFormData, setSelectedUserHydrationError, setSelectedUserHydrating]
  );

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSubmitting) return;
    if (!formData.userId) {
      toast.error('Select a user before starting training');
      return;
    }

    if (!selectedUser) {
      toast.error('Unable to locate the selected user. Refresh and try again.');
      return;
    }

    let resolvedUser = selectedUser;
    try {
      if (!resolvedUser || typeof resolvedUser.imageAssets === 'undefined') {
        resolvedUser = await ensureUserHydrated(formData.userId);
      }
    } catch (error) {
      toast.error(`Failed to load user assets: ${error.message}`);
      return;
    }

    if (!resolvedUser) {
      toast.error('Unable to load user data for training.');
      return;
    }

    if (!resolvedUser._id) {
      toast.error('Selected user details are unavailable. Refresh and try again.');
      return;
    }

    setSelectedUserHydrationError('');
    setSelectedUserHydrating(false);

    const resolvedAssets = Array.isArray(resolvedUser.imageAssets) ? resolvedUser.imageAssets : [];
    if (resolvedAssets.length === 0) {
      toast.error('This user has no reference photos yet. Upload images on the Users page first.');
      return;
    }

    try {
      setIsSubmitting(true);
      const payload = {
        userId: formData.userId,
      };

      if (formData.modelName) {
        payload.modelName = formData.modelName;
      }
      if (Object.keys(formData.trainingConfig || {}).length > 0) {
        payload.trainingConfig = formData.trainingConfig;
      }

      const response = await trainingAPI.create(payload);
      const createdTraining = response?.data || response;
      if (createdTraining?._id && createdTraining.status) {
        statusMapRef.current.set(createdTraining._id, createdTraining.status);
      }
      toast.success('Training kicked off');
      resetForm();
      fetchTrainings({ silent: true }).catch((error) =>
        console.warn('Failed to refresh trainings after create', error)
      );
    } catch (error) {
      toast.error(`Failed to start training: ${error.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const openTrainingAsset = (asset) => {
    if (!asset?.url) return;
    setViewerImage({
      src: asset.url,
      title: asset.originalName || asset.key || 'Training image',
      downloadUrl: asset.url,
      sizeLabel:
        typeof asset.size === 'number'
          ? formatFileSize(asset.size)
          : undefined,
    });
  };

  const handleViewerClose = useCallback(() => {
    if (viewerImage?.shouldRevoke && viewerImage?.src?.startsWith('blob:')) {
      URL.revokeObjectURL(viewerImage.src);
    }
    setViewerImage(null);
  }, [viewerImage]);

  const handleCancelTraining = async (id) => {
    if (!window.confirm('Cancel this training job?')) return;

    try {
      const response = await trainingAPI.cancel(id);
      const canceledTraining = response?.data || response;
      if (canceledTraining?._id && canceledTraining.status) {
        statusMapRef.current.set(canceledTraining._id, canceledTraining.status);
      }
      toast.success('Training canceled');
      fetchTrainings({ silent: true }).catch((error) =>
        console.warn('Failed to refresh trainings after cancel', error)
      );
    } catch (error) {
      toast.error(`Failed to cancel: ${error.message}`);
    }
  };

  const resetForm = () => {
    if (viewerImage?.shouldRevoke && viewerImage?.src?.startsWith('blob:')) {
      URL.revokeObjectURL(viewerImage.src);
    }
    setFormData(createInitialForm());
    setViewerImage(null);
    setShowForm(false);
    setIsSubmitting(false);
    setSelectedUserHydrating(false);
    setSelectedUserHydrationError('');
  };

  if (loading) {
    return (
      <div className="space-y-6">
        {/* Header skeleton */}
        <div className="flex items-end justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-96" />
          </div>
          <Skeleton className="h-10 w-40" />
        </div>

        {/* Trainings list skeleton */}
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="space-y-2">
                    <Skeleton className="h-6 w-40" />
                    <Skeleton className="h-4 w-32" />
                  </div>
                  <Skeleton className="h-6 w-24" />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                </div>
                <Skeleton className="h-24 w-full" />
              </CardContent>
              <CardFooter className="gap-2">
                <Skeleton className="h-10 w-32" />
                <Skeleton className="h-10 w-32" />
              </CardFooter>
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
            Model Training
          </h2>
          <p className="mt-1 text-sm text-foreground/60">
            Upload curated portrait datasets to fine-tune your characters.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="hidden sm:inline-flex bg-foreground/10 text-foreground/70">
            {modelCount} jobs
          </Badge>
          <Badge className="hidden sm:inline-flex bg-foreground/10 text-foreground/70">
            {completedCount} completed
          </Badge>
          <Badge className="hidden sm:inline-flex bg-foreground/10 text-foreground/70">
            Page {currentTrainingPage} / {totalTrainingPages}
          </Badge>
          <Badge
            variant={isStreamConnected ? 'success' : 'outline'}
            className="hidden sm:inline-flex"
          >
            {isStreamConnected ? 'Live updates' : 'Reconnecting…'}
          </Badge>
          <Button className="gap-2" onClick={() => setShowForm((prev) => !prev)}>
            <Rocket className="h-4 w-4" />
            {showForm ? 'Close form' : 'Start training'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <div className="space-y-2">
          <Label htmlFor="training-search">Search trainings</Label>
          <Input
            id="training-search"
            type="search"
            placeholder="Search by model name or version"
            value={trainingSearch}
            onChange={(event) => setTrainingSearch(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Status</Label>
          <Select value={trainingStatus} onValueChange={setTrainingStatus}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="queued">Queued</SelectItem>
              <SelectItem value="starting">Starting</SelectItem>
              <SelectItem value="processing">Processing</SelectItem>
              <SelectItem value="succeeded">Succeeded</SelectItem>
              <SelectItem value="failed">Failed</SelectItem>
              <SelectItem value="canceled">Canceled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>User</Label>
          <SearchableSelect
            value={trainingUserFilter}
            onValueChange={setTrainingUserFilter}
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
            value={String(trainingLimit)}
            onValueChange={(value) => setTrainingLimit(Number(value))}
          >
            <SelectTrigger>
              <SelectValue placeholder="Results per page" />
            </SelectTrigger>
            <SelectContent>
              {TRAINING_PAGE_SIZES.map((size) => (
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
            onClick={handleTrainingResetFilters}
            disabled={!hasTrainingFilters}
            className="justify-center"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Reset
          </Button>
        </div>
      </div>

      {isFetchingTrainings && (
        <div className="flex items-center gap-2 text-sm text-foreground/60">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          Refreshing training feed…
        </div>
      )}

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>Start a new fine-tune</CardTitle>
            <CardDescription>
              Pick a user and we’ll bundle their uploaded reference photos into a ZIP for Replicate automatically.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="userId">Select user *</Label>
                  <Select
                    value={formData.userId}
                    onValueChange={handleUserSelect}
                  >
                    <SelectTrigger id="userId">
                      <SelectValue placeholder="Pick a user" />
                    </SelectTrigger>
                    <SelectContent>
                      {users.map((user) => (
                        <SelectItem key={user._id} value={user._id}>
                          {user.name} · {user.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="modelName">Model name (optional)</Label>
                  <Input
                    id="modelName"
                    name="modelName"
                    placeholder="orbiting-salih"
                    value={formData.modelName}
                    onChange={handleInputChange}
                  />
                </div>
              </div>

              <div className="space-y-4 rounded-xl border border-border/60 bg-muted p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-2">
                    <Label>Training dataset</Label>
                    <p className="text-xs text-foreground/45">
                      We’ll compress the selected user’s reference photos into a training-ready ZIP automatically.
                    </p>
                    {selectedUser ? (
                      <>
                        {selectedUserHydrating && (
                          <div className="flex items-center gap-2 text-xs text-foreground/50">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading reference photos…
                          </div>
                        )}
                        {!selectedUserHydrating && !selectedUserHydrationError && (
                          <>
                            {selectedUserAssetCount < 10 && (
                              <p className="text-xs text-amber-300">
                                Fewer than 10 images uploaded. Add more variety for better results.
                              </p>
                            )}
                            <p className="text-xs text-foreground/45">
                              Selected: {selectedUserAssetCount} · Total size {formatFileSize(totalDatasetSize)}
                            </p>
                          </>
                        )}
                        {selectedUserHydrationError && (
                          <p className="text-xs text-red-300">{selectedUserHydrationError}</p>
                        )}
                      </>
                    ) : (
                      <p className="text-xs text-foreground/45">
                        Choose a user to review the dataset that will be sent for training.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">
                      {selectedUser
                        ? selectedUserHydrating
                          ? 'Loading…'
                          : selectedUserHydrationError
                          ? 'Error'
                          : `${selectedUserAssetCount} images`
                        : 'Select user'}
                    </Badge>
                  </div>
                </div>

                {selectedUser ? (
                  selectedUserHydrating ? (
                    <div className="flex items-center gap-2 text-xs text-foreground/50">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Fetching reference photos…
                    </div>
                  ) : selectedUserHydrationError ? (
                    <p className="text-xs text-red-300">
                      Unable to load reference photos: {selectedUserHydrationError}
                    </p>
                  ) : selectedUserAssetCount > 0 ? (
                    <div className="overflow-hidden rounded-xl border border-border/60">
                      <div className="hidden bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-foreground/45 sm:grid sm:grid-cols-[auto,1fr,auto]">
                        <span className="pl-2">Preview</span>
                        <span>File</span>
                        <span className="text-right">Size</span>
                      </div>
                      <ul className="divide-y divide-border/60">
                        {selectedUserAssets.map((asset, index) => {
                          if (!asset?.url) {
                            return null;
                          }
                          const displayName =
                            asset?.originalName ||
                            asset?.key?.split('/').pop() ||
                            `image-${index + 1}.jpg`;
                          const sizeLabel =
                            typeof asset?.size === 'number'
                              ? formatFileSize(asset.size)
                              : '—';
                          const uploadedAt =
                            asset?.uploadedAt && !Number.isNaN(new Date(asset.uploadedAt)?.getTime())
                              ? new Date(asset.uploadedAt)
                              : null;
                          const uploadedLabel = uploadedAt ? uploadedAt.toLocaleDateString() : null;
                          return (
                            <li
                              key={asset?._id || asset?.key || index}
                              className="flex flex-col gap-3 px-4 py-3 sm:grid sm:grid-cols-[auto,1fr,auto] sm:items-center sm:gap-4"
                            >
                              <button
                                type="button"
                                className="group relative h-28 w-full overflow-hidden rounded-lg border border-border/40 bg-card sm:h-16 sm:w-28"
                                onClick={() =>
                                  openTrainingAsset({
                                    ...asset,
                                    originalName: displayName,
                                  })
                                }
                              >
                                <img
                                  src={asset?.url}
                                  alt={displayName}
                                  className="h-full w-full object-cover transition group-hover:scale-[1.02]"
                                />
                                <span className="absolute inset-0 bg-black/30 opacity-0 transition group-hover:opacity-100" />
                                <Maximize2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-white opacity-0 transition group-hover:opacity-100" />
                              </button>
                              <div className="min-w-0 space-y-1">
                                <p className="truncate text-sm font-medium text-foreground">
                                  {displayName}
                                </p>
                                {uploadedLabel ? (
                                  <p className="text-xs uppercase tracking-[0.2em] text-foreground/45">
                                    Uploaded {uploadedLabel}
                                  </p>
                                ) : (
                                  <p className="text-xs uppercase tracking-[0.2em] text-foreground/45">
                                    Source: user library
                                  </p>
                                )}
                              </div>
                              <div className="flex items-center gap-2 sm:justify-end">
                                <span className="text-xs font-medium text-foreground/60">
                                  {sizeLabel}
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-foreground hover:text-accent"
                                  onClick={() =>
                                    openTrainingAsset({
                                      ...asset,
                                      originalName: displayName,
                                    })
                                  }
                                >
                                  <Maximize2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : (
                    <p className="text-xs text-foreground/50">
                      This user has no uploaded images yet. Add reference photos from the Users page before training.
                    </p>
                  )
                ) : (
                  <p className="text-xs text-foreground/50">
                    Select a user to preview the images that will be packaged.
                  </p>
                )}
              </div>

              <CardFooter className="flex flex-col-reverse gap-3 border-none p-0 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" onClick={resetForm} disabled={isSubmitting}>
                  Cancel
                </Button>
                <Button type="submit" className="gap-2" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Launching…
                    </>
                  ) : (
                    <>
                      <Rocket className="h-4 w-4" />
                      Launch training
                    </>
                  )}
                </Button>
              </CardFooter>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-foreground">Training history</h3>
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => fetchTrainings()}
          >
            <RefreshCw className="h-4 w-4" />
            Refresh all
          </Button>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {trainings.map((training) => {
            const statusMeta = STATUS_VARIANTS[training.status] ?? STATUS_VARIANTS.processing;
            const hasNumericProgress =
              typeof training.progress === 'number' && Number.isFinite(training.progress);
            const clampedProgress = hasNumericProgress
              ? Math.min(100, Math.max(0, training.progress))
              : null;
            const progressLabel =
              clampedProgress !== null
                ? Number.isInteger(clampedProgress)
                  ? clampedProgress.toString()
                  : clampedProgress.toFixed(1)
                : null;
            const startedAt = training.startedAt ? new Date(training.startedAt) : null;
            const completedAt = training.completedAt ? new Date(training.completedAt) : null;
            let etaLabel = null;
            if (
              startedAt &&
              clampedProgress !== null &&
              clampedProgress > 0 &&
              clampedProgress < 100
            ) {
              const referenceTime = training.completedAt ? completedAt.getTime() : now;
              const elapsedMs = Math.max(0, referenceTime - startedAt.getTime());
              if (elapsedMs > 0) {
                const remainingMs = (elapsedMs * (100 - clampedProgress)) / clampedProgress;
                etaLabel = formatDuration(remainingMs);
              }
            }
            const attemptsLabel = `${training.attempts ?? 0}/${MAX_TRAINING_ATTEMPTS}`;
            const logsEntry = trainingLogsState[training._id];
            const fetchedLogs = logsEntry?.data?.logs || [];
            const canViewLogs = (training.logsCount ?? 0) > 0 || Boolean(training.hasLogsUrl);
            const datasetCount =
              training.imageAssetCount ??
              training.imageUrlCount ??
              (training.imageAssets?.length || training.imageUrls?.length || 0);
            const showCancel = ['queued', 'starting', 'processing'].includes(training.status);

            return (
              <Card key={training._id} className="flex flex-col justify-between">
                <CardHeader className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-xl">{training.modelName}</CardTitle>
                      <CardDescription className="text-xs text-foreground/45">
                        Started {new Date(training.createdAt).toLocaleString()}
                      </CardDescription>
                    </div>
                    <Badge variant={statusMeta.variant}>
                      {statusMeta.label}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/50">
                    <Boxes className="h-3.5 w-3.5" />
                    <span>{datasetCount} images</span>
                    {training.trainingConfig?.source === 'upload' && (
                      <span className="rounded-full bg-foreground/10 px-2 py-1 text-[11px] uppercase tracking-wide text-foreground/55">
                        ZIP upload
                      </span>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 text-sm text-foreground/70">
                  <p>
                    User · {training.userId?.name} ({training.userId?.email})
                  </p>

                  <div className="grid gap-3 lg:grid-cols-2">
                    <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-3">
                      <div className="flex items-center justify-between text-xs text-foreground/55">
                        <span className="uppercase tracking-[0.25em] text-foreground/45">Progress</span>
                        <span className="font-mono text-foreground">
                          {progressLabel !== null ? `${progressLabel}%` : '—'}
                        </span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-foreground/10">
                        <div
                          className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
                          style={{ width: `${clampedProgress ?? 0}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-foreground/55">
                        <span>Status: {statusMeta.label}</span>
                        {etaLabel ? <span>ETA ~ {etaLabel}</span> : null}
                      </div>
                      <div className="flex items-center justify-between text-[11px] text-foreground/55">
                        <span>Attempts</span>
                        <span className="font-mono text-foreground">{attemptsLabel}</span>
                      </div>
                      {!hasNumericProgress && (
                        <p className="text-[11px] text-foreground/55">
                          Awaiting progress metrics from Replicate…
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2 text-[11px] text-foreground/55">
                        {startedAt ? <span>Started {startedAt.toLocaleString()}</span> : null}
                        {completedAt ? <span>Completed {completedAt.toLocaleString()}</span> : null}
                      </div>
                    </div>
                    <div className="rounded-lg border border-border/60 bg-card/70 p-3 space-y-3">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="text-xs text-foreground/55">
                          <span className="uppercase tracking-[0.25em] text-foreground/45">Logs</span>
                          <span className="ml-2 rounded-full bg-foreground/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-foreground/45">
                            {training.logsCount ?? 0} entries
                          </span>
                        </div>
                        {canViewLogs && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="gap-2"
                            onClick={() => handleToggleTrainingLogs(training._id)}
                          >
                            {logsEntry?.loading ? (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin" />
                                Loading…
                              </>
                            ) : logsEntry?.open ? (
                              <>
                                <ChevronUp className="h-3 w-3" />
                                Hide logs
                              </>
                            ) : (
                              <>
                                <ChevronDown className="h-3 w-3" />
                                View logs
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                      {logsEntry?.error && (
                        <p className="text-xs text-red-300">Failed to load logs: {logsEntry.error}</p>
                      )}
                      {logsEntry?.open && (
                        <>
                          {logsEntry.loading ? (
                            <div className="mt-3 space-y-2 font-mono text-[11px] text-foreground/60">
                              <Skeleton className="h-3 w-full" />
                              <Skeleton className="h-3 w-[80%]" />
                              <Skeleton className="h-3 w-[90%]" />
                            </div>
                          ) : fetchedLogs.length > 0 ? (
                            <div className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1 font-mono text-[11px] text-foreground/65">
                              {fetchedLogs.map((log, index) => (
                                <div key={`${log.timestamp || index}-${log.message}`}>
                                  <span className="text-foreground/40">
                                    {formatTimestamp(log.timestamp)} ·
                                  </span>{' '}
                                  {log.message}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-2 text-xs text-foreground/50">No log entries are available yet.</p>
                          )}
                          {logsEntry?.data?.logsUrl && (
                            <a
                              href={logsEntry.data.logsUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="mt-2 inline-flex items-center gap-2 text-xs text-accent hover:text-accent/80"
                            >
                              <ExternalLink className="h-3 w-3" />
                              Open full log
                            </a>
                          )}
                        </>
                      )}
                      {!canViewLogs && !logsEntry?.open && (
                        <p className="mt-2 text-xs text-foreground/50">Logs will appear once the training starts.</p>
                      )}
                    </div>
                  </div>

                  {training.trainingConfig?.zipUrl && (
                    <a
                      href={training.trainingConfig.zipUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex w-fit items-center gap-2 text-xs text-accent hover:text-accent/80"
                    >
                      <DownloadCloud className="h-3.5 w-3.5" />
                      Download dataset ZIP
                    </a>
                  )}
                  {training.modelVersion && (
                    <p className="break-all font-mono text-xs text-emerald-300">
                      Model version: {training.modelVersion}
                    </p>
                  )}
                  {training.error && (
                    <p className="text-sm text-red-300">
                      {training.error}
                    </p>
                  )}
                  {training.imageAssets?.length > 0 ? (
                    <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs text-foreground/50">
                    <p className="uppercase tracking-[0.25em] text-foreground/45">Dataset preview</p>
                    <span className="font-medium">
                      {training.imageAssetCount ?? training.imageAssets.length} files
                    </span>
                  </div>
                      <div className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto pr-1">
                        {training.imageAssets.map((asset, index) => {
                          if (!asset?.url) return null;
                          return (
                            <button
                              type="button"
                              key={asset._id || asset.key || index}
                              className="group relative h-20 overflow-hidden rounded-md border border-border/40"
                              onClick={() => openTrainingAsset(asset)}
                            >
                              <img
                                src={asset.url}
                                alt={asset.originalName || asset.key || `training-${index + 1}`}
                                className="h-full w-full object-cover transition group-hover:scale-[1.03]"
                              />
                              <span className="absolute inset-0 bg-black/35 opacity-0 transition group-hover:opacity-100" />
                              <Maximize2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-white opacity-0 transition group-hover:opacity-100" />
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : training.imageUrls?.length > 0 ? (
                    <div className="space-y-1 text-xs text-foreground/50">
                      <p className="uppercase tracking-[0.25em]">
                        Dataset links ({training.imageUrlCount ?? training.imageUrls.length})
                      </p>
                      <ul className="space-y-1">
                        {training.imageUrls.slice(0, 6).map((url) => (
                          <li key={url} className="truncate">
                            <a href={url} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent/80">
                              {url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </CardContent>
                <CardFooter className="flex items-center justify-end gap-2 border-t border-border/60 bg-card py-4">
                  {showCancel ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="gap-1"
                      onClick={() => handleCancelTraining(training._id)}
                    >
                      <Ban className="h-4 w-4" />
                      Cancel
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

        <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/20 p-4 sm:flex-row">
          <p className="text-sm text-foreground/60">
            {trainingPagination.total === 0
              ? 'No trainings found'
              : `Showing ${trainingPageStart}-${trainingPageEnd} of ${trainingPagination.total} trainings`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTrainingPreviousPage}
              disabled={!canGoPrevTraining}
              className="gap-1"
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>
            <span className="text-sm font-medium text-foreground">
              Page {currentTrainingPage} / {totalTrainingPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTrainingNextPage}
              disabled={!canGoNextTraining}
              className="gap-1"
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {trainings.length === 0 && !isFetchingTrainings && (
          <Card className="border-dashed border-border/50 bg-card text-center">
            <CardContent className="space-y-3 py-14">
              <CloudUpload className="mx-auto h-10 w-10 text-foreground/30" />
              <h3 className="text-lg font-medium text-foreground">
                {hasTrainingFilters ? 'No trainings match your filters' : 'No training jobs yet'}
              </h3>
              <p className="text-sm text-foreground/55">
                {hasTrainingFilters
                  ? 'Adjust your filters or search terms to reveal matching training jobs.'
                  : 'Start a training job to generate your first custom checkpoints.'}
              </p>
              {hasTrainingFilters ? (
                <Button onClick={handleTrainingResetFilters} className="mt-3">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Clear filters
                </Button>
              ) : (
                <Button onClick={() => setShowForm(true)} className="mt-3">
                  <Rocket className="mr-2 h-4 w-4" />
                  Start training
                </Button>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <ImageViewer open={Boolean(viewerImage)} image={viewerImage} onClose={handleViewerClose} />
    </div>
  );
}

export default Training;
