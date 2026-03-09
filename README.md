# cl-env

Type-safe, leak-free .env loading for Node.js.

- **Full type inference**
    - return type is derived from your config. Transforms, defaults, key casing, **all reflected at the type level** with minimal effort.
- **No exceptions**
    - every operation returns a `Result<T, E>`. Errors are accumulated, never thrown, unless `unwrap` is called.
- **No `process.env` mutation**
    - returns a plain object. Secrets stay out of child processes.
- **Proper dotenv parser**
    - multiline quoted values, escape sequences, inline comments, variable expansion, BOM stripping, CRLF normalization.
- **Layered files**
    - load `[".env", ".env.local"]` with last-wins semantics.
- **Composable**
    - combine `withRequired`, `withDefault`, built-in transforms, or write your own.

## Install

```
npm i @lindeneg/cl-env
```

## Quick start

```ts
import { loadEnv, toString, toInt, toFloat, toBool, withOptional, withDefault, withRequired } from "@lindeneg/cl-env";

const env = loadEnv(
    {files: [".env"], transformKeys: true},
    {
        DATABASE_URL: withRequired(toString),
        PORT: withDefault(toInt, 3000),
        FLOAT: withOptional(toFloat),
        DEBUG: toBool,
    }
);

// result data typed as: { databaseUrl: string; port: number; float: number | undefined; debug: boolean }
```

Key transformation only applies to fully uppercase keys. Mixed-case keys like `helloThere` are preserved. Trailing digits after underscores are kept: `DATABASE_URL_2` becomes `databaseUrl_2`.

With `transformKeys: false`, keys are preserved as-is: `{ DATABASE_URL: string; PORT: number; FLOAT: number | undefined; DEBUG: boolean; }`, enforced at the type-level and of course in the object itself.

## Result type

`loadEnv` never throws. It returns `Result<T, EnvError[]>`:

```ts
const result = loadEnv(
    { files: [".env"], transformKeys: false },
    {
        PORT: withRequired(toInt),
        API_KEY: withRequired(toString),
    }
);

if (!result.ok) {
    // result.ctx: EnvError[] — structured errors with source, line, key, and message
    // [{ key: "PORT", source: ".env", line: 3, message: "PORT: is required but is missing" }, ...]
    for (const err of result.ctx) {
        console.error(`${err.source}:L${err.line}: ${err.key}: ${err.message}`);
    }
    process.exit(1);
}

// result.data is the fully typed env object
result.data.PORT; // number
```

```ts
type EnvError = {
    key: string;
    line?: number;
    source?: string;
    message: string;
};
```

`unwrap(result)` extracts the data or throws if the result is a failure — use this when you want your program to crash if environment loading fails. It also types correctly of course.

```ts
// env is typed correctly with no result check needed: 
// { databaseUrl: string; port: number; float: number | undefined; debug: boolean }
const env = unwrap(
    loadEnv(
        { files: [".env"], transformKeys: true },
        {
            DATABASE_URL: withRequired(toString),
            PORT: withDefault(toInt, 3000),
            FLOAT: withOptional(toFloat),
            DEBUG: toBool,
        }
    )
);
```

All transforms also return `Result`. The `success(data)` and `failure(ctx)` constructors are exported for writing custom transforms.

## Options

Options are passed inline as the first argument to `loadEnv`:

```ts
loadEnv(
    {
        files: [".env"],                              // files to load, in order
        transformKeys: true,                          // convert UPPER_SNAKE_CASE to camelCase
        basePath: ".",                                // prepended to each file path
        encoding: "utf8",                             // default: "utf8"
        includeProcessEnv: "fallback",                // merge process.env (see below)
        logger: true,                                 // logging (see below)
        schemaParser: myParser,                       // for toJSON schema validation
        radix: (key) => key === "HEX" ? 16 : undefined, // per-key radix for toInt
    },
    config
);
```

Only `files` and `transformKeys` are required. The options type is not exported — pass options inline so TypeScript can infer the literal type of `transformKeys` and produce the correct key casing in the result.

## Transform context

Every transform receives a `TransformContext` as its third argument:

```ts
type TransformContext = {
    rawEnv: Record<string, string>;   // resolved string values from files/expansion, before transforms
    schemaParser?: SchemaParser;      // from options
    radix?: (key: string) => number | undefined;  // from options
    log?: Logger;                     // from options
    line?: number;                    // line number where the key was defined
    source?: string;                  // file path, "process.env", or "none"
};
```

`line` and `source` are set per-key and are useful for custom transforms that want to produce rich error messages.

## Transforms

Each config value is a transform function: `(key, value, ctx) => Result<T>`. `value` is `string | undefined` — `undefined` means the key was not found in any file. The return type determines the type of that key in the result.

### Built-in transforms

