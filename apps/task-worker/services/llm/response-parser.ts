import { z } from "zod";
import type { LLMResponse } from "./types.js";

type NormalizedExtract = {
    text: string;
    responseFormat: NonNullable<LLMResponse["responseFormat"]>;
    parseRepaired: boolean;
};

function stripCodeFences(text: string): string {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        return fenced[1].trim();
    }

    return text.trim();
}

function trimTrailingText(text: string): string {
    const trimmed = text.trim();
    const objectStart = trimmed.indexOf("{");
    const arrayStart = trimmed.indexOf("[");

    if (objectStart < 0 && arrayStart < 0) {
        return trimmed;
    }

    const start = objectStart === -1 ? arrayStart : arrayStart === -1 ? objectStart : Math.min(objectStart, arrayStart);
    const candidate = trimmed.slice(start);
    const objectEnd = candidate.lastIndexOf("}");
    const arrayEnd = candidate.lastIndexOf("]");
    const end = Math.max(objectEnd, arrayEnd);

    return end > 0 ? candidate.slice(0, end + 1) : candidate;
}

function tryParseJson<T>(text: string): { value: T | null; repaired: boolean } {
    const candidates = [text, stripCodeFences(text), trimTrailingText(text), trimTrailingText(stripCodeFences(text))];

    for (const candidate of candidates) {
        try {
            return { value: JSON.parse(candidate) as T, repaired: candidate !== text };
        } catch {
            // continue
        }
    }

    return { value: null, repaired: false };
}

export function extractResponseText(response: LLMResponse): NormalizedExtract {
    if (typeof response.output_text === "string" && response.output_text.trim().length > 0) {
        return { text: response.output_text.trim(), responseFormat: response.responseFormat ?? "normalized", parseRepaired: Boolean(response.parseRepaired) };
    }

    const raw = response.raw as Record<string, unknown> | undefined;

    const candidateStrings: Array<{ text?: unknown; responseFormat: NormalizedExtract["responseFormat"] }> = [];

    if (Array.isArray(response.output)) {
        for (const item of response.output) {
            if (!item || typeof item !== "object") continue;
            const itemRecord = item as Record<string, unknown>;
            const content = itemRecord.content;
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (!part || typeof part !== "object") continue;
                    const partRecord = part as Record<string, unknown>;
                    candidateStrings.push({ text: partRecord.text ?? partRecord.content ?? partRecord.value, responseFormat: "responses" });
                }
            }
        }
    }

    const choiceContent = raw?.choices;
    if (Array.isArray(choiceContent) && choiceContent.length > 0) {
        for (const choice of choiceContent) {
            if (!choice || typeof choice !== "object") continue;
            const choiceRecord = choice as Record<string, unknown>;
            const message = choiceRecord.message as Record<string, unknown> | undefined;
            candidateStrings.push({
                text: message?.content ?? choiceRecord.text ?? choiceRecord.output_text,
                responseFormat: "chat_completions",
            });
        }
    }

    const rawText = raw?.output_text ?? raw?.generated_text ?? raw?.text ?? raw?.content;
    candidateStrings.push({ text: rawText, responseFormat: "normalized" });

    for (const candidate of candidateStrings) {
        if (typeof candidate.text === "string" && candidate.text.trim().length > 0) {
            return { text: candidate.text.trim(), responseFormat: candidate.responseFormat, parseRepaired: false };
        }
    }

    return { text: "", responseFormat: response.responseFormat ?? "normalized", parseRepaired: false };
}

export function parseJsonText<T>(text: string): { value: T | null; parseRepaired: boolean } {
    const { value, repaired } = tryParseJson<T>(text);
    return { value, parseRepaired: repaired };
}

export function parseJsonResponse<T>(response: LLMResponse): { value: T | null; text: string; responseFormat: NormalizedExtract["responseFormat"]; parseRepaired: boolean } {
    const extracted = extractResponseText(response);
    const parsed = parseJsonText<T>(extracted.text);
    return {
        value: parsed.value,
        text: extracted.text,
        responseFormat: extracted.responseFormat,
        parseRepaired: extracted.parseRepaired || parsed.parseRepaired,
    };
}

export function parseJsonWithSchema<T>(response: LLMResponse, schema: z.ZodSchema<T>): { value: T | null; text: string; responseFormat: NormalizedExtract["responseFormat"]; parseRepaired: boolean } {
    const parsed = parseJsonResponse<unknown>(response);
    if (parsed.value === null) {
        return parsed as { value: T | null; text: string; responseFormat: NormalizedExtract["responseFormat"]; parseRepaired: boolean };
    }

    const validated = schema.safeParse(parsed.value);
    return {
        ...parsed,
        value: validated.success ? validated.data : null,
        parseRepaired: parsed.parseRepaired || !validated.success,
    };
}
