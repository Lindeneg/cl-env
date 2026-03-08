import {writeFileSync, mkdirSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";

import {describe, it, expect, afterAll, beforeAll, vi} from "vitest";
import {Expect, Equal} from "type-testing";
import {
    loadEnv,
    unwrap,
    toString,
    toInt,
    toFloat,
    toBool,
    toJSON,
    toStringArray,
    toIntArray,
    withDefault,
    withRequired,
    withOptional,
    success,
    failure,
    type Logger,
    type LogLevel,
    type SchemaParser,
    type TransformContext,
    type Result,
} from "./index.js";

const fixtures = join(import.meta.dirname, "fixtures");
const fixture = (...names: string[]) => join(fixtures, ...names);
const opts = (files: string[], extra: Partial<Parameters<typeof loadEnv>[0]> = {}) =>
    ({files, transformKeys: false, basePath: fixtures, ...extra}) as const;

// minimal ctx for direct transform unit tests
const ctx: TransformContext = {rawEnv: {}};

// ─── transforms (unit) ──────────────────────────────────────────────────────

describe("transforms", () => {
    describe("toString", () => {
        it("returns value as-is", () => {
            expect(toString("K", "hello")).toEqual({ok: true, data: "hello"});
        });

        it("returns empty string for empty value", () => {
            expect(toString("K", "")).toEqual({ok: true, data: ""});
        });

        it("fails on undefined", () => {
            const result = toString("K", undefined);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.ctx).toContain("no value provided");
        });
    });

    describe("toBool", () => {
        it.each([
            ["true", true],
            ["TRUE", true],
            ["True", true],
            ["1", true],
            ["false", false],
            ["FALSE", false],
            ["False", false],
            ["0", false],
        ] as const)("parses '%s' as %s", (input, expected) => {
            expect(toBool("K", input)).toEqual({ok: true, data: expected});
        });

        it.each(["yes", "no", "on", "off", "2", ""])("rejects '%s'", (input) => {
            const result = toBool("K", input);
            expect(result.ok).toBe(false);
        });

        it("includes key and value in error message", () => {
            expect(toBool("DEBUG", "nope")).toEqual({
                ok: false,
                ctx: "DEBUG: expected boolean, got 'nope'",
            });
        });

        it("fails on undefined", () => {
            const result = toBool("K", undefined);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.ctx).toContain("no value provided");
        });
    });

    describe("toInt", () => {
        it("parses valid integer", () => {
            expect(toInt("K", "42", ctx)).toEqual({ok: true, data: 42});
        });

        it("parses negative integer", () => {
            expect(toInt("K", "-7", ctx)).toEqual({ok: true, data: -7});
        });

        it("fails on non-numeric", () => {
            expect(toInt("PORT", "abc", ctx)).toEqual({
                ok: false,
                ctx: "PORT: failed to convert 'abc' to a number",
            });
        });

        it("fails on empty string", () => {
            expect(toInt("K", "", ctx)).toEqual({
                ok: false,
                ctx: "K: failed to convert '' to a number",
            });
        });

        it("respects radix from context", () => {
            const hexCtx: TransformContext = {rawEnv: {}, radix: () => 16};
            expect(toInt("K", "ff", hexCtx)).toEqual({ok: true, data: 255});
        });

        it("radix can be per-key", () => {
            const mixedCtx: TransformContext = {
                rawEnv: {},
                radix: (key: string) => (key === "HEX" ? 16 : undefined),
            };
            expect(toInt("HEX", "a", mixedCtx)).toEqual({ok: true, data: 10});
            expect(toInt("DEC", "10", mixedCtx)).toEqual({ok: true, data: 10});
        });

        it("fails on undefined", () => {
            const result = toInt("K", undefined, ctx);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.ctx).toContain("no value provided");
        });
    });

    describe("toFloat", () => {
        it("parses valid float", () => {
            expect(toFloat("K", "3.14", ctx)).toEqual({ok: true, data: 3.14});
        });

        it("parses negative float", () => {
            expect(toFloat("K", "-0.5", ctx)).toEqual({ok: true, data: -0.5});
        });

        it("parses integer as float", () => {
            expect(toFloat("K", "42", ctx)).toEqual({ok: true, data: 42});
        });

        it("fails on non-numeric", () => {
            expect(toFloat("RATE", "abc", ctx)).toEqual({
                ok: false,
                ctx: "RATE: failed to convert 'abc' to a number",
            });
        });

        it("fails on undefined", () => {
            const result = toFloat("K", undefined, ctx);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.ctx).toContain("no value provided");
        });
    });

    describe("toStringArray", () => {
        it("splits by comma by default", () => {
            expect(toStringArray()("K", "a,b,c")).toEqual({ok: true, data: ["a", "b", "c"]});
        });

        it("trims whitespace from elements", () => {
            expect(toStringArray()("K", "a , b , c")).toEqual({ok: true, data: ["a", "b", "c"]});
        });

        it("supports custom delimiter", () => {
            expect(toStringArray("|")("K", "x|y|z")).toEqual({ok: true, data: ["x", "y", "z"]});
        });

        it("returns single-element array for no delimiter match", () => {
            expect(toStringArray()("K", "single")).toEqual({ok: true, data: ["single"]});
        });

        it("fails on undefined", () => {
            const result = toStringArray()("K", undefined);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.ctx).toContain("no value provided");
        });
    });

    describe("toIntArray", () => {
        it("splits and parses integers", () => {
            expect(toIntArray()("K", "1,2,3", ctx)).toEqual({ok: true, data: [1, 2, 3]});
        });

        it("trims whitespace from elements", () => {
            expect(toIntArray()("K", "1 , 2 , 3", ctx)).toEqual({ok: true, data: [1, 2, 3]});
        });

        it("supports custom delimiter", () => {
            expect(toIntArray("-")("K", "3-1-4", ctx)).toEqual({ok: true, data: [3, 1, 4]});
        });

        it("fails if any element is not a number", () => {
            const result = toIntArray()("NUMS", "1,abc,3", ctx);
            expect(result.ok).toBe(false);
        });

        it("fails on undefined", () => {
            const result = toIntArray()("K", undefined, ctx);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.ctx).toContain("no value provided");
        });
    });

    describe("toJSON", () => {
        it("parses valid JSON", () => {
            expect(toJSON<{id: number}>()("K", '{"id":1}', ctx)).toEqual({
                ok: true,
                data: {id: 1},
            });
        });

        it("fails on invalid JSON", () => {
            expect(toJSON()("CFG", "not json", ctx)).toEqual({
                ok: false,
                ctx: "CFG: failed to convert to JSON",
            });
        });

        it("calls schemaParser when schema provided", () => {
            const schema = {type: "object"};
            const parser: SchemaParser = (obj, s, _k) => {
                if (s === schema) return success(obj);
                return failure("wrong schema");
            };
            const ctxWithParser: TransformContext = {rawEnv: {}, schemaParser: parser};
            expect(toJSON<{a: number}>(schema)("K", '{"a":1}', ctxWithParser)).toEqual({
                ok: true,
                data: {a: 1},
            });
        });

        it("fails when schema provided but no parser set", () => {
            expect(toJSON({})("K", '{"a":1}', ctx)).toEqual({
                ok: false,
                ctx: "K: schema provided but no schemaParser is set. Please use 'schemaParser' in options.",
            });
        });

        it("does not call parser when no schema provided", () => {
            let called = false;
            const ctxWithParser: TransformContext = {
                rawEnv: {},
                schemaParser: () => {
                    called = true;
                    return success({});
                },
            };
            toJSON<{a: number}>()("K", '{"a":1}', ctxWithParser);
            expect(called).toBe(false);
        });

        it("fails on undefined", () => {
            const result = toJSON()("K", undefined, ctx);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.ctx).toContain("no value provided");
        });
    });
});

