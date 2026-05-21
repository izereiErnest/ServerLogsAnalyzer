import { AnalyticsReport, EndpointStats, HourBucket } from "./Analytics.js";

// -- Format helpers --

export function formatMillis(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    return `${Math.round(ms)}ms`;
}

export function formatPct(f: number): string {
    return `${(f * 100).toFixed(1)}%`;
}

export function formatTs(dt: Date | null): string {
    if (!dt) return "N/A";
    return dt.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

//-- Color support --

type ColorFn = (s: string) => string;
const id: ColorFn = (s) => s;

let _chalk: {
    cyan: ColorFn; green: ColorFn; yellow: ColorFn; red: ColorFn;
    bold: ColorFn; dim: ColorFn; magenta: ColorFn;
} | null = null;

async function loadChalk() {
    try {
        const { default: chalk } = await import("chalk");
        _chalk = {
            cyan: (s) => chalk.cyan(s),
            green: (s) => chalk.green(s),
            yellow: (s) => chalk.yellow(s),
            red: (s) => chalk.red(s),
            bold: (s) => chalk.bold(s),
            dim: (s) => chalk.dim(s),
            magenta: (s) => chalk.magenta(s),
        };
    } catch {
        _chalk = { cyan: id, green: id, yellow: id, red: id, bold: id, dim: id, magenta: id };
    }
}

// -- Table helpers --

function hr(char = "─", width = 72): string {
    return char.repeat(width);
}

function pad(s: string, width: number, right = false): string {
    const str = String(s);
    if (str.length >= width) return str.slice(0, width);
    const padding = " ".repeat(width - str.length);
    return right ? padding + str : str + padding;
}

// -- Renderer --

export async function render(
    report: AnalyticsReport,
    out: NodeJS.WriteStream = process.stdout
): Promise<void> {
    await loadChalk();
    const c = _chalk!;
    const w = (s: string) => out.write(s + "\n");

    const [start, end] = report.timeRange;
    let duration = "";
    if (start && end) {
        const secs = Math.floor((end.getTime() - start.getTime()) / 1000);
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        duration = `  (${h}h ${m}m ${s}s span)`;
    }

    w("");
    w(c.bold("═".repeat(72)));
    w(c.bold(c.cyan("  LOG ANALYZER REPORT")));
    w(c.bold("═".repeat(72)));
    w(`  Period: ${c.green(formatTs(start))} → ${c.green(formatTs(end))}${duration}`);

    section(w, c, "OVERVIEW");
    w(`  Total lines        : ${report.totalLines.toLocaleString()}`);
    w(`  Parsed OK          : ${c.green(report.parsedCount.toLocaleString())} (${formatPct(report.parseRate)})`);
    w(`  Malformed/skipped  : ${c.yellow(report.malformedCount.toLocaleString())}`);
    w(`  JSON lines         : ${report.jsonLineCount.toLocaleString()}`);
    w(`  Lines w/ warnings  : ${report.linesWithWarnings.toLocaleString()}`);
    const errColor = report.errorRate > 0.05 ? c.red : c.green;
    w(`  Error rate         : ${errColor(formatPct(report.errorRate))}  (4xx: ${report.error4xxCount.toLocaleString()}  5xx: ${report.error5xxCount.toLocaleString()})`);

    section(w, c, "RESPONSE TIME (all endpoints)");
    w(`  Average : ${formatMillis(report.overallAvgMs)}`);
    w(`  p50     : ${formatMillis(report.overallP50Ms)}`);
    w(`  p95     : ${formatMillis(report.overallP95Ms)}`);
    w(`  p99     : ${formatMillis(report.overallP99Ms)}`);

    section(w, c, "HTTP METHODS");
    const totalReqs = Object.values(report.requestsByMethod).reduce((a, b) => a + b, 0);
    const sortedMethods = Object.entries(report.requestsByMethod).sort((a, b) => b[1] - a[1]);
    w(`  ${pad("Method", 10)} ${pad("Requests", 10, true)} ${pad("Share", 7, true)}`);
    for (const [method, count] of sortedMethods) {
        w(`  ${c.cyan(pad(method, 10))} ${pad(count.toLocaleString(), 10, true)} ${pad(formatPct(totalReqs ? count / totalReqs : 0), 7, true)}`);
    }

    section(w, c, "STATUS CODE DISTRIBUTION");
    const totalStatuses = Object.values(report.statusDistribution).reduce((a, b) => a + b, 0);
    w(`  ${pad("Status", 8)} ${pad("Count", 10, true)} ${pad("Share", 7, true)}`);
    for (const [statusStr, count] of Object.entries(report.statusDistribution).sort(
        (a, b) => Number(a[0]) - Number(b[0])
    )) {
        const status = Number(statusStr);
        const colorFn = status < 400 ? c.green : status < 500 ? c.yellow : c.red;
        w(`  ${colorFn(pad(statusStr, 8))} ${pad(count.toLocaleString(), 10, true)} ${pad(formatPct(totalStatuses ? count / totalStatuses : 0), 7, true)}`);
    }

    section(w, c, "TOP ENDPOINTS BY TRAFFIC");
    renderEndpointTable(w, c, report.topEndpointsByHits.slice(0, 15));

    section(w, c, "SLOWEST ENDPOINTS (p95, min 5 hits)");
    renderEndpointTable(w, c, report.slowestEndpoints.slice(0, 10));

    section(w, c, "HIGHEST ERROR-RATE ENDPOINTS (min 5 hits)");
    renderErrorEndpointTable(w, c, report.topEndpointsByErrors.slice(0, 10));

    section(w, c, "TOP SOURCE IPs");
    w(`  ${pad("IP", 20)} ${pad("Requests", 10, true)}`);
    for (const [ip, count] of report.topIps.slice(0, 10)) {
        w(`  ${c.cyan(pad(ip, 20))} ${pad(count.toLocaleString(), 10, true)}`);
    }

    if (Object.keys(report.formatAnomalies).length > 0) {
        section(w, c, "FORMAT ANOMALIES DETECTED");
        w(`  ${pad("Anomaly", 50)} ${pad("Count", 8, true)}`);
        const sorted = Object.entries(report.formatAnomalies).sort((a, b) => b[1] - a[1]);
        for (const [anom, count] of sorted.slice(0, 15)) {
            w(`  ${c.yellow(pad(anom, 50))} ${pad(count.toLocaleString(), 8, true)}`);
        }
    }

    if (report.hourlyBuckets.length > 0) {
        section(w, c, "HOURLY TRAFFIC");
        renderSparkline(w, c, report.hourlyBuckets);
    }

    w(c.bold("═".repeat(72)));
    w("");
}

function section(
    w: (s: string) => void,
    c: { bold: ColorFn; dim: ColorFn },
    title: string
) {
    w("");
    w(c.dim(hr()));
    w(`  ${c.bold(title)}`);
    w(c.dim(hr()));
}

function renderEndpointTable(
    w: (s: string) => void,
    c: { cyan: ColorFn; green: ColorFn; yellow: ColorFn; red: ColorFn },
    stats: EndpointStats[]
) {
    w(
        `  ${pad("Endpoint", 40)} ${pad("Hits", 8, true)} ${pad("Err%", 7, true)} ${pad("Avg", 8, true)} ${pad("p95", 8, true)} ${pad("p99", 8, true)}`
    );
    for (const s of stats) {
        const errColor = s.errorRate > 0.1 ? c.red : s.errorRate > 0.02 ? c.yellow : c.green;
        w(
            `  ${c.cyan(pad(s.path, 40))} ${pad(s.hits.toLocaleString(), 8, true)} ${errColor(pad(formatPct(s.errorRate), 7, true))} ${pad(formatMillis(s.avgMs), 8, true)} ${pad(formatMillis(s.p95Ms), 8, true)} ${pad(formatMillis(s.p99Ms), 8, true)}`
        );
    }
}

function renderErrorEndpointTable(
    w: (s: string) => void,
    c: { cyan: ColorFn; red: ColorFn },
    stats: EndpointStats[]
) {
    w(
        `  ${pad("Endpoint", 40)} ${pad("Hits", 8, true)} ${pad("Errors", 8, true)} ${pad("Error Rate", 10, true)} ${"Status Codes"}`
    );
    for (const s of stats) {
        const topCodes = Object.entries(s.statusCounts)
            .filter(([k]) => Number(k) >= 400)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([k, v]) => `${k}×${v}`)
            .join(", ") || "-";
        w(
            `  ${c.cyan(pad(s.path, 40))} ${pad(s.hits.toLocaleString(), 8, true)} ${pad(Math.round(s.errorRate * s.hits).toLocaleString(), 8, true)} ${c.red(pad(formatPct(s.errorRate), 10, true))} ${topCodes}`
        );
    }
}

function renderSparkline(
    w: (s: string) => void,
    c: { dim: ColorFn; cyan: ColorFn },
    buckets: HourBucket[]
) {
    const maxReq = Math.max(...buckets.map((b) => b.requests)) || 1;
    const bars = "▁▂▃▄▅▆▇█";
    let line = "";
    const labels: [number, string][] = [];

    for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const h = b.hour.toISOString().slice(11, 13);
        const idx = Math.min(bars.length - 1, Math.floor((b.requests / maxReq) * (bars.length - 1)));
        line += bars[idx];
        if (i % 6 === 0) labels.push([i, h]);
    }

    w(`  ${c.cyan(line)}`);
    let labelRow = "  ";
    let prev = 0;
    for (const [pos, lbl] of labels) {
        labelRow += " ".repeat(pos - prev) + lbl;
        prev = pos + lbl.length;
    }
    w(c.dim(labelRow));
    w(c.dim(`  peak: ${Math.max(...buckets.map((b) => b.requests)).toLocaleString()} req/hr`));
}
