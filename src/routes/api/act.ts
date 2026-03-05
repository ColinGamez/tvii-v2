import express, { type Request, type Response, type Router } from "express";
import multer from "multer";
//@ts-ignore
import Mii from "@pretendonetwork/mii-js";
import { parseServiceToken } from "../../utils/serviceToken.ts";
import { db } from "../../utils/db.ts";
import { z } from "zod";
import { BskyClient } from "../../utils/bsky.ts";
import { env } from "../../env.ts";
import { encrypt, decrypt } from "../../utils/crypto.ts";
import { logger } from "../../utils/logger.ts";

const isDev = ["dev", "stg"].includes(
    (process.env.VINO_JP_CONFIG_ENV ?? "dev").toLowerCase()
);

const router: Router = express.Router();

const upload = multer();

router.get("/status", async (req: Request, res: Response): Promise<any> => {
    res.status(200).send("ok");
});

router.post(
    "/createAccount",
    upload.none(),
    async (req: Request, res: Response): Promise<any> => {
        try {
            const token = parseServiceToken(req);
            //Creates a new Nintendo TVii account instance for that console
            const data = req.body;

            const serialNumber = token.serial_number;
            const accessKey = token.access_key;
            //Country code
            const countryCode = token.country;
            const principalId = token.pid;

            const existing = await db("account")
                .where({ pid: principalId })
                .first();

            if (existing) {
                logger.warn(
                    "Account already exists for: %s set up from Serial Number %s", token.pid, token.serial_number
                );
                return res.status(500).json({
                    status: "error",
                });
            }

            let mii_name: string;
            let mii_data: string;
            let mii_bday: string;
            let nnid: string | null = null;

            if (isDev) {
                // Dev mode — still try Pretendo Mii API, fall back to defaults
                logger.info("DEV mode — attempting Pretendo Mii check for pid %s", principalId);
                try {
                    const devMiiResp = await fetch(
                        `https://mii-unsecure.ariankordi.net/mii_data/?pid=${principalId}&api_id=1&force_refresh=1`,
                        { signal: AbortSignal.timeout(10_000) }
                    );
                    if (devMiiResp.ok) {
                        const devMiiData = await devMiiResp.json() as any;
                        mii_name = devMiiData.name || "Player";
                        mii_data = devMiiData.data || "";
                        nnid = devMiiData.user_id || null;
                        if (mii_data) {
                            const mii = new Mii(Buffer.from(mii_data, "base64"));
                            mii_bday = mii.birthMonth + "/" + mii.birthDay;
                        } else {
                            mii_bday = "1/1";
                        }
                        logger.info("DEV mode — fetched real Mii for pid %s: %s", principalId, mii_name);
                    } else {
                        throw new Error("Mii API returned " + devMiiResp.status);
                    }
                } catch (err) {
                    logger.info("DEV mode — Mii fetch failed, using defaults: %s", err);
                    mii_name = "Player";
                    mii_data = "";
                    mii_bday = "1/1";
                }
            } else {
                const checkPID = await fetch(
                    `https://mii-unsecure.ariankordi.net/mii_data/?pid=${principalId}&api_id=1&force_refresh=1`,
                    { signal: AbortSignal.timeout(10_000) }
                );
                if (!checkPID.ok) {
                    logger.warn(
                        "Mii Unsecure Pretendo fetching error for: %s %s", token.pid, token.serial_number
                    );
                    return res.status(500).json({
                        status: "error_not_pretendo",
                    });
                }

                const checkPIDData = await checkPID.json() as any;

                mii_name = checkPIDData!.name!;
                mii_data = checkPIDData!.data!;
                nnid = checkPIDData?.user_id || null;

                const mii = new Mii(Buffer.from(mii_data, "base64"));
                mii_bday = mii.birthMonth + "/" + mii.birthDay;
            }

            // Country comes from the NN linked account now, no longer the local country
            if (
                countryCode && countryCode.length != 2
            ) {
                return res.status(500).json({
                    status: "error",
                    error: "Invalid country.",
                });
            }

            //Used for creating the session, will be stored in DB to refresh token.
            let hashedBskyPass = null;
            let hashedBskySess = null;
            let bskyUsername = data.bskyUsernameTemp
                ? data.bskyUsernameTemp
                : null;
            let bskySession = null;
            //If user did log in to Bluesky
            if (
                data.bskyUsernameTemp &&
                data.bskyPasswordTemp &&
                data.bskyUsernameTemp.length &&
                data.bskyPasswordTemp.length
            ) {
                let bsky = new BskyClient();

                bskySession = await bsky.login(
                    data.bskyUsernameTemp,
                    data.bskyPasswordTemp
                );

                if (!bskySession) {
                    logger.warn(
                        "Error fetching bsky login for: %s %s", token.pid, token.serial_number
                    );
                }

                hashedBskyPass = encrypt(data.bskyPasswordTemp);
                hashedBskySess = encrypt(JSON.stringify(bskySession));
            }

            const tvProviderIdChosen = data.tv_provider_id;
            const tvProviderTzChosen = data.tv_provider_tz;

            // Extract the user's IP
            let ip =
                req.headers["cf-connecting-ip"] ||
                req.headers["x-forwarded-for"] ||
                req.ip;

            // If x-forwarded-for contains multiple IPs, take the first
            if (typeof ip === "string" && ip.includes(",")) {
                ip = ip.split(",")[0]!.trim();
            }

            // Strip IPv6 prefix
            if (typeof ip === "string" && ip.startsWith("::ffff:")) {
                ip = ip.substring(7);
            }

            // Validate IP before making external request (SSRF protection)
            const { isIP } = await import("net");
            const ipReq = (typeof ip === "string" && isIP(ip))
                ? await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(10_000) })
                : null;
            const ipInfo = ipReq ? await ipReq.json() as any : null;
            let utc_offset;

            if (
                ipInfo &&
                ipInfo.success &&
                ipInfo.timezone &&
                typeof ipInfo.timezone.offset === "number"
            ) {
                utc_offset = ipInfo.timezone.offset;
            } else {
                // Fallback: derive offset from country code
                logger.warn(
                    "UTC offset fetching error, using country fallback: %s %s", token.pid, token.serial_number
                );
                if (countryCode === "JP") {
                    utc_offset = 32400; // JST +09:00
                } else if (countryCode === "US") {
                    utc_offset = -18000; // EST -05:00 (conservative)
                } else if (countryCode === "CA") {
                    utc_offset = -18000; // EST -05:00
                } else {
                    utc_offset = 0; // UTC fallback
                }
            }

            const userEnv = env.VINO_JP_CONFIG_ENV;

            // Parse favorites before the transaction so we can bail early on bad JSON
            let favorites: any[] = [];
            if (data.favorite_channels) {
                try {
                    favorites = JSON.parse(data.favorite_channels);
                } catch (e) {
                    return res.status(400).json({
                        status: "error",
                        error: "Invalid favorite_channels JSON"
                    });
                }
            }

            // Atomic transaction: account + settings + favorite_channels
            await db.transaction(async (trx) => {
                await trx("account").insert({
                    pid: principalId,
                    country: countryCode,
                    mii_data,
                    mii_name,
                    mii_bday,
                    nnid,
                    utc_offset,
                    serial_number: serialNumber,
                    access_key: accessKey,
                    last_data_update: new Date().toISOString().slice(0, 19).replace("T", " "),
                    env: userEnv,
                });

                await trx("settings").insert({
                    pid: token.pid,
                    tv_provider_id: tvProviderIdChosen,
                    tv_provider_tz: tvProviderTzChosen,
                    bsky_auth_session_json: hashedBskySess,
                    bsky_password_hashed: hashedBskyPass,
                    bsky_username: bskyUsername,
                });

                if (Array.isArray(favorites) && favorites.length > 0) {
                    const now = new Date().toISOString();
                    const uniqueFavs = [...new Set(favorites)];

                    const existingRows = await trx("favorite_channels")
                        .where("pid", token.pid)
                        .select("channel_id");

                    const existingSet = new Set(
                        existingRows.map((r: any) => r.channel_id)
                    );

                    const rows = uniqueFavs
                        .filter((ch) => !existingSet.has(ch))
                        .map((ch) => ({
                            create_time: now,
                            pid: token.pid,
                            channel_id: ch,
                        }));

                    if (rows.length > 0) {
                        await trx("favorite_channels").insert(rows);
                    }
                }
            });

            logger.success("Account created for pid %s", token.pid);

            res.status(200).json({
                status: "verified",
                pid: token.pid,
            });
        } catch (error) {
            logger.error("/createAccount error: %s", error);
            res.status(500).json({
                status: "error",
                error: "Internal server error",
            });
        }
    }
);