| Transform | Output | Description |
|---|---|---|
| `toString` | `string` | Returns value as-is |
| `toInt` | `number` | Parses integer via `parseInt` (respects `radix` option). Note: `parseInt` ignores trailing non-numeric characters (e.g. `'42abc'` parses as `42`). Use a custom transform if you need strict validation. |
| `toFloat` | `number` | Parses float |
| `toBool` | `boolean` | Strict: `true/TRUE/True/1` → `true`, `false/FALSE/False/0` → `false`, anything else fails |
| `toJSON<T>(schema?)` | `T` | Parses JSON, optionally validates with schema parser |
| `toStringArray(delimiter?)` | `string[]` | Splits by delimiter (default `,`), trims elements |
| `toIntArray(delimiter?)` | `number[]` | Splits and parses each element as integer |
| `toFloatArray(delimiter?)` | `number[]` | Splits and parses each element as float |
| `toEnum(...values)` | union of `values` | Succeeds if value is one of the provided strings (case-sensitive), fails otherwise |

### Wrappers

| Wrapper | Description |
|---|---|
| `withRequired(transform)` | Fails if key is missing (`undefined`) — empty values pass through to the transform |
| `withDefault(transform, defaultValue)` | Uses `defaultValue` when key is missing (`undefined`) — empty values pass through to the transform |
| `withOptional(transform)` | Returns `undefined` when key is missing, otherwise delegates to the inner transform |

Without a wrapper, a missing key passes `undefined` to the transform. All built-in transforms fail on `undefined` with a message suggesting `withDefault` or `withRequired`.

### Custom transforms

```ts
import { loadEnv, unwrap, success, failure } from "@lindeneg/cl-env";

const env = unwrap(
    loadEnv(
        { files: [".env"], transformKeys: false },
        {
            CREATED: (key, v) => {
                if (v === undefined) return failure(`${key}: no value provided`);
                const d = new Date(v);
                if (isNaN(d.getTime())) return failure(`${key}: invalid date '${v}'`);
                return success(d);
            },
        }
    )
);
// env: { CREATED: Date }
```

TypeScript infers the return type from your `success(...)` calls, so explicit type annotations on custom transforms are not needed but available if desired.

## Layered files

```ts
const env = unwrap(
    loadEnv(
        { files: [".env", ".env.local"], transformKeys: false, basePath: "." },
        { PORT: toInt, SECRET: withRequired(toString) }
    )
);
```

Files are loaded in order. Duplicate keys use last-wins semantics.

## Variable expansion

Values can reference other variables using `$VAR` or `${VAR}`:

```ini
HOST=localhost
PORT=3000
URL=http://${HOST}:$PORT
```

Expansion runs after deduplication (last-wins) and processes keys in order. A reference resolves against keys that have already been expanded, then falls back to `process.env`. Forward references (to keys not yet expanded) are left unresolved. Unresolved references are left unchanged (e.g. `$MISSING` stays as `$MISSING`). Single-quoted values are **not** expanded (they're literal).

## Process env merge

```ts
// Fallback: process.env fills in keys missing from files
loadEnv({ files: [".env"], transformKeys: false, includeProcessEnv: "fallback" }, config);

// Override: process.env wins over file values
loadEnv({ files: [".env"], transformKeys: false, includeProcessEnv: "override" }, config);
```

Only keys defined in your config are read from `process.env` — it doesn't pull in arbitrary env vars.

## Schema validation

`toJSON` accepts an optional schema argument. Pass a `schemaParser` in options to validate:

```ts
import { loadEnv, unwrap, toJSON, success, failure, type SchemaParser } from "@lindeneg/cl-env";

const parser: SchemaParser = (obj, schema, key) => {
    const result = schema.safeParse(obj);
    if (result.success) return success(result.data);
    return failure(`${key}: ${result.error.message}`);
};

const env = unwrap(
    loadEnv(
        { files: [".env"], transformKeys: false, schemaParser: parser },
        { DB_CONFIG: toJSON<DbConfig>(dbConfigSchema) }
    )
);
```

If a schema is passed to `toJSON` but no `schemaParser` is set, it fails with an error.

## Logging

```ts
// Use the built-in logger
loadEnv({ files: [".env"], transformKeys: false, logger: true }, config);

// Or provide your own
loadEnv({
    files: [".env"],
    transformKeys: false,
    logger: (level, message) => { /* level: "error" | "warn" | "debug" | "verbose" */ },
}, config);
```

The logger reports: duplicate keys, unknown keys, suspicious whitespace, variable expansion, process.env merges, default value usage, and a final summary.

## Parsing rules

- Full dotenv-compatible parser (character-by-character state machine)
- `#` lines are comments. Inline `#` preceded by whitespace is a comment in unquoted values.
- `export KEY=value` is supported (prefix stripped)
- Double-quoted values: escape sequences (`\n`, `\r`, `\t`, `\\`, `\"`), multiline
- Single-quoted and backtick-quoted values: literal (no escapes), multiline
- Unquoted values: single line, trailing whitespace trimmed
- BOM (`\uFEFF`) stripped, `\r\n` and `\r` normalized to `\n`
- Line numbers tracked and included in error messages (`file:L32: KEY: error`)
- Unterminated quotes are detected and logged as a warning. The parser continues with best-effort parsing — the unterminated value consumes all content to EOF, so subsequent entries in the same file will be missing. These missing keys will surface as transform errors if they use `withRequired`.
- Invalid key names (not matching `[A-Za-z_][A-Za-z0-9_]*`) produce a warning

## License

MIT
