import mongoose, { Mongoose } from "mongoose";

// Extend NodeJS global type
declare global {
    var mongooseCache: {
        conn: Mongoose | null;
        promise: Promise<Mongoose> | null;
    };
}

// Initialize global cache if not present
global.mongooseCache = global.mongooseCache || { conn: null, promise: null };

const cached = global.mongooseCache;

export async function connectToDatabase(): Promise<Mongoose> {
    const mongoUri = process.env.MONGODB_URI as string | undefined;

    if (!mongoUri) {
        throw new Error("Please define the MONGODB_URI environment variable in your .env file");
    }
    if (cached.conn) return cached.conn;

    if (!cached.promise) {
        const options = {
            bufferCommands: false,
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 5000,
        };

        cached.promise = mongoose.connect(mongoUri, options);
    }

    try {
        cached.conn = await cached.promise;
    } catch (err) {
        cached.promise = null;
        throw err;
    }

    return cached.conn;
}
import { User } from "@chat/db/models/User";

export interface UserFromDatabase {
    id: string;
    name: string;
    email: string;
    image?: string;
    role: string;
}

export async function getUserFromDB(email: string): Promise<UserFromDatabase | undefined> {
    try {
        await connectToDatabase();

        const user = await User.findOne({ email });

        if (!user) {
            throw new Error("User not found");
        }

        return {
            id: user._id.toString(),
            name: user.username,
            email: user.email,
            image: user.profilePicture,
            role: user.role,
        };
    } catch (error) {
        console.error("Error fetching user from DB:", error);
    }
}