router.get("/favorites", async (req: Request, res: Response): Promise<any> => {
    try {
        const token = parseServiceToken(req);
        if (!token && !isDev) {
            return res.status(401).json({ status: "error", error: "Unauthorized" });
        }
        const pid = token?.pid ?? 0;

        const rows = await db("favorite_channels")
            .where("pid", pid)
            .select("channel_id");

        const channelIds = rows.map((r: any) => r.channel_id);
        return res.json({ status: "ok", channels: channelIds });
    } catch (err: any) {
        logger.error("Error fetching favorites: %s", err.message);
        return res.status(500).json({ status: "error", error: "Internal server error" });
    }
});

router.post("/favorites", async (req: Request, res: Response): Promise<any> => {
    try {
        const token = parseServiceToken(req);
        if (!token && !isDev) {
            return res.status(401).json({ status: "error", error: "Unauthorized" });
        }
        const pid = token?.pid ?? 0;
        const { channels } = req.body;

        if (!Array.isArray(channels)) {
            return res.status(400).json({ status: "error", error: "channels must be an array" });
        }

        const now = new Date().toISOString();
        const uniqueChannels = [...new Set(channels)] as string[];

        await db.transaction(async (trx) => {
            await trx("favorite_channels").where("pid", pid).del();

            if (uniqueChannels.length > 0) {
                const rows = uniqueChannels.map((ch) => ({
                    create_time: now,
                    pid: pid,
                    channel_id: ch,
                }));
                await trx("favorite_channels").insert(rows);
            }
        });

        logger.info("Favorites updated for pid %s (%d channels)", pid, uniqueChannels.length);
        return res.json({ status: "ok" });
    } catch (err: any) {
        logger.error("Error updating favorites: %s", err.message);
        return res.status(500).json({ status: "error", error: "Internal server error" });
    }
});