// ─── parser (integration) ───────────────────────────────────────────────────

describe("parser", () => {
    describe("basic key=value", () => {
        it("reads and parses a simple .env file", () => {
            const result = loadEnv(opts([".env.basic"]), {
                HOST: toString,
                PORT: toInt,
                DEBUG: toBool,
                APP_NAME: toString,
            });
            expect(result).toEqual({
                ok: true,
                data: {HOST: "localhost", PORT: 3000, DEBUG: true, APP_NAME: "my-app"},
            });
        });

        it("ignores keys not present in config", () => {
            const result = loadEnv(opts([".env.basic"]), {HOST: toString});
            expect(result).toEqual({ok: true, data: {HOST: "localhost"}});
        });
    });

    describe("empty and special values", () => {
        it("handles empty values (KEY=)", () => {
            const result = loadEnv(opts([".env.empty-value"]), {EMPTY_KEY: toString});
            expect(result).toEqual({ok: true, data: {EMPTY_KEY: ""}});
        });

        it("empty value is not undefined — transforms receive empty string", () => {
            const result = loadEnv(opts([".env.empty-value"]), {EMPTY_KEY: toBool});
            expect(result.ok).toBe(false);
            if (!result.ok) {
                // should fail with "expected boolean" not "no value provided"
                expect(result.ctx[0]).toContain("expected boolean");
            }
        });

        it("handles values containing equals signs", () => {
            const result = loadEnv(opts([".env.messy"]), {EXTRA_EQUALS: toString});
            expect(result).toEqual({ok: true, data: {EXTRA_EQUALS: "a=b=c"}});
        });

        it("handles URLs with equals in query params", () => {
            const result = loadEnv(opts([".env.complex"]), {DATABASE_URL: toString});
            expect(result).toEqual({
                ok: true,
                data: {DATABASE_URL: "postgres://user:pass@localhost:5432/mydb?sslmode=require"},
            });
        });
    });

    describe("whitespace handling", () => {
        it("trims whitespace from keys and values", () => {
            const result = loadEnv(opts([".env.messy"]), {SPACED: toString});
            expect(result).toEqual({ok: true, data: {SPACED: "hello"}});
        });

        it("skips empty lines and lines without =", () => {
            const result = loadEnv(opts([".env.messy"]), {
                SPACED: toString,
                ANOTHER: toString,
            });
            expect(result).toEqual({
                ok: true,
                data: {SPACED: "hello", ANOTHER: "value"},
            });
        });
    });

    describe("comments", () => {
        it("skips lines starting with #", () => {
            const result = loadEnv(opts([".env.comments"]), {
                HOST: toString,
                PORT: toInt,
                DEBUG: toBool,
            });
            expect(result).toEqual({
                ok: true,
                data: {HOST: "localhost", PORT: 3000, DEBUG: true},
            });
        });

        it("skips indented comments", () => {
            const result = loadEnv(opts([".env.comments"]), {HOST: toString, DEBUG: toBool});
            expect(result).toEqual({ok: true, data: {HOST: "localhost", DEBUG: true}});
        });

        it("commented-out key is treated as missing", () => {
            const result = loadEnv(opts([".env.comments"]), {KEY: withRequired(toString)});
            expect(result).toEqual({ok: false, ctx: ["KEY: is required but is missing"]});
        });
    });

    describe("inline comments", () => {
        it("strips inline comments preceded by whitespace", () => {
            const result = loadEnv(opts([".env.inline-comments"]), {BARE: toString});
            expect(result).toEqual({ok: true, data: {BARE: "value"}});
        });

        it("does not treat # without preceding space as comment", () => {
            const result = loadEnv(opts([".env.inline-comments"]), {NO_SPACE: toString});
            expect(result).toEqual({ok: true, data: {NO_SPACE: "value#not-a-comment"}});
        });

        it("preserves # inside double quotes", () => {
            const result = loadEnv(opts([".env.inline-comments"]), {QUOTED_DOUBLE: toString});
            expect(result).toEqual({ok: true, data: {QUOTED_DOUBLE: "has # inside"}});
        });

        it("preserves # inside single quotes", () => {
            const result = loadEnv(opts([".env.inline-comments"]), {QUOTED_SINGLE: toString});
            expect(result).toEqual({ok: true, data: {QUOTED_SINGLE: "has # inside"}});
        });

        it("value starting with # is not treated as comment", () => {
            const result = loadEnv(opts([".env.inline-comments"]), {HASH_START: toString});
            expect(result).toEqual({ok: true, data: {HASH_START: "#not-a-comment"}});
        });
    });

    describe("export stripping", () => {
        it("strips export prefix from lines", () => {
            const result = loadEnv(opts([".env.export"]), {
                HOST: toString,
                PORT: toInt,
                API_KEY: toString,
            });
            expect(result).toEqual({
                ok: true,
                data: {HOST: "localhost", PORT: 3000, API_KEY: "secret123"},
            });
        });

        it("mixes export and non-export lines", () => {
            const result = loadEnv(opts([".env.export"]), {HOST: toString, DEBUG: toBool});
            expect(result).toEqual({ok: true, data: {HOST: "localhost", DEBUG: true}});
        });

        it("does not strip 'export' without trailing space", () => {
            const result = loadEnv(opts([".env.export"]), {FOO: withRequired(toString)});
            expect(result).toEqual({ok: false, ctx: ["FOO: is required but is missing"]});
        });
    });

    describe("quote handling", () => {
        it("strips surrounding double quotes", () => {
            const result = loadEnv(opts([".env.quotes"]), {DOUBLE: toString});
            expect(result).toEqual({ok: true, data: {DOUBLE: "hello world"}});
        });

        it("strips surrounding single quotes", () => {
            const result = loadEnv(opts([".env.quotes"]), {SINGLE: toString});
            expect(result).toEqual({ok: true, data: {SINGLE: "hello world"}});
        });

        it("strips surrounding backticks", () => {
            const result = loadEnv(opts([".env.quotes"]), {BACKTICK: toString});
            expect(result).toEqual({ok: true, data: {BACKTICK: "hello world"}});
        });

        it("unclosed double quote reads to EOF (mismatched quotes)", () => {
            const result = loadEnv(opts([".env.quotes"]), {MISMATCH: toString});
            // MISMATCH="hello world' — no closing ", parser consumes to EOF including trailing newline
            expect(result).toEqual({ok: true, data: {MISMATCH: "hello world'\n"}});
        });

        it("quotes are stripped before transform runs", () => {
            const result = loadEnv(opts([".env.basic"]), {
                PORT: toInt,
                DEBUG: toBool,
            });
            expect(result).toEqual({ok: true, data: {PORT: 3000, DEBUG: true}});
        });
    });

    describe("escape sequences", () => {
        it("expands \\n in double-quoted values", () => {
            const result = loadEnv(opts([".env.escapes"]), {NEWLINE: toString});
            expect(result).toEqual({ok: true, data: {NEWLINE: "hello\nworld"}});
        });

        it("expands \\t in double-quoted values", () => {
            const result = loadEnv(opts([".env.escapes"]), {TAB: toString});
            expect(result).toEqual({ok: true, data: {TAB: "hello\tworld"}});
        });

        it("expands \\r in double-quoted values", () => {
            const result = loadEnv(opts([".env.escapes"]), {CARRIAGE: toString});
            expect(result).toEqual({ok: true, data: {CARRIAGE: "hello\rworld"}});
        });

        it("expands \\\\ to single backslash in double-quoted values", () => {
            const result = loadEnv(opts([".env.escapes"]), {BACKSLASH: toString});
            expect(result).toEqual({ok: true, data: {BACKSLASH: "hello\\world"}});
        });

        it("expands escaped quotes in double-quoted values", () => {
            const result = loadEnv(opts([".env.escapes"]), {ESCAPED_QUOTE: toString});
            expect(result).toEqual({ok: true, data: {ESCAPED_QUOTE: 'say "hello"'}});
        });

        it("does NOT expand escapes in single-quoted values", () => {
            const result = loadEnv(opts([".env.escapes"]), {SINGLE_LITERAL: toString});
            expect(result).toEqual({ok: true, data: {SINGLE_LITERAL: "hello\\nworld"}});
        });

        it("does NOT expand escapes in backtick-quoted values", () => {
            const result = loadEnv(opts([".env.escapes"]), {BACKTICK_LITERAL: toString});
            expect(result).toEqual({ok: true, data: {BACKTICK_LITERAL: "hello\\nworld"}});
        });
    });

    describe("multiline values", () => {
        it("supports multiline in double quotes", () => {
            const result = loadEnv(opts([".env.multiline"]), {MULTI_DOUBLE: toString});
            expect(result).toEqual({ok: true, data: {MULTI_DOUBLE: "line1\nline2\nline3"}});
        });

        it("supports multiline in single quotes", () => {
            const result = loadEnv(opts([".env.multiline"]), {MULTI_SINGLE: toString});
            expect(result).toEqual({ok: true, data: {MULTI_SINGLE: "line1\nline2\nline3"}});
        });

        it("supports multiline in backticks", () => {
            const result = loadEnv(opts([".env.multiline"]), {MULTI_BACKTICK: toString});
            expect(result).toEqual({ok: true, data: {MULTI_BACKTICK: "line1\nline2\nline3"}});
        });

        it("parses entries after multiline values correctly", () => {
            const result = loadEnv(opts([".env.multiline"]), {
                MULTI_DOUBLE: toString,
                AFTER: toString,
            });
            expect(result).toEqual({
                ok: true,
                data: {MULTI_DOUBLE: "line1\nline2\nline3", AFTER: "still works"},
            });
        });
    });

    describe("BOM handling", () => {
        const tmpDir = join(tmpdir(), "cl-env-test-bom");

        beforeAll(() => {
            mkdirSync(tmpDir, {recursive: true});
            writeFileSync(join(tmpDir, ".env.bom"), "\uFEFFHOST=localhost\nPORT=3000\n", "utf8");
        });

        afterAll(() => {
            rmSync(tmpDir, {recursive: true, force: true});
        });

        it("strips BOM and parses correctly", () => {
            const result = loadEnv(
                {files: [".env.bom"], transformKeys: false, basePath: tmpDir},
                {HOST: toString, PORT: toInt}
            );
            expect(result).toEqual({ok: true, data: {HOST: "localhost", PORT: 3000}});
        });
    });

    describe("CRLF normalization", () => {
        const tmpDir = join(tmpdir(), "cl-env-test-crlf");

        beforeAll(() => {
            mkdirSync(tmpDir, {recursive: true});
            writeFileSync(join(tmpDir, ".env.crlf"), "FOO=bar\r\nBAR=baz\r\n", "utf8");
            writeFileSync(join(tmpDir, ".env.cr"), "FOO=bar\rBAR=baz\r", "utf8");
        });

        afterAll(() => {
            rmSync(tmpDir, {recursive: true, force: true});
        });

        it("handles CRLF line endings", () => {
            const result = loadEnv(
                {files: [".env.crlf"], transformKeys: false, basePath: tmpDir},
                {FOO: toString, BAR: toString}
            );
            expect(result).toEqual({ok: true, data: {FOO: "bar", BAR: "baz"}});
        });

        it("handles bare CR line endings", () => {
            const result = loadEnv(
                {files: [".env.cr"], transformKeys: false, basePath: tmpDir},
                {FOO: toString, BAR: toString}
            );
            expect(result).toEqual({ok: true, data: {FOO: "bar", BAR: "baz"}});
        });
    });

    describe("parser warnings", () => {
        it("errors on unterminated double quote with lines consumed", () => {
            const messages: Array<{level: LogLevel; message: string}> = [];
            const logger: Logger = (level, message) => messages.push({level, message});

            loadEnv(
                opts([".env.unterminated-double"], {logger}),
                {GOOD: toString, BAD_DOUBLE: toString}
            );

            const err = messages.find(
                (m) => m.level === "error" && m.message.includes("unterminated double quote")
            );
            expect(err).toBeDefined();
            expect(err!.message).toContain("consumed");
            expect(err!.message).toContain("to EOF");
        });

        it("errors on unterminated single quote with lines consumed", () => {
            const messages: Array<{level: LogLevel; message: string}> = [];
            const logger: Logger = (level, message) => messages.push({level, message});

            loadEnv(
                opts([".env.unterminated-single"], {logger}),
                {GOOD: toString, BAD_SINGLE: toString}
            );

            const err = messages.find(
                (m) => m.level === "error" && m.message.includes("unterminated single quote")
            );
            expect(err).toBeDefined();
            expect(err!.message).toContain("consumed");
        });

        it("errors on unterminated backtick quote with lines consumed", () => {
            const messages: Array<{level: LogLevel; message: string}> = [];
            const logger: Logger = (level, message) => messages.push({level, message});

            loadEnv(
                opts([".env.unterminated-backtick"], {logger}),
                {GOOD: toString, BAD_BACKTICK: toString}
            );

            const err = messages.find(
                (m) => m.level === "error" && m.message.includes("unterminated backtick quote")
            );
            expect(err).toBeDefined();
            expect(err!.message).toContain("consumed");
        });

        it("unterminated quote consumes all subsequent entries to EOF", () => {
            const messages: Array<{level: LogLevel; message: string}> = [];
            const logger: Logger = (level, message) => messages.push({level, message});

            const result = loadEnv(
                opts([".env.unterminated-combined"], {logger}),
                {
                    GOOD: toString,
                    BAD: toString,
                    AFTER_BAD: withOptional(toString),
                    LAST: withOptional(toString),
                }
            );

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.data.GOOD).toBe("hello");
                // BAD consumes everything after the opening " to EOF
                expect(result.data.BAD).toContain("unclosed double");
                expect(result.data.BAD).toContain("AFTER_BAD");
                // AFTER_BAD and LAST are never parsed as entries — they're inside BAD's value
                expect(result.data.AFTER_BAD).toBeUndefined();
                expect(result.data.LAST).toBeUndefined();
            }

            // error log should report lines consumed
            const err = messages.find((m) => m.level === "error" && m.message.includes("unterminated"));
            expect(err).toBeDefined();
            expect(err!.message).toMatch(/consumed \d+ line/);
        });

        it("warns on invalid key names", () => {
            const messages: Array<{level: LogLevel; message: string}> = [];
            const logger: Logger = (level, message) => messages.push({level, message});

            loadEnv(opts([".env.invalid-keys"], {logger}), {
                VALID_KEY: toString,
                "123ABC": toString,
                "API-KEY": toString,
                "API.KEY": toString,
                _UNDERSCORE: toString,
            });

            const invalidWarnings = messages.filter(
                (m) => m.level === "warn" && m.message.includes("invalid key name")
            );
            // 123ABC, API-KEY, API.KEY should warn; VALID_KEY and _UNDERSCORE should not
            expect(invalidWarnings.length).toBe(3);
        });

        it("does not warn on valid key names", () => {
            const messages: Array<{level: LogLevel; message: string}> = [];
            const logger: Logger = (level, message) => messages.push({level, message});

            loadEnv(opts([".env.basic"], {logger}), {HOST: toString});

            const invalidWarnings = messages.filter(
                (m) => m.level === "warn" && m.message.includes("invalid key name")
            );
            expect(invalidWarnings.length).toBe(0);
        });

        it("warning/error format follows src:L{line}: key: message convention", () => {
            const messages: Array<{level: LogLevel; message: string}> = [];
            const logger: Logger = (level, message) => messages.push({level, message});

            loadEnv(opts([".env.unterminated-double"], {logger}), {BAD_DOUBLE: toString});

            const err = messages.find(
                (m) => m.level === "error" && m.message.includes("unterminated double quote")
            );
            expect(err).toBeDefined();
            expect(err!.message).toMatch(/^\.env\.unterminated-double:L\d+: BAD_DOUBLE:/);
        });
    });
});

