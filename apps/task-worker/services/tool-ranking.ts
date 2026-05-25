import type { TaskExecutionActionType } from "@chat/types";

export type ToolRankingInput = {
    toolName: Exclude<TaskExecutionActionType, "none">;
    capabilityScore: number;
    historicalSuccessRate: number;
    riskPenalty: number;
    recentFailurePenalty: number;
};

export type RankedTool = {
    toolName: Exclude<TaskExecutionActionType, "none">;
    score: number;
    breakdown: {
        capability: number;
        history: number;
        riskPenalty: number;
        recentFailurePenalty: number;
    };
};

function clamp01(value: number) {
    return Math.max(0, Math.min(1, value));
}

export function scoreTool(input: ToolRankingInput): RankedTool {
    const capability = clamp01(input.capabilityScore);
    const history = clamp01(input.historicalSuccessRate);
    const riskPenalty = clamp01(input.riskPenalty);
    const recentFailurePenalty = clamp01(input.recentFailurePenalty);

    const score = clamp01(
        (0.55 * capability)
        + (0.35 * history)
        - (0.07 * riskPenalty)
        - (0.03 * recentFailurePenalty)
    );

    return {
        toolName: input.toolName,
        score,
        breakdown: {
            capability,
            history,
            riskPenalty,
            recentFailurePenalty,
        },
    };
}

export function rankTools(inputs: ToolRankingInput[]): RankedTool[] {
    return inputs
        .map(scoreTool)
        .sort((left, right) => right.score - left.score);
}
