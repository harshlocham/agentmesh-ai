import mongoose from "mongoose";
import * as dbModule from "@chat/db";
import ContactModel from "@chat/db/models/Contact";
import { User } from "@chat/db/models/User";

function isContactResolutionDebugEnabled(): boolean {
    return process.env.CONTACT_RESOLUTION_DEBUG === "1"
        || process.env.CONTACT_RESOLUTION_DEBUG === "true";
}

function logContactResolution(event: string, payload: Record<string, unknown>): void {
    if (!isContactResolutionDebugEnabled()) {
        return;
    }
    console.log(`contact-resolution ${event}`, payload);
}

function toUserIdQueryValue(userId: string): string | mongoose.Types.ObjectId {
    if (mongoose.isValidObjectId(userId)) {
        try {
            return new mongoose.Types.ObjectId(userId);
        } catch {
            return userId;
        }
    }
    return userId;
}

const connectToDatabase =
    (dbModule as unknown as { connectToDatabase?: () => Promise<unknown> }).connectToDatabase
    || ((dbModule as unknown as { default?: { connectToDatabase?: () => Promise<unknown> } }).default?.connectToDatabase)
    || (async () => undefined);

type CreateContactInput = {
    userId: string;
    name: string;
    email: string;
    aliases?: string[];
};

type ContactMatch = {
    name: string;
    email: string;
};

export type ContactResolutionResult = {
    success: boolean;
    resolved?: {
        name: string;
        email: string;
        confidence: number;
    };
    ambiguous?: Array<{
        name: string;
        email: string;
    }>;
    error?: string;
};

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve a registered app user by exact username (case-insensitive) when no Contact matches.
 */
async function tryResolveRegisteredUserByUsername(reference: string): Promise<ContactResolutionResult | null> {
    const q = reference.trim();
    if (q.length === 0 || q.length > 128) {
        return null;
    }

    await connectToDatabase();

    const users = await User.find({
        username: new RegExp(`^${escapeRegex(q)}$`, "i"),
        isDeleted: { $ne: true },
        status: "active",
    })
        .limit(5)
        .select({ username: 1, email: 1 })
        .lean();

    const matches: ContactMatch[] = [];
    for (const row of users) {
        if (typeof row.username !== "string" || typeof row.email !== "string") {
            continue;
        }
        const name = row.username.trim();
        const email = row.email.trim().toLowerCase();
        if (!name || !email) {
            continue;
        }
        matches.push({ name, email });
    }

    if (matches.length === 0) {
        return null;
    }

    if (matches.length === 1) {
        return {
            success: true,
            resolved: {
                name: matches[0].name,
                email: matches[0].email,
                confidence: 0.88,
            },
        };
    }

    return {
        success: false,
        ambiguous: matches,
        error: "Ambiguous user reference.",
    };
}

/** RFC 5321 / common practice upper bound; avoids ReDoS on huge inputs. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Linear-time shape check (no backtracking regex). Intentionally similar to the
 * prior pattern: single @, no whitespace, domain contains a dot with non-empty
 * parts on both sides of the last dot.
 */
function isValidEmail(value: string): boolean {
    if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) {
        return false;
    }

    if (/\s/.test(value)) {
        return false;
    }

    const atIndex = value.indexOf("@");
    if (atIndex <= 0 || value.lastIndexOf("@") !== atIndex) {
        return false;
    }

    const domain = value.slice(atIndex + 1);
    const lastDot = domain.lastIndexOf(".");
    if (lastDot <= 0 || lastDot === domain.length - 1) {
        return false;
    }

    const domainHead = domain.slice(0, lastDot);
    const domainTail = domain.slice(lastDot + 1);
    return domainHead.length > 0 && domainTail.length > 0;
}

function normalizeName(value: string): string {
    return value.trim();
}

function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

function normalizeAliases(aliases: string[] | undefined): string[] {
    if (!Array.isArray(aliases)) {
        return [];
    }

    const seen = new Set<string>();
    const output: string[] = [];

    for (const alias of aliases) {
        if (typeof alias !== "string") {
            continue;
        }

        const normalized = alias.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        output.push(normalized);
    }

    return output;
}

export async function createContact(input: CreateContactInput) {
    await connectToDatabase();

    const normalizedName = normalizeName(input.name);
    const normalizedEmail = normalizeEmail(input.email);

    if (!normalizedName) {
        throw new Error("Contact name is required.");
    }

    if (!isValidEmail(normalizedEmail)) {
        throw new Error("Contact email is invalid.");
    }

    return ContactModel.findOneAndUpdate(
        {
            userId: input.userId,
            email: normalizedEmail,
        },
        {
            $set: {
                userId: input.userId,
                name: normalizedName,
                email: normalizedEmail,
                aliases: normalizeAliases(input.aliases),
            },
        },
        {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        }
    ).lean().exec();
}

export async function findByExactEmail(userId: string, email: string) {
    await connectToDatabase();
    const userIdQuery = toUserIdQueryValue(userId);
    const normalizedEmailValue = normalizeEmail(email);
    const result = await ContactModel.findOne({
        userId: userIdQuery,
        email: normalizedEmailValue,
    }).lean().exec();
    logContactResolution("findByExactEmail", {
        userId,
        userIdCasted: String(userIdQuery),
        email: normalizedEmailValue,
        found: Boolean(result),
    });
    return result;
}