// ─── wrappers ───────────────────────────────────────────────────────────────

describe("wrappers", () => {
    describe("withRequired", () => {
        it("succeeds when key exists in file", () => {
            const result = loadEnv(opts([".env.missing"]), {PRESENT: withRequired(toString)});
            expect(result).toEqual({ok: true, data: {PRESENT: "here"}});
        });

        it("fails when key is missing from file", () => {
            const result = loadEnv(opts([".env.missing"]), {ABSENT: withRequired(toString)});
            expect(result).toEqual({ok: false, ctx: ["ABSENT: is required but is missing"]});
        });

        it("passes empty string through to inner transform (KEY= is not missing)", () => {
            const result = loadEnv(opts([".env.empty-value"]), {
                EMPTY_KEY: withRequired(toString),
            });
            expect(result).toEqual({ok: true, data: {EMPTY_KEY: ""}});
        });

        it("passes through to inner transform when value is present", () => {
            const result = loadEnv(opts([".env.basic"]), {PORT: withRequired(toInt)});
            expect(result).toEqual({ok: true, data: {PORT: 3000}});
        });
    });

    describe("withDefault", () => {
        it("returns default when key is missing from file", () => {
            const result = loadEnv(opts([".env.missing"]), {ABSENT: withDefault(toInt, 9999)});
            expect(result).toEqual({ok: true, data: {ABSENT: 9999}});
        });

        it("passes empty string through — does NOT use default for KEY=", () => {
            const result = loadEnv(opts([".env.empty-value"]), {
                EMPTY_KEY: withDefault(toString, "fallback"),
            });
            expect(result).toEqual({ok: true, data: {EMPTY_KEY: ""}});
        });

        it("uses file value when key exists", () => {
            const result = loadEnv(opts([".env.basic"]), {PORT: withDefault(toInt, 9999)});
            expect(result).toEqual({ok: true, data: {PORT: 3000}});
        });

        it("applies transformKeys to default values for missing keys", () => {
            const result = loadEnv(
                {files: [".env.missing"], transformKeys: true, basePath: fixtures},
                {MY_PORT: withDefault(toInt, 3000)}
            );
            expect(result).toEqual({ok: true, data: {myPort: 3000}});
        });
    });

    describe("withOptional", () => {
        it("returns undefined when key is missing from file", () => {
            const result = loadEnv(opts([".env.missing"]), {
                ABSENT: withOptional(toString),
            });
            expect(result).toEqual({ok: true, data: {ABSENT: undefined}});
        });

        it("delegates to inner transform when value is present", () => {
            const result = loadEnv(opts([".env.basic"]), {PORT: withOptional(toInt)});
            expect(result).toEqual({ok: true, data: {PORT: 3000}});
        });

        it("passes empty string through — does NOT return undefined for KEY=", () => {
            const result = loadEnv(opts([".env.empty-value"]), {
                EMPTY_KEY: withOptional(toString),
            });
            expect(result).toEqual({ok: true, data: {EMPTY_KEY: ""}});
        });

        it("inner transform error propagates", () => {
            const result = loadEnv(opts([".env.basic"]), {
                HOST: withOptional(toInt),
            });
            expect(result.ok).toBe(false);
        });
    });

    describe("bare transform for missing key", () => {
        it("bare toString fails with 'no value provided' for missing key", () => {
            const result = loadEnv(opts([".env.missing"]), {FOO: toString});
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.ctx[0]).toContain("no value provided");
        });

        it("bare toInt fails with 'no value provided' for missing key", () => {
            const result = loadEnv(opts([".env.missing"]), {FOO: toInt});
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.ctx[0]).toContain("no value provided");
        });
    });
});

