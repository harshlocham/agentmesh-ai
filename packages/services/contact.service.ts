import * as dbModule from "@chat/db";
import ContactModel from "@chat/db/models/Contact";

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

function isValidEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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
    return ContactModel.findOne({ userId, email: normalizeEmail(email) }).lean().exec();
}

export async function findByExactName(userId: string, name: string) {
    await connectToDatabase();

    const normalizedName = normalizeName(name);
    return ContactModel.find({
        userId,
        name: { $regex: `^${normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    }).lean().exec();
}

export async function findByAlias(userId: string, alias: string) {
    await connectToDatabase();

    const normalizedAlias = alias.trim().toLowerCase();
    if (!normalizedAlias) {
        return [];
    }

    return ContactModel.find({
        userId,
        aliases: normalizedAlias,
    }).lean().exec();
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

    return {
        success: false,
        error: `No contact found for reference '${trimmedReference}'.`,
    };
}
