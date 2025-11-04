import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  BookOpen,
  Plus,
  Loader2,
  Image as ImageIcon,
  Pencil,
  Trash2,
  Layers,
  ArrowUp,
  ArrowDown,
  Ban,
  CheckCircle2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { bookAPI } from '@/services/api';
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
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import ImageViewer from '@/components/ImageViewer';
import { formatFileSize } from '@/utils/file';

const GENDER_OPTIONS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'both', label: 'Both' },
];

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

const BOOK_PAGE_SIZES = [10, 20, 50];

const PAGE_ALIGNMENT_OPTIONS = [
  { value: 'auto', label: 'Alternate automatically' },
  { value: 'left', label: 'Character on left' },
  { value: 'right', label: 'Character on right' },
];

const defaultCoverConfig = () => ({
  headline: '',
  footer: '',
  bodyOverride: '',
  uppercaseName: true,
});

const createEmptyPage = () => ({
  id: null,
  pageType: 'story',
  text: '',
  prompt: '',
  promptMale: '',
  promptFemale: '',
  file: null,
  preview: null,
  previewIsObject: false,
  existingImage: null,
  removeImage: false,
  characterPosition: 'auto',
  cover: defaultCoverConfig(),
  qr: {
    existing: null,
    file: null,
    preview: null,
    previewIsObject: false,
    remove: false,
  },
});

const createEmptyBookForm = () => ({
  name: '',
  description: '',
  gender: 'both',
  status: 'active',
  cover: {
    existing: null,
    file: null,
    preview: null,
    previewIsObject: false,
    action: 'remove',
  },
  pages: [createEmptyPage()],
  coverPage: {
    backgroundImage: {
      existing: null,
      file: null,
      preview: null,
      previewIsObject: false,
      remove: false,
    },
    characterImage: {
      existing: null,
    },
    leftSide: {
      title: '',
      content: '',
      bottomText: '',
    },
    qrCode: {
      existing: null,
      file: null,
      preview: null,
      previewIsObject: false,
      remove: false,
    },
    rightSide: {
      mainTitle: '',
      subtitle: '',
    },
    characterPrompt: '',
    characterPromptMale: '',
    characterPromptFemale: '',
  },
  dedicationPage: {
    backgroundImage: {
      existing: null,
      file: null,
      preview: null,
      previewIsObject: false,
      remove: false,
    },
    kidImage: {
      existing: null,
    },
    title: '',
    secondTitle: '',
    characterPrompt: '',
    characterPromptMale: '',
    characterPromptFemale: '',
  },
});

const revokeIfNeeded = (preview, isObjectUrl) => {
  if (isObjectUrl && preview) {
    URL.revokeObjectURL(preview);
  }
};

function Books() {
  const [books, setBooks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isFetchingBooks, setIsFetchingBooks] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState('create');
  const [formState, setFormState] = useState(createEmptyBookForm);
  const [editingBook, setEditingBook] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [viewerImage, setViewerImage] = useState(null);
  const [activeTab, setActiveTab] = useState('story-pages');
  const [coverPreview, setCoverPreview] = useState(null);
  const [isGeneratingPreview, setIsGeneratingPreview] = useState(false);
  const [dedicationPreview, setDedicationPreview] = useState(null);
  const [isGeneratingDedicationPreview, setIsGeneratingDedicationPreview] = useState(false);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(BOOK_PAGE_SIZES[0]);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [genderFilter, setGenderFilter] = useState('all');
  const [pagination, setPagination] = useState({
    page: 1,
    totalPages: 0,
    total: 0,
    limit: BOOK_PAGE_SIZES[0],
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [stats, setStats] = useState({
    totalBooks: 0,
    totalPages: 0,
    byStatus: { active: 0, inactive: 0 },
    byGender: { male: 0, female: 0, both: 0 },
  });
  const [loadingBookDetailId, setLoadingBookDetailId] = useState(null);
  const formCardRef = useRef(null);
  const latestLoadRequestRef = useRef(null);
  useEffect(() => {
    if (showForm && formCardRef.current) {
      formCardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [showForm, editingBook?._id]);
  const hasInitialisedRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm.trim());
    }, 400);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, genderFilter, limit]);

  const fetchBooks = useCallback(
    async ({ withSpinner = true } = {}) => {
      try {
        if (withSpinner) {
          setLoading(true);
        } else {
          setIsFetchingBooks(true);
        }

        const params = {
          page,
          limit,
        };
        if (debouncedSearch) {
          params.search = debouncedSearch;
        }
        if (statusFilter !== 'all') {
          params.status = statusFilter;
        }
        if (genderFilter !== 'all') {
          params.gender = genderFilter;
        }

        const response = await bookAPI.getAll({ ...params, minimal: true });
        const fetchedBooks = Array.isArray(response?.data)
          ? response.data
          : Array.isArray(response)
          ? response
          : [];
        setBooks(fetchedBooks);

        const responsePagination = response?.pagination || {};
        const responseStats = response?.stats || {};

        const nextPage = responsePagination.page ?? page;
        const nextTotalPages = responsePagination.totalPages ?? 0;
        const nextTotal = responsePagination.total ?? fetchedBooks.length;
        const nextLimit = responsePagination.limit ?? limit;

        const computedHasNext =
          typeof responsePagination.hasNextPage === 'boolean'
            ? responsePagination.hasNextPage
            : nextTotalPages > 0 && nextPage < nextTotalPages;
        const computedHasPrev =
          typeof responsePagination.hasPrevPage === 'boolean'
            ? responsePagination.hasPrevPage
            : nextPage > 1;

        setPagination({
          page: nextPage,
          totalPages: nextTotalPages,
          total: nextTotal,
          limit: nextLimit,
          hasNextPage: computedHasNext,
          hasPrevPage: computedHasPrev,
        });

        const fallbackPageCount = fetchedBooks.reduce(
          (sum, book) => {
            if (typeof book.pageCount === 'number') {
              return sum + book.pageCount;
            }
            return sum + (Array.isArray(book.pages) ? book.pages.length : 0);
          },
          0
        );

        setStats({
          totalBooks:
            typeof responseStats.totalBooks === 'number'
              ? responseStats.totalBooks
              : nextTotal,
          totalPages:
            typeof responseStats.totalPages === 'number'
              ? responseStats.totalPages
              : fallbackPageCount,
          byStatus: {
            active: responseStats?.byStatus?.active ?? 0,
            inactive: responseStats?.byStatus?.inactive ?? 0,
          },
          byGender: {
            male: responseStats?.byGender?.male ?? 0,
            female: responseStats?.byGender?.female ?? 0,
            both: responseStats?.byGender?.both ?? 0,
          },
        });

        if (responsePagination.page && responsePagination.page !== page) {
          setPage(responsePagination.page);
        }
      } catch (error) {
        toast.error(`Failed to fetch books: ${error.message}`);
      } finally {
        if (withSpinner) {
          setLoading(false);
        }
        setIsFetchingBooks(false);
      }
    },
    [page, limit, debouncedSearch, statusFilter, genderFilter]
  );

  useEffect(() => {
    if (!hasInitialisedRef.current) {
      hasInitialisedRef.current = true;
      fetchBooks({ withSpinner: true });
      return;
    }
    fetchBooks({ withSpinner: false });
  }, [fetchBooks]);

  const totalBooksCount =
    typeof stats.totalBooks === 'number' && stats.totalBooks >= 0
      ? stats.totalBooks
      : pagination.total || books.length;

  const totalStoryPages = useMemo(() => {
    if (typeof stats.totalPages === 'number' && stats.totalPages >= 0) {
      return stats.totalPages;
    }
    return books.reduce((sum, book) => {
      if (typeof book.pageCount === 'number') {
        return sum + book.pageCount;
      }
      return sum + (Array.isArray(book.pages) ? book.pages.length : 0);
    }, 0);
  }, [stats.totalPages, books]);

  const effectivePageSize =
    pagination.limit && pagination.limit > 0 ? pagination.limit : limit;
  const totalPagesDisplay =
    pagination.totalPages && pagination.totalPages > 0
      ? pagination.totalPages
      : pagination.total > 0
      ? 1
      : 1;
  const currentPage =
    pagination.totalPages && pagination.totalPages > 0 ? pagination.page : 1;
  const pageStart =
    pagination.total === 0 ? 0 : (currentPage - 1) * effectivePageSize + 1;
  const pageEnd =
    pagination.total === 0
      ? 0
      : Math.min(currentPage * effectivePageSize, pagination.total);
  const hasActiveFilters =
    Boolean(searchTerm) ||
    statusFilter !== 'all' ||
    genderFilter !== 'all' ||
    limit !== BOOK_PAGE_SIZES[0];
  const canGoPrev = pagination.hasPrevPage && !isFetchingBooks;
  const canGoNext = pagination.hasNextPage && !isFetchingBooks;

  const handleResetFilters = useCallback(() => {
    setSearchTerm('');
    setStatusFilter('all');
    setGenderFilter('all');
    setLimit(BOOK_PAGE_SIZES[0]);
    setPage(1);
  }, []);

  const handlePreviousPage = useCallback(() => {
    if (!pagination.hasPrevPage) return;
    setPage((prev) => Math.max(prev - 1, 1));
  }, [pagination.hasPrevPage]);

  const handleNextPage = useCallback(() => {
    if (!pagination.hasNextPage) return;
    setPage((prev) => prev + 1);
  }, [pagination.hasNextPage]);

  const resetForm = useCallback(() => {
    revokeIfNeeded(formState.cover.preview, formState.cover.previewIsObject);
    formState.pages.forEach((page) => {
      revokeIfNeeded(page.preview, page.previewIsObject);
      if (page.qr) {
        revokeIfNeeded(page.qr.preview, page.qr.previewIsObject);
      }
    });
    // Revoke cover page image URLs
  if (formState.coverPage) {
    revokeIfNeeded(formState.coverPage.backgroundImage?.preview, formState.coverPage.backgroundImage?.previewIsObject);
    revokeIfNeeded(formState.coverPage.qrCode?.preview, formState.coverPage.qrCode?.previewIsObject);
  }
  // Revoke dedication page image URLs
  if (formState.dedicationPage) {
    revokeIfNeeded(formState.dedicationPage.backgroundImage?.preview, formState.dedicationPage.backgroundImage?.previewIsObject);
  }
    setFormState(createEmptyBookForm());
    setEditingBook(null);
    setFormMode('create');
    setShowForm(false);
    setIsSaving(false);
    setActiveTab('story-pages');
    setLoadingBookDetailId(null);
  }, [formState.cover, formState.pages, formState.coverPage, formState.dedicationPage]);

  const openCreateForm = () => {
    resetForm();
    setShowForm(true);
  };

  const openEditForm = async (bookOrId) => {
    const bookId = typeof bookOrId === 'string' ? bookOrId : bookOrId?._id;
    if (!bookId) {
      toast.error('Unable to identify book to edit.');
      return;
    }

    if (latestLoadRequestRef.current === bookId) {
      return;
    }

    revokeIfNeeded(formState.cover.preview, formState.cover.previewIsObject);
    formState.pages.forEach((page) => {
      revokeIfNeeded(page.preview, page.previewIsObject);
      if (page.qr) {
        revokeIfNeeded(page.qr.preview, page.qr.previewIsObject);
      }
    });

    let book = typeof bookOrId === 'object' ? bookOrId : null;
    const requiresFetch =
      !book ||
      !Array.isArray(book.pages) ||
      !book.coverPage ||
      !book.dedicationPage;

    const currentRequestId = bookId;

    if (requiresFetch) {
      try {
        latestLoadRequestRef.current = bookId;
        setLoadingBookDetailId(bookId);
        const response = await bookAPI.getById(bookId);
        if (response?.success === false || !response?.data) {
          throw new Error(response?.message || 'Failed to load book details');
        }
        book = response.data;
      } catch (error) {
        toast.error(error.message || 'Failed to load book details');
        setLoadingBookDetailId(null);
        if (latestLoadRequestRef.current === bookId) {
          latestLoadRequestRef.current = null;
        }
        return;
      }

      if (latestLoadRequestRef.current !== currentRequestId) {
        return;
      }
    }

    const sortedPages = [...(book.pages || [])].sort(
      (a, b) => (a.order || 0) - (b.order || 0)
    );

    setFormState({
      name: book.name || '',
      description: book.description || '',
      gender: book.gender || 'both',
      status: book.status || 'active',
      cover: {
        existing: book.coverImage || null,
        file: null,
        preview: book.coverImage?.url || null,
        previewIsObject: false,
        action: 'keep',
      },
      pages:
        sortedPages.length > 0
          ? sortedPages.map((page) => {
              const pageType = page.pageType === 'cover' ? 'cover' : 'story';
              const coverConfig = page.cover || null;
              const qrAsset = coverConfig?.qrCodeImage || null;
              const resolveAssetUrl = (asset) =>
                asset?.url || asset?.downloadUrl || asset?.signedUrl || null;
              return {
                id: page._id || null,
                pageType,
                text: page.text || '',
                prompt:
                  page.characterPrompt ||
                  page.prompt ||
                  page.characterPromptMale ||
                  page.characterPromptFemale ||
                  '',
                promptMale: page.characterPromptMale || page.characterPrompt || '',
                promptFemale:
                  page.characterPromptFemale || page.characterPrompt || '',
                file: null,
                preview:
                  page.backgroundImage?.url || page.characterImage?.url || null,
                previewIsObject: false,
                existingImage: page.backgroundImage || page.characterImage || null,
                removeImage: false,
                characterPosition: page.characterPosition || 'auto',
                cover: {
                  headline: coverConfig?.headline || '',
                  footer: coverConfig?.footer || '',
                  bodyOverride: coverConfig?.bodyOverride || '',
                  uppercaseName:
                    typeof coverConfig?.uppercaseName === 'boolean'
                      ? coverConfig.uppercaseName
                      : true,
                },
                qr: {
                  existing: qrAsset,
                  file: null,
                  preview: resolveAssetUrl(qrAsset),
                  previewIsObject: false,
                  remove: false,
                },
              };
            })
          : [createEmptyPage()],
      coverPage: {
        backgroundImage: {
          existing: book.coverPage?.backgroundImage || null,
          file: null,
          preview: book.coverPage?.backgroundImage?.url || null,
          previewIsObject: false,
          remove: false,
        },
        characterImage: {
          existing: book.coverPage?.characterImage || null,
        },
        leftSide: {
          title: book.coverPage?.leftSide?.title || '',
          content: book.coverPage?.leftSide?.content || '',
          bottomText: book.coverPage?.leftSide?.bottomText || '',
        },
        qrCode: {
          existing: book.coverPage?.qrCode || null,
          file: null,
          preview: book.coverPage?.qrCode?.url || null,
          previewIsObject: false,
          remove: false,
        },
        rightSide: {
          mainTitle: book.coverPage?.rightSide?.mainTitle || '',
          subtitle: book.coverPage?.rightSide?.subtitle || '',
        },
        characterPrompt:
          book.coverPage?.characterPrompt ||
          book.coverPage?.characterPromptMale ||
          book.coverPage?.characterPromptFemale ||
          '',
        characterPromptMale:
          book.coverPage?.characterPromptMale || book.coverPage?.characterPrompt || '',
        characterPromptFemale:
          book.coverPage?.characterPromptFemale ||
          book.coverPage?.characterPrompt ||
          '',
      },
      dedicationPage: {
        backgroundImage: {
          existing: book.dedicationPage?.backgroundImage || null,
          file: null,
          preview: book.dedicationPage?.backgroundImage?.url || null,
          previewIsObject: false,
          remove: false,
        },
        kidImage: {
          existing: book.dedicationPage?.kidImage || null,
        },
        title: book.dedicationPage?.title || '',
        secondTitle: book.dedicationPage?.secondTitle || '',
        characterPrompt:
          book.dedicationPage?.characterPrompt ||
          book.dedicationPage?.characterPromptMale ||
          book.dedicationPage?.characterPromptFemale ||
          '',
        characterPromptMale:
          book.dedicationPage?.characterPromptMale ||
          book.dedicationPage?.characterPrompt ||
          '',
        characterPromptFemale:
          book.dedicationPage?.characterPromptFemale ||
          book.dedicationPage?.characterPrompt ||
          '',
      },
    });

    setEditingBook(book);
    setFormMode('edit');
    setShowForm(true);
    setActiveTab('story-pages');
    setLoadingBookDetailId((prev) => (prev === currentRequestId ? null : prev));
    if (latestLoadRequestRef.current === currentRequestId) {
      latestLoadRequestRef.current = null;
    }
  };

  const handleCoverChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    revokeIfNeeded(formState.cover.preview, formState.cover.previewIsObject);

    const preview = URL.createObjectURL(file);
    setFormState((prev) => ({
      ...prev,
      cover: {
        existing: prev.cover.existing,
        file,
        preview,
        previewIsObject: true,
        action: 'replace',
      },
    }));
  };

  const handleCoverRemove = () => {
    revokeIfNeeded(formState.cover.preview, formState.cover.previewIsObject);
    setFormState((prev) => ({
      ...prev,
      cover: {
        existing: prev.cover.existing,
        file: null,
        preview: null,
        previewIsObject: false,
        action: prev.cover.existing ? 'remove' : 'remove',
      },
    }));
  };

  const handleAddPage = () => {
    setFormState((prev) => ({
      ...prev,
      pages: [...prev.pages, createEmptyPage()],
    }));
  };

  const handleRemovePage = (index) => {
    setFormState((prev) => {
      const nextPages = [...prev.pages];
      const [removed] = nextPages.splice(index, 1);
      if (!nextPages.length) {
        nextPages.push(createEmptyPage());
      }
      revokeIfNeeded(removed.preview, removed.previewIsObject);
      if (removed.qr) {
        revokeIfNeeded(removed.qr.preview, removed.qr.previewIsObject);
      }
      return {
        ...prev,
        pages: nextPages,
      };
    });
  };

  const handleMovePage = (index, direction) => {
    setFormState((prev) => {
      const nextPages = [...prev.pages];
      const swapIndex = direction === 'up' ? index - 1 : index + 1;
      if (swapIndex < 0 || swapIndex >= nextPages.length) return prev;
      [nextPages[index], nextPages[swapIndex]] = [
        nextPages[swapIndex],
        nextPages[index],
      ];
      return { ...prev, pages: nextPages };
    });
  };

  const handlePageTextChange = (index, value) => {
    setFormState((prev) => {
      const nextPages = [...prev.pages];
      nextPages[index] = { ...nextPages[index], text: value };
      return { ...prev, pages: nextPages };
    });
  };

