import { parseServiceToken } from "../utils/serviceToken.ts";
import { type Request, type Response, type NextFunction } from "express";
import {db, db_whitelist} from "../utils/db.ts";
import { logger } from "../utils/logger.ts";
import { env, APP_VERSION } from "../env.ts";
import { join } from "path";

const environment = env.VINO_JP_CONFIG_ENV as "dev" | "stg" | "prod";
const latest_version = APP_VERSION;

/** Check whitelist for a given PID. Returns true if allowed, false otherwise. */
async function checkWhitelist(pid: string | number): Promise<boolean> {
    const whitelistRow = await db_whitelist("access_allowlist")
        .where("pid", pid)
        .first();

    const whitelistEnv = (whitelistRow?.env ?? "prod") as
        | "dev"
        | "stg"
        | "prod";

    const allowedEnvs: Record<"dev" | "stg" | "prod", string[]> = {
        dev: ["dev", "stg", "prod"],
        stg: ["stg", "prod"],
        prod: ["prod"],
    };

    return !!whitelistEnv && allowedEnvs[whitelistEnv].includes(environment);
}

const middleware = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<any> => {
    // ── API routes: lightweight auth (JSON errors) ──
    if (req.path.startsWith("/api/")) {
        // Dev mode: skip all checks
        if (environment === "dev") return next();

        const serviceToken = parseServiceToken(req);
        if (!serviceToken?.pid) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        try {
            if (!(await checkWhitelist(serviceToken.pid))) {
                return res.status(403).json({ error: "Forbidden" });
            }
        } catch (err) {
            logger.error("Whitelist DB query failed (API): %s", err);
            return res.status(503).json({ error: "Service temporarily unavailable" });
        }

        return next();
    }

    // ── UI routes ──

    // In dev mode, bypass token validation entirely (HTTP mode — AIST won't fire)
    if (environment === "dev") {
        logger.info("DEV mode — skipping token validation for %s", req.path);
        return next();
    }

    const serviceToken = parseServiceToken(req);

    if (
        !serviceToken ||
        !serviceToken.pid ||
        !serviceToken.serial_number ||
        !serviceToken.access_key ||
        !serviceToken.version
    ) {
        logger.warn("Invalid service token: %j", serviceToken);
        return res
            .contentType("text/html")
            .sendFile(
                join(__dirname, "..", "..", "pages", "error", "invalidToken.html")
            );
    }

    if (!serviceToken.version || serviceToken.version !== latest_version) {
        logger.error(
            "User has outdated Rose Patcher: %j", serviceToken);
        return res
            .contentType("text/html")
            .render("error/outdatedPlugin", {
                version: APP_VERSION.replace(/^v/, ""),
            });
    }

    try {
        if (!(await checkWhitelist(serviceToken.pid))) {
            logger.warn(
                "User %s tried to access %s without whitelist permission",
                serviceToken.pid,
                environment
            );
            return res
                .contentType("text/html")
                .sendFile(
                    join(
                        __dirname,
                        "..",
                        "..",
                        "pages",
                        "error",
                        "unauthorized_en.html"
                    )
                );
        }
    } catch (err) {
        logger.error("Whitelist DB query failed (UI): %s", err);
        return res.status(503).send("Service temporarily unavailable");
    }

    return next();
};

export { middleware as access };