// ─── undefined vs empty string semantics ────────────────────────────────────

describe("undefined vs empty string", () => {
    it("missing key → undefined to transform", () => {
        const result = loadEnv(opts([".env.missing"]), {ABSENT: toString});
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.ctx[0]).toContain("no value provided");
    });

    it("present empty KEY= → empty string to transform", () => {
        const result = loadEnv(opts([".env.empty-value"]), {EMPTY_KEY: toString});
        expect(result).toEqual({ok: true, data: {EMPTY_KEY: ""}});
    });

    it("withRequired fails on missing, succeeds on empty", () => {
        const missing = loadEnv(opts([".env.missing"]), {ABSENT: withRequired(toString)});
        expect(missing.ok).toBe(false);

        const empty = loadEnv(opts([".env.empty-value"]), {EMPTY_KEY: withRequired(toString)});
        expect(empty).toEqual({ok: true, data: {EMPTY_KEY: ""}});
    });

    it("withDefault substitutes on missing, passes through empty", () => {
        const missing = loadEnv(opts([".env.missing"]), {
            ABSENT: withDefault(toString, "fallback"),
        });
        expect(missing).toEqual({ok: true, data: {ABSENT: "fallback"}});

        const empty = loadEnv(opts([".env.empty-value"]), {
            EMPTY_KEY: withDefault(toString, "fallback"),
        });
        expect(empty).toEqual({ok: true, data: {EMPTY_KEY: ""}});
    });

    it("withOptional returns undefined on missing, passes through empty", () => {
        const missing = loadEnv(opts([".env.missing"]), {
            ABSENT: withOptional(toString),
        });
        expect(missing).toEqual({ok: true, data: {ABSENT: undefined}});

        const empty = loadEnv(opts([".env.empty-value"]), {
            EMPTY_KEY: withOptional(toString),
        });
        expect(empty).toEqual({ok: true, data: {EMPTY_KEY: ""}});
    });
});

// ─── features ───────────────────────────────────────────────────────────────

