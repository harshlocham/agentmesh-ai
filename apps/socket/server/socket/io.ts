import { Server as SocketIOServer } from "socket.io";
import type { Server as HTTPServer } from "http";
import { createAdapter } from "@socket.io/redis-adapter";
import type { RedisAdapterClients } from "./redis.js";
import {
    isOriginAllowed,
    parseCommaSeparatedValues,
} from "./utils/url.js";

export function initIO(
    httpServer: HTTPServer,
    redis: RedisAdapterClients
) {
    const allowedOrigins = parseCommaSeparatedValues(process.env.ORIGIN);

    const io = new SocketIOServer(httpServer, {
        path: "/api/socket",
        cors: {
            origin: (origin, callback) => {
                if (isOriginAllowed(origin, allowedOrigins)) {
                    return callback(null, true);
                }

                return callback(new Error("Origin not allowed"));
            },
            methods: ["GET", "POST"],
            credentials: true,
        },
        allowRequest: (req, callback) => {
            const originHeader = req.headers.origin;

            return callback(null, isOriginAllowed(originHeader, allowedOrigins));
        },
        maxHttpBufferSize: 1e6,
        connectTimeout: 10_000,
    });

    if (!redis.isMock) {
        io.adapter(createAdapter(redis.pubClient, redis.subClient));
    } else {
        console.warn("⚠️ Running socket server without Redis adapter (development mock mode).");
    }

    return io;
}