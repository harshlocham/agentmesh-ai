import "dotenv/config";
import mongoose from "mongoose";
import { createContact } from "@chat/services/contact.service";

type SeedContact = {
    name: string;
    email: string;
    aliases?: string[];
};

function parseArg(name: string): string | null {
    const prefix = `--${name}=`;
    const arg = process.argv.find((entry) => entry.startsWith(prefix));
    return arg ? arg.slice(prefix.length).trim() : null;
}

function loadContacts(): SeedContact[] {
    const contactsJson = parseArg("contacts") || process.env.SEED_CONTACTS_JSON;
    if (contactsJson) {
        try {
            const parsed = JSON.parse(contactsJson) as unknown;
            if (Array.isArray(parsed)) {
                return parsed
                    .filter((entry) => entry && typeof entry === "object")
                    .map((entry) => entry as SeedContact)
                    .filter((entry) => typeof entry.name === "string" && typeof entry.email === "string");
            }
        } catch (error) {
            throw new Error(`Invalid contacts JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return [
        { name: "Harshdeep Singh", email: "harshdeepsinghlocham@gmail.com", aliases: ["harsh", "harshdeep"] }
    ];
}

async function main() {
    const userId = parseArg("userId") || process.env.SEED_CONTACTS_USER_ID;
    if (!userId) {
        throw new Error("Missing userId. Provide --userId=<mongoUserId> or SEED_CONTACTS_USER_ID.");
    }

    const contacts = loadContacts();
    if (contacts.length === 0) {
        throw new Error("No valid contacts provided for seeding.");
    }

    for (const contact of contacts) {
        await createContact({
            userId,
            name: contact.name,
            email: contact.email,
            aliases: contact.aliases ?? [],
        });
    }

    console.log(`Seeded ${contacts.length} contacts for user ${userId}.`);
}

main()
    .catch((error) => {
        console.error("Failed to seed contacts:", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    })
    .finally(async () => {
        try {
            await mongoose.disconnect();
        } catch {
            // no-op
        }
    });