const handlePagePromptChange = (index, gender, value) => {
  setFormState((prev) => {
    const nextPages = [...prev.pages];
    const current = nextPages[index];
    if (!current) return prev;
    const updated = { ...current };

    if (gender === 'male') {
      updated.promptMale = value;
    } else if (gender === 'female') {
      updated.promptFemale = value;
    } else {
      updated.prompt = value;
    }

    const normalizedMale = updated.promptMale?.trim?.();
    const normalizedFemale = updated.promptFemale?.trim?.();
    const normalizedFallback = updated.prompt?.trim?.();

    updated.prompt = normalizedFallback || normalizedMale || normalizedFemale || '';

    nextPages[index] = updated;
    return { ...prev, pages: nextPages };
  });
};

const updatePageCover = (index, updates) => {
  setFormState((prev) => {
    const nextPages = [...prev.pages];
    const current = nextPages[index];
    if (!current) return prev;
    const nextCover = {
      ...defaultCoverConfig(),
      ...(current.cover || {}),
      ...updates,
    };
    nextPages[index] = {
      ...current,
      cover: nextCover,
    };
    return { ...prev, pages: nextPages };
  });
};

const handlePageTypeChange = (index, value) => {
  setFormState((prev) => {
    const nextPages = [...prev.pages];
    const current = nextPages[index];
    if (!current) return prev;
    const nextType = value === 'cover' ? 'cover' : 'story';
    if (nextType === 'story') {
      if (current.qr) {
        revokeIfNeeded(current.qr.preview, current.qr.previewIsObject);
      }
      nextPages[index] = {
        ...current,
        pageType: nextType,
        cover: defaultCoverConfig(),
        qr: {
          existing: null,
          file: null,
          preview: null,
          previewIsObject: false,
          remove: false,
        },
      };
    } else {
      nextPages[index] = {
        ...current,
        pageType: nextType,
        cover: current.cover || defaultCoverConfig(),
        qr: current.qr || {
          existing: null,
          file: null,
          preview: null,
          previewIsObject: false,
          remove: false,
        },
      };
    }
    return { ...prev, pages: nextPages };
  });
};

const handlePageCharacterPositionChange = (index, value) => {
  setFormState((prev) => {
    const nextPages = [...prev.pages];
    const current = nextPages[index];
    if (!current) return prev;
    nextPages[index] = {
      ...current,
      characterPosition: value,
    };
    return { ...prev, pages: nextPages };
  });
};

const handleCoverHeadlineChange = (index, value) => {
  updatePageCover(index, { headline: value });
};

const handleCoverFooterChange = (index, value) => {
  updatePageCover(index, { footer: value });
};

const handleCoverBodyOverrideChange = (index, value) => {
  updatePageCover(index, { bodyOverride: value });
};

const handleCoverUppercaseChange = (index, value) => {
  updatePageCover(index, { uppercaseName: value });
};

const handleCoverQrChange = (index, event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  setFormState((prev) => {
    const nextPages = [...prev.pages];
    const current = nextPages[index];
    if (!current) return prev;
    const nextQr = { ...(current.qr || {}) };
    revokeIfNeeded(nextQr.preview, nextQr.previewIsObject);
    nextQr.file = file;
    nextQr.preview = URL.createObjectURL(file);
    nextQr.previewIsObject = true;
    nextQr.remove = false;
    nextPages[index] = {
      ...current,
      qr: nextQr,
    };
    return { ...prev, pages: nextPages };
  });
};

const handleRemoveCoverQr = (index) => {
  setFormState((prev) => {
    const nextPages = [...prev.pages];
    const current = nextPages[index];
    if (!current) return prev;
    const nextQr = { ...(current.qr || {}) };
    revokeIfNeeded(nextQr.preview, nextQr.previewIsObject);
    nextQr.file = null;
    nextQr.preview = null;
    nextQr.previewIsObject = false;
    nextQr.remove = Boolean(nextQr.existing);
    nextPages[index] = {
      ...current,
      qr: nextQr,
    };
    return { ...prev, pages: nextPages };
  });
};

const handlePageImageChange = (index, event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  setFormState((prev) => {
    const nextPages = [...prev.pages];
    const current = nextPages[index];
    revokeIfNeeded(current.preview, current.previewIsObject);
    const preview = URL.createObjectURL(file);
    nextPages[index] = {
      ...current,
      file,
      preview,
      previewIsObject: true,
      removeImage: false,
    };
    return { ...prev, pages: nextPages };
  });
};