router.get("/reminders", async (req: Request, res: Response): Promise<any> => {
    try {
        const token = parseServiceToken(req);
        if (!token && !isDev) {
            return res.status(401).json({ status: "error", error: "Unauthorized" });
        }
        const pid = token?.pid ?? 0;

        const rows = await db("reminders")
            .where({ pid })
            .orderBy("start_time", "asc")
            .select("id", "listing_id", "channel_id", "channel_name", "program_name", "start_time", "created_at");

        res.status(200).json({
            status: "success",
            reminders: rows,
        });
    } catch (error) {
        logger.error("/reminders error: %s", error);
        res.status(500).json({
            status: "error",
            error: "Internal server error.",
        });
    }
});

/* ── Check if a specific listing has a reminder ─────────── */
router.get("/reminders/check", async (req: Request, res: Response): Promise<any> => {
    try {
        const token = parseServiceToken(req);
        if (!token && !isDev) {
            return res.status(401).json({ status: "error", error: "Unauthorized" });
        }
        const pid = token?.pid ?? 0;
        const listingId = String(req.query.listingId ?? "");
        if (!listingId) {
            return res.status(400).json({ status: "error", error: "Missing listingId" });
        }

        const row = await db("reminders").where({ pid, listing_id: listingId }).first();
        res.status(200).json({
            status: "success",
            hasReminder: !!row,
            reminder: row ?? null,
        });
    } catch (error) {
        logger.error("/reminders/check error: %s", error);
        res.status(500).json({ status: "error", error: "Internal server error." });
    }
});

/* ── Create a reminder ──────────────────────────────────── */
router.post("/reminders", async (req: Request, res: Response): Promise<any> => {
    try {
        const token = parseServiceToken(req);
        if (!token && !isDev) {
            return res.status(401).json({ status: "error", error: "Unauthorized" });
        }
        const pid = token?.pid ?? 0;

        const schema = z.object({
            listingId: z.string().min(1),
            channelId: z.string().min(1),
            channelName: z.string().optional().default(""),
            programName: z.string().optional().default(""),
            startTime: z.string().min(1),
        });

        const parsed = schema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ status: "error", error: "Invalid body", details: parsed.error.issues });
        }

        const { listingId, channelId, channelName, programName, startTime } = parsed.data;

        // Upsert — ignore if already exists
        await db("reminders")
            .insert({
                pid,
                listing_id: listingId,
                channel_id: channelId,
                channel_name: channelName,
                program_name: programName,
                start_time: startTime,
            })
            .onConflict(["pid", "listing_id"])
            .ignore();

        res.status(200).json({ status: "success" });
    } catch (error) {
        logger.error("/reminders POST error: %s", error);
        res.status(500).json({ status: "error", error: "Internal server error." });
    }
});

/* ── Delete a reminder ──────────────────────────────────── */
router.delete("/reminders", async (req: Request, res: Response): Promise<any> => {
    try {
        const token = parseServiceToken(req);
        if (!token && !isDev) {
            return res.status(401).json({ status: "error", error: "Unauthorized" });
        }
        const pid = token?.pid ?? 0;
        const listingId = String(req.query.listingId ?? req.body?.listingId ?? "");
        if (!listingId) {
            return res.status(400).json({ status: "error", error: "Missing listingId" });
        }

        await db("reminders").where({ pid, listing_id: listingId }).delete();
        res.status(200).json({ status: "success" });
    } catch (error) {
        logger.error("/reminders DELETE error: %s", error);
        res.status(500).json({ status: "error", error: "Internal server error." });
    }
});

export { router as account };
