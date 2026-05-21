import * as fs from "fs";
import * as path from "path";

const ENDPOINTS = [
    "/api/users", "/api/users/{id}", "/api/login", "/api/logout",
    "/api/products", "/api/products/{id}", "/api/orders", "/api/orders/{id}",
    "/api/search", "/api/health", "/api/metrics", "/api/settings",
    "/static/js/app.js", "/static/css/main.css", "/favicon.ico",
    "/api/reports", "/api/export", "/api/upload", "/api/webhooks",
];

const METHODS = ["GET", "GET", "GET", "GET", "POST", "POST", "PUT", "DELETE", "PATCH"];

const STATUS_DIST: [number, number][] = [
    [200, 55], [201, 8], [204, 4], [301, 2], [302, 2],
    [400, 5], [401, 5], [403, 3], [404, 8], [500, 4], [502, 2], [503, 2],
];

const IPS = [
    "192.168.1.42", "192.168.1.43", "10.0.0.7", "10.0.0.8",
    "172.16.0.1", "203.0.113.5", "198.51.100.23", "192.0.2.17",
    "10.10.1.100", "10.10.1.101",
];

const USER_AGENTS = [
    '"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"',
    '"curl/7.88.1"',
    '"python-requests/2.31.0"',
    '"Go-http-client/1.1"',
    '"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"',
];

const REFERRERS = [
    '"https://example.com/dashboard"',
    '"https://example.com/settings"',
    '"-"',
    '"https://external-site.com/link"',
];

const MALFORMED_LINES = [
    "",
    "   ",
    "TRUNCATED REQUEST --",
    "2024-03-15T14:23:01Z",
    "GET /api/users",
    "---",
    "null",
    "internal error: nil pointer dereference",
    "[GC] heap freed 42MB",
];

// Simple seeded PRNG (mulberry32)

function makePrng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Helpers

function weightedChoice<T>(dist: [T, number][], rand: () => number): T {
    const items: T[] = dist.flatMap(([item, weight]) => Array(weight).fill(item));
    return items[Math.floor(rand() * items.length)];
}

function randomResponseTime(rand: () => number): number {
    // Log-normal approximating lognormvariate(4.0, 0.8)
    const u = rand(), v = rand();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const base = Math.exp(4.0 + 0.8 * z);
    return Math.max(1, Math.round(base));
}

function fmtTimestampNormal(d: Date): string {
    return d.toISOString().replace(".000Z", "Z");
}

function fmtTimestampVariant(d: Date, rand: () => number): string {
    const choice = Math.floor(rand() * 3);
    if (choice === 0) {
        return d.toISOString().slice(0, 10).replace(/-/g, "/") +
            " " + d.toISOString().slice(11, 19);
    } else if (choice === 1) {
        const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
        const dd = String(d.getUTCDate()).padStart(2, "0");
        const mon = MONTHS[d.getUTCMonth()];
        const yyyy = d.getUTCFullYear();
        const time = d.toISOString().slice(11, 19);
        return `${dd}-${mon}-${yyyy} ${time}`;
    } else {
        return String(Math.floor(d.getTime() / 1000));
    }
}

function fmtRtNormal(ms: number): string { return `${ms}ms`; }
function fmtRtVariant(ms: number, rand: () => number): string {
    return rand() < 0.5 ? `${(ms / 1000).toFixed(3)}s` : String(ms);
}

function makeEndpoint(rand: () => number): string {
    const ep = ENDPOINTS[Math.floor(rand() * ENDPOINTS.length)];
    return ep.includes("{id}") ? ep.replace("{id}", String(Math.floor(rand() * 99999) + 1)) : ep;
}

function makeNormalLine(d: Date, rand: () => number): string {
    const ts = fmtTimestampNormal(d);
    const ip = IPS[Math.floor(rand() * IPS.length)];
    const method = METHODS[Math.floor(rand() * METHODS.length)];
    const ep = makeEndpoint(rand);
    const status = weightedChoice(STATUS_DIST, rand);
    const ms = randomResponseTime(rand);
    return `${ts} ${ip} ${method} ${ep} ${status} ${fmtRtNormal(ms)}`;
}