describe("features", () => {
    describe("transformKeys", () => {
        it("converts UPPER_SNAKE_CASE to camelCase", () => {
            const result = loadEnv(
                {files: [".env.basic"], transformKeys: true, basePath: fixtures},
                {HOST: toString, PORT: toInt, APP_NAME: toString}
            );
            expect(result).toEqual({
                ok: true,
                data: {host: "localhost", port: 3000, appName: "my-app"},
            });
        });

        it("leaves mixed-case keys untouched", () => {
            const result = loadEnv(
                {files: [".env.transformkeys"], transformKeys: true, basePath: fixtures},
                {FOO_BAR: toString, helloThere: toString, blah: toString}
            );
            expect(result).toEqual({
                ok: true,
                data: {fooBar: "1", helloThere: "2", blah: "3"},
            });
        });

        it("does not transform keys when transformKeys is false", () => {
            const result = loadEnv(opts([".env.basic"]), {APP_NAME: toString});
            expect(result).toEqual({ok: true, data: {APP_NAME: "my-app"}});
        });

        it("works with export prefix", () => {
            const result = loadEnv(
                {files: [".env.export"], transformKeys: true, basePath: fixtures},
                {API_KEY: withRequired(toString), PORT: toInt}
            );
            expect(result).toEqual({ok: true, data: {apiKey: "secret123", port: 3000}});
        });
    });

    describe("layered files", () => {
        it("loads multiple files and merges (last-wins)", () => {
            const result = loadEnv(
                {
                    files: [".env.layered.base", ".env.layered.local"],
                    transformKeys: false,
                    basePath: fixtures,
                },
                {HOST: toString, PORT: toInt, DEBUG: toBool, SECRET: toString}
            );
            expect(result).toEqual({
                ok: true,
                data: {HOST: "localhost", PORT: 8080, DEBUG: true, SECRET: "mysecret"},
            });
        });

        it("base values used when not overridden", () => {
            const result = loadEnv(
                {
                    files: [".env.layered.base", ".env.layered.local"],
                    transformKeys: false,
                    basePath: fixtures,
                },
                {HOST: toString}
            );
            expect(result).toEqual({ok: true, data: {HOST: "localhost"}});
        });
    });

    describe("duplicate keys", () => {
        it("last value wins", () => {
            const result = loadEnv(opts([".env.duplicate"]), {
                KEY: toString,
                OTHER: toString,
            });
            expect(result).toEqual({ok: true, data: {KEY: "second", OTHER: "only"}});
        });
    });

    describe("variable expansion", () => {
        it("expands ${VAR} references", () => {
            const result = loadEnv(opts([".env.expansion"]), {
                HOST: toString,
                PORT: toString,
                URL: toString,
            });
            expect(result).toEqual({
                ok: true,
                data: {HOST: "localhost", PORT: "3000", URL: "http://localhost:3000"},
            });
        });

        it("expands $VAR references (bare)", () => {
            const result = loadEnv(opts([".env.expansion"]), {
                HOST: toString,
                PORT: toString,
                URL: toString,
            });
            if (result.ok) {
                // URL uses both ${HOST} and $PORT
                expect(result.data.URL).toBe("http://localhost:3000");
            }
        });

        it("does NOT expand variables in single-quoted values", () => {
            const result = loadEnv(opts([".env.expansion"]), {
                HOST: toString,
                PORT: toString,
                SINGLE_QUOTED: toString,
            });
            if (result.ok) {
                expect(result.data.SINGLE_QUOTED).toBe("$HOST:${PORT}");
            }
        });

        it("leaves unresolved references unchanged (not empty string)", () => {
            // ensure CLENV_UNDEFINED_VAR is not in process.env
            delete process.env.CLENV_UNDEFINED_VAR;
            const result = loadEnv(opts([".env.expansion"]), {MISSING_REF: toString});
            expect(result).toEqual({ok: true, data: {MISSING_REF: "$CLENV_UNDEFINED_VAR"}});
        });

        it("supports chained expansion", () => {
            const result = loadEnv(opts([".env.expansion"]), {
                HOST: toString,
                PORT: toString,
                URL: toString,
                CHAINED: toString,
            });
            if (result.ok) {
                expect(result.data.CHAINED).toBe("http://localhost:3000/api");
            }
        });
    });

    describe("process.env merge", () => {
        const ENV_KEY = "CLENV_TEST_MERGE_KEY";

        afterAll(() => {
            delete process.env[ENV_KEY];
        });

        it("includeProcessEnv: true uses process.env as fallback for missing keys", () => {
            process.env[ENV_KEY] = "from-process";
            const result = loadEnv(
                {
                    files: [".env.missing"],
                    transformKeys: false,
                    basePath: fixtures,
                    includeProcessEnv: true,
                },
                {PRESENT: toString, [ENV_KEY]: toString}
            );
            expect(result).toEqual({
                ok: true,
                data: {PRESENT: "here", [ENV_KEY]: "from-process"},
            });
        });

        it("includeProcessEnv: true does not overwrite file values", () => {
            process.env.PRESENT = "from-process";
            const result = loadEnv(
                {
                    files: [".env.missing"],
                    transformKeys: false,
                    basePath: fixtures,
                    includeProcessEnv: true,
                },
                {PRESENT: toString}
            );
            expect(result).toEqual({ok: true, data: {PRESENT: "here"}});
            delete process.env.PRESENT;
        });

        it("includeProcessEnv: 'overwrite' lets process.env win", () => {
            process.env.PRESENT = "overwritten";
            const result = loadEnv(
                {
                    files: [".env.missing"],
                    transformKeys: false,
                    basePath: fixtures,
                    includeProcessEnv: "overwrite",
                },
                {PRESENT: toString}
            );
            expect(result).toEqual({ok: true, data: {PRESENT: "overwritten"}});
            delete process.env.PRESENT;
        });

        it("no merge when includeProcessEnv is false/undefined", () => {
            process.env[ENV_KEY] = "should-not-appear";
            const result = loadEnv(opts([".env.missing"]), {
                PRESENT: toString,
                [ENV_KEY]: withDefault(toString, "default"),
            });
            expect(result).toEqual({
                ok: true,
                data: {PRESENT: "here", [ENV_KEY]: "default"},
            });
        });
    });

    describe("schemaParser", () => {
        it("validates JSON with schema parser from opts", () => {
            type DbConfig = {host: string; port: number; ssl: boolean};
            const schema = {type: "DbConfig"};
            const parser: SchemaParser = (obj, s) => {
                if (s === schema && typeof obj === "object" && obj !== null) return success(obj);
                return failure("validation failed");
            };

            const result = loadEnv(
                {
                    files: [".env.complex"],
                    transformKeys: false,
                    basePath: fixtures,
                    schemaParser: parser,
                },
                {JSON_CONFIG: toJSON<DbConfig>(schema)}
            );
            expect(result).toEqual({
                ok: true,
                data: {JSON_CONFIG: {host: "localhost", port: 5432, ssl: true}},
            });
        });

        it("returns failure when schema parser rejects", () => {
            const parser: SchemaParser = () => failure("invalid shape");
            const result = loadEnv(
                {
                    files: [".env.complex"],
                    transformKeys: false,
                    basePath: fixtures,
                    schemaParser: parser,
                },
                {JSON_CONFIG: toJSON({})}
            );
            expect(result.ok).toBe(false);
        });

        it("no parser with schema fails", () => {
            const result = loadEnv(opts([".env.complex"]), {JSON_CONFIG: toJSON({})});
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.ctx[0]).toContain("schema provided but no schemaParser is set");
            }
        });

        it("no schema does not call parser", () => {
            let called = false;
            const parser: SchemaParser = () => {
                called = true;
                return success({});
            };
            loadEnv(
                {
                    files: [".env.complex"],
                    transformKeys: false,
                    basePath: fixtures,
                    schemaParser: parser,
                },
                {JSON_CONFIG: toJSON<{host: string; port: number; ssl: boolean}>()}
            );
            expect(called).toBe(false);
        });
    });

    describe("radix", () => {
        it("uses radix function for parseInt", () => {
            const result = loadEnv(
                {
                    files: [".env.radix"],
                    transformKeys: false,
                    basePath: fixtures,
                    radix: (key) => (key === "HEX_PORT" ? 16 : undefined),
                },
                {HEX_PORT: toInt, DEC_PORT: toInt}
            );
            expect(result).toEqual({ok: true, data: {HEX_PORT: 26, DEC_PORT: 3000}});
        });
    });

    describe("basePath", () => {
        it("joins basePath with file names", () => {
            const result = loadEnv(
                {files: [".env.basic"], transformKeys: false, basePath: fixtures},
                {HOST: toString}
            );
            expect(result).toEqual({ok: true, data: {HOST: "localhost"}});
        });

        it("works without basePath (absolute file paths)", () => {
            const result = loadEnv(
                {files: [fixture(".env.basic")], transformKeys: false},
                {HOST: toString}
            );
            expect(result).toEqual({ok: true, data: {HOST: "localhost"}});
        });
    });

    describe("source tracking", () => {
        it("ctx.source reflects file name for file entries", () => {
            let capturedSource: string | undefined;
            const spy = (key: string, val: string | undefined, ctx: TransformContext) => {
                capturedSource = ctx.source;
                return toString(key, val);
            };

            loadEnv(opts([".env.basic"]), {HOST: spy});
            expect(capturedSource).toBe(".env.basic");
        });

        it("ctx.source is 'process.env' when value comes from process.env merge", () => {
            const envKey = "CLENV_SOURCE_TEST";
            process.env[envKey] = "from-process";
            let capturedSource: string | undefined;
            const spy = (key: string, val: string | undefined, ctx: TransformContext) => {
                capturedSource = ctx.source;
                return toString(key, val);
            };

            loadEnv(
                {
                    files: [".env.missing"],
                    transformKeys: false,
                    basePath: fixtures,
                    includeProcessEnv: true,
                },
                {PRESENT: toString, [envKey]: spy}
            );
            expect(capturedSource).toBe("process.env");
            delete process.env[envKey];
        });

        it("ctx.source is 'none' for unseen keys", () => {
            let capturedSource: string | undefined;
            const spy = (key: string, val: string | undefined, ctx: TransformContext) => {
                capturedSource = ctx.source;
                return success("default");
            };

            loadEnv(opts([".env.missing"]), {ABSENT: spy});
            expect(capturedSource).toBe("none");
        });

        it("ctx.line reflects line number from file", () => {
            let capturedLine: number | undefined;
            const spy = (key: string, val: string | undefined, ctx: TransformContext) => {
                capturedLine = ctx.line;
                return toString(key, val);
            };

            // PORT is on line 2 of .env.basic
            loadEnv(opts([".env.basic"]), {PORT: spy});
            expect(capturedLine).toBe(2);
        });

        it("ctx.source reflects overwriting file in layered setup", () => {
            let capturedSource: string | undefined;
            const spy = (key: string, val: string | undefined, ctx: TransformContext) => {
                capturedSource = ctx.source;
                return toString(key, val);
            };

            // PORT is in both files, .env.layered.local wins
            loadEnv(
                {
                    files: [".env.layered.base", ".env.layered.local"],
                    transformKeys: false,
                    basePath: fixtures,
                },
                {PORT: spy}
            );
            expect(capturedSource).toBe(".env.layered.local");
        });
    });
});

