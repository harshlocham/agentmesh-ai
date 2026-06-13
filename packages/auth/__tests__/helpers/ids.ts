import { Types } from "mongoose";

/**
 * Generate a fresh, valid Mongo ObjectId string.
 *
 * Auth modules validate ids with `Types.ObjectId.isValid` and serialize them as
 * strings, so tests overwhelmingly need string ids rather than ObjectId
 * instances.
 */
export function objectId(): string {
    return new Types.ObjectId().toString();
}

/** Generate `count` distinct ObjectId strings. */
export function objectIds(count: number): string[] {
    return Array.from({ length: count }, () => objectId());
}

/**
 * A deterministic, syntactically invalid id for negative-path tests
 * (e.g. asserting `assertValidObjectId` / `Types.ObjectId.isValid` rejection).
 */
export const INVALID_OBJECT_ID = "not-a-valid-object-id";
