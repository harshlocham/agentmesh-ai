import { initRedis } from "./redis.js";
import { initIO } from "./io.js";
import { socketAuth } from "./middleware/auth.js";
import messageEditHandler from "./handlers/message/edit.handler.js";
import { DeleteHandler } from "./handlers/message/delete.handler.js";
import { adminHandler } from "./handlers/admin/admin.js";
import { presenceHandler } from "./handlers/presence/presence.handler.js";
import { registerMessageHandlers } from "./handlers/message/message.handler.js";
import { deliveredHandler } from "./handlers/delivery/delivered.handler.js";
import { SeenHandler } from "./handlers/delivery/seen.handler.js";
import { callHandler } from "./handlers/call/call.handler.js";
import { cleanupStaleActiveUsers } from "./services/presence.redis.service.js";
import { SocketEvents } from "@chat/types";

import { typingHandler } from "./handlers/typing/typing.handler.js";
import type { Socket } from "socket.io";
import { registerIO } from "./emit.js";
import type { Server as HTTPServer } from "http";

export async function initSocket(server: HTTPServer) {
    const redis = await initRedis();
    const io = initIO(server, redis);
    registerIO(io);

    const presenceSweep = setInterval(() => {
        void (async () => {
            try {
                const staleUsers = await cleanupStaleActiveUsers(redis.appClient);
                if (staleUsers.length === 0) return;

                for (const userId of staleUsers) {
                    io.emit(SocketEvents.USER_OFFLINE, {
                        userId,
                        lastSeen: new Date(),
                    });
                }
            } catch (error) {
                console.error("presence sweep error", error);
            }
        })();
    }, 5000);

    server.on("close", () => {
        clearInterval(presenceSweep);
    });

    io.use(socketAuth);

    io.on("connection", (socket: Socket) => {
        const userId = socket.data.userId;
        socket.join(`user:${userId}`);
        console.log("🔌 socket connected:", socket.id);
        adminHandler(io, socket, redis);
        presenceHandler(io, socket, redis.appClient);
        registerMessageHandlers(io, socket, redis.appClient);
        deliveredHandler(io, socket, redis.appClient);
        SeenHandler(io, socket, redis.appClient);
        callHandler(io, socket);
        typingHandler(io, socket);
        messageEditHandler(io, socket);
        DeleteHandler(io, socket);
    });
}