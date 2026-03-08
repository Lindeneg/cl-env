import {join as nodeJoin} from "node:path";
import {readFileSync} from "node:fs";

export type LoadEnvOpts = {
    files: string[];
    transformKeys: boolean;
    basePath?: string;
    encoding?: BufferEncoding;
    includeProcessEnv?: boolean | "overwrite";
    logger?: Logger | boolean;
    schemaParser?: SchemaParser;
    radix?: RadixFn;
};

export function loadEnv<TOpts extends LoadEnvOpts, TConfig extends Config>(
    opts: TOpts,
    config: TConfig
): Result<
    {
        [K in keyof TConfig as TOpts["transformKeys"] extends true
            ? K extends string
                ? SafeCamelCase<K>
                : K
            : K]: InferValueFromTransformFn<TConfig[K]>;
    },
    string[]
> {
    const errors: string[] = [];
    const env: Record<PropertyKey, unknown> = {};
    const rawEnv: Record<string, unknown> = {};
    const seenKeys = new Set<string>();

    const log: Logger | undefined =
        typeof opts.logger === "function"
            ? opts.logger
            : opts.logger === true
              ? defaultLogger
              : undefined;

    const ctx: TransformContext = {
        rawEnv,
        ...(opts.schemaParser && {schemaParser: opts.schemaParser}),
        ...(opts.radix && {radix: opts.radix}),
        ...(log && {log}),
    };

    const allEntries = parseAllFiles(opts.files, errors, log, opts.basePath, opts.encoding);
    const deduped = deduplicate(allEntries, log);

    if (log) checkUnknownKeys(deduped, config, log);

    const expanded = expandEntries(deduped, log);

    if (opts.includeProcessEnv) {
        mergeProcessEnv(expanded, opts.includeProcessEnv, config, log);
    }

    function setVal(key: string, value: unknown) {
        const finalKey = opts.transformKeys ? toCamelCase(key) : key;
        (env as any)[finalKey] = value;
        rawEnv[key] = value;
    }

    for (const [key, value] of expanded) {
        const transform = config[key];
        if (!transform) continue;
        seenKeys.add(key);
        const entry = deduped.get(key);
        try {
            const transformResult = transform(key, value, ctx);
            if (!transformResult.ok) {
                const prefix = entry ? `${key}:L${entry.line}` : key;
                errors.push(`${prefix}: ${transformResult.ctx}`);
                continue;
            }
            setVal(key, transformResult.data);
        } catch (err) {
            const prefix = entry ? `${key}:L${entry.line}` : key;
            errors.push(`${prefix}: transform function threw: ` + err);
            continue;
        }
    }

    // handle unseen keys
    const cfgEntries = Object.entries(config);
    if (seenKeys.size < cfgEntries.length) {
        for (const [cfgKey, cfgFn] of cfgEntries) {
            if (seenKeys.has(cfgKey)) continue;
            const result = cfgFn(cfgKey, "", ctx);
            if (result.ok) {
                log?.("debug", `${cfgKey}: not found in any file, using default`);
                setVal(cfgKey, result.data);
            } else {
                errors.push(result.ctx);
            }
        }
    }

    if (errors.length) return failure(errors);

    log?.(
        "debug",
        `loaded ${seenKeys.size} keys from ${opts.files.length} file(s) (${opts.files.join(", ")})`
    );

    return success(env as any);
}

export type LogLevel = "error" | "warn" | "debug" | "verbose";
export type Logger = (level: LogLevel, message: string) => void;

export type SchemaParser<TSchema = any, TReturn = any> = (
    obj: unknown,
    schema: TSchema,
    key: string
) => Result<TReturn, string>;

type ResultSuccess<TData> = {
    data: TData;
    ok: true;
};

interface ResultFailure<TCtx> {
    ctx: TCtx;
    ok: false;
}

export type Result<TData, TErrorCtx = string> = ResultSuccess<TData> | ResultFailure<TErrorCtx>;

export function success<TData>(data: TData): ResultSuccess<TData> {
    return {data, ok: true};
}

export function failure<TCtx>(ctx: TCtx): ResultFailure<TCtx> {
    return {ok: false, ctx};
}

