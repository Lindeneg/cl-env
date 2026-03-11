import {success, failure, type Result} from "./result.js";
import type {TransformContext, TransformFn} from "./types.js";

export type RefineCheck<T> = (key: string, val: T, ctx: TransformContext) => Result<T>;

export function refine<T>(
    transform: TransformFn<T>,
    ...checks: RefineCheck<NoInfer<T>>[]
): TransformFn<T> {
    return function (key, val, ctx) {
        const transformed = transform(key, val, ctx);
        if (!transformed.ok) return transformed;
        let last = transformed.data;
        for (const check of checks) {
            const result = check(key, last, ctx);
            if (!result.ok) return result;
            last = result.data;
        }
        return success(last);
    };
}

export function inRange(min: number, max: number): RefineCheck<number> {
    return function (key, val, _ctx) {
        if (val < min) {
            return failure(`${key}: '${val}' is smaller than constraint '${min}'`);
        }
        if (val > max) {
            return failure(`${key}: '${val}' is bigger than constraint '${max}'`);
        }
        return success(val);
    };
}

export function nonEmpty<T extends string | any[]>(): RefineCheck<T> {
    return minLength(1);
}

export function matches(regex: RegExp): RefineCheck<string> {
    return function (key, val, _ctx) {
        if (regex.test(val)) return success(val);
        return failure(`${key}: '${val}' failed to match ${regex}`);
    };
}

export function minLength<T extends string | any[]>(n: number): RefineCheck<T> {
    return function (key, val, _ctx) {
        if (val.length < n) {
            return failure(`${key}: '${val.length}' expected to be minimum '${n}' length`);
        }
        return success(val);
    };
}

export function maxLength<T extends string | any[]>(n: number): RefineCheck<T> {
    return function (key, val, _ctx) {
        if (val.length > n) {
            return failure(`${key}: '${val.length}' expected to be maximum '${n}' length`);
        }
        return success(val);
    };
}