// ─── logging ────────────────────────────────────────────────────────────────

describe("logging", () => {
    function capture() {
        const messages: Array<{level: LogLevel; message: string}> = [];
        const logger: Logger = (level, message) => messages.push({level, message});
        return {messages, logger};
    }

    it("calls custom logger function", () => {
        const {messages, logger} = capture();
        loadEnv(opts([".env.basic"], {logger}), {HOST: toString});

        expect(messages.some((m) => m.level === "verbose")).toBe(true);
        expect(messages.some((m) => m.level === "debug")).toBe(true);
    });

    it("logger: true uses default logger (does not throw)", () => {
        const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
        loadEnv(
            {files: [".env.basic"], transformKeys: false, basePath: fixtures, logger: true},
            {HOST: toString}
        );
        spy.mockRestore();
    });

    it("logs duplicate key warnings with source info", () => {
        const {messages, logger} = capture();
        loadEnv(opts([".env.duplicate"], {logger}), {KEY: toString, OTHER: toString});

        const dupWarning = messages.find(
            (m) => m.level === "warn" && m.message.includes("duplicate key")
        );
        expect(dupWarning).toBeDefined();
        expect(dupWarning!.message).toContain("overwriting");
        expect(dupWarning!.message).toContain(".env.duplicate");
    });

    it("logs duplicate key warnings across layered files", () => {
        const {messages, logger} = capture();
        loadEnv(
            {
                files: [".env.layered.base", ".env.layered.local"],
                transformKeys: false,
                basePath: fixtures,
                logger,
            },
            {PORT: toString, DEBUG: toString}
        );

        const dupWarnings = messages.filter(
            (m) => m.level === "warn" && m.message.includes("duplicate key")
        );
        expect(dupWarnings.length).toBeGreaterThan(0);
        // should mention both source files
        const portWarning = dupWarnings.find((m) => m.message.includes("PORT"));
        expect(portWarning).toBeDefined();
        expect(portWarning!.message).toContain(".env.layered.base");
        expect(portWarning!.message).toContain(".env.layered.local");
    });

    it("logs unknown key warnings with source info", () => {
        const {messages, logger} = capture();
        loadEnv(opts([".env.basic"], {logger}), {HOST: toString});

        const unknownWarnings = messages.filter(
            (m) => m.level === "warn" && m.message.includes("not a known key")
        );
        expect(unknownWarnings.length).toBeGreaterThan(0);
        expect(unknownWarnings[0]!.message).toContain(".env.basic");
    });

    it("logs summary with per-file counts", () => {
        const {messages, logger} = capture();
        loadEnv(opts([".env.basic"], {logger}), {HOST: toString, PORT: toInt});

        const summary = messages.find(
            (m) => m.level === "debug" && m.message.includes("loaded 2 vars")
        );
        expect(summary).toBeDefined();
        expect(summary!.message).toContain("from .env.basic");
    });

    it("logs summary with multiple files", () => {
        const {messages, logger} = capture();
        loadEnv(
            {
                files: [".env.layered.base", ".env.layered.local"],
                transformKeys: false,
                basePath: fixtures,
                logger,
            },
            {HOST: toString, PORT: toString, DEBUG: toString, SECRET: toString}
        );

        const summary = messages.find(
            (m) => m.level === "debug" && m.message.includes("loaded")
        );
        expect(summary).toBeDefined();
        expect(summary!.message).toContain(".env.layered.base");
        expect(summary!.message).toContain(".env.layered.local");
    });

    it("logs expansion with source info", () => {
        const {messages, logger} = capture();
        loadEnv(opts([".env.expansion"], {logger}), {
            HOST: toString,
            PORT: toString,
            URL: toString,
        });

        const expandLog = messages.find(
            (m) => m.level === "verbose" && m.message.includes("expanded")
        );
        expect(expandLog).toBeDefined();
        expect(expandLog!.message).toContain(".env.expansion");
    });

    it("warns on unresolved variable expansion", () => {
        delete process.env.CLENV_UNDEFINED_VAR;
        const {messages, logger} = capture();
        loadEnv(opts([".env.expansion"], {logger}), {MISSING_REF: toString});

        const unresolved = messages.find(
            (m) => m.level === "warn" && m.message.includes("not defined, left unexpanded")
        );
        expect(unresolved).toBeDefined();
        expect(unresolved!.message).toContain("$CLENV_UNDEFINED_VAR");
    });

    it("logs default values at debug level", () => {
        const {messages, logger} = capture();
        loadEnv(opts([".env.missing"], {logger}), {
            PRESENT: toString,
            ABSENT: withDefault(toInt, 9999),
        });

        const defaultLog = messages.find(
            (m) =>
                m.level === "debug" &&
                m.message.includes("not found in any file, using default")
        );
        expect(defaultLog).toBeDefined();
    });

    it("logs process.env merge mode", () => {
        const {messages, logger} = capture();
        loadEnv(
            {
                files: [".env.basic"],
                transformKeys: false,
                basePath: fixtures,
                logger,
                includeProcessEnv: true,
            },
            {HOST: toString}
        );

        const mergeLog = messages.find(
            (m) => m.level === "debug" && m.message.includes("merging process.env as fallback")
        );
        expect(mergeLog).toBeDefined();
    });

    it("logs process.env overwrite with source info", () => {
        process.env.HOST = "overwritten";
        const {messages, logger} = capture();
        loadEnv(
            {
                files: [".env.basic"],
                transformKeys: false,
                basePath: fixtures,
                logger,
                includeProcessEnv: "overwrite",
            },
            {HOST: toString}
        );
        delete process.env.HOST;

        const overwriteLog = messages.find(
            (m) => m.level === "verbose" && m.message.includes("process.env") && m.message.includes("overwrites")
        );
        expect(overwriteLog).toBeDefined();
    });

    it("no logging when logger is undefined/false", () => {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        const spyDebug = vi.spyOn(console, "debug").mockImplementation(() => {});

        loadEnv(opts([".env.basic"]), {HOST: toString});

        expect(spy).not.toHaveBeenCalled();
        expect(spyDebug).not.toHaveBeenCalled();
        spy.mockRestore();
        spyDebug.mockRestore();
    });
});

