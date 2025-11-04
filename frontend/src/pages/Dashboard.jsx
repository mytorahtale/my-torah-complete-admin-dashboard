import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  BookOpenCheck,
  BookX,
  CheckCircle2,
  Flame,
  Layers3,
  RefreshCw,
  Sparkles,
  Users,
  UserCog,
  UserX,
} from 'lucide-react';
import { dashboardAPI } from '@/services/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const toValidDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const relativeTimeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

const formatRelativeTime = (value) => {
  const date = toValidDate(value);
  if (!date) return 'moments ago';

  const now = Date.now();
  let delta = (date.getTime() - now) / 1000;

  const divisions = [
    { amount: 60, unit: 'seconds' },
    { amount: 60, unit: 'minutes' },
    { amount: 24, unit: 'hours' },
    { amount: 7, unit: 'days' },
    { amount: 4.34524, unit: 'weeks' },
    { amount: 12, unit: 'months' },
    { amount: Infinity, unit: 'years' },
  ];

  for (const { amount, unit } of divisions) {
    if (Math.abs(delta) < amount) {
      return relativeTimeFormatter.format(Math.round(delta), unit.slice(0, -1));
    }
    delta /= amount;
  }
  return 'moments ago';
};

const formatNumber = (value) =>
  new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value ?? 0);

