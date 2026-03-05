import knex from "knex";
import Redis from "ioredis";
import { env } from "../env.ts";
import { logger } from "./logger.ts";

export const db = knex({
    client: "mysql2",
    connection: {
        host: env.VINO_JP_CONFIG_DB_HOST,
        port: env.VINO_JP_CONFIG_DB_PORT,
        user: env.VINO_JP_CONFIG_DB_USERNAME,
        password: env.VINO_JP_CONFIG_DB_PASSWORD,
        database: env.VINO_JP_CONFIG_DB_NAME,
        charset: "utf8mb4",
    },
});

export const db_whitelist = knex({
    client: "mysql2",
    connection: {
        host: env.VINO_JP_CONFIG_DB_HOST,
        port: env.VINO_JP_CONFIG_DB_PORT,
        user: env.VINO_JP_CONFIG_DB_USERNAME,
        password: env.VINO_JP_CONFIG_DB_PASSWORD,
        database: env.VINO_JP_CONFIG_WHITELIST_DB_NAME,
        charset: "utf8mb4",
    },
});

/** Shared Redis singleton — use this instead of creating new Redis() per module */
export const redis = new Redis();

redis.on("error", (err) => logger.error("Redis connection error: %s", err.message));