function makeVariantLine(d: Date, rand: () => number): string {
    const variant = Math.floor(rand() * 6);
    const ip = IPS[Math.floor(rand() * IPS.length)];
    const method = METHODS[Math.floor(rand() * METHODS.length)];
    const ep = makeEndpoint(rand);
    const status = weightedChoice(STATUS_DIST, rand);
    const ms = randomResponseTime(rand);

    if (variant === 0) {
        return `${fmtTimestampVariant(d, rand)} ${ip} ${method} ${ep} ${status} ${fmtRtNormal(ms)}`;
    } else if (variant === 1) {
        return `${fmtTimestampNormal(d)} ${ip} ${method} ${ep} ${status} ${fmtRtVariant(ms, rand)}`;
    } else if (variant === 2) {
        const statusStr = rand() < 0.5 ? "-" : "";
        if (!statusStr) return `${fmtTimestampNormal(d)} ${ip} ${method} ${ep} ${fmtRtNormal(ms)}`;
        return `${fmtTimestampNormal(d)} ${ip} ${method} ${ep} ${statusStr} ${fmtRtNormal(ms)}`;
    } else if (variant === 3) {
        const ua = USER_AGENTS[Math.floor(rand() * USER_AGENTS.length)];
        const ref = REFERRERS[Math.floor(rand() * REFERRERS.length)];
        return `${fmtTimestampNormal(d)} ${ip} ${method} ${ep} ${status} ${fmtRtNormal(ms)} ${ref} ${ua}`;
    } else if (variant === 4) {
        const useAlt = rand() < 0.5;
        if (!useAlt) {
            return JSON.stringify({ time: d.toISOString(), remote_addr: ip, method, path: ep, status, duration_ms: ms, service: "api-gateway" });
        } else {
            return JSON.stringify({ timestamp: Math.floor(d.getTime() / 1000), src: ip, req: `GET ${ep}`, resp_code: status, ms });
        }
    } else {
        return `${fmtTimestampVariant(d, rand)} ${ip} ${method} ${ep} ${status} ${fmtRtVariant(ms, rand)}`;
    }
}

function makeMalformedLine(rand: () => number): string {
    if (rand() < 0.3) {
        const traces = [
            "Traceback (most recent call last):",
            "NullPointerException at com.example.Service",
            "FATAL: unhandled exception in worker thread",
        ];
        return traces[Math.floor(rand() * traces.length)];
    }
    return MALFORMED_LINES[Math.floor(rand() * MALFORMED_LINES.length)];
}

function generateLog(nLines: number, seed: number): string[] {
    const rand = makePrng(seed);
    const lines: string[] = [];
    const start = new Date("2024-03-15T00:00:00Z").getTime();
    const dayMs = 86_400_000;
    const stepMs = dayMs / nLines;
    let current = start;

    for (let i = 0; i < nLines; i++) {
        current += stepMs + (rand() * 2 - 1) * stepMs * 0.3;
        current = Math.max(start, current);
        const d = new Date(current);
        const roll = rand();
        if (roll < 0.02) {
            lines.push(makeMalformedLine(rand));
        } else if (roll < 0.10) {
            lines.push(makeVariantLine(d, rand));
        } else {
            lines.push(makeNormalLine(d, rand));
        }
    }
    return lines;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
    const argv = process.argv.slice(2);
    const getArg = (flag: string, def: string) => {
        const idx = argv.indexOf(flag);
        return idx !== -1 ? argv[idx + 1] : def;
    };

    const nLines = parseInt(getArg("--lines", "5000"), 10);
    const outputPath = getArg("--output", "test_logs/sample.log");
    const seed = parseInt(getArg("--seed", "42"), 10);

    const dir = path.dirname(outputPath);
    if (dir) fs.mkdirSync(dir, { recursive: true });

    const lines = generateLog(nLines, seed);
    fs.writeFileSync(outputPath, lines.join("\n") + "\n", "utf-8");

    console.log(`Generated ${lines.length} lines → ${outputPath}`);
    const malformed = lines.filter(
        (l) => !l.trim() || l.startsWith("TRUNCATED") || l === "---"
    ).length;
    console.log(`  ~${malformed} obviously malformed/blank lines (${((malformed / lines.length) * 100).toFixed(1)}%)`);
}

main();
