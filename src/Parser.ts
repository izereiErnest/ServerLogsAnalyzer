import * as fs from "fs";

// -- Data Model --

export interface LogEntry {
    timestamp: Date | null;
    ip: string | null;
    method: string | null;
    path: string | null;
    status: number | null;
    responseMillis: number | null;
    rawLine: string;
    parseWarnings: string[];
    isJSON: boolean;
    extraFields: string[];
}

export interface ParseResult {
    entries: LogEntry[];
    malformedCount: number;
    totalLines: number;
    formatAnomalies: Record<string, number>;
}

//Timestamp Parsers(Most common comes first)

type TimestampParser = {
    pattern: RegExp;
    parse: (s: string) => Date;
};

const TimeStampFormats: TimestampParser[] = [
  //1stLy, ISO 8601 with Z
  {
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    parse: (s) => new Date(s),
  },
  //2ndLy, ISO 8601 with offset
  {
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    parse: (s) => new Date(s),
  },
  //3rdLy, YYYY/MM/DD HH:MM:SS
  {
    pattern: /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/,
    parse: (s) => new Date(s.replace(/\//g, '-').replace(' ', 'T') + 'Z'),
  },
  //4thLy, DD-Mon-YYYY HH:MM:SS
  {
    pattern: /^\d{2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}$/,
    parse: (s) => {
      const MONTHS: Record<string, string> = {
        jan: '01',
        feb: '02',
        mar: '03',
        apr: '04',
        may: '05',
        jun: '06',
        jul: '07',
        aug: '08',
        sep: '09',
        oct: '10',
        nov: '11',
        dec: '12',
      };
      const [datePart, timePart] = s.split(' ');
      const [day, mon, year] = datePart.split('-');
      const mm = MONTHS[mon.toLowerCase()] ?? '01';
      return new Date(`${year}-${mm}-${day}T${timePart}Z`);
    },
  },
  //5thLy, Unix epoch: 10 didit version
  {
    pattern: /^\d{10}$/,
    parse: (s) => new Date(parseInt(s, 10) * 1000),
  },
  //6thLy Unix epoch with decimals
  {
    pattern: /^\d{10}\.\d+$/,
    parse: (s) => new Date(parseFloat(s) * 1000),
  },
  //7thLy, YYYY-MM-DD HH:MM:SS without T
  {
    pattern: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    parse: (s) => new Date(s.replace(' ', 'T') + 'Z'),
  },
];

const EPOCH_RE = /^\d{10}(\.\d+)?$/;

function parseTimeStamp(
  token: string,
  nextToken = ""
): { date: Date | null; consumed: number } {
  const combined = nextToken ? `${token} ${nextToken}` : token;

  for (const { pattern, parse } of TimeStampFormats) {
    for (const [candidate, consumed] of [
      [combined, 2],
      [token, 1],
    ] as [string, number][]) {
      if (!pattern.test(candidate)) continue;
      try {
        const date = parse(candidate);
        if (!isNaN(date.getTime())) {
          return { date, consumed };
        }
      } catch {
        // try next
      }
    }
  }

  return { date: null, consumed: 0 };
}

//--Response time Parser--

const ResponseTimeMillSecsRegex = /^(\d+(?:\.\d+)?)ms$/i;
const ResponseTimeSecsRegex = /^(\d+(?:\.\d+)?)s$/i;
const ResponseTimeIntegerRegex = /^\d+$/;

function parseResponseTime(
    token: string
): {ms: number | null; anomaly: string | null}{
    let m = ResponseTimeMillSecsRegex.exec(token);
    if (m) return {ms: parseFloat(m[1]), anomaly: null};

    m = ResponseTimeSecsRegex.exec(token);
    if (m) return {ms: parseFloat(m[1]) * 1000, anomaly: "Response_Time_In_Seconds"};

    m = ResponseTimeIntegerRegex.exec(token);
    if (m) return { ms: parseFloat(token), anomaly: "Response_Time_Bare_Integer" };

    return {ms: null, anomaly: null};
}

//--IP Validator--

const IPRegex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIp(token: string): boolean {
    const m = IPRegex.exec(token);
    if (!m) return false;
    return [m[1], m[2], m[3], m[4]].every((g) => parseInt(g, 10) <= 255);
}

//--HTTP method --

const HTTP_Methods = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT",]);

function isStatus(token: string): boolean {
    if (!/^\d+$/.test(token)) return false;
    const n = parseInt(token, 10);
    return n >= 100 && n <= 599;
}

//--JSON Field--
const JSONFieldMap: Record<string, string> = {
    timestamp: "timestamp",
    time: "timestamp",
    ts: "timestamp",
    "@timestamp": "timestamp",
    remoteAddr: "ip",
    src: "ip",
    client: "ip",
    ip: "ip",
    method: "method",
    path: "path",
    url: "path",
    uri: "path",
    status: "status",
    statusCode: "status",
    respCode: "status",
    responseCode: "status",
    durationMillis: "response_ms",
    ms: "response_ms",
    duration: "response_ms",
    responseTime: "response_ms",
}

function parseJsonLine(raw: string): LogEntry | null {
    let obj: unknown;
    try{
     obj = JSON.parse(raw);
    }catch{
       return null;
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

    const record = obj as Record<string, unknown>;
    const entry: LogEntry = {
        timestamp: null,
        ip: null,
        method: null,
        path: null,
        status: null,
        responseMillis: null,
        rawLine: raw,
        isJSON: true,
        parseWarnings: [],
        extraFields: [],
    };
    const warnings: string[] = [];
    for (const [k, v] of Object.entries(record)){
        const mapped = JSONFieldMap[k.toLowerCase()];
        if (!mapped) continue;

        if (mapped === "timestamp") {
            const { date } = parseTimeStamp(String(v));
            if (date === null && typeof v === "number" && v > 1e9) {
                entry.timestamp = new Date(v * 1000);
            } else {
                entry.timestamp = date;
            }
        } else if (mapped === "ip") {
            entry.ip = String(v);
        } else if (mapped === "method") {
            if (k.toLowerCase() === "req" && typeof v === "string" && v.includes(" ")) {
                const parts = v.split(/\s+/, 2);
                if (HTTP_Methods.has(parts[0])) {
                    entry.method = parts[0];
                    entry.path = parts[1] ?? null;
                    continue;
                }
            }
            const upper = String(v).toUpperCase();
            entry.method = HTTP_Methods.has(upper) ? upper : String(v);
        } else if (mapped === "path") {
            entry.path = String(v);
        } else if (mapped === "status") {
            const n = Number(v);
            if (!isNaN(n)) {
                entry.status = n;
            } else {
                warnings.push(`json_unparseable_status:${JSON.stringify(v)}`);
            }
        } else if (mapped === "response_ms") {
            const n = Number(v);
            if (!isNaN(n)) {
                let ms = n;
                // Heuristic: if field name contains 's' but not 'ms', and looks like seconds
                if (!k.toLowerCase().includes("ms") &&
                    (k.toLowerCase().includes("second") || ["duration", "response_time"].includes(k.toLowerCase()))) {
                    if (ms < 100) ms *= 1000;
                }
                entry.responseMillis = ms;
            } else {
                warnings.push(`json_unparseable_response_time:${JSON.stringify(v)}`);
            }
        }
    }
    entry.parseWarnings = warnings;
    return entry;
}

// -- Tokeniser --

function tokenise(line: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let inQuote: string | null = null;

    for (const ch of line) {
        if((ch === "" || ch === "'") && inQuote === null) {
            inQuote = ch;
            current += ch;
        }else if(ch === inQuote) {
            inQuote = null;
            current += ch;
        }else if (ch === " " && inQuote === null) {
            if (current) {
                tokens.push(current);
                current = "";
            }
        }else {
            current += ch;
        }
    }
    if (current) tokens.push(current);
    return tokens. filter(Boolean);
}

// -- Main Line Parser --

export function parseLine(raw: string): LogEntry | null {
    const line = raw.trim();
    if(!line) return null;

    if (line.startsWith("{")) {
        return parseJsonLine(line);
    }

    const warnings: string[] = [];
    const anomalies: string[] = [];
    const tokens = tokenise(line);

    if (tokens.length < 2) return null;

    let timestamp: Date | null = null;
    let consumed = 0;

    if (tokens.length > 0) {
        const { date, consumed: c } = parseTimeStamp(
            tokens[0],
            tokens[1] ?? ""
        );
        if (date) {
            timestamp = date;
            consumed = c;
            if (c === 2) anomalies.push("timestamp_two_token");
        } else if (EPOCH_RE.test(tokens[0])) {
            const n = parseFloat(tokens[0]);
            const d = new Date(n * 1000);
            if (!isNaN(d.getTime())) {
                timestamp = d;
                consumed = 1;
            }
        }
        if (!timestamp) {
            warnings.push("unparseable_timestamp");
            consumed = 0;
        }
    }
    const rest = tokens.slice(consumed);

    let ip: string | null = null;
    let method: string | null = null;
    let path: string | null = null;
    let status: number | null = null;
    let responseMillis: number | null = null;

    let idx = 0;

    // IP
    if (idx < rest.length && isIp(rest[idx])) {
        ip = rest[idx++];
    } else if (idx < rest.length) {
        warnings.push(`missing_or_invalid_ip:token=${JSON.stringify(rest[idx])}`);
    }

    // Method
    if (idx < rest.length && HTTP_Methods.has(rest[idx].toUpperCase())) {
        method = rest[idx++].toUpperCase();
    } else {
        warnings.push("missing_method");
    }

    // Path
    if (idx < rest.length && rest[idx].startsWith("/")) {
        path = rest[idx++];
    } else {
        warnings.push("missing_path");
    }

    // Status code
    if (idx < rest.length) {
        const tok = rest[idx];
        if (isStatus(tok)) {
            status = parseInt(tok, 10);
            idx++;
        } else if (tok === "-") {
            warnings.push("placeholder_status_code");
            idx++;
        }
    }

    // Response time
    if (idx < rest.length) {
        const { ms, anomaly } = parseResponseTime(rest[idx]);
        if (ms !== null) {
            responseMillis = ms;
            if (anomaly) anomalies.push(anomaly);
            idx++;
        } else {
            warnings.push(`missing_or_unparseable_response_time:token=${JSON.stringify(rest[idx])}`);
        }
    }

    const extraFields = rest.slice(idx);

    // If nothing useful was parsed, treat as malformed
    const useful = [timestamp, ip, method, path].filter(Boolean).length;
    if (useful === 0) return null;

    const allWarnings = [
        ...warnings,
        ...anomalies.map((a) => `anomaly:${a}`),
        ...(extraFields.length > 0 ? [`extra_fields:${extraFields.length}`] : []),
    ];

    return {
        timestamp,
        ip,
        method,
        path,
        status,
        responseMillis,
        rawLine: raw,
        parseWarnings: allWarnings,
        isJSON: false,
        extraFields,
    };
}

// -- File Level Parser

export function parseFile(filePath: string): ParseResult {
    if (!fs.existsSync(filePath)) {
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`);
    }

    const entries: LogEntry[] = [];
    let malformedCount = 0;
    let totalLines = 0;
    const anomalyCounts: Record<string, number> = {};

    try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n");

        for (const rawLine of lines) {
            // Skip the trailing empty element from a trailing newline
            if (rawLine === "" && totalLines === lines.length - 1) {
                // final trailing newline — still count it
                totalLines++;
                malformedCount++;
                continue;
            }
            totalLines++;
            const entry = parseLine(rawLine);
            if (entry === null) {
                malformedCount++;
            } else {
                entries.push(entry);
                for (const w of entry.parseWarnings) {
                    anomalyCounts[w] = (anomalyCounts[w] ?? 0) + 1;
                }
            }
        }
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw err;
        const msg = err instanceof Error ? err.message : String(err);
        anomalyCounts[`file_read_error:${msg}`] = 1;
    }

    return {
        entries,
        malformedCount,
        totalLines,
        formatAnomalies: anomalyCounts,
    };
}


