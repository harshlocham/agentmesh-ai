export enum CallState {
    INITIATED = "initiated",
    RINGING = "ringing",
    ACCEPTED = "accepted",
    ACTIVE = "active",
    RECONNECTING = "reconnecting",
    ENDED = "ended",
    REJECTED = "rejected",
    MISSED = "missed",
    FAILED = "failed",
}

type TransitionMap = Record<CallState, ReadonlySet<CallState>>;

export const CALL_STATE_TRANSITIONS: TransitionMap = {
    [CallState.INITIATED]: new Set([CallState.RINGING, CallState.FAILED]),
    [CallState.RINGING]: new Set([
        CallState.ACCEPTED,
        CallState.REJECTED,
        CallState.MISSED,
        CallState.FAILED,
    ]),
    [CallState.ACCEPTED]: new Set([CallState.ACTIVE, CallState.FAILED]),
    [CallState.ACTIVE]: new Set([
        CallState.RECONNECTING,
        CallState.ENDED,
        CallState.FAILED,
    ]),
    [CallState.RECONNECTING]: new Set([
        CallState.ACTIVE,
        CallState.ENDED,
        CallState.FAILED,
    ]),
    [CallState.ENDED]: new Set(),
    [CallState.REJECTED]: new Set(),
    [CallState.MISSED]: new Set(),
    [CallState.FAILED]: new Set(),
};

export function canTransitionCallState(
    current: CallState,
    next: CallState
): boolean {
    return CALL_STATE_TRANSITIONS[current].has(next);
}

export function assertValidCallStateTransition(
    current: CallState,
    next: CallState
): void {
    if (canTransitionCallState(current, next)) return;

    throw new Error(`Invalid call state transition: ${current} -> ${next}`);
}

export function isTerminalCallState(state: CallState): boolean {
    return (
        state === CallState.ENDED ||
        state === CallState.REJECTED ||
        state === CallState.MISSED ||
        state === CallState.FAILED
    );
}
