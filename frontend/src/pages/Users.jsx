import { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Users as UsersIcon,
  UserPlus,
  UserCircle2,
  Trash2,
  Pencil,
  UploadCloud,
  Loader2,
  Maximize2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { userAPI } from '@/services/api';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
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
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import ImageViewer from '@/components/ImageViewer';
import { formatFileSize } from '@/utils/file';

const PAGE_SIZE_OPTIONS = [10, 20, 50];

const createEmptyForm = () => ({
  name: '',
  secondTitle: '',
  age: '',
  gender: 'male',
  email: '',
  countryCode: '+1',
  phoneNumber: '',
});

const buildUserPayload = (formValues) => {
  const payload = {
    name: formValues.name?.trim(),
    secondTitle: formValues.secondTitle?.trim() || '',
    gender: formValues.gender || undefined,
    email: formValues.email?.trim(),
    countryCode: formValues.countryCode?.trim(),
    phoneNumber: formValues.phoneNumber?.trim(),
  };

  if (formValues.age !== undefined && formValues.age !== null && `${formValues.age}`.trim() !== '') {
    const numericAge = Number.parseInt(formValues.age, 10);
    if (!Number.isNaN(numericAge)) {
      payload.age = numericAge;
    }
  }

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined || payload[key] === null || payload[key] === '') {
      delete payload[key];
    }
  });

  return payload;
};

