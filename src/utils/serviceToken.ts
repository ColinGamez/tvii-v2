import type { Request } from "express";
import { env } from "../env.ts";
import { logger } from "./logger.ts";

const isDev = ["dev", "stg"].includes(
    (process.env.VINO_JP_CONFIG_ENV ?? "dev").toLowerCase()
);

export function parseServiceToken(req: Request): {
    ok: boolean;
    pid: number | undefined;
    access_key: string | undefined;
    serial_number: string | undefined;
    version: string | undefined;
    country: string | undefined;
} {
    // Try both possible header names (with and without hyphen)
    const rawHeader =
        req.headers["x-nintendo-servicetoken"] ??
        req.headers["x-nintendo-service-token"];

    // In dev mode without a token, return a synthetic dev token so all routes work
    if (isDev && (!rawHeader || typeof rawHeader !== "string")) {
        logger.info("DEV mode — no service token, using synthetic dev token for %s", req.path);
        return {
            ok: true,
            pid: 0,
            access_key: "dev",
            serial_number: "DEV000000000",
            version: "v1.2.6",
            country: "JP",
        };
    }

    if (!rawHeader || typeof rawHeader !== "string") {
        return {
            ok: false,
            pid: undefined,
            serial_number: undefined,
            access_key: undefined,
            version: undefined,
            country: undefined,
        };
    }

    if (isDev) {
        logger.info("Token debug — raw header value (first 40 chars): %s", rawHeader.substring(0, 40));
    }

    let decoded: string;

    try {
        const data = Buffer.from(rawHeader, "base64");
        const buf = Buffer.alloc(data.length);
        const secret = env.VINO_JP_TOKEN_SECRET;

        for (let i = 0; i < data.length; i++) {
            buf[i] = data[i]! ^ secret.charCodeAt(i % secret.length);
        }

        decoded = buf.toString("utf8");
    } catch (e) {
        return {
            ok: false,
            pid: undefined,
            serial_number: undefined,
            access_key: undefined,
            version: undefined,
            country: undefined,
        };
    }

    const headerParts = decoded.split(",").map(p => p.trim());

    if (headerParts.length < 6) {
        return {
            ok: false,
            pid: undefined,
            serial_number: undefined,
            access_key: undefined,
            version: undefined,
            country: undefined,
        };
    }

    const pid = Number(headerParts[0]);
    const access_key = headerParts[1];
    const serial_number = `${headerParts[2]}${headerParts[3]}`; // combine third and fourth for serial
    const country = headerParts[4];
    const version = headerParts[5];

    return {
        ok: true,
        pid: isNaN(pid) ? undefined : pid,
        access_key,
        serial_number,
        country,
        version,
    };
}