const formatPercent = (value) => {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value)}%`;
};

const STAT_CARDS = [
  {
    key: 'totalBooks',
    label: 'Books in library',
    icon: BookOpen,
  },
  {
    key: 'activeBooks',
    label: 'Active books',
    icon: BookOpenCheck,
  },
  {
    key: 'inactiveBooks',
    label: 'Inactive books',
    icon: BookX,
  },
  {
    key: 'generatedBooks',
    label: 'Books generated',
    icon: Layers3,
  },
  {
    key: 'totalUsers',
    label: 'Enrolled users',
    icon: Users,
  },
  {
    key: 'trainedUsers',
    label: 'Users ready for generation',
    icon: UserCog,
  },
  {
    key: 'failedUsers',
    label: 'Users needing attention',
    icon: UserX,
  },
  {
    key: 'activeTrainings',
    label: 'Active trainings',
    icon: Activity,
  },
];

function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessages, setErrorMessages] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [overview, setOverview] = useState(null);
  const hasFetchedRef = useRef(false);

  const fetchOverview = useCallback(async ({ silent = false } = {}) => {
    setErrorMessages([]);

    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await dashboardAPI.getOverview();
      const payload = response?.data || response;
      setOverview(payload);
      setLastUpdated(payload?.lastUpdated || new Date().toISOString());
      setErrorMessages(Array.isArray(payload?.errors) ? payload.errors : []);
    } catch (error) {
      setErrorMessages([error.message || 'Dashboard data unavailable']);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (hasFetchedRef.current) {
      return;
    }
    hasFetchedRef.current = true;
    fetchOverview();
  }, [fetchOverview]);

  const bookStats = useMemo(() => {
    const stats = overview?.stats?.books || {};
    const generationSucceeded = overview?.stats?.generations?.succeeded || 0;
    return {
      total: stats.total || 0,
      active: stats.active || 0,
      inactive: stats.inactive || 0,
      generated: generationSucceeded,
      avgPages: stats.averagePages || 0,
    };
  }, [overview]);

  const trainingStats = useMemo(() => {
    const stats = overview?.stats?.trainings || {};
    const total = stats.total || 0;
    const succeeded = stats.succeeded || 0;
    const successRate = total ? (succeeded / Math.max(total, 1)) * 100 : 0;
    return {
      total,
      active: stats.active || 0,
      failed: stats.failed || 0,
      failedUsers: stats.failedUsers || 0,
      readyUsers: stats.readyUsers || 0,
      successRate,
    };
  }, [overview]);

  const userStats = useMemo(() => {
    const stats = overview?.stats?.users || {};
    return {
      total: stats.total || 0,
      imageAssets: stats.totalImages || 0,
      avgImages: stats.averageImages || 0,
    };
  }, [overview]);

  const generationStats = useMemo(() => {
    const stats = overview?.stats?.generations || {};
    return {
      total: stats.total || 0,
      succeeded: stats.succeeded || 0,
      failed: stats.failed || 0,
      queued: stats.queued || 0,
      successRate: stats.successRate || 0,
    };
  }, [overview]);

  const statCardValues = useMemo(() => {
    return {
      totalBooks: {
        value: bookStats.total,
        delta: bookStats.avgPages ? `${formatNumber(bookStats.avgPages)} pages / book` : null,
      },
      activeBooks: {
        value: bookStats.active,
        delta: bookStats.total
          ? `${formatPercent((bookStats.active / bookStats.total) * 100)} active`
          : null,
      },
      inactiveBooks: {
        value: bookStats.inactive,
        delta: bookStats.total
          ? `${formatPercent((bookStats.inactive / bookStats.total) * 100)} inactive`
          : null,
      },
      generatedBooks: {
        value: bookStats.generated,
        delta: generationStats.successRate ? `${formatPercent(generationStats.successRate)} success` : null,
      },
      totalUsers: {
        value: userStats.total,
        delta: userStats.avgImages
          ? `${formatNumber(userStats.avgImages)} photos / user`
          : null,
      },
      trainedUsers: {
        value: trainingStats.readyUsers,
        delta: trainingStats.total
          ? `${formatPercent((trainingStats.readyUsers / Math.max(userStats.total, 1)) * 100)} ready`
          : null,
      },
      failedUsers: {
        value: trainingStats.failedUsers,
        tone: 'warning',
        delta: trainingStats.failed ? `${formatNumber(trainingStats.failed)} failed runs` : null,
      },
      activeTrainings: {
        value: trainingStats.active,
        delta: trainingStats.total
          ? `${formatPercent((trainingStats.active / Math.max(trainingStats.total, 1)) * 100)} in-flight`
          : null,
      },
    };
  }, [bookStats, generationStats, trainingStats, userStats]);

  const activityIconMap = useMemo(
    () => ({
      book: BookOpen,
      training: Flame,
      generation: Sparkles,
    }),
    []
  );

  const activityFeed = useMemo(() => {
    const activities = overview?.activity || [];
    return activities
      .map((item) => {
        const timestamp = toValidDate(item.timestamp);
        if (!timestamp) return null;
        return {
          ...item,
          icon: activityIconMap[item.type] || RefreshCw,
          timestamp,
        };
      })
      .filter(Boolean);
  }, [activityIconMap, overview]);

  const showSkeleton = loading && !overview;

  const healthSummary = useMemo(() => {
    const trainingLoad = trainingStats.total
      ? (trainingStats.active / Math.max(trainingStats.total, 1)) * 100
      : 0;
    const generationSuccess = generationStats.successRate;
    const attentionItems = trainingStats.failedUsers;
    const systemScore =
      (Math.min(trainingLoad, 100) * 0.3 + Math.min(generationSuccess, 100) * 0.5 + Math.max(100 - attentionItems * 5, 0) * 0.2) /
      1;
    return {
      trainingLoad,
      generationSuccess,
      attentionItems,
      systemScore: Math.round(systemScore),
    };
  }, [generationStats.successRate, trainingStats]);

  const handleRefresh = () => {
    fetchOverview({ silent: true });
  };

  return (
    <div className="page-wrapper">
      <section className="section-card">
        <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Operations overview
            </p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
              Dashboard
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Monitor your books, trainings, and generation runs at a glance.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw
                className={cn(
                  'mr-2 h-4 w-4 transition-transform duration-500',
                  refreshing && 'animate-spin'
                )}
              />
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </Button>
            <Button asChild className="bg-foreground hover:bg-foreground/90 text-background">
              <Link to="/books">
                New book
                <ArrowUpRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </header>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="badge-ghost">
            <Sparkles className="h-3 w-3" />
            {formatPercent(generationStats.successRate)} generation success
          </span>
          <span className="badge-ghost">
            <Users className="h-3 w-3" />
            {formatNumber(userStats.total)} active users
          </span>
          <span className="badge-ghost">
            <Flame className="h-3 w-3" />
            {formatNumber(trainingStats.total)} training runs
          </span>
          {lastUpdated && (
            <span className="badge-ghost">
              <CheckCircle2 className="h-3 w-3" />
              Updated {formatRelativeTime(lastUpdated)}
            </span>
          )}
        </div>
      </section>

      {errorMessages.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
            <div>
              <p className="font-medium text-amber-900 dark:text-amber-100">Some data could not be refreshed.</p>
              <p className="mt-1 text-amber-800 dark:text-amber-200">
                {errorMessages.join(' • ')}
              </p>
            </div>
          </div>
        </div>
      )}

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-foreground">Key metrics</h2>
          <Badge variant="outline" className="bg-white/10 text-foreground/70">
            {showSkeleton ? '—' : `${formatNumber(activityFeed.length)} recent updates`}
          </Badge>
        </div>
        <div className="stat-grid">
          {showSkeleton
            ? Array.from({ length: STAT_CARDS.length }).map((_, index) => (
                <article key={`stat-skeleton-${index}`} className="stat-card animate-pulse">
                  <div className="flex items-center justify-between">
                    <span className="h-4 w-28 rounded bg-muted" />
                    <span className="h-10 w-10 rounded-lg bg-muted" />
                  </div>
                  <div className="mt-4 h-8 w-20 rounded bg-muted" />
                  <div className="mt-2 h-3 w-24 rounded bg-muted" />
                </article>
              ))
            : STAT_CARDS.map(({ key, label, icon: Icon }) => {
                const stat = statCardValues[key] ?? {};
                return (
                  <article key={key} className="stat-card">
                    <div className="flex items-center justify-between">
                      <p className="stat-card__title">{label}</p>
                      <span className="rounded-lg bg-secondary p-2">
                        <Icon className="h-5 w-5 text-foreground/70" />
                      </span>
                    </div>
                    <p className="stat-card__value">{formatNumber(stat.value)}</p>
                    {stat.delta && (
                      <p
                        className={cn(
                          'stat-card__meta',
                          stat.tone === 'warning'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        )}
                      >
                        {stat.delta}
                      </p>
                    )}
                  </article>
                );
              })}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[2fr,1fr]">
        <article className="panel">
          <header className="panel-header">
            <div>
              <h3 className="panel-title">Latest activity</h3>
              <p className="text-xs text-muted-foreground">
                Books, trainings, and generations arriving in chronological order.
              </p>
            </div>
          </header>
          <div className="mt-5 space-y-2">
            {showSkeleton ? (
              Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={`activity-skeleton-${index}`}
                  className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex items-center gap-3">
                    <span className="h-10 w-10 rounded-lg bg-muted" />
                    <div className="space-y-2">
                      <div className="h-4 w-32 rounded bg-muted" />
                      <div className="h-3 w-24 rounded bg-muted" />
                    </div>
                  </div>
                  <span className="h-4 w-4 rounded bg-muted" />
                </div>
              ))
            ) : activityFeed.length === 0 ? (
              <div className="rounded-lg border border-border bg-secondary/50 p-4 text-sm text-muted-foreground">
                No recent actions. Kick things off with a new book or training run.
              </div>
            ) : (
              activityFeed.map((event) => {
                const IconComponent = event.icon || RefreshCw;
                return (
                  <Link
                    key={event.id}
                    to={event.href}
                    className="group flex items-center justify-between gap-4 rounded-lg border border-border bg-card p-4 transition-all hover:shadow-md hover:border-foreground/20"
                  >
                    <div className="flex items-center gap-3">
                      <span className="rounded-lg bg-secondary p-2">
                        <IconComponent className="h-5 w-5 text-foreground/70" />
                      </span>
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {event.title}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {event.status ? `${event.status} • ` : ''}
                          {formatRelativeTime(event.timestamp)}
                        </p>
                      </div>
                    </div>
                    <ArrowUpRight className="h-4 w-4 text-muted-foreground transition group-hover:text-foreground" />
                  </Link>
                );
              })
            )}
          </div>
        </article>

        <article className="panel space-y-4">
          <header className="panel-header">
            <div>
              <h3 className="panel-title">System health</h3>
              <p className="text-xs text-muted-foreground">At-a-glance readiness across the stack.</p>
            </div>
            <div className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              {formatPercent(healthSummary.systemScore)} healthy
            </div>
          </header>
          <div className="space-y-4 text-sm">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Training capacity</span>
                <span className="font-medium text-foreground">{formatPercent(healthSummary.trainingLoad)}</span>
              </div>
              <div className="h-2 rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-foreground"
                  style={{ width: `${Math.min(healthSummary.trainingLoad, 100)}%` }}
                />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Generation success</span>
                <span className="font-medium text-foreground">{formatPercent(healthSummary.generationSuccess)}</span>
              </div>
              <div className="h-2 rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-foreground"
                  style={{ width: `${Math.min(healthSummary.generationSuccess, 100)}%` }}
                />
              </div>
            </div>
            <div className="rounded-lg border border-border bg-secondary/50 p-4 text-xs">
              <p className="flex items-center gap-2 font-medium text-foreground">
                <BarChart3 className="h-4 w-4 text-foreground/70" />
                Focus points
              </p>
              <p className="mt-2 text-muted-foreground">
                {healthSummary.attentionItems ? (
                  <>
                    Review {formatNumber(healthSummary.attentionItems)} user
                    {healthSummary.attentionItems === 1 ? '' : 's'} marked for follow-up to keep the pipeline clear.
                  </>
                ) : (
                  'All systems nominated as healthy. Keep monitoring for new training runs.'
                )}
              </p>
            </div>
          </div>
        </article>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <article className="panel space-y-5">
          <header className="panel-header">
            <div>
              <h3 className="panel-title">Training pipeline</h3>
              <p className="text-xs text-muted-foreground">Where models stand right now.</p>
            </div>
            <Badge className="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20">
              {formatPercent(trainingStats.successRate)} success
            </Badge>
          </header>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Active</p>
              <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
                {formatNumber(trainingStats.active)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Currently running jobs</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Ready</p>
              <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
                {formatNumber(trainingStats.readyUsers)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Users ready to generate</p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Needs review</p>
              <p className="mt-2 text-2xl font-bold tracking-tight text-amber-600 dark:text-amber-400">
                {formatNumber(trainingStats.failedUsers)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">Users flagged for action</p>
            </div>
          </div>
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              • Restart failed runs with updated datasets to recover {formatPercent(Math.min(trainingStats.successRate + 6, 100))}{' '}
              success rates.
            </p>
            <p>• Promote ready users to the generation queue to keep outputs flowing.</p>
          </div>
        </article>

        <article className="panel space-y-4">
          <header className="panel-header">
            <div>
              <h3 className="panel-title">Quick actions</h3>
              <p className="text-xs text-muted-foreground">Tackle the next priority in seconds.</p>
            </div>
          </header>
          <div className="grid gap-3">
            <Button
              asChild
              variant="outline"
              className="justify-between px-4 py-5 h-auto text-left"
            >
              <Link to="/users">
                <span className="font-semibold">Enroll a new user</span>
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              className="justify-between px-4 py-5 h-auto text-left bg-foreground hover:bg-foreground/90 text-background"
            >
              <Link to="/generate">
                <span className="font-semibold">Launch image generation</span>
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="justify-between px-4 py-5 h-auto text-left"
            >
              <Link to="/automate">
                <span className="font-semibold">Configure automation workflow</span>
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
          <div className="rounded-lg border border-border bg-secondary/50 p-4 text-xs">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <Sparkles className="h-4 w-4 text-foreground/70" />
              Pro tip
            </p>
            <p className="mt-2 text-muted-foreground">
              Keep the dashboard clean by clearing failed trainings after you re-run them. The health score reflects resolved items immediately.
            </p>
          </div>
        </article>
      </section>
    </div>
  );
}

export default Dashboard;
