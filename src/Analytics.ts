import { LogEntry, ParseResult } from "./Parser.js";

// -- Data structures --

export interface EndpointStats {
    path: string;
    hits: number;
    errorRate: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    avgMs: number;
    maxMs: number;
    statusCounts: Record<number, number>;
}

export interface HourBucket {
    hour: Date;
    requests: number;
    errors: number;
    avgMs: number;
}

export interface AnalyticsReport {
    totalLines: number;
    parsedCount: number;
    malformedCount: number;
    parseRate: number;
    timeRange: [Date | null, Date | null];

    requestsByMethod: Record<string, number>;
    statusDistribution: Record<number, number>;
    errorRate: number;
    topIps: [string, number][];

    topEndpointsByHits: EndpointStats[];
    topEndpointsByErrors: EndpointStats[];
    slowestEndpoints: EndpointStats[];

    // Performance
    overallP50Ms: number;
    overallP95Ms: number;
    overallP99Ms: number;
    overallAvgMs: number;

    // Errors
    topErrorPaths: [string, number][];
    error4xxCount: number;
    error5xxCount: number;

    // Time series
    hourlyBuckets: HourBucket[];

    // Format anomalies
    formatAnomalies: Record<string, number>;
    jsonLineCount: number;
    linesWithWarnings: number;

    // Raw entries for CLI filtering
    entries: LogEntry[];
}

// -- Helpers --

function percentile(sortedValues: number[], p: number): number {
    if (sortedValues.length === 0) return 0;
    const idx = Math.max(0, Math.floor((sortedValues.length * p) / 100) - 1);
    return sortedValues[Math.min(idx, sortedValues.length - 1)];
}

function endpointStats(path: string, group: LogEntry[]): EndpointStats {
    const statuses = group.map((e) => e.status).filter((s): s is number => s !== null);
    const errors = statuses.filter((s) => s >= 400);
    const times = group
        .map((e) => e.responseMillis)
        .filter((t): t is number => t !== null)
        .sort((a, b) => a - b);

    const statusCounts: Record<number, number> = {};
    for (const s of statuses) {
        statusCounts[s] = (statusCounts[s] ?? 0) + 1;
    }

    const errorRate = group.length > 0 ? errors.length / group.length : 0;
    const avgMs = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0;

    return {
        path,
        hits: group.length,
        errorRate,
        p50Ms: percentile(times, 50),
        p95Ms: percentile(times, 95),
        p99Ms: percentile(times, 99),
        avgMs,
        maxMs: times.length > 0 ? times[times.length - 1] : 0,
        statusCounts,
    };
}

function normalizePath(path: string | null): string {
    if (!path) return "(unknown)";
    return path.replace(/\/\d+/g, "/{id}");
}

// -- Main analytics function --

export function compute(
    result: ParseResult,
    normalizePaths = true
): AnalyticsReport {
    const { entries } = result;
    const pathKey = normalizePaths
        ? (p: string | null) => normalizePath(p)
        : (p: string | null) => p ?? "(unknown)";

    // Time range
    const timestamps = entries
        .map((e) => e.timestamp)
        .filter((t): t is Date => t !== null);
    const timeRange: [Date | null, Date | null] =
        timestamps.length > 0
            ? [
                new Date(Math.min(...timestamps.map((t) => t.getTime()))),
                new Date(Math.max(...timestamps.map((t) => t.getTime()))),
            ]
            : [null, null];

    // Method distribution
    const requestsByMethod: Record<string, number> = {};
    for (const e of entries) {
        if (e.method) requestsByMethod[e.method] = (requestsByMethod[e.method] ?? 0) + 1;
    }

    // Status distribution
    const statusDistribution: Record<number, number> = {};
    for (const e of entries) {
        if (e.status !== null)
            statusDistribution[e.status] = (statusDistribution[e.status] ?? 0) + 1;
    }

    // Error rate
    const allStatuses = entries.map((e) => e.status).filter((s): s is number => s !== null);
    const errorStatuses = allStatuses.filter((s) => s >= 400);
    const errorRate = allStatuses.length > 0 ? errorStatuses.length / allStatuses.length : 0;
    const error4xxCount = allStatuses.filter((s) => s >= 400 && s < 500).length;
    const error5xxCount = allStatuses.filter((s) => s >= 500).length;

    // Top IPs
    const ipCounts: Record<string, number> = {};
    for (const e of entries) {
        if (e.ip) ipCounts[e.ip] = (ipCounts[e.ip] ?? 0) + 1;
    }
    const topIps: [string, number][] = Object.entries(ipCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    // Endpoint grouping
    const byEndpoint = new Map<string, LogEntry[]>();
    for (const e of entries) {
        const key = pathKey(e.path);
        if (!byEndpoint.has(key)) byEndpoint.set(key, []);
        byEndpoint.get(key)!.push(e);
    }

    const endpointStatsMap = new Map<string, EndpointStats>();
    for (const [p, group] of byEndpoint) {
        endpointStatsMap.set(p, endpointStats(p, group));
    }

    const allStats = Array.from(endpointStatsMap.values()).sort(
        (a, b) => b.hits - a.hits
    );
    const topEndpointsByHits = allStats.slice(0, 20);
    const topEndpointsByErrors = allStats
        .filter((s) => s.hits >= 5)
        .sort((a, b) => b.errorRate - a.errorRate || b.hits - a.hits)
        .slice(0, 20);
    const slowestEndpoints = allStats
        .filter((s) => s.hits >= 5 && s.avgMs > 0)
        .sort((a, b) => b.p95Ms - a.p95Ms)
        .slice(0, 20);

    // Overall percentiles
    const allTimes = entries
        .map((e) => e.responseMillis)
        .filter((t): t is number => t !== null)
        .sort((a, b) => a - b);
    const overallP50 = percentile(allTimes, 50);
    const overallP95 = percentile(allTimes, 95);
    const overallP99 = percentile(allTimes, 99);
    const overallAvg =
        allTimes.length > 0 ? allTimes.reduce((a, b) => a + b, 0) / allTimes.length : 0;

    // Top error paths
    const errorEntries = entries.filter(
        (e) => e.status !== null && e.status >= 400
    );
    const errorPathCounts: Record<string, number> = {};
    for (const e of errorEntries) {
        const key = pathKey(e.path);
        errorPathCounts[key] = (errorPathCounts[key] ?? 0) + 1;
    }
    const topErrorPaths: [string, number][] = Object.entries(errorPathCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    // Hourly buckets
    const hourlyBuckets = computeHourly(entries);

    // Anomalies
    const jsonLineCount = entries.filter((e) => e.isJSON).length;
    const linesWithWarnings = entries.filter((e) => e.parseWarnings.length > 0).length;
    const parseRate =
        result.totalLines > 0 ? entries.length / result.totalLines : 1.0;

    return {
        totalLines: result.totalLines,
        parsedCount: entries.length,
        malformedCount: result.malformedCount,
        parseRate,
        timeRange,
        requestsByMethod,
        statusDistribution,
        errorRate,
        topIps,
        topEndpointsByHits,
        topEndpointsByErrors,
        slowestEndpoints,
        overallP50Ms: overallP50,
        overallP95Ms: overallP95,
        overallP99Ms: overallP99,
        overallAvgMs: overallAvg,
        topErrorPaths,
        error4xxCount,
        error5xxCount,
        hourlyBuckets,
        formatAnomalies: result.formatAnomalies,
        jsonLineCount,
        linesWithWarnings,
        entries,
    };
}

function computeHourly(entries: LogEntry[]): HourBucket[] {
    const byHour = new Map<number, LogEntry[]>();
    for (const e of entries) {
        if (!e.timestamp) continue;
        const d = new Date(e.timestamp);
        d.setUTCMinutes(0, 0, 0);
        const key = d.getTime();
        if (!byHour.has(key)) byHour.set(key, []);
        byHour.get(key)!.push(e);
    }

    return Array.from(byHour.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([ts, group]) => {
            const times = group
                .map((e) => e.responseMillis)
                .filter((t): t is number => t !== null);
            const errors = group.filter(
                (e) => e.status !== null && e.status >= 400
            ).length;
            return {
                hour: new Date(ts),
                requests: group.length,
                errors,
                avgMs: times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : 0,
            };
        });
}
