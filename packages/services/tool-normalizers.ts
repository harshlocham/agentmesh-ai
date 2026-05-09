export type NormalizedSendEmailParams = {
    to: string[];
    subject: string;
    body: string;
};

function isValidEmail(email: string): boolean {
    if (typeof email !== "string") return false;
    if (email.length === 0) return false;

    for (const char of email) {
        if (char.trim().length === 0) return false;
    }

    const atIndex = email.indexOf("@");
    if (atIndex <= 0) return false; // must have local part
    if (email.indexOf("@", atIndex + 1) !== -1) return false; // only one @

    const domain = email.slice(atIndex + 1);
    if (domain.length < 3) return false; // a.b at minimum
    if (domain.startsWith(".") || domain.endsWith(".")) return false;
    if (domain.indexOf(".") === -1) return false; // must contain a dot

    const local = email.slice(0, atIndex);
    if (local.length === 0) return false;

    return true;
}

function coerceString(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function coerceStringList(value: unknown): string[] {
    if (typeof value === "string") {
        return value
            .split(/[;,]/)
            .map((part) => part.trim())
            .filter(Boolean);
    }

    if (Array.isArray(value)) {
        return value
            .filter((entry) => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean);
    }

    return [];
}

function dedupe(values: string[]): string[] {
    const seen = new Set<string>();
    const output: string[] = [];
    for (const value of values) {
        const key = value.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        output.push(value);
    }
    return output;
}

function normalizeBodyText(text: string): string {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const normalizedLines: string[] = [];
    let previousWasEmpty = false;

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (trimmed.length === 0) {
            if (!previousWasEmpty && normalizedLines.length > 0) {
                normalizedLines.push("");
            }
            previousWasEmpty = true;
            continue;
        }

        const bulletMatch = trimmed.match(/^(?:[-*•●▪◦‣]+|\d+[.)])\s+(.*)$/);
        if (bulletMatch && bulletMatch[1].trim().length > 0) {
            normalizedLines.push(`- ${bulletMatch[1].trim()}`);
        } else {
            normalizedLines.push(trimmed);
        }
        previousWasEmpty = false;
    }

    while (normalizedLines.length > 0 && normalizedLines[normalizedLines.length - 1] === "") {
        normalizedLines.pop();
    }

    return normalizedLines.join("\n").trim();
}

function coerceBodyValue(params: Record<string, unknown>): string | null {
    const bodyKeys = ["body", "content", "message", "text", "notes"];

    for (const key of bodyKeys) {
        const value = params[key];
        const stringValue = coerceString(value);
        if (stringValue) {
            return normalizeBodyText(stringValue);
        }

        if (Array.isArray(value)) {
            const lines = value
                .filter((entry) => typeof entry === "string")
                .map((entry) => entry.trim())
                .filter(Boolean);
            if (lines.length > 0) {
                return normalizeBodyText(lines.join("\n"));
            }
        }
    }

    return null;
}

function inferDefaultSubject(body: string): string {
    const firstNonBulletLine = body
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("- "));

    if (!firstNonBulletLine) {
        return "Automated Email Update";
    }

    const compact = firstNonBulletLine.replace(/\s+/g, " ");
    if (compact.length <= 80) {
        return compact;
    }

    return `${compact.slice(0, 77)}...`;
}

function inferDefaultBody(subject: string): string {
    return `Automated update: ${subject}`;
}

export function normalizeEmailParams(params: Record<string, unknown>): NormalizedSendEmailParams {
    const rawRecipients = [
        ...coerceStringList(params.to),
        ...coerceStringList(params.recipient),
        ...coerceStringList(params.recipients),
        ...coerceStringList(params.email),
    ];

    const to = dedupe(rawRecipients);
    if (to.length === 0) {
        throw new Error("send_email requires at least one recipient in 'to'.");
    }

    for (const recipient of to) {
        if (!isValidEmail(recipient)) {
            throw new Error(`send_email contains invalid recipient email: ${recipient}`);
        }
    }

    const parsedBody = coerceBodyValue(params);
    const explicitSubject = coerceString(params.subject);
    const subject = explicitSubject ?? inferDefaultSubject(parsedBody ?? "Automated Email Update");
    const body = parsedBody ?? inferDefaultBody(subject);

    // Whitelist only schema-safe send_email fields.
    return {
        to,
        subject,
        body,
    };
}

export function normalizeToolParams(toolName: string, params: Record<string, unknown>): Record<string, unknown> {
    if (toolName === "send_email") {
        return normalizeEmailParams(params);
    }

    return { ...params };
}