const handleRemovePageImage = (index) => {
  setFormState((prev) => {
    const nextPages = [...prev.pages];
    const current = nextPages[index];
    revokeIfNeeded(current.preview, current.previewIsObject);
    nextPages[index] = {
      ...current,
      file: null,
      preview: null,
      previewIsObject: false,
      removeImage: Boolean(current.existingImage),
    };
    return { ...prev, pages: nextPages };
  });
};

  // Cover Page handlers
  const handleCoverPageBgChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFormState((prev) => {
      const nextCoverPage = { ...prev.coverPage };
      revokeIfNeeded(nextCoverPage.backgroundImage.preview, nextCoverPage.backgroundImage.previewIsObject);

      nextCoverPage.backgroundImage = {
        ...nextCoverPage.backgroundImage,
        file,
        preview: URL.createObjectURL(file),
        previewIsObject: true,
        remove: false,
      };

      return { ...prev, coverPage: nextCoverPage };
    });
  };

  const handleRemoveCoverPageBg = () => {
    setFormState((prev) => {
      const nextCoverPage = { ...prev.coverPage };
      revokeIfNeeded(nextCoverPage.backgroundImage.preview, nextCoverPage.backgroundImage.previewIsObject);

      nextCoverPage.backgroundImage = {
        existing: nextCoverPage.backgroundImage.existing,
        file: null,
        preview: null,
        previewIsObject: false,
        remove: Boolean(nextCoverPage.backgroundImage.existing),
      };

      return { ...prev, coverPage: nextCoverPage };
    });
  };

  const handleCoverPageQrChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setFormState((prev) => {
      const nextCoverPage = { ...prev.coverPage };
      revokeIfNeeded(nextCoverPage.qrCode.preview, nextCoverPage.qrCode.previewIsObject);

      nextCoverPage.qrCode = {
        ...nextCoverPage.qrCode,
        file,
        preview: URL.createObjectURL(file),
        previewIsObject: true,
        remove: false,
      };

      return { ...prev, coverPage: nextCoverPage };
    });
  };

  const handleRemoveCoverPageQr = () => {
    setFormState((prev) => {
      const nextCoverPage = { ...prev.coverPage };
      revokeIfNeeded(nextCoverPage.qrCode.preview, nextCoverPage.qrCode.previewIsObject);

      nextCoverPage.qrCode = {
        existing: nextCoverPage.qrCode.existing,
        file: null,
        preview: null,
        previewIsObject: false,
        remove: Boolean(nextCoverPage.qrCode.existing),
      };

      return { ...prev, coverPage: nextCoverPage };
    });
  };

  const handleCoverPageFieldChange = (section, field, value) => {
    setFormState((prev) => ({
      ...prev,
      coverPage: {
        ...prev.coverPage,
        [section]: {
          ...prev.coverPage[section],
          [field]: value,
        },
      },
    }));
  };

  const handleCoverPagePromptChange = (field, value) => {
    setFormState((prev) => {
      const nextCoverPage = { ...prev.coverPage };
      if (field === 'male') {
        nextCoverPage.characterPromptMale = value;
      } else if (field === 'female') {
        nextCoverPage.characterPromptFemale = value;
      } else {
        nextCoverPage.characterPrompt = value;
      }
      const maleTrim = nextCoverPage.characterPromptMale?.trim?.();
      const femaleTrim = nextCoverPage.characterPromptFemale?.trim?.();
      const neutralTrim =
        field === 'neutral'
          ? value?.trim?.()
          : nextCoverPage.characterPrompt?.trim?.();
      nextCoverPage.characterPrompt =
        neutralTrim || maleTrim || femaleTrim || '';

      return {
        ...prev,
        coverPage: nextCoverPage,
      };
    });
  };

  const handleDedicationFieldChange = (field, value) => {
    setFormState((prev) => ({
      ...prev,
      dedicationPage: {
        ...prev.dedicationPage,
        [field]: value,
      },
    }));
  };

  const handleDedicationPromptChange = (field, value) => {
    setFormState((prev) => {
      const nextDedication = { ...prev.dedicationPage };
      if (field === 'male') {
        nextDedication.characterPromptMale = value;
      } else if (field === 'female') {
        nextDedication.characterPromptFemale = value;
      } else {
        nextDedication.characterPrompt = value;
      }
      const maleTrim = nextDedication.characterPromptMale?.trim?.();
      const femaleTrim = nextDedication.characterPromptFemale?.trim?.();
      const neutralTrim =
        field === 'neutral'
          ? value?.trim?.()
          : nextDedication.characterPrompt?.trim?.();
      nextDedication.characterPrompt =
        neutralTrim || maleTrim || femaleTrim || '';

      return {
        ...prev,
        dedicationPage: nextDedication,
      };
    });
  };

  const handleDedicationImageChange = (imageType, event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Check dimensions for background image
    if (imageType === 'backgroundImage') {
      const img = new Image();
      img.onload = () => {
        if (img.width !== 5375 || img.height !== 2975) {
          toast.error(`Background image must be exactly 5375 x 2975 px. Current: ${img.width} x ${img.height}`);
          event.target.value = '';
          return;
        }

        const preview = URL.createObjectURL(file);
        revokeIfNeeded(
          formState.dedicationPage[imageType].preview,
          formState.dedicationPage[imageType].previewIsObject
        );

        setFormState((prev) => ({
          ...prev,
          dedicationPage: {
            ...prev.dedicationPage,
            [imageType]: {
              existing: null,
              file,
              preview,
              previewIsObject: true,
              remove: false,
            },
          },
        }));
      };
      img.src = URL.createObjectURL(file);
    }
  };

  const handleRemoveDedicationImage = (imageType) => {
    if (imageType !== 'backgroundImage') {
      return;
    }

    revokeIfNeeded(
      formState.dedicationPage[imageType].preview,
      formState.dedicationPage[imageType].previewIsObject
    );

    setFormState((prev) => ({
      ...prev,
      dedicationPage: {
        ...prev.dedicationPage,
        [imageType]: {
          existing: prev.dedicationPage[imageType].existing,
          file: null,
          preview: null,
          previewIsObject: false,
          remove: true,
        },
      },
    }));
  };

  const handleGeneratePreview = async () => {
    // Validate required fields
    const hasBackgroundImage =
      formState.coverPage.backgroundImage.file ||
      formState.coverPage.backgroundImage.preview ||
      formState.coverPage.backgroundImage.existing?.url;

    if (!hasBackgroundImage) {
      toast.error('Please upload or select a background image first');
      return;
    }

    const hasLeftContent =
      formState.coverPage.leftSide.title ||
      formState.coverPage.leftSide.content;
    const hasRightContent = formState.coverPage.rightSide.mainTitle;

    if (!hasLeftContent && !hasRightContent) {
      toast.error('Please fill in at least some text fields');
      return;
    }

    setIsGeneratingPreview(true);

    try {
      const formData = new FormData();

      // Add cover page data
      formData.append('leftSide', JSON.stringify({
        title: formState.coverPage.leftSide.title || '',
        content: formState.coverPage.leftSide.content || '',
        bottomText: formState.coverPage.leftSide.bottomText || '',
      }));
      formData.append('rightSide', JSON.stringify({
        mainTitle: formState.coverPage.rightSide.mainTitle || '',
        subtitle: formState.coverPage.rightSide.subtitle || '',
      }));

      // Add background image
      if (formState.coverPage.backgroundImage.file) {
        formData.append('backgroundImage', formState.coverPage.backgroundImage.file);
      } else if (formState.coverPage.backgroundImage.existing?.url) {
        formData.append('backgroundImageUrl', formState.coverPage.backgroundImage.existing.url);
      }

      // Use existing character image if available (synced from storybooks)
      if (formState.coverPage.characterImage?.existing?.url) {
        formData.append('characterImageUrl', formState.coverPage.characterImage.existing.url);
      }

      // Add QR code if present
      if (formState.coverPage.qrCode.file) {
        formData.append('qrCode', formState.coverPage.qrCode.file);
      } else if (formState.coverPage.qrCode.existing?.url) {
        formData.append('qrCodeUrl', formState.coverPage.qrCode.existing.url);
      }

      // Call API to generate preview
      const response = await bookAPI.generateCoverPreview(formData);

      if (response.data?.previewUrl) {
        setCoverPreview(response.data.previewUrl);
        toast.success('Preview generated successfully!');
      }
    } catch (error) {
      toast.error(`Failed to generate preview: ${error.message}`);
      console.error('Preview generation error:', error);
    } finally {
      setIsGeneratingPreview(false);
    }
  };

  const handleGenerateDedicationPreview = async () => {
    // Validate required fields
    const hasBackgroundImage =
      formState.dedicationPage.backgroundImage.file ||
      formState.dedicationPage.backgroundImage.preview ||
      formState.dedicationPage.backgroundImage.existing?.url;

    if (!hasBackgroundImage) {
      toast.error('Please upload or select a background image first');
      return;
    }

    if (!formState.dedicationPage.title && !formState.dedicationPage.secondTitle) {
      toast.error('Please fill in at least one title field');
      return;
    }

    setIsGeneratingDedicationPreview(true);

    try {
      const formData = new FormData();

      // Add dedication page data
      formData.append('title', formState.dedicationPage.title || '');
      formData.append('secondTitle', formState.dedicationPage.secondTitle || '');

      // Add background image
      if (formState.dedicationPage.backgroundImage.file) {
        formData.append('backgroundImage', formState.dedicationPage.backgroundImage.file);
      } else if (formState.dedicationPage.backgroundImage.existing?.url) {
        formData.append('backgroundImageUrl', formState.dedicationPage.backgroundImage.existing.url);
      }

      // Use existing kid image if available (synced from storybooks)
      if (formState.dedicationPage.kidImage?.existing?.url) {
        formData.append('kidImageUrl', formState.dedicationPage.kidImage.existing.url);
      }

      // Call API to generate preview
      const response = await bookAPI.generateDedicationPreview(formData);

      if (response.data?.previewUrl) {
        setDedicationPreview(response.data.previewUrl);
        toast.success('Dedication preview generated successfully!');
      }
    } catch (error) {
      toast.error(`Failed to generate dedication preview: ${error.message}`);
      console.error('Dedication preview generation error:', error);
    } finally {
      setIsGeneratingDedicationPreview(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSaving) return;

    if (!formState.name.trim()) {
      toast.error('Book name is required');
      return;
    }

    const shouldIncludePage = (page) => {
      const hasText = page.text?.trim?.();
      const hasPrompt =
        page.promptMale?.trim?.() ||
        page.promptFemale?.trim?.() ||
        page.prompt?.trim?.();
      const hasBackground = page.file || page.existingImage;
      const hasCoverInputs =
        page.pageType === 'cover' &&
        (page.cover?.headline?.trim?.() ||
          page.cover?.bodyOverride?.trim?.() ||
          page.cover?.footer?.trim?.());
      const hasQr =
        page.pageType === 'cover' && (page.qr?.file || page.qr?.existing);
      return (
        hasText ||
        hasPrompt ||
        hasBackground ||
        hasCoverInputs ||
        hasQr ||
        page.pageType === 'cover'
      );
    };

    const pagesPayload = [];
    const pageImageFiles = [];
    const pageQrFiles = [];

    for (let idx = 0; idx < formState.pages.length; idx += 1) {
      const page = formState.pages[idx];
      if (!shouldIncludePage(page)) {
        continue;
      }

      const coverConfig =
        page.pageType === 'cover'
          ? {
              headline: page.cover?.headline?.trim?.() || '',
              footer: page.cover?.footer?.trim?.() || '',
              bodyOverride: page.cover?.bodyOverride?.trim?.() || '',
              uppercaseName:
                typeof page.cover?.uppercaseName === 'boolean'
                  ? page.cover.uppercaseName
                  : true,
            }
          : null;

      const promptMale = page.promptMale?.trim?.() || '';
      const promptFemale = page.promptFemale?.trim?.() || '';
      const promptCombined =
        page.prompt?.trim?.() || promptMale || promptFemale || '';

      pagesPayload.push({
        id: page.id,
        order: pagesPayload.length + 1,
        text: page.text,
        prompt: promptCombined,
        promptMale,
        promptFemale,
        hasNewImage: Boolean(page.file),
        removeImage: Boolean(page.removeImage) && !page.file,
        pageType: page.pageType,
        characterPosition: page.characterPosition || 'auto',
        cover: coverConfig,
        hasNewQrImage: page.pageType === 'cover' && Boolean(page.qr?.file),
        removeQrImage:
          page.pageType === 'cover' && Boolean(page.qr?.remove) && !page.qr?.file,
      });

      if (page.file) {
        pageImageFiles.push(page.file);
      }
      if (page.pageType === 'cover' && page.qr?.file) {
        pageQrFiles.push(page.qr.file);
      }
    }

    if (!pagesPayload.length) {
      toast.error('Add at least one page with content before saving');
      return;
    }

    const formData = new FormData();
    formData.append('name', formState.name.trim());
    if (formState.description?.trim()) {
      formData.append('description', formState.description.trim());
    } else {
      formData.append('description', '');
    }
    formData.append('gender', formState.gender);
    formData.append('status', formState.status);

    const coverAction =
      formMode === 'edit'
        ? formState.cover.action
        : formState.cover.file
        ? 'replace'
        : 'remove';
    formData.append('coverAction', coverAction);
    if (formState.cover.file) {
      formData.append('coverImage', formState.cover.file);
    }

    formData.append('pages', JSON.stringify(pagesPayload));
    pageImageFiles.forEach((file) => {
      formData.append('pageImages', file);
    });
    pageQrFiles.forEach((file) => {
      formData.append('pageQrImages', file);
    });

    // Add cover page data
    const coverPageData = {
      leftSide: {
        title: formState.coverPage.leftSide.title || '',
        content: formState.coverPage.leftSide.content || '',
        bottomText: formState.coverPage.leftSide.bottomText || '',
      },
      rightSide: {
        mainTitle: formState.coverPage.rightSide.mainTitle || '',
        subtitle: formState.coverPage.rightSide.subtitle || '',
      },
      hasNewBackgroundImage: Boolean(formState.coverPage.backgroundImage.file),
      removeBackgroundImage: Boolean(formState.coverPage.backgroundImage.remove) && !formState.coverPage.backgroundImage.file,
      hasNewQrCode: Boolean(formState.coverPage.qrCode.file),
      removeQrCode: Boolean(formState.coverPage.qrCode.remove) && !formState.coverPage.qrCode.file,
      characterPrompt:
        formState.coverPage.characterPrompt ||
        formState.coverPage.characterPromptMale ||
        formState.coverPage.characterPromptFemale ||
        '',
      characterPromptMale: formState.coverPage.characterPromptMale || '',
      characterPromptFemale: formState.coverPage.characterPromptFemale || '',
    };
    formData.append('coverPage', JSON.stringify(coverPageData));

    if (formState.coverPage.backgroundImage.file) {
      formData.append('coverPageBackgroundImage', formState.coverPage.backgroundImage.file);
    }
    if (formState.coverPage.qrCode.file) {
      formData.append('coverPageQrCode', formState.coverPage.qrCode.file);
    }

    // Add dedication page data
    const dedicationPageData = {
      title: formState.dedicationPage.title || '',
      secondTitle: formState.dedicationPage.secondTitle || '',
      hasNewBackgroundImage: Boolean(formState.dedicationPage.backgroundImage.file),
      removeBackgroundImage: Boolean(formState.dedicationPage.backgroundImage.remove) && !formState.dedicationPage.backgroundImage.file,
      characterPrompt:
        formState.dedicationPage.characterPrompt ||
        formState.dedicationPage.characterPromptMale ||
        formState.dedicationPage.characterPromptFemale ||
        '',
      characterPromptMale: formState.dedicationPage.characterPromptMale || '',
      characterPromptFemale: formState.dedicationPage.characterPromptFemale || '',
    };
    formData.append('dedicationPage', JSON.stringify(dedicationPageData));

    if (formState.dedicationPage.backgroundImage.file) {
      formData.append('dedicationPageBackgroundImage', formState.dedicationPage.backgroundImage.file);
    }

    setIsSaving(true);

    try {
      if (formMode === 'edit' && editingBook?._id) {
        await bookAPI.update(editingBook._id, formData);
        toast.success('Book updated');
      } else {
        await bookAPI.create(formData);
        toast.success('Book created');
      }
      await fetchBooks({ withSpinner: false });
      resetForm();
    } catch (error) {
      toast.error(`Failed to save book: ${error.message}`);
      setIsSaving(false);
    }
  };

  const handleDeleteBook = async (bookId) => {
    if (!window.confirm('Delete this book permanently?')) return;
    try {
      await bookAPI.delete(bookId);
      toast.success('Book deleted');
      fetchBooks({ withSpinner: false });
    } catch (error) {
      toast.error(`Failed to delete book: ${error.message}`);
    }
  };

  const handleToggleStatus = async (book) => {
    const nextStatus = book.status === 'active' ? 'inactive' : 'active';
    try {
      await bookAPI.updateStatus(book._id, nextStatus);
      toast.success(
        `Book ${nextStatus === 'active' ? 'activated' : 'deactivated'}`
      );
      fetchBooks({ withSpinner: false });
    } catch (error) {
      toast.error(`Failed to update status: ${error.message}`);
    }
  };

  const openImageViewer = (image, fallbackTitle) => {
    if (!image?.url && !image?.preview) return;
    setViewerImage({
      src: image.url || image.preview,
      title: image.originalName || fallbackTitle,
      downloadUrl: image.url,
      sizeLabel:
        typeof image.size === 'number' ? formatFileSize(image.size) : undefined,
    });
  };

  const handleViewerClose = useCallback(() => {
    setViewerImage(null);
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        {/* Header skeleton */}
        <div className="flex items-end justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-96" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>

        {/* Books grid skeleton */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-4 w-32" />
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-10 w-full" />
                </div>
                <div className="space-y-2">
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-20 w-full" />
                </div>
              </CardContent>
              <CardFooter className="gap-2">
                <Skeleton className="h-10 flex-1" />
                <Skeleton className="h-10 w-10" />
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
            Story Books
          </h2>
          <p className="mt-1 text-sm text-foreground/60">
            Curate interactive storybooks with rich background art for personalised adventures.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge className="hidden sm:inline-flex bg-foreground/10 text-foreground/70">
            {totalBooksCount} books
          </Badge>
          <Badge className="hidden sm:inline-flex bg-foreground/10 text-foreground/70">
            {totalStoryPages} story pages
          </Badge>
          <Badge className="hidden sm:inline-flex bg-foreground/10 text-foreground/70">
            Page {currentPage} / {totalPagesDisplay}
          </Badge>
          <Button className="gap-2" onClick={openCreateForm}>
            <Plus className="h-4 w-4" />
            Add book
          </Button>
        </div>
      </div>

      {loadingBookDetailId ? (
        <div className="flex items-center gap-2 text-sm text-foreground/60">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          Loading book details…
        </div>
      ) : null}

      <div className="grid gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto]">
        <div className="space-y-2">
          <Label htmlFor="book-search">Search books</Label>
          <Input
            id="book-search"
            type="search"
            placeholder="Search by name or description"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Gender focus</Label>
          <Select value={genderFilter} onValueChange={setGenderFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Filter by gender focus" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All genders</SelectItem>
              <SelectItem value="male">Male</SelectItem>
              <SelectItem value="female">Female</SelectItem>
              <SelectItem value="both">Both</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Per page</Label>
          <Select value={String(limit)} onValueChange={(value) => setLimit(Number(value))}>
            <SelectTrigger>
              <SelectValue placeholder="Results per page" />
            </SelectTrigger>
            <SelectContent>
              {BOOK_PAGE_SIZES.map((size) => (
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
            onClick={handleResetFilters}
            disabled={!hasActiveFilters}
            className="justify-center"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Reset
          </Button>
        </div>
      </div>

      {isFetchingBooks && (
        <div className="flex items-center gap-2 text-sm text-foreground/60">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
          Refreshing library…
        </div>
      )}

      {showForm && (
        <Card ref={formCardRef}>
          <CardHeader>
            <CardTitle>{formMode === 'edit' ? 'Edit book' : 'Create new book'}</CardTitle>
            <CardDescription>
              Define the story metadata, cover, and per-page content for this personalised book.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="bookName">Book name *</Label>
                  <Input
                    id="bookName"
                    value={formState.name}
                    onChange={(event) =>
                      setFormState((prev) => ({
                        ...prev,
                        name: event.target.value,
                      }))
                    }
                    placeholder="The Galactic Explorer"
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Gender focus</Label>
                  <Select
                    value={formState.gender}
                    onValueChange={(value) =>
                      setFormState((prev) => ({ ...prev, gender: value }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select gender" />
                    </SelectTrigger>
                    <SelectContent>
                      {GENDER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor="bookDescription">Description</Label>
                  <Textarea
                    id="bookDescription"
                    minRows={4}
                    placeholder="A thrilling journey through space tailored to your child's imagination."
                    value={formState.description}
                    onChange={(event) =>
                      setFormState((prev) => ({
                        ...prev,
                        description: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Status</Label>
                  <Select
                    value={formState.status}
                    onValueChange={(value) =>
                      setFormState((prev) => ({ ...prev, status: value }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select status" />
                    </SelectTrigger>
                    <SelectContent>
                      {STATUS_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-3 rounded-xl border border-border/60 bg-muted p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <Label>Cover image</Label>
                    <p className="text-xs text-foreground/50">
                      Upload artwork that represents the story. Landscape orientation works best.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => document.getElementById('coverImageInput')?.click()}
                    >
                      <ImageIcon className="mr-2 h-4 w-4" />
                      Choose cover
                    </Button>
                    {formState.cover.preview && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-red-300 hover:text-red-200"
                        onClick={handleCoverRemove}
                      >
                        Remove
                      </Button>
                    )}
                    <input
                      id="coverImageInput"
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={handleCoverChange}
                    />
                  </div>
                </div>
                {formState.cover.preview ? (
                  <div className="relative overflow-hidden rounded-xl border border-border/60 bg-card">
                    <img
                      src={formState.cover.preview}
                      alt="Book cover preview"
                      className="w-full object-cover"
                      onClick={() =>
                        openImageViewer(
                          formState.cover.file
                            ? { url: formState.cover.preview, size: formState.cover.file.size }
                            : formState.cover.existing,
                          'Book cover'
                        )
                      }
                    />
                  </div>
                ) : (
                  <p className="text-xs text-foreground/50">
                    No cover selected yet.
                  </p>
                )}
              </div>

              <div className="space-y-4 rounded-xl border border-border/60 bg-muted p-4">
                <Tabs value={activeTab} onValueChange={setActiveTab}>
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="story-pages">Story Pages</TabsTrigger>
                    <TabsTrigger value="cover-page">Cover Page</TabsTrigger>
                    <TabsTrigger value="dedication-page">Dedication Page</TabsTrigger>
                  </TabsList>

                  <TabsContent value="story-pages" className="space-y-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <Label>Story Pages</Label>
                        <p className="text-xs text-foreground/50">
                          Add story beats with accompanying background visuals for each page.
                        </p>
                      </div>
                      <Button type="button" variant="outline" className="gap-2" onClick={handleAddPage}>
                        <Plus className="h-4 w-4" />
                        Add page
                      </Button>
                    </div>

                <div className="space-y-4">
                  {formState.pages.map((page, index) => (
                    <div
                      key={page.id || index}
                      className="space-y-3 rounded-lg border border-border/60 bg-card p-4"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
                          <Layers className="h-4 w-4 text-foreground/50" />
                          <span>Page {index + 1}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={index === 0}
                            onClick={() => handleMovePage(index, 'up')}
                          >
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            disabled={index === formState.pages.length - 1}
                            onClick={() => handleMovePage(index, 'down')}
                          >
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-red-300 hover:text-red-200"
                            onClick={() => handleRemovePage(index)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Character placement</Label>
                        <Select
                          value={page.characterPosition || 'auto'}
                          onValueChange={(value) => handlePageCharacterPositionChange(index, value)}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Placement" />
                          </SelectTrigger>
                          <SelectContent>
                            {PAGE_ALIGNMENT_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-foreground/50">
                          "Auto" keeps the alternating layout. Override to force the artwork left or right.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={`page-text-${index}`}>Narration</Label>
                        <Textarea
                          id={`page-text-${index}`}
                          minRows={3}
                          placeholder="Describe the scene and action for this page."
                          value={page.text}
                          onChange={(event) =>
                            handlePageTextChange(index, event.target.value)
                          }
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>Background image</Label>
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              document
                                .getElementById(`page-image-${index}`)
                                ?.click()
                            }
                          >
                            <ImageIcon className="mr-2 h-4 w-4" />
                            {page.preview ? 'Change image' : 'Upload image'}
                          </Button>
                          {page.preview && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-red-300 hover:text-red-200"
                              onClick={() => handleRemovePageImage(index)}
                            >
                              Remove
                            </Button>
                          )}
                          <input
                            id={`page-image-${index}`}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(event) => handlePageImageChange(index, event)}
                          />
                        </div>
                        {page.preview ? (
                          <div className="group relative overflow-hidden rounded-lg border border-border/60 bg-muted/40">
                            <img
                              src={page.preview}
                              alt={`Page ${index + 1} background`}
                              className="h-48 w-full object-cover transition group-hover:scale-[1.02]"
                              onClick={() =>
                                openImageViewer(
                                  page.file
                                    ? {
                                        url: page.preview,
                                        size: page.file.size,
                                        originalName: page.file.name,
                                      }
                                    : page.existingImage,
                                  `Page ${index + 1} background`
                                )
                              }
                            />
                          </div>
                        ) : (
                          <p className="text-xs text-foreground/50">
                            No background image attached.
                          </p>
                        )}
                      </div>

                      <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor={`page-prompt-male-${index}`}>
                              Character prompt (male reader)
                            </Label>
                            <Textarea
                              id={`page-prompt-male-${index}`}
                              minRows={2}
                              placeholder="Describe the character when the reader is male."
                              value={page.promptMale}
                              onChange={(event) =>
                                handlePagePromptChange(index, 'male', event.target.value)
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor={`page-prompt-female-${index}`}>
                              Character prompt (female reader)
                            </Label>
                            <Textarea
                              id={`page-prompt-female-${index}`}
                              minRows={2}
                              placeholder="Describe the character when the reader is female."
                              value={page.promptFemale}
                              onChange={(event) =>
                                handlePagePromptChange(index, 'female', event.target.value)
                              }
                            />
                          </div>
                        </div>
                        <p className="text-xs text-foreground/50">
                          Prompts feed future character generation; leave a field empty to reuse the other prompt.
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                  </TabsContent>

                  <TabsContent value="cover-page" className="space-y-4">
                    <div className="space-y-3">
                      <div>
                        <Label className="text-base">Cover Page Editor</Label>
                        <p className="text-xs text-foreground/50 mt-1">
                          Design the backcover of your book with customizable text and images. Use {'{name}'} and pronoun tags like {'{gender}'}, {'{genderx}'}, {'{gendery}'}, {'{genderz}'} for dynamic personalisation.
                        </p>
                      </div>

                      {/* Background Image */}
                      <div className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <Label>Background Image</Label>
                            <p className="text-xs text-foreground/50">
                              Upload the background image for the cover page.
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => document.getElementById('coverPageBgInput')?.click()}
                            >
                              <ImageIcon className="mr-2 h-4 w-4" />
                              {formState.coverPage.backgroundImage.preview ? 'Change image' : 'Upload image'}
                            </Button>
                            {formState.coverPage.backgroundImage.preview && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-red-300 hover:text-red-200"
                                onClick={handleRemoveCoverPageBg}
                              >
                                Remove
                              </Button>
                            )}
                            <input
                              id="coverPageBgInput"
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={handleCoverPageBgChange}
                            />
                          </div>
                        </div>
                        {formState.coverPage.backgroundImage.preview ? (
                          <div className="relative overflow-hidden rounded-lg border border-border/60 bg-muted/40">
                            <img
                              src={formState.coverPage.backgroundImage.preview}
                              alt="Cover page background"
                              className="h-48 w-full object-cover"
                            />
                          </div>
                        ) : (
                          <p className="text-xs text-foreground/50">No background image selected.</p>
                        )}
                      </div>

                      <div className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
                        <Label>Cover character prompts</Label>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="coverPageCharacterPromptMale">
                              Male reader
                            </Label>
                            <Textarea
                              id="coverPageCharacterPromptMale"
                              minRows={3}
                              placeholder="Describe the cover character when the reader is male."
                              value={formState.coverPage.characterPromptMale}
                              onChange={(event) =>
                                handleCoverPagePromptChange('male', event.target.value)
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="coverPageCharacterPromptFemale">
                              Female reader
                            </Label>
                            <Textarea
                              id="coverPageCharacterPromptFemale"
                              minRows={3}
                              placeholder="Describe the cover character when the reader is female."
                              value={formState.coverPage.characterPromptFemale}
                              onChange={(event) =>
                                handleCoverPagePromptChange('female', event.target.value)
                              }
                            />
                          </div>
                        </div>
                        <p className="text-xs text-foreground/50">
                          Leave a field empty to reuse the other prompt. Prompts guide automatic cover character generation and support {'{name}'} and gender placeholders ({'{gender}'}, {'{genderx}'}, {'{gendery}'}, {'{genderz}'}).
                        </p>
                      </div>

                      {/* Left Side Section */}
                      <div className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
                        <Label className="text-base">Left Side Content</Label>

                        <div className="space-y-2">
                          <Label htmlFor="coverPageLeftTitle">Title</Label>
                          <Textarea
                            id="coverPageLeftTitle"
                            minRows={2}
                            placeholder="Join {name} on an Unforgettable Adventure Across Israel!"
                            value={formState.coverPage.leftSide.title}
                            onChange={(event) =>
                              handleCoverPageFieldChange('leftSide', 'title', event.target.value)
                            }
                          />
                          <p className="text-xs text-foreground/50">
                            Use {'{name}'} or pronoun placeholders ({'{gender}'}, {'{genderx}'}, {'{gendery}'}, {'{genderz}'}) for the child's details.
                          </p>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="coverPageLeftContent">Content</Label>
                          <Textarea
                            id="coverPageLeftContent"
                            minRows={6}
                            placeholder="From the sparkling shores of the Kinneret to the ancient stones of the Kotel, {name} is on a journey like no other..."
                            value={formState.coverPage.leftSide.content}
                            onChange={(event) =>
                              handleCoverPageFieldChange('leftSide', 'content', event.target.value)
                            }
                          />
                          <p className="text-xs text-foreground/50">
                            Main description text. Use {'{name}'} and gender placeholders to personalise the story.
                          </p>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="coverPageLeftBottomText">Bottom Text</Label>
                          <Input
                            id="coverPageLeftBottomText"
                            placeholder="Shop more books at Mytorahtales.com"
                            value={formState.coverPage.leftSide.bottomText}
                            onChange={(event) =>
                              handleCoverPageFieldChange('leftSide', 'bottomText', event.target.value)
                            }
                          />
                        </div>
                      </div>

                      {/* QR Code Section */}
                      <div className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <Label>QR Code Image</Label>
                            <p className="text-xs text-foreground/50">
                              Upload a QR code to be displayed on the cover.
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => document.getElementById('coverPageQrInput')?.click()}
                            >
                              <ImageIcon className="mr-2 h-4 w-4" />
                              {formState.coverPage.qrCode.preview ? 'Change QR code' : 'Upload QR code'}
                            </Button>
                            {formState.coverPage.qrCode.preview && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="text-red-300 hover:text-red-200"
                                onClick={handleRemoveCoverPageQr}
                              >
                                Remove
                              </Button>
                            )}
                            <input
                              id="coverPageQrInput"
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={handleCoverPageQrChange}
                            />
                          </div>
                        </div>
                        {formState.coverPage.qrCode.preview ? (
                          <div className="relative w-40 overflow-hidden rounded-lg border border-border/60 bg-muted/40">
                            <img
                              src={formState.coverPage.qrCode.preview}
                              alt="Cover page QR code"
                              className="h-40 w-full object-contain"
                            />
                          </div>
                        ) : (
                          <p className="text-xs text-foreground/50">No QR code uploaded.</p>
                        )}
                      </div>

                      {/* Right Side Section */}
                      <div className="space-y-3 rounded-lg border border-border/60 bg-card p-4">
                        <Label className="text-base">Right Side Content</Label>

                        <div className="space-y-2">
                          <Label htmlFor="coverPageRightTitle">Main Title</Label>
                          <Textarea
                            id="coverPageRightTitle"
                            minRows={2}
                            placeholder="{name}'s TRIP TO ISRAEL"
                            value={formState.coverPage.rightSide.mainTitle}
                            onChange={(event) =>
                              handleCoverPageFieldChange('rightSide', 'mainTitle', event.target.value)
                            }
                          />
                          <p className="text-xs text-foreground/50">
                            Main title displayed prominently on the right in ALL CAPS. Use {'{name}'} and gender placeholders for dynamic personalisation.
                          </p>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="coverPageRightSubtitle">Subtitle</Label>
                          <Input
                            id="coverPageRightSubtitle"
                            placeholder="An amazing adventure"
                            value={formState.coverPage.rightSide.subtitle}
                            onChange={(event) =>
                              handleCoverPageFieldChange('rightSide', 'subtitle', event.target.value)
                            }
                          />
                          <p className="text-xs text-foreground/50">
                            Small text displayed below the main title.
                          </p>
                        </div>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="dedication-page" className="space-y-4">
                    <div className="space-y-4 rounded-xl border border-border/60 bg-card p-6">
                      <div className="space-y-3">
                        <h3 className="font-semibold text-foreground">Background Image (5375 x 2975 px)</h3>
                        <p className="text-xs text-muted-foreground">Upload the background image for the dedication page</p>
                        <Input
                          type="file"
                          accept="image/*"
                          onChange={(e) => handleDedicationImageChange('backgroundImage', e)}
                        />
                        {formState.dedicationPage.backgroundImage.preview && (
                          <div className="relative">
                            <img
                              src={formState.dedicationPage.backgroundImage.preview}
                              alt="Background preview"
                              className="w-full rounded-lg"
                            />
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              className="absolute top-2 right-2"
                              onClick={() => handleRemoveDedicationImage('backgroundImage')}
                            >
                              Remove
                            </Button>
                          </div>
                        )}
                      </div>

                      <div className="space-y-3">
                        <h3 className="font-semibold text-foreground">Character prompts</h3>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-2">
                            <Label htmlFor="dedicationPromptMale">Male reader</Label>
                            <Textarea
                              id="dedicationPromptMale"
                              minRows={3}
                              placeholder="Describe the dedication illustration for a male reader."
                              value={formState.dedicationPage.characterPromptMale}
                              onChange={(event) =>
                                handleDedicationPromptChange('male', event.target.value)
                              }
                            />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="dedicationPromptFemale">Female reader</Label>
                            <Textarea
                              id="dedicationPromptFemale"
                              minRows={3}
                              placeholder="Describe the dedication illustration for a female reader."
                              value={formState.dedicationPage.characterPromptFemale}
                              onChange={(event) =>
                                handleDedicationPromptChange('female', event.target.value)
                              }
                            />
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Prompts guide dedication artwork generation. Leave one blank to reuse the other; {'{name}'} and gender placeholders personalise content.
                        </p>
                      </div>

                      <div className="space-y-3">
                        <h3 className="font-semibold text-foreground">Right Side Content</h3>
                        <div className="space-y-2">
                          <Label htmlFor="dedicationTitle">Title (Name)</Label>
                          <Input
                            id="dedicationTitle"
                            placeholder="Enter name or title"
                            value={formState.dedicationPage.title}
                            onChange={(e) => handleDedicationFieldChange('title', e.target.value)}
                          />
                          <p className="text-xs text-foreground/50">
                            Main title displayed on the right. Use {'{name}'} and gender placeholders for dynamic name insertion.
                          </p>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="dedicationSecondTitle">Second Title</Label>
                          <Textarea
                            id="dedicationSecondTitle"
                            minRows={4}
                            placeholder="Enter second title (use line breaks to control spacing)"
                            value={formState.dedicationPage.secondTitle}
                            onChange={(e) => handleDedicationFieldChange('secondTitle', e.target.value)}
                          />
                          <p className="text-xs text-foreground/50">
                            Secondary title displayed below the main title. Use the Enter key to add new lines.
                          </p>
                        </div>
                      </div>

                      {/* Generate Preview Button */}
                      <Button
                        type="button"
                        onClick={handleGenerateDedicationPreview}
                        disabled={isGeneratingDedicationPreview}
                        className="w-full"
                      >
                        {isGeneratingDedicationPreview ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            Generating Preview...
                          </>
                        ) : (
                          'Generate Preview'
                        )}
                      </Button>
                    </div>
                  </TabsContent>
                </Tabs>
              </div>

              {/* Cover Preview Section */}
              {activeTab === 'cover-page' && coverPreview && (
                <div className="space-y-3 rounded-xl border border-border/60 bg-muted p-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-base">Preview</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setCoverPreview(null)}
                    >
                      Close Preview
                    </Button>
                  </div>
                  <div className="relative overflow-hidden rounded-lg border border-border/60 bg-card">
                    <img
                      src={coverPreview}
                      alt="Cover page preview"
                      className="w-full object-contain"
                      onClick={() =>
                        openImageViewer(
                          { url: coverPreview },
                          'Cover page preview'
                        )
                      }
                    />
                  </div>
                </div>
              )}

              {/* Dedication Preview Section */}
              {activeTab === 'dedication-page' && dedicationPreview && (
                <div className="space-y-3 rounded-xl border border-border/60 bg-muted p-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-base">Dedication Preview</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDedicationPreview(null)}
                    >
                      Close Preview
                    </Button>
                  </div>
                  <div className="relative overflow-hidden rounded-lg border border-border/60 bg-card">
                    <img
                      src={dedicationPreview}
                      alt="Dedication page preview"
                      className="w-full object-contain"
                      onClick={() =>
                        openImageViewer(
                          { url: dedicationPreview },
                          'Dedication page preview'
                        )
                      }
                    />
                  </div>
                </div>
              )}

              <CardFooter className="flex flex-col-reverse gap-3 border-none p-0 sm:flex-row sm:justify-between">
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" onClick={resetForm} disabled={isSaving || isGeneratingPreview}>
                    Cancel
                  </Button>
                  {activeTab === 'cover-page' && (
                    <Button
                      type="button"
                      variant="outline"
                      className="gap-2"
                      onClick={handleGeneratePreview}
                      disabled={isSaving || isGeneratingPreview}
                    >
                      {isGeneratingPreview ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          Generating…
                        </>
                      ) : (
                        <>
                          <ImageIcon className="h-4 w-4" />
                          Generate Preview
                        </>
                      )}
                    </Button>
                  )}
                </div>
                <Button type="submit" className="gap-2" disabled={isSaving || isGeneratingPreview}>
                  {isSaving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    <>
                      <BookOpen className="h-4 w-4" />
                      {formMode === 'edit' ? 'Update book' : 'Create book'}
                    </>
                  )}
                </Button>
              </CardFooter>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {books.map((book) => {
          const pageCount =
            typeof book.pageCount === 'number'
              ? book.pageCount
              : Array.isArray(book.pages)
              ? book.pages.length
              : 0;
        const hasDetailedPages = Array.isArray(book.pages) && book.pages.length > 0;
        const highlightedPageCount = hasDetailedPages
          ? book.pages.filter(
              (page) => page.backgroundImage?.url || page.characterImage?.url
            ).length
          : 0;
          const isLoadingDetails = loadingBookDetailId === book._id;

          return (
            <Card key={book._id} className="flex flex-col justify-between">
            <CardHeader className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="text-lg">{book.name}</CardTitle>
                  <CardDescription className="text-xs text-foreground/55">
                    {book.description || 'No description provided.'}
                  </CardDescription>
                </div>
                <Badge variant={book.status === 'active' ? 'success' : 'secondary'}>
                  {book.status}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-foreground/50">
                <BookOpen className="h-3.5 w-3.5" />
                <span>{pageCount} pages</span>
                <span className="rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] uppercase tracking-wide text-foreground/55">
                  {book.gender}
                </span>
              </div>
            </CardHeader>

            {book.coverImage?.url ? (
              <div className="mx-4 overflow-hidden rounded-lg border border-border/60 bg-muted/20">
                <img
                  src={book.coverImage.url}
                  alt={`${book.name} cover`}
                  className="h-44 w-full object-cover"
                  onClick={() => openImageViewer(book.coverImage, `${book.name} cover`)}
                />
              </div>
            ) : (
              <div className="mx-4 flex h-44 items-center justify-center rounded-lg border border-dashed border-border/60 bg-muted/20 text-xs text-foreground/50">
                No cover image
              </div>
            )}

            <CardContent className="space-y-3 text-sm text-foreground/70">
              <div className="flex items-center gap-2">
                {book.status === 'active' ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                ) : (
                  <Ban className="h-4 w-4 text-amber-400" />
                )}
                <span>
                  {book.status === 'active'
                    ? 'Visible in generation workflows'
                    : 'Hidden from generation workflows'}
                </span>
              </div>
              {hasDetailedPages ? (
                <div className="space-y-1">
                  <p className="text-xs uppercase tracking-[0.2em] text-foreground/45">
                    Highlights
                  </p>
                  <p className="text-xs text-foreground/60">
                    Includes{' '}
                    {highlightedPageCount}{' '}
                    pages with background art.
                  </p>
                </div>
              ) : null}
            </CardContent>

            <CardFooter className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 bg-card py-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => openEditForm(book)}
                disabled={isLoadingDetails}
              >
                {isLoadingDetails ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Loading…
                  </>
                ) : (
                  <>
                    <Pencil className="h-4 w-4" />
                    Edit
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1"
                onClick={() => handleToggleStatus(book)}
              >
                {book.status === 'active' ? (
                  <>
                    <Ban className="h-4 w-4" />
                    Deactivate
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Activate
                  </>
                )}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="gap-1"
                onClick={() => handleDeleteBook(book._id)}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            </CardFooter>
          </Card>
        );
        })}
      </div>

      <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/20 p-4 sm:flex-row">
        <p className="text-sm text-foreground/60">
          {pagination.total === 0
            ? 'No books found'
            : `Showing ${pageStart}-${pageEnd} of ${pagination.total} books`}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handlePreviousPage}
            disabled={!canGoPrev}
            className="gap-1"
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <span className="text-sm font-medium text-foreground">
            Page {currentPage} / {totalPagesDisplay}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleNextPage}
            disabled={!canGoNext}
            className="gap-1"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {books.length === 0 && !loading && !isFetchingBooks && (
        <Card className="border-dashed border-border/50 bg-card text-center">
          <CardContent className="space-y-3 py-14">
            <BookOpen className="mx-auto h-10 w-10 text-foreground/30" />
            <h3 className="text-lg font-medium text-foreground">
              {hasActiveFilters ? 'No books match your filters' : 'No books yet'}
            </h3>
            <p className="text-sm text-foreground/55">
              {hasActiveFilters
                ? 'Update your filters or search terms to view matching books.'
                : 'Create your first personalised storybook to get started.'}
            </p>
            {hasActiveFilters ? (
              <Button onClick={handleResetFilters} className="mt-3">
                <RefreshCw className="mr-2 h-4 w-4" />
                Clear filters
              </Button>
            ) : (
              <Button onClick={openCreateForm} className="mt-3">
                <Plus className="mr-2 h-4 w-4" />
                Add book
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <ImageViewer open={Boolean(viewerImage)} image={viewerImage} onClose={handleViewerClose} />
    </div>
  );
}

export default Books;