export function unwrap<T extends Result<any, any>>(
    r: T
): [T] extends [Result<infer TData, any>] ? TData : never {
    if (!r.ok) throw new Error(Array.isArray(r.ctx) ? r.ctx.join("\n") : r.ctx);
    return r.data;
}

export function toString(_: string, v: string): Result<string> {
    return success(v);
}

export function toBool(key: string, v: string): Result<boolean> {
    const lower = v.toLowerCase();
    if (lower === "true" || v === "1") return success(true);
    if (lower === "false" || v === "0") return success(false);
    return failure(`${key}: expected boolean, got '${v}'`);
}

export function toInt(key: string, v: string, ctx: TransformContext): Result<number> {
    return toNumber(key, v, ctx, "int");
}

export function toFloat(key: string, v: string, ctx: TransformContext): Result<number> {
    return toNumber(key, v, ctx, "float");
}

export function toStringArray(delimiter = ",") {
    return function (_: string, v: string): Result<string[]> {
        return success(v.split(delimiter).map((s) => s.trim()));
    };
}

export function toIntArray(delimiter = ",") {
    return function (key: string, v: string, ctx: TransformContext): Result<number[]> {
        const parts = v.split(delimiter).map((s) => s.trim());
        const out: number[] = [];

        for (const p of parts) {
            const r = toInt(key, p, ctx);
            if (!r.ok) return r;
            out.push(r.data);
        }

        return success(out);
    };
}

export function toJSON<T>(schema?: unknown) {
    return function (k: string, v: string, ctx: TransformContext): Result<T> {
        try {
            const json = JSON.parse(v);
            if (schema) {
                if (!ctx.schemaParser) {
                    return failure(
                        `${k}: schema provided but no schemaParser is set. ` +
                            "Please use 'schemaParser' in options."
                    );
                }
                return ctx.schemaParser(json, schema, k);
            }
            return success(json);
        } catch (err) {
            return failure(`${k}: failed to convert to JSON`);
        }
    };
}

export function withDefault<TTransform extends TransformFn>(
    transform: TTransform,
    defaultValue: InferValueFromTransformFn<TTransform>
) {
    return function (
        key: string,
        val: string,
        ctx: TransformContext
    ): Result<InferValueFromTransformFn<TTransform>> {
        if (!val) return success(defaultValue);
        return transform(key, val, ctx);
    };
}

export function withRequired<TTransform extends TransformFn>(transform: TTransform) {
    return function (
        key: string,
        val: string,
        ctx: TransformContext
    ): Result<InferValueFromTransformFn<TTransform>> {
        if (!val) return failure(`${key}: is required but is missing`);
        return transform(key, val, ctx);
    };
}

type Config = Record<string, TransformFn>;

type CamelCase<S extends string> = S extends `${infer Head}_${infer Tail}`
    ? `${Lowercase<Head>}${PascalTail<Tail>}`
    : Lowercase<S>;

type PascalTail<S extends string> = S extends `${infer Head}_${infer Tail}`
    ? `${Capitalize<Lowercase<Head>>}${PascalTail<Tail>}`
    : Capitalize<Lowercase<S>>;

type SafeCamelCase<S extends string> = S extends Uppercase<S> ? CamelCase<S> : S;

type RadixFn = (key: string) => number | undefined;

type TransformContext = {
    rawEnv: Record<string, unknown>;
    schemaParser?: SchemaParser;
    radix?: RadixFn;
    log?: Logger;
};

type TransformFn<TData = any> = (
    key: string,
    val: string,
    ctx: TransformContext
) => Result<TData, string>;

type InferValueFromTransformFn<TTransform extends TransformFn> =
    ReturnType<TTransform> extends Result<infer TData> ? TData : never;

function defaultLogger(level: LogLevel, message: string) {
    console[level === "error" ? "error" : level === "warn" ? "warn" : "debug"](
        `[cl-env:${level}] ${message}`
    );
}

function readFile(path: string, encoding: BufferEncoding): Result<string> {
    try {
        const file = readFileSync(path, {encoding});
        return success(file);
    } catch (err) {
        return failure(err instanceof Error ? err.message : `failed to read env file: '${path}'`);
    }
}