export async function findByExactName(userId: string, name: string) {
    await connectToDatabase();

    const normalizedName = normalizeName(name);
    const userIdQuery = toUserIdQueryValue(userId);
    const results = await ContactModel.find({
        userId: userIdQuery,
        name: { $regex: `^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    }).lean().exec();
    logContactResolution("findByExactName", {
        userId,
        userIdCasted: String(userIdQuery),
        name: normalizedName,
        matchCount: results.length,
    });
    return results;
}

export async function findByAlias(userId: string, alias: string) {
    await connectToDatabase();

    const normalizedAlias = alias.trim().toLowerCase();
    if (!normalizedAlias) {
        return [];
    }

    const userIdQuery = toUserIdQueryValue(userId);
    const results = await ContactModel.find({
        userId: userIdQuery,
        aliases: normalizedAlias,
    }).lean().exec();
    logContactResolution("findByAlias", {
        userId,
        userIdCasted: String(userIdQuery),
        alias: normalizedAlias,
        matchCount: results.length,
    });
    return results;
}

function toContactMatch(value: { name?: unknown; email?: unknown }): ContactMatch | null {
    if (typeof value.name !== "string" || typeof value.email !== "string") {
        return null;
    }

    const name = value.name.trim();
    const email = value.email.trim().toLowerCase();
    if (!name || !email) {
        return null;
    }

    return { name, email };
}

export async function resolveContactReference(userId: string, reference: string): Promise<ContactResolutionResult> {
    const trimmedReference = reference.trim();
    if (!trimmedReference) {
        return { success: false, error: "Contact reference is empty." };
    }

    logContactResolution("start", {
        userId,
        userIdLength: userId.length,
        userIdIsValidObjectId: mongoose.isValidObjectId(userId),
        reference: trimmedReference,
    });

    async function resolveByLocalPart(localPart: string): Promise<ContactResolutionResult | null> {
        const normalizedLocalPart = localPart.trim();
        if (!normalizedLocalPart) {
            return null;
        }

        const exactNameMatches = await findByExactName(userId, normalizedLocalPart);
        if (exactNameMatches.length === 1) {
            const match = toContactMatch(exactNameMatches[0]);
            if (!match) {
                return { success: false, error: "Matched contact has invalid data." };
            }

            return {
                success: true,
                resolved: {
                    ...match,
                    confidence: 0.93,
                },
            };
        }

        if (exactNameMatches.length > 1) {
            return {
                success: false,
                ambiguous: exactNameMatches
                    .map((item: Record<string, unknown>) => toContactMatch(item))
                    .filter((item: ContactMatch | null): item is ContactMatch => Boolean(item)),
                error: "Ambiguous contact reference.",
            };
        }

        const aliasMatches = await findByAlias(userId, normalizedLocalPart);
        if (aliasMatches.length === 1) {
            const match = toContactMatch(aliasMatches[0]);
            if (!match) {
                return { success: false, error: "Matched contact has invalid data." };
            }

            return {
                success: true,
                resolved: {
                    ...match,
                    confidence: 0.92,
                },
            };
        }

        if (aliasMatches.length > 1) {
            return {
                success: false,
                ambiguous: aliasMatches
                    .map((item: Record<string, unknown>) => toContactMatch(item))
                    .filter((item: ContactMatch | null): item is ContactMatch => Boolean(item)),
                error: "Ambiguous contact alias.",
            };
        }

        return null;
    }

    if (isValidEmail(trimmedReference)) {
        const known = await findByExactEmail(userId, trimmedReference);
        if (known) {
            return {
                success: true,
                resolved: {
                    name: known.name,
                    email: known.email,
                    confidence: 1,
                },
            };
        }

        const localPart = trimmedReference.slice(0, trimmedReference.indexOf("@"));
        const localPartResolution = await resolveByLocalPart(localPart);
        if (localPartResolution) {
            return localPartResolution;
        }

        return {
            success: true,
            resolved: {
                name: trimmedReference,
                email: normalizeEmail(trimmedReference),
                confidence: 0.99,
            },
        };
    }

    const exactNameMatches = await findByExactName(userId, trimmedReference);
    if (exactNameMatches.length === 1) {
        const match = toContactMatch(exactNameMatches[0]);
        if (!match) {
            return { success: false, error: "Matched contact has invalid data." };
        }

        return {
            success: true,
            resolved: {
                ...match,
                confidence: 0.95,
            },
        };
    }

    if (exactNameMatches.length > 1) {
        return {
            success: false,
            ambiguous: exactNameMatches
                .map((item: Record<string, unknown>) => toContactMatch(item))
                .filter((item: ContactMatch | null): item is ContactMatch => Boolean(item)),
            error: "Ambiguous contact reference.",
        };
    }

    const aliasMatches = await findByAlias(userId, trimmedReference);
    if (aliasMatches.length === 1) {
        const match = toContactMatch(aliasMatches[0]);
        if (!match) {
            return { success: false, error: "Matched contact has invalid data." };
        }

        return {
            success: true,
            resolved: {
                ...match,
                confidence: 0.9,
            },
        };
    }

    if (aliasMatches.length > 1) {
        return {
            success: false,
            ambiguous: aliasMatches
                .map((item: Record<string, unknown>) => toContactMatch(item))
                .filter((item: ContactMatch | null): item is ContactMatch => Boolean(item)),
            error: "Ambiguous contact alias.",
        };
    }

    const userMatch = await tryResolveRegisteredUserByUsername(trimmedReference);
    if (userMatch) {
        return userMatch;
    }

    logContactResolution("not_found", {
        userId,
        reference: trimmedReference,
        exactNameMatches: exactNameMatches.length,
        aliasMatches: aliasMatches.length,
    });

    return {
        success: false,
        error: `No contact found for reference '${trimmedReference}'.`,
    };
}