// ─── error handling ─────────────────────────────────────────────────────────

describe("error handling", () => {
    it("returns failure for nonexistent file", () => {
        const result = loadEnv(
            {files: ["does-not-exist.env"], transformKeys: false, basePath: fixtures},
            {FOO: toString}
        );
        expect(result.ok).toBe(false);
    });

    it("includes source and line in transform errors", () => {
        // HOST is on line 1 of .env.basic, value "localhost" fails toInt
        const result = loadEnv(opts([".env.basic"]), {HOST: toInt});
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.ctx[0]).toMatch(/\.env\.basic:L1: HOST/);
            expect(result.ctx[0]).toContain("failed to convert 'localhost' to a number");
        }
    });

    it("catches transform that throws and formats error message", () => {
        const result = loadEnv(opts([".env.basic"]), {
            HOST: () => {
                throw new Error("boom");
            },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.ctx[0]).toMatch(/\.env\.basic:L1: HOST/);
            expect(result.ctx[0]).toContain("transform function threw");
            expect(result.ctx[0]).toContain("boom");
            // should use err.message, not toString of Error object
            expect(result.ctx[0]).not.toContain("[object");
        }
    });

    it("catches transform that throws non-Error and stringifies", () => {
        const result = loadEnv(opts([".env.basic"]), {
            HOST: () => {
                throw "raw string error";
            },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.ctx[0]).toContain("raw string error");
        }
    });

    it("accumulates multiple errors", () => {
        const result = loadEnv(opts([".env.basic"]), {
            HOST: toInt,
            MISSING: withRequired(toString),
            PORT: toInt,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            // HOST fails to parse as int, MISSING is required but absent
            expect(result.ctx.length).toBe(2);
            expect(result.ctx[0]).toContain("HOST");
            expect(result.ctx[1]).toContain("MISSING");
        }
    });

    it("errors from layered files reference winning entry's source", () => {
        // PORT=8080 is on line 1 of .env.layered.local (this one wins)
        const result = loadEnv(
            {
                files: [".env.layered.base", ".env.layered.local"],
                transformKeys: false,
                basePath: fixtures,
            },
            {
                PORT: () => failure("custom error"),
            }
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.ctx[0]).toMatch(/\.env\.layered\.local:L1: PORT/);
        }
    });
});

// ─── type inference ─────────────────────────────────────────────────────────

describe("type inference", () => {
    it("infers correct types with transformKeys: false", () => {
        type SomeType = {host: string; port: number; ssl: boolean};

        const result = unwrap(
            loadEnv(opts([".env.complex"]), {
                DATABASE_URL: withRequired(toString),
                API_KEY: withRequired(toString),
                JSON_CONFIG: toJSON<SomeType>(),
                TAGS: toStringArray(),
                NUMBERS: toIntArray(),
            })
        );

        type assertion = Expect<
            Equal<
                typeof result,
                {
                    DATABASE_URL: string;
                    API_KEY: string;
                    JSON_CONFIG: SomeType;
                    TAGS: string[];
                    NUMBERS: number[];
                }
            >
        >;

        expect(result.DATABASE_URL).toBe(
            "postgres://user:pass@localhost:5432/mydb?sslmode=require"
        );
        expect(result.TAGS).toEqual(["foo", "bar", "baz"]);
        expect(result.NUMBERS).toEqual([1, 2, 3, 4, 5]);
    });

    it("infers camelCase keys with transformKeys: true", () => {
        const result = unwrap(
            loadEnv(
                {files: [".env.basic"], transformKeys: true, basePath: fixtures},
                {
                    HOST: toString,
                    PORT: toInt,
                    DEBUG: toBool,
                    APP_NAME: toString,
                }
            )
        );

        type assertion = Expect<
            Equal<
                typeof result,
                {
                    host: string;
                    port: number;
                    debug: boolean;
                    appName: string;
                }
            >
        >;

        expect(result.host).toBe("localhost");
        expect(result.port).toBe(3000);
        expect(result.debug).toBe(true);
        expect(result.appName).toBe("my-app");
    });

    it("preserves mixed-case keys with transformKeys: true", () => {
        const result = unwrap(
            loadEnv(
                {files: [".env.transformkeys"], transformKeys: true, basePath: fixtures},
                {FOO_BAR: toString, helloThere: toString}
            )
        );

        type assertion = Expect<
            Equal<
                typeof result,
                {
                    fooBar: string;
                    helloThere: string;
                }
            >
        >;

        expect(result.fooBar).toBe("1");
        expect(result.helloThere).toBe("2");
    });

    it("infers withDefault type correctly", () => {
        const result = unwrap(
            loadEnv(opts([".env.missing"]), {
                PRESENT: withRequired(toString),
                ABSENT: withDefault(toInt, 9999),
            })
        );

        type assertion = Expect<
            Equal<
                typeof result,
                {
                    PRESENT: string;
                    ABSENT: number;
                }
            >
        >;

        expect(result.PRESENT).toBe("here");
        expect(result.ABSENT).toBe(9999);
    });

    it("infers withOptional type as T | undefined", () => {
        const result = unwrap(
            loadEnv(opts([".env.missing"]), {
                PRESENT: withRequired(toString),
                ABSENT: withOptional(toInt),
            })
        );

        type assertion = Expect<
            Equal<
                typeof result,
                {
                    PRESENT: string;
                    ABSENT: number | undefined;
                }
            >
        >;

        expect(result.PRESENT).toBe("here");
        expect(result.ABSENT).toBeUndefined();
    });

    it("infers custom transform types", () => {
        const toDate = (k: string, v: string | undefined): Result<Date> => {
            if (v === undefined) return failure(`${k}: no value`);
            const d = new Date(v);
            if (isNaN(d.getTime())) return failure(`${k}: invalid date`);
            return success(d);
        };

        const result = unwrap(loadEnv(opts([".env.custom"]), {CREATED: toDate}));

        type assertion = Expect<Equal<typeof result, {CREATED: Date}>>;

        expect(result.CREATED).toBeInstanceOf(Date);
    });

    it("infers union type from custom transform", () => {
        const toLogLevel = (key: string, v: string | undefined) => {
            if (v !== undefined && ["debug", "info", "warn", "error"].includes(v))
                return success(v as "debug" | "info" | "warn" | "error");
            return failure(`${key}: invalid log level '${v}'`);
        };

        const result = unwrap(loadEnv(opts([".env.custom"]), {LOG_LEVEL: toLogLevel}));

        type assertion = Expect<
            Equal<typeof result, {LOG_LEVEL: "debug" | "info" | "warn" | "error"}>
        >;

        expect(result.LOG_LEVEL).toBe("debug");
    });

    it("infers schemaParser + transformKeys combined", () => {
        type Config = {host: string; port: number};
        const parser: SchemaParser = (obj) => success(obj);

        const result = unwrap(
            loadEnv(
                {
                    files: [".env.complex"],
                    transformKeys: true,
                    basePath: fixtures,
                    schemaParser: parser,
                },
                {
                    JSON_CONFIG: toJSON<Config>({}),
                    API_KEY: withDefault(toString, "none"),
                }
            )
        );

        type assertion = Expect<
            Equal<
                typeof result,
                {
                    jsonConfig: Config;
                    apiKey: string;
                }
            >
        >;

        expect(result.jsonConfig).toEqual({host: "localhost", port: 5432, ssl: true});
        expect(result.apiKey).toBe("sk-abc123def456");
    });

    it("infers toBool as boolean, not true | false", () => {
        const result = unwrap(loadEnv(opts([".env.basic"]), {DEBUG: toBool}));

        type assertion = Expect<Equal<typeof result, {DEBUG: boolean}>>;
        expect(result.DEBUG).toBe(true);
    });

    it("infers toStringArray as string[]", () => {
        const result = unwrap(loadEnv(opts([".env.complex"]), {TAGS: toStringArray()}));

        type assertion = Expect<Equal<typeof result, {TAGS: string[]}>>;
        expect(result.TAGS).toEqual(["foo", "bar", "baz"]);
    });

    it("infers toIntArray as number[]", () => {
        const result = unwrap(loadEnv(opts([".env.complex"]), {NUMBERS: toIntArray()}));

        type assertion = Expect<Equal<typeof result, {NUMBERS: number[]}>>;
        expect(result.NUMBERS).toEqual([1, 2, 3, 4, 5]);
    });

    it("full end-to-end with all transform types", () => {
        type JsonShape = {host: string; port: number; ssl: boolean};

        const result = unwrap(
            loadEnv(
                {files: [".env.complex"], transformKeys: true, basePath: fixtures},
                {
                    DATABASE_URL: withRequired(toString),
                    API_KEY: withRequired(toString),
                    JSON_CONFIG: toJSON<JsonShape>(),
                    TAGS: toStringArray(),
                    NUMBERS: toIntArray(),
                    MULTILINE: toString,
                    SINGLE_NO_EXPAND: toString,
                }
            )
        );

        type assertion = Expect<
            Equal<
                typeof result,
                {
                    databaseUrl: string;
                    apiKey: string;
                    jsonConfig: JsonShape;
                    tags: string[];
                    numbers: number[];
                    multiline: string;
                    singleNoExpand: string;
                }
            >
        >;

        expect(result).toEqual({
            databaseUrl: "postgres://user:pass@localhost:5432/mydb?sslmode=require",
            apiKey: "sk-abc123def456",
            jsonConfig: {host: "localhost", port: 5432, ssl: true},
            tags: ["foo", "bar", "baz"],
            numbers: [1, 2, 3, 4, 5],
            multiline: "line1\nline2\nline3",
            singleNoExpand: "keep\\nraw",
        });
    });
});