function Users() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState(createEmptyForm);
  const [editingId, setEditingId] = useState(null);
  const [viewerAsset, setViewerAsset] = useState(null);
  const [formImages, setFormImages] = useState([]);
  const [isSavingUser, setIsSavingUser] = useState(false);

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(PAGE_SIZE_OPTIONS[0]);
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [genderFilter, setGenderFilter] = useState('all');
  const [pagination, setPagination] = useState({
    page: 1,
    totalPages: 0,
    total: 0,
    limit: PAGE_SIZE_OPTIONS[0],
    hasNextPage: false,
    hasPrevPage: false,
  });
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalImages: 0,
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchTerm.trim());
    }, 400);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, statusFilter, genderFilter, limit]);

  const handleViewerClose = useCallback(() => {
    if (viewerAsset?.shouldRevoke && viewerAsset?.src?.startsWith('blob:')) {
      URL.revokeObjectURL(viewerAsset.src);
    }
    setViewerAsset(null);
  }, [viewerAsset]);

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
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

      const response = await userAPI.getAll(params);
      const fetchedUsers = Array.isArray(response?.data) ? response.data : [];

      setUsers(fetchedUsers);
      const responsePagination = response?.pagination || {};
      const responseStats = response?.stats || {};

      const nextPage = responsePagination.page ?? page;
      const nextTotalPages = responsePagination.totalPages ?? 0;
      const nextTotal = responsePagination.total ?? fetchedUsers.length;
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

      const fallbackImageCount = fetchedUsers.reduce(
        (sum, user) => sum + (user.imageAssets?.length || 0),
        0
      );

      setStats({
        totalUsers:
          typeof responseStats.totalUsers === 'number' ? responseStats.totalUsers : nextTotal,
        totalImages:
          typeof responseStats.totalImages === 'number'
            ? responseStats.totalImages
            : fallbackImageCount,
      });

      if (responsePagination.page && responsePagination.page !== page) {
        setPage(responsePagination.page);
      }
    } catch (error) {
      toast.error(`Failed to fetch users: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }, [page, limit, debouncedSearch, statusFilter, genderFilter]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleResetFilters = useCallback(() => {
    setSearchTerm('');
    setStatusFilter('all');
    setGenderFilter('all');
    setLimit(PAGE_SIZE_OPTIONS[0]);
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

  const totalImages = useMemo(
    () =>
      typeof stats.totalImages === 'number' && stats.totalImages >= 0
        ? stats.totalImages
        : users.reduce((sum, user) => sum + (user.imageAssets?.length || 0), 0),
    [stats.totalImages, users]
  );

  const totalPagesDisplay =
    pagination.totalPages && pagination.totalPages > 0
      ? pagination.totalPages
      : pagination.total > 0
      ? 1
      : 1;
  const currentPage = pagination.totalPages && pagination.totalPages > 0 ? pagination.page : 1;
  const hasActiveFilters =
    Boolean(searchTerm) ||
    statusFilter !== 'all' ||
    genderFilter !== 'all' ||
    limit !== PAGE_SIZE_OPTIONS[0];
  const effectivePageSize =
    pagination.limit && pagination.limit > 0 ? pagination.limit : limit || PAGE_SIZE_OPTIONS[0];
  const pageStart = pagination.total === 0 ? 0 : (currentPage - 1) * effectivePageSize + 1;
  const pageEnd =
    pagination.total === 0 ? 0 : Math.min(currentPage * effectivePageSize, pagination.total);
  const canGoPrev = pagination.hasPrevPage && !loading;
  const canGoNext = pagination.hasNextPage && !loading;

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSelectChange = (name, value) => {
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleFormImageUpload = (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const timestamp = Date.now();
    const mapped = files.map((file, index) => ({
      id: `${timestamp}-${index}-${file.name}`,
      file,
      preview: URL.createObjectURL(file),
      status: 'pending',
    }));

    setFormImages((prev) => [...prev, ...mapped]);
    event.target.value = '';
  };

  const handleRemoveFormImage = (id) => {
    setFormImages((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.preview?.startsWith('blob:')) {
        URL.revokeObjectURL(target.preview);
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const resetForm = () => {
    setFormData(createEmptyForm());
    setEditingId(null);
    setShowForm(false);
    formImages.forEach((img) => img.preview && URL.revokeObjectURL(img.preview));
    setFormImages([]);
    if (viewerAsset?.shouldRevoke && viewerAsset?.src?.startsWith('blob:')) {
      URL.revokeObjectURL(viewerAsset.src);
    }
    setViewerAsset(null);
    setIsSavingUser(false);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (isSavingUser) return;

    if (!formData.name?.trim()) {
      toast.error('Please enter a name');
      return;
    }

    setIsSavingUser(true);
    try {
      if (editingId) {
        const payload = buildUserPayload(formData);
        await userAPI.update(editingId, payload);
        toast.success('User updated successfully');
        resetForm();
        fetchUsers();
        return;
      }

      const payload = buildUserPayload(formData);
      const response = await userAPI.create(payload);
      const newUserId = response.data._id;

      const imagesToUpload = formImages.filter((item) => item.file);
      if (imagesToUpload.length > 0) {
        let successCount = 0;
        let failCount = 0;

        for (const item of imagesToUpload) {
          try {
            await userAPI.uploadImage(newUserId, item.file);
            successCount += 1;
          } catch (error) {
            console.warn(`Failed to upload image ${item.file?.name}:`, error);
            failCount += 1;
          }
        }

        if (successCount > 0 && failCount === 0) {
          toast.success(
            `User created with ${successCount} image${successCount > 1 ? 's' : ''}`
          );
        } else if (successCount > 0 && failCount > 0) {
          toast.success(
            `User created. ${successCount} image${successCount > 1 ? 's' : ''} uploaded, ${failCount} failed.`
          );
        } else if (failCount > 0) {
          toast.warning('User created, but images could not be uploaded');
        }
      } else {
        toast.success('User created successfully');
      }

      resetForm();
      fetchUsers();
    } catch (error) {
      toast.error(`Failed to save user: ${error.message}`);
    } finally {
      setIsSavingUser(false);
    }
  };

  const handleEdit = (user) => {
    setFormData({
      name: user.name || '',
      secondTitle: user.secondTitle || '',
      age: user.age ?? '',
      gender: user.gender || 'male',
      email: user.email || '',
      countryCode: user.countryCode || '+1',
      phoneNumber: user.phoneNumber || '',
    });
    setEditingId(user._id);
    setShowForm(true);
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this user?')) return;
    try {
      await userAPI.delete(id);
      toast.success('User deleted');
      fetchUsers();
    } catch (error) {
      toast.error(`Failed to delete user: ${error.message}`);
    }
  };

  const handleUploadImages = async (userId, fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    let successCount = 0;
    let failCount = 0;

    for (const file of files) {
      try {
        await userAPI.uploadImage(userId, file);
        successCount += 1;
      } catch (error) {
        console.warn(`Failed to upload image ${file?.name}:`, error);
        failCount += 1;
      }
    }

    if (successCount > 0) {
      toast.success(
        `Uploaded ${successCount} image${successCount > 1 ? 's' : ''} for this user`
      );
    }
    if (failCount > 0) {
      toast.error(`Failed to upload ${failCount} image${failCount > 1 ? 's' : ''}`);
    }
    fetchUsers();
  };

  const handleDeleteImage = async (userId, assetId) => {
    if (!window.confirm('Remove this image?')) return;
    try {
      await userAPI.deleteImage(userId, assetId);
      toast.success('Image removed');
      fetchUsers();
    } catch (error) {
      toast.error(`Failed to remove image: ${error.message}`);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-end justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-96" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="space-y-2">
                    <Skeleton className="h-6 w-32" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                  <Skeleton className="h-9 w-9 rounded-full" />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <Skeleton className="h-4 w-40" />
                <div className="grid grid-cols-3 gap-2">
                  {[1, 2, 3].map((j) => (
                    <Skeleton key={j} className="h-20 w-full rounded-md" />
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
            <UsersIcon className="h-6 w-6 text-primary" />
            Readers
          </h1>
          <p className="text-sm text-foreground/60">
            Manage children profiles and their reference photos used for training and storybooks.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setShowForm(true);
            setEditingId(null);
            setFormData(createEmptyForm());
            setFormImages([]);
          }}
          className="gap-2"
        >
          <UserPlus className="h-4 w-4" />
          Add user
        </Button>
      </div>

      <div className="grid gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div className="space-y-2">
          <Label htmlFor="user-search">Search</Label>
          <Input
            id="user-search"
            type="search"
            placeholder="Search by name, email, or phone"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Gender</Label>
          <Select value={genderFilter} onValueChange={setGenderFilter}>
            <SelectTrigger>
              <SelectValue placeholder="All genders" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="male">Male</SelectItem>
              <SelectItem value="female">Female</SelectItem>
              <SelectItem value="other">Other</SelectItem>
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
              {PAGE_SIZE_OPTIONS.map((size) => (
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

      <div className="grid gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 sm:grid-cols-3">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">
            Readers
          </p>
          <p className="text-2xl font-semibold text-foreground">{stats.totalUsers || 0}</p>
          <p className="text-xs text-foreground/60">Total children profiles</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">
            Reference photos
          </p>
          <p className="text-2xl font-semibold text-foreground">{totalImages}</p>
          <p className="text-xs text-foreground/60">Uploaded for training and storybooks</p>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">
            Page
          </p>
          <p className="text-2xl font-semibold text-foreground">
            {currentPage} / {totalPagesDisplay}
          </p>
          <p className="text-xs text-foreground/60">
            Showing {pageStart}-{pageEnd} of {pagination.total} users
          </p>
        </div>
      </div>

      {showForm && (
        <Card className="border-border/60 bg-card/95">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg font-semibold">
              <UserCircle2 className="h-5 w-5 text-primary" />
              {editingId ? 'Edit user' : 'Add new user'}
            </CardTitle>
            <CardDescription className="text-sm text-foreground/60">
              Store the child’s details and optional reference photos. Images are compressed
              automatically on upload.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-6" onSubmit={handleSubmit}>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input
                    id="name"
                    name="name"
                    value={formData.name}
                    onChange={handleInputChange}
                    placeholder="Child's name"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="secondTitle">Second title (optional)</Label>
                  <Textarea
                    id="secondTitle"
                    name="secondTitle"
                    rows={2}
                    value={formData.secondTitle}
                    onChange={handleInputChange}
                    placeholder="Short dedication or description"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="age">Age</Label>
                  <Input
                    id="age"
                    name="age"
                    type="number"
                    min="0"
                    max="150"
                    value={formData.age}
                    onChange={handleInputChange}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Gender</Label>
                  <Select
                    value={formData.gender}
                    onValueChange={(value) => handleSelectChange('gender', value)}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select gender" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="male">Male</SelectItem>
                      <SelectItem value="female">Female</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    value={formData.email}
                    onChange={handleInputChange}
                    placeholder="parent@example.com"
                  />
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="countryCode">Country code</Label>
                    <Input
                      id="countryCode"
                      name="countryCode"
                      value={formData.countryCode}
                      onChange={handleInputChange}
                      placeholder="+1"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phoneNumber">Phone number</Label>
                    <Input
                      id="phoneNumber"
                      name="phoneNumber"
                      value={formData.phoneNumber}
                      onChange={handleInputChange}
                      placeholder="5551234567"
                    />
                  </div>
                </div>
              </div>

              {!editingId && (
                <div className="space-y-4 rounded-xl border border-border/60 bg-muted p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <Label>Upload images (optional)</Label>
                      <p className="text-xs text-foreground/50">
                        Add 10–15 clear photos of the child. Images are compressed automatically.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{formImages.length} images</Badge>
                      <label
                        htmlFor="formImages"
                        className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-card px-3 py-2 text-xs font-semibold text-foreground/70 hover:bg-card/80"
                      >
                        <UploadCloud className="h-4 w-4" />
                        Upload
                      </label>
                      <input
                        id="formImages"
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={handleFormImageUpload}
                      />
                    </div>
                  </div>

                  {formImages.length > 0 ? (
                    <div className="space-y-4">
                      <p className="text-xs text-foreground/50">
                        Selected for upload: {formImages.length} image
                        {formImages.length > 1 ? 's' : ''}.
                      </p>
                      <div className="space-y-3">
                        {formImages.map((item) => (
                          <div
                            key={item.id}
                            className="space-y-3 rounded-xl border border-border/50 bg-card p-4"
                          >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                              <button
                                type="button"
                                className="group relative h-36 w-full overflow-hidden rounded-lg border border-border/40 bg-background sm:h-32 sm:w-40"
                                onClick={() =>
                                  setViewerAsset({
                                    src: item.preview,
                                    title: item.file.name,
                                    sizeLabel: formatFileSize(item.file.size),
                                    shouldRevoke: true,
                                  })
                                }
                              >
                                <img
                                  src={item.preview}
                                  alt={item.file.name}
                                  className="h-full w-full object-cover transition group-hover:scale-[1.03]"
                                />
                                <span className="absolute inset-0 bg-black/25 opacity-0 transition group-hover:opacity-100" />
                                <Maximize2 className="absolute left-1/2 top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 text-white opacity-0 transition group-hover:opacity-100" />
                              </button>
                              <div className="flex-1 space-y-3">
                                <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                                  <div>
                                    <p className="text-sm font-semibold text-foreground">
                                      {item.file.name}
                                    </p>
                                    <p className="text-xs text-foreground/50">
                                      {formatFileSize(item.file.size)}
                                    </p>
                                  </div>
                                  <div className="flex gap-2">
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="text-xs text-red-300 hover:text-red-200"
                                      onClick={() => handleRemoveFormImage(item.id)}
                                    >
                                      Remove
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}

              <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="secondary"
                  className="sm:w-auto"
                  onClick={resetForm}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  className="sm:w-auto gap-2"
                  disabled={isSavingUser}
                >
                  {isSavingUser && <Loader2 className="h-4 w-4 animate-spin" />}
                  {editingId
                    ? isSavingUser
                      ? 'Updating...'
                      : 'Update user'
                    : isSavingUser
                    ? 'Creating...'
                    : 'Create user'}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {users.map((user) => {
          const displayGender = user.gender || '—';
          const displayAge = typeof user.age === 'number' ? user.age : '—';
          const displayEmail = user.email || '—';
          const displayPhone =
            [user.countryCode, user.phoneNumber].filter(Boolean).join(' ').trim() || '—';

          return (
            <Card key={user._id} className="flex flex-col justify-between">
              <CardHeader className="flex flex-row items-start justify-between space-y-0">
                <div className="space-y-1">
                  <CardTitle className="text-lg">{user.name}</CardTitle>
                  {user.secondTitle && (
                    <p className="whitespace-pre-wrap text-sm text-foreground/70">
                      {user.secondTitle}
                    </p>
                  )}
                  <CardDescription className="flex items-center gap-2 text-xs uppercase text-foreground/40">
                    <UsersIcon className="h-3.5 w-3.5" />
                    Member
                  </CardDescription>
                </div>
                <Badge variant="outline" className="text-xs">
                  {user.imageAssets?.length || 0} images
                </Badge>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2 text-sm text-foreground/70">
                  <p className="flex items-center gap-2">
                    <UserCircle2 className="h-4 w-4 text-foreground/50" />
                    <span>
                      {displayGender} · {displayAge}
                    </span>
                  </p>
                  <p className="truncate text-foreground/60">{displayEmail}</p>
                  <p className="text-foreground/60">{displayPhone}</p>
                </div>

                <div className="space-y-4">
                  <div className="space-y-3 rounded-xl border border-border/60 bg-muted/30 p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-sm font-semibold text-foreground/80">Reference photos</p>
                      <div className="flex items-center gap-2">
                        <label
                          htmlFor={`upload-${user._id}`}
                          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border/60 bg-card px-3 py-2 text-xs font-semibold text-foreground/70 hover:bg-card/80"
                        >
                          <UploadCloud className="h-4 w-4" />
                          Upload
                        </label>
                        <input
                          id={`upload-${user._id}`}
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          onChange={(event) => {
                            handleUploadImages(user._id, event.target.files);
                            event.target.value = '';
                          }}
                        />
                      </div>
                    </div>

                    {user.imageAssets?.length ? (
                      <div className="grid grid-cols-3 gap-2">
                        {user.imageAssets.map((asset) => (
                          <div
                            key={asset._id || asset.key}
                            className="group relative overflow-hidden rounded-md border border-border/40 bg-card"
                          >
                            <button
                              type="button"
                              className="group relative block h-20 w-full overflow-hidden"
                              onClick={() =>
                                setViewerAsset({
                                  src: asset.url,
                                  title: asset.originalName || asset.key || 'Reference photo',
                                  downloadUrl: asset.url,
                                  sizeLabel:
                                    typeof asset.size === 'number'
                                      ? formatFileSize(asset.size)
                                      : undefined,
                                })
                              }
                            >
                              <img
                                src={asset.url}
                                alt={asset.originalName || asset.key}
                                className="h-full w-full object-cover transition group-hover:scale-[1.03]"
                              />
                              <span className="absolute inset-0 bg-black/25 opacity-0 transition group-hover:opacity-100" />
                              <Maximize2 className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-white opacity-0 transition group-hover:opacity-100" />
                            </button>
                            <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 opacity-0 transition group-hover:pointer-events-auto group-hover:opacity-100">
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="pointer-events-auto h-7 w-7 text-foreground hover:text-accent"
                                onClick={() =>
                                  setViewerAsset({
                                    src: asset.url,
                                    title: asset.originalName || asset.key || 'Reference photo',
                                    downloadUrl: asset.url,
                                    sizeLabel:
                                      typeof asset.size === 'number'
                                        ? formatFileSize(asset.size)
                                        : undefined,
                                  })
                                }
                              >
                                <Maximize2 className="h-4 w-4" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="pointer-events-auto h-7 w-7 text-red-300 hover:text-red-200"
                                onClick={() => handleDeleteImage(user._id, asset._id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-foreground/50">No images uploaded yet.</p>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1"
                    onClick={() => handleEdit(user)}
                  >
                    <Pencil className="h-4 w-4" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    className="gap-1"
                    onClick={() => handleDelete(user._id)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/20 p-4 sm:flex-row">
        <p className="text-sm text-foreground/60">
          {pagination.total === 0
            ? 'No users found'
            : `Showing ${pageStart}-${pageEnd} of ${pagination.total} users`}
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

      {users.length === 0 && !loading && (
        <Card className="border-dashed border-border/50 bg-card text-center">
          <CardContent className="space-y-3 py-14">
            <UserCircle2 className="mx-auto h-10 w-10 text-foreground/30" />
            <h3 className="text-lg font-medium text-foreground">
              {hasActiveFilters ? 'No users match your filters' : 'No users yet'}
            </h3>
            <p className="text-sm text-foreground/55">
              {hasActiveFilters
                ? 'Adjust your filters or search terms to see matching personas.'
                : 'Add your first persona to start fine-tuning your models.'}
            </p>
            {hasActiveFilters ? (
              <Button onClick={handleResetFilters} className="mt-3">
                <RefreshCw className="mr-2 h-4 w-4" />
                Clear filters
              </Button>
            ) : (
              <Button
                onClick={() => {
                  setShowForm(true);
                  setEditingId(null);
                  setFormData(createEmptyForm());
                  setFormImages([]);
                }}
                className="mt-3"
              >
                <UserPlus className="mr-2 h-4 w-4" />
                Add user
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <ImageViewer open={Boolean(viewerAsset)} image={viewerAsset} onClose={handleViewerClose} />
    </div>
  );
}

export default Users;
