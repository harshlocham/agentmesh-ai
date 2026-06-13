// src/server/socket/handlers/call/call.handler.ts
import type { Server as IOServer } from "socket.io";
import {
    CallAcceptPayload,
    ServerToClientEvents,
    ClientToServerEvents,
    CallOfferPayload,
    CallOfferInitPayload,
    CallAnswerPayload,
    CallIceCandidatePayload,
    CallEndPayload,
    CallRejectPayload,
    CallStatePayload,
    CallRingingPayload,
    SocketEvents,
} from "@chat/types";

type IO = IOServer<ClientToServerEvents, ServerToClientEvents>;
type Socket = import("socket.io").Socket<
    ClientToServerEvents,
    ServerToClientEvents
>;

export function callHandler(io: IO, socket: Socket) {
    const userRoom = (userId: string) => `user:${userId}`;

    socket.on(
        SocketEvents.CALL_OFFER_INIT,
        ({ callId, conversationId, to, callType }: CallOfferInitPayload) => {
            const from = socket.data.userId;
            if (!to) return;

            io.to(userRoom(to)).emit(SocketEvents.CALL_RINGING, {
                callId,
                conversationId,
                from,
                to,
            });

            const statePayload: CallStatePayload = {
                callId,
                conversationId,
                status: "ringing",
                participants: [{ userId: from }, { userId: to }],
                serverTs: new Date(),
            };

            io.to(userRoom(from)).emit(SocketEvents.CALL_STATE, statePayload);
            io.to(userRoom(to)).emit(SocketEvents.CALL_STATE, statePayload);

            io.to(userRoom(to)).emit(SocketEvents.CALL_OFFER_INIT, {
                callId,
                conversationId,
                from,
                to,
                callType,
            });
        }
    );

    socket.on(SocketEvents.CALL_OFFER, ({ to, offer }: CallOfferPayload) => {
        const from = socket.data.userId;
        if (!to) return;

        io.to(userRoom(to)).emit(SocketEvents.CALL_OFFER, {
            from,
            to,
            offer,
        });
    });

    socket.on(SocketEvents.CALL_ANSWER, ({ to, answer }: CallAnswerPayload) => {
        const from = socket.data.userId;
        if (!to) return;

        io.to(userRoom(to)).emit(SocketEvents.CALL_ANSWER, {
            from,
            to,
            answer,
        });
    });

    socket.on(SocketEvents.CALL_ICE_CANDIDATE, ({ to, candidate, callId }: CallIceCandidatePayload) => {
        const from = socket.data.userId;
        if (!to) return;

        io.to(userRoom(to)).emit(SocketEvents.CALL_ICE_CANDIDATE, {
            callId,
            from,
            to,
            candidate,
        });
    });

    socket.on(SocketEvents.CALL_ACCEPT, ({ callId, conversationId, to, acceptedAt, deviceId }: CallAcceptPayload) => {
        const from = socket.data.userId;
        if (!to) return;

        io.to(userRoom(to)).emit(SocketEvents.CALL_ACCEPT, {
            callId,
            conversationId,
            from,
            to,
            acceptedAt: acceptedAt ?? new Date(),
            deviceId,
        });
    });

    socket.on(SocketEvents.CALL_REJECT, ({ callId, conversationId, to, reason }: CallRejectPayload) => {
        const from = socket.data.userId;
        if (!to) return;

        io.to(userRoom(to)).emit(SocketEvents.CALL_REJECT, {
            callId,
            conversationId,
            from,
            to,
            reason,
        });
    });

    socket.on(SocketEvents.CALL_END, ({ to }: CallEndPayload) => {
        const from = socket.data.userId;
        if (!to) return;

        io.to(userRoom(to)).emit(SocketEvents.CALL_END, {
            from,
            to,
        });
    });

    socket.on(SocketEvents.CALL_BUSY, ({ to }: CallRingingPayload) => {
        const from = socket.data.userId;
        if (!to) return;

        io.to(userRoom(to)).emit(SocketEvents.CALL_BUSY, {
            from,
            to,
        });
    });

    socket.on(SocketEvents.CALL_RECONNECT, ({ to, callId }) => {
        const from = socket.data.userId;
        if (!to) return;

        io.to(userRoom(to)).emit(SocketEvents.CALL_RECONNECT, {
            callId,
            from,
            to,
        });
    });
}