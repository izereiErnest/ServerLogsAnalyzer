import { parseFile } from "./Parser";
import { compute } from "./Analytics";
import { render, formatMillis, formatPct, formatTs } from "./Report";
import { LogEntry } from "./Parser";

// -- Subcommand handlers --

async function cmdReport(args: ParsedArgs): Promise<void> {
    const result = parseFile(args.logFile!);
    const report = compute(result);
    await render(report);
    printParseFooter(report.malformedCount, report.parseRate);
}

async function cmdSlow(args: ParsedArgs): Promise<void> {
    const result = parseFile(args.logFile!);
    const entries = result.entries
        .filter((e) => e.responseMillis !== null)
        .sort((a, b) => b.responseMillis! - a.responseMillis!);
    const n = args.n ?? 10;

    console.log(`\nTop ${n} slowest requests from ${args.logFile}\n`);
    printEntryTable(entries.slice(0, n));
}

async function cmdErrors(args: ParsedArgs): Promise<void> {
    const result = parseFile(args.logFile!);
    const entries = result.entries
        .filter((e) => e.status !== null && e.status >= 400)
        .sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
    const n = args.n ?? entries.length;

    console.log(
        `\n${entries.length} errors found in ${args.logFile}  (showing ${Math.min(n, entries.length)})\n`
    );
    printEntryTable(entries.slice(0, n));
}

async function cmdIp(args: ParsedArgs): Promise<void> {
    const result = parseFile(args.logFile!);
    const entries = result.entries.filter((e) => e.ip === args.ipAddress);
    console.log(`\n${entries.length} requests from ${args.ipAddress}\n`);
    printEntryTable(entries.slice(0, args.n ?? 200));
}

async function cmdPath(args: ParsedArgs): Promise<void> {
    const result = parseFile(args.logFile!);
    const pattern = args.pathPattern!;
    const entries = result.entries.filter(
        (e) => e.path && (e.path === pattern || e.path.startsWith(pattern))
    );
    console.log(`\n${entries.length} requests matching path ${JSON.stringify(pattern)}\n`);
    printEntryTable(entries.slice(0, args.n ?? 200));
}

async function cmdStatus(args: ParsedArgs): Promise<void> {
    const result = parseFile(args.logFile!);
    const code = args.statusCode!;
    const entries = result.entries.filter((e) => e.status === code);
    console.log(`\n${entries.length} requests with status ${code}\n`);
    printEntryTable(entries.slice(0, args.n ?? 200));
}

async function cmdInfo(args: ParsedArgs): Promise<void> {
    const result = parseFile(args.logFile!);
    const report = compute(result);
    const [start, end] = report.timeRange;
    console.log(`\nFile   : ${args.logFile}`);
    console.log(
        `Lines  : ${report.totalLines.toLocaleString()}  (parsed: ${report.parsedCount.toLocaleString()}  malformed: ${report.malformedCount.toLocaleString()})`
    );
    console.log(`From   : ${formatTs(start)}`);
    console.log(`To     : ${formatTs(end)}`);
    console.log(`Errors : ${formatPct(report.errorRate)}`);
    console.log(`p95    : ${formatMillis(report.overallP95Ms)}`);
    console.log();
}

// -- Shared helper --

function statusColor(status: number | null): string {
    if (!status) return "";
    if (status >= 500) return "\x1b[31m"; // red
    if (status >= 400) return "\x1b[33m"; // yellow
    return "\x1b[32m";                     // green
}
const RESET = "\x1b[0m";

function printEntryTable(entries: LogEntry[]): void {
    const fmt = (ts: string, ip: string, method: string, path: string, status: string, dur: string) =>
        `  ${ts.padEnd(22)} ${ip.padEnd(16)} ${method.padEnd(8)} ${path.padEnd(40)} ${status.padEnd(6)} ${dur.padStart(10)}`;

    console.log(fmt("Timestamp", "IP", "Method", "Path", "Status", "Duration"));
    console.log("  " + "─".repeat(108));

    for (const e of entries) {
        const statusStr = e.status != null ? String(e.status) : "-";
        const color = statusColor(e.status);
        console.log(
            fmt(
                formatTs(e.timestamp).slice(0, 22),
                (e.ip ?? "-").slice(0, 16),
                (e.method ?? "-").slice(0, 8),
                (e.path ?? "-").slice(0, 40),
                `${color}${statusStr}${RESET}`,
                e.responseMillis !== null ? formatMillis(e.responseMillis) : "-"
            )
        );
    }
}

function printParseFooter(malformedCount: number, parseRate: number): void {
    if (malformedCount > 0) {
        process.stderr.write(
            `\n  ⚠  ${malformedCount.toLocaleString()} lines skipped ` +
            `(${formatPct(1 - parseRate)} of total) — ` +
            `malformed, blank, or unparseable.\n\n`
        );
    }
}

// -- Argument parsing --

interface ParsedArgs {
    command: string;
    logFile?: string;
    top?: number;
    n?: number;
    ipAddress?: string;
    pathPattern?: string;
    statusCode?: number;
}

function printHelp(): void {
    console.log(`
Log Analyzer — parse and interrogate server log files.

Usage: analyze <command> <log_file> [options]

Commands:
  report   <log_file> [--top N]          Full summary report
  slow     <log_file> [--n N]            Show N slowest individual requests
  errors   <log_file> [--n N]            Show error responses (4xx/5xx)
  ip       <log_file> <ip> [--n N]       Show requests from a specific IP
  path     <log_file> <pattern> [--n N]  Show requests matching a path prefix
  status   <log_file> <code> [--n N]     Show requests with a specific status
  info     <log_file>                    Quick file summary

Examples:
  npx ts-node src/analyze.ts report  server.log
  npx ts-node src/analyze.ts slow    server.log --n 20
  npx ts-node src/analyze.ts errors  server.log --n 50
  npx ts-node src/analyze.ts ip      server.log 192.168.1.42
  npx ts-node src/analyze.ts path    server.log /api/users
  npx ts-node src/analyze.ts status  server.log 500
  npx ts-node src/analyze.ts info    server.log
`);
}

function parseArgs(argv: string[]): ParsedArgs {
    const args = argv.slice(2); // strip node + script

    if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        printHelp();
        process.exit(0);
    }

    const command = args[0];
    const parsed: ParsedArgs = { command };

    const getFlag = (flag: string): string | undefined => {
        const idx = args.indexOf(flag);
        return idx !== -1 ? args[idx + 1] : undefined;
    };

    parsed.top = getFlag("--top") ? parseInt(getFlag("--top")!, 10) : undefined;
    parsed.n = getFlag("--n") ? parseInt(getFlag("--n")!, 10) : undefined;

    // Positional args (non-flag tokens after the command)
    const positional = args.slice(1).filter((a) => !a.startsWith("-") && !/^\d+$/.test(a) || a.startsWith("/"));

    switch (command) {
        case "report":
        case "slow":
        case "errors":
        case "info":
            parsed.logFile = positional[0];
            break;
        case "ip":
            parsed.logFile = positional[0];
            parsed.ipAddress = positional[1];
            break;
        case "path":
            parsed.logFile = positional[0];
            parsed.pathPattern = positional[1];
            break;
        case "status": {
            parsed.logFile = positional[0];
            // status code may be numeric — grab it from positionals or raw args
            const codeStr = args.slice(1).find((a) => /^\d{3}$/.test(a));
            parsed.statusCode = codeStr ? parseInt(codeStr, 10) : undefined;
            break;
        }
        default:
            console.error(`Unknown command: ${command}`);
            printHelp();
            process.exit(1);
    }

    return parsed;
}

// Main

const COMMANDS: Record<string, (args: ParsedArgs) => Promise<void>> = {
    report: cmdReport,
    slow: cmdSlow,
    errors: cmdErrors,
    ip: cmdIp,
    path: cmdPath,
    status: cmdStatus,
    info: cmdInfo,
};

async function main(): Promise<void> {
    const args = parseArgs(process.argv);
    const fn = COMMANDS[args.command];
    if (!fn) {
        printHelp();
        process.exit(1);
    }
    try {
        await fn(args);
    } catch (err: unknown) {
        if (err instanceof Error && err.message.includes("ENOENT")) {
            console.error(`Error: ${err.message}`);
            process.exit(1);
        }
        throw err;
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