// ─── large files ────────────────────────────────────────────────────────────

describe("large files", () => {
    it("parses a 10,000-entry .env file", () => {
        const config: Record<string, typeof toString> = {};
        config.KEY_00001 = toString;
        config.KEY_05000 = toString;
        config.KEY_10000 = toString;

        const result = loadEnv(opts([".env.large"]), config);
        expect(result).toEqual({
            ok: true,
            data: {
                KEY_00001: "value_00001",
                KEY_05000: "value_05000",
                KEY_10000: "value_10000",
            },
        });
    });

    it("parses all 10,000 entries when requested", () => {
        const config: Record<string, typeof toString> = {};
        for (let i = 1; i <= 10000; i++) {
            config[`KEY_${String(i).padStart(5, "0")}`] = toString;
        }

        const result = loadEnv(opts([".env.large"]), config);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(Object.keys(result.data).length).toBe(10000);
        }
    });
});

// ─── fuzz testing ───────────────────────────────────────────────────────────

describe("fuzz", () => {
    // helper: generate random string
    function randStr(len: number) {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-. #${}='\"`\\\n\t";
        let s = "";
        for (let i = 0; i < len; i++) {
            s += chars[Math.floor(Math.random() * chars.length)];
        }
        return s;
    }

    // helper: generate valid key
    function randKey() {
        const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_";
        const alnum = alpha + "0123456789";
        let key = alpha[Math.floor(Math.random() * alpha.length)]!;
        const len = Math.floor(Math.random() * 20) + 1;
        for (let i = 0; i < len; i++) {
            key += alnum[Math.floor(Math.random() * alnum.length)]!;
        }
        return key;
    }

    it("parseDotenv never throws on random input (1000 chunks)", () => {
        const tmpDir = join(tmpdir(), "cl-env-fuzz");
        mkdirSync(tmpDir, {recursive: true});

        // write one large file with 1000 random chunks separated by newlines
        const chunks: string[] = [];
        for (let i = 0; i < 1000; i++) {
            chunks.push(randStr(Math.floor(Math.random() * 200)));
        }
        writeFileSync(join(tmpDir, ".env"), chunks.join("\n"), "utf8");

        // should never throw — parser should handle garbage
        expect(() => {
            loadEnv(
                {files: [".env"], transformKeys: false, basePath: tmpDir},
                {ANYTHING: withOptional(toString)}
            );
        }).not.toThrow();

        rmSync(tmpDir, {recursive: true, force: true});
    });

    it("well-formed KEY=VALUE always produces an entry", () => {
        const tmpDir = join(tmpdir(), "cl-env-fuzz-kv");
        mkdirSync(tmpDir, {recursive: true});

        // generate 200 entries in a single file, then verify each
        const entries: Array<{key: string; value: string}> = [];
        const lines: string[] = [];
        for (let i = 0; i < 200; i++) {
            const key = `${randKey()}_${i}`; // suffix to avoid duplicates
            const value = `simple_value_${i}`;
            entries.push({key, value});
            lines.push(`${key}=${value}`);
        }
        writeFileSync(join(tmpDir, ".env"), lines.join("\n") + "\n", "utf8");

        const config: Record<string, typeof toString> = {};
        for (const e of entries) config[e.key] = toString;

        const result = loadEnv(
            {files: [".env"], transformKeys: false, basePath: tmpDir},
            config
        );
        expect(result.ok).toBe(true);
        if (result.ok) {
            for (const e of entries) {
                expect((result.data as any)[e.key]).toBe(e.value);
            }
        }

        rmSync(tmpDir, {recursive: true, force: true});
    });

    it("heavy $expansion input does not cause stack overflow", () => {
        const tmpDir = join(tmpdir(), "cl-env-fuzz-expand");
        mkdirSync(tmpDir, {recursive: true});

        // generate entries where every value references the previous
        const lines: string[] = ["BASE=start"];
        for (let i = 1; i <= 500; i++) {
            lines.push(`V${i}=$V${i - 1}_suffix`);
        }
        // add lots of unresolved refs
        for (let i = 0; i < 100; i++) {
            lines.push(`MISS_${i}=$NONEXISTENT_${i}`);
        }
        writeFileSync(join(tmpDir, ".env"), lines.join("\n") + "\n", "utf8");

        const config: Record<string, typeof toString> = {BASE: toString, V500: toString};
        expect(() => {
            loadEnv({files: [".env"], transformKeys: false, basePath: tmpDir}, config);
        }).not.toThrow();

        rmSync(tmpDir, {recursive: true, force: true});
    });
});