function toCamelCase(s: string): string {
    if (s !== s.toUpperCase()) return s;
    return s.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function toNumber(key: string, v: string, ctx: TransformContext, parser: "int" | "float") {
    let n;
    if (parser === "int") {
        n = parseInt(v, ctx.radix ? ctx.radix(key) : 10);
    } else {
        n = parseFloat(v);
    }
    if (Number.isNaN(n)) return failure(`${key}: failed to convert '${v}' to a number`);
    return success(n);
}

function parseAllFiles(
    files: string[],
    errors: string[],
    log?: Logger,
    basePath?: string,
    encoding?: BufferEncoding
) {
    const allEntries: ParsedEntry[] = [];
    for (let filePath of files) {
        if (basePath) {
            filePath = nodeJoin(basePath, filePath);
        }
        const fileResult = readFile(filePath, encoding ?? "utf8");
        if (fileResult.ok) {
            const {entries, warnings} = parseDotenv(fileResult.data);
            allEntries.push(...entries);
            log?.("verbose", `loaded file: ${filePath} (${entries.length} entries)`);
            if (log) {
                for (const w of warnings) {
                    log("warn", w.message);
                }
            }
        } else {
            log?.("verbose", `failed to read file: ${filePath}`);
            errors.push(fileResult.ctx);
        }
    }
    return allEntries;
}

function deduplicate(allEntries: ParsedEntry[], log?: Logger) {
    const deduped = new Map<string, ParsedEntry>();
    for (const entry of allEntries) {
        if (log && deduped.has(entry.key)) {
            log("warn", `${entry.key}:L${entry.line}: duplicate key, overwriting previous value.`);
        }
        deduped.set(entry.key, entry);
    }
    return deduped;
}

function expandEntries(deduped: Map<string, ParsedEntry>, log?: Logger) {
    const expanded = new Map<string, string>();
    for (const [key, entry] of deduped) {
        if (entry.quoted === "'") {
            expanded.set(key, entry.value);
        } else {
            const expandedValue = expand(entry.value, expanded, process.env);
            if (log && expandedValue !== entry.value) {
                log(
                    "verbose",
                    `${key}:L${entry.line}: expanded "${entry.value}" → "${expandedValue}"`
                );
            }
            expanded.set(key, expandedValue);
        }
    }
    return expanded;
}

function checkUnknownKeys(deduped: Map<string, ParsedEntry>, config: Config, log: Logger) {
    for (const [key, entry] of deduped) {
        if (!config[key]) {
            log("warn", `${key}:L${entry.line}: not a known key.`);
        }
    }
}

function mergeProcessEnv(
    expanded: Map<string, string>,
    includeProcessEnv: boolean | "overwrite",
    config: Config,
    log?: Logger
) {
    const mode = includeProcessEnv === "overwrite" ? "overwrite" : "fallback";
    log?.("debug", `merging process.env as ${mode}`);
    for (const key of Object.keys(config)) {
        const pVal = process.env[key];
        if (pVal === undefined) continue;

        if (includeProcessEnv === "overwrite") {
            log?.("verbose", `${key}: process.env overwriting file value`);
            expanded.set(key, pVal);
        } else if (!expanded.has(key)) {
            log?.("verbose", `${key}: using value from process.env`);
            expanded.set(key, pVal);
        }
    }
}

type ParsedEntry = {
    key: string;
    value: string;
    line: number;
    quoted?: '"' | "'" | "`";
};

type ParseWarning = {
    line: number;
    message: string;
};

function parseDotenv(raw: string): {entries: ParsedEntry[]; warnings: ParseWarning[]} {
    // strip BOM
    if (raw.charCodeAt(0) === 0xfeff) {
        raw = raw.slice(1);
    }
    // normalize line endings
    raw = raw.replace(/\r\n?/g, "\n");

    const entries: ParsedEntry[] = [];
    const warnings: ParseWarning[] = [];
    let pos = 0;
    let line = 1;

    function advance(): string | undefined {
        const ch = raw[pos++];
        if (ch === "\n") line++;
        return ch;
    }

    function skipInlineWhitespace() {
        while (pos < raw.length && (raw[pos] === " " || raw[pos] === "\t")) {
            pos++;
        }
    }

    function skipToNewline() {
        while (pos < raw.length && raw[pos] !== "\n") pos++;
        if (pos < raw.length) advance();
    }

    while (pos < raw.length) {
        skipInlineWhitespace();

        if (raw[pos] === "\n") {
            advance();
            continue;
        }

        // comment line
        if (raw[pos] === "#") {
            skipToNewline();
            continue;
        }

        // strip `export ` prefix
        if (raw.startsWith("export ", pos)) {
            pos += 7;
            skipInlineWhitespace();
        }

        const entryLine = line;

        // read key
        let key = "";
        while (pos < raw.length) {
            const c = raw[pos];
            if (c === "=" || c === " " || c === "\t" || c === "\n") break;
            key += advance();
        }

        if (!key) {
            skipToNewline();
            continue;
        }

        skipInlineWhitespace();

        if (raw[pos] !== "=") {
            skipToNewline();
            continue;
        }
        // consume =
        advance();

        skipInlineWhitespace();

        let value = "";
        const quote = raw[pos];

        if (quote === '"') {
            // double-quoted: escape sequences, multiline
            advance();
            while (pos < raw.length) {
                const c = raw[pos];
                if (c === "\\") {
                    advance();
                    if (pos >= raw.length) break;
                    const esc = advance();
                    switch (esc) {
                        case "n":
                            value += "\n";
                            break;
                        case "r":
                            value += "\r";
                            break;
                        case "t":
                            value += "\t";
                            break;
                        case "\\":
                            value += "\\";
                            break;
                        case '"':
                            value += '"';
                            break;
                        default:
                            value += "\\" + esc;
                            break;
                    }
                } else if (c === '"') {
                    advance();
                    break;
                } else {
                    value += advance();
                }
            }
        } else if (quote === "'") {
            // single-quoted: literal, no escapes, multiline
            advance();
            while (pos < raw.length) {
                if (raw[pos] === "'") {
                    advance();
                    break;
                }
                value += advance();
            }
        } else if (quote === "`") {
            // backtick-quoted: literal, no escapes, multiline
            advance();
            while (pos < raw.length) {
                if (raw[pos] === "`") {
                    advance();
                    break;
                }
                value += advance();
            }
        } else {
            // unquoted: single line, inline comments, trim trailing whitespace
            while (pos < raw.length && raw[pos] !== "\n") {
                if (
                    raw[pos] === "#" &&
                    value.length > 0 &&
                    (raw[pos - 1] === " " || raw[pos - 1] === "\t")
                ) {
                    value = value.trimEnd();
                    break;
                }
                value += raw[pos];
                pos++;
            }
            if (value !== value.trimEnd()) {
                warnings.push({
                    line: entryLine,
                    message: `${key}:L${entryLine}: suspicious trailing whitespace in unquoted value.`,
                });
            }
            value = value.trimEnd();
        }

        // consume rest of line after quoted value
        skipToNewline();

        const quoted = quote === '"' || quote === "'" || quote === "`" ? quote : undefined;
        entries.push({key, value, line: entryLine, ...(quoted && {quoted})});
    }

    return {entries, warnings};
}

function expand(
    value: string,
    resolved: Map<string, string>,
    env: Record<string, string | undefined>
): string {
    return value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
        const name = braced ?? bare;
        return resolved.get(name) ?? env[name] ?? "";
    });
}

// TEST CODE IGNORE
class Foo {}

const k = unwrap(
    loadEnv(
        {files: [".env"], transformKeys: false},
        {
            DATABASE_URL: withRequired(toString),
            PORT: withDefault(toInt, 3000),
            RANGE_VALUES: toIntArray(),
            GOOGLE_ID: toString,
            GOOGLE_MID: toString,
            PROCESS_TEST: toJSON<LoadEnvOpts>(),
            CUSTOM_STUFF_THING: withRequired((k, v) => {
                return success(new Foo());
            }),
        }
    )
);
