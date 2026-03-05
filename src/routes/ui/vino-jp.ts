import express, { type Request, type Response, type Router } from "express";
import { join } from "path";
import { parseServiceToken } from "../../utils/serviceToken.ts";
import { db } from "../..//utils/db.ts";
import { getRegion } from "../..//utils/other.ts";
import Mii from "@pretendonetwork/mii-js";
import { logger } from "../../utils/logger.ts";

const isDev = ["dev", "stg"].includes(
    (process.env.VINO_JP_CONFIG_ENV ?? "dev").toLowerCase()
);

function mysqlNow(): string {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

const router: Router = express.Router();

// Serves the frontend HTML
router.get("/", async (req: Request, res: Response): Promise<any> => {
    const token = parseServiceToken(req);

    if (!token.ok) {
        return res.sendStatus(404);
    }

    res.redirect("/index.html");
});

// Serves the frontend HTML
router.get("/setup.html", async (req: Request, res: Response): Promise<any> => {
    const lang = (req.headers["accept-language"] || "en").split(",")[0]!.split("-")[0]!.toLowerCase();
    const token = parseServiceToken(req);

    if (!token.ok) {
        return res.sendStatus(404);
    }

    const account = await db("account")
        .where({
            pid: token.pid,
            serial_number: token.serial_number,
            access_key: token.access_key,
        })
        .first();

    // If account, redirect to default
    if (account) {
        return res.redirect("/index.html");
    }

    res.render("setup.ejs", {
        pid: token.pid,
        country: token.country,
        lang: lang,
        region: getRegion(token.country!)
    });
});

router.get("/index.html", async (req: Request, res: Response): Promise<any> => {
    const lang = (req.headers["accept-language"] || "en")
        .split(",")[0]!.split("-")[0]!.toLowerCase();

    const token = parseServiceToken(req);

    if (!token.ok) {
        return res.sendStatus(404);
    }

    // Fetch account + settings
    const account = await db("account")
        .leftJoin("settings", "settings.pid", "account.pid")
        .select(
            "account.*",
            "settings.pid as setting_pid",
            "settings.tv_provider_id",
            "settings.tv_provider_tz"
        )
        .where({
            "account.pid": token.pid,
            "account.serial_number": token.serial_number,
            "account.access_key": token.access_key,
        })
        .first();

    if (!account) {
        return res.redirect("/setup.html");
    }

    const country = token.country;
    let utc_offset = account.utc_offset;

    const updateValues: any = {};

    // update country if changed
    if (account.country !== country) {
        updateValues.country = country;
    }

    // check 1 hour rule
    const now = new Date();
    const lastUpdate = account.last_data_update
        ? new Date(account.last_data_update)
        : new Date(0);

    const oneHour = 60 * 60 * 1000;

    if (now.getTime() - lastUpdate.getTime() > oneHour) {
        try {
            const updateMiiData = await fetch(
                `https://mii-unsecure.ariankordi.net/mii_data/?pid=${token.pid}&api_id=1&force_refresh=1`,
                { signal: AbortSignal.timeout(10_000) }
            );

            if (updateMiiData.ok) {
                const PIDData = await updateMiiData.json() as any;

                const mii_name = PIDData.name;
                const mii_data = PIDData.data;
                const nnid = PIDData.user_id || null;

                let mii_bday: string | undefined;
                if (mii_data) {
                    const mii = new Mii(Buffer.from(mii_data, "base64"));
                    mii_bday = mii.birthMonth + "/" + mii.birthDay;
                }

                // Extract real IP (Cloudflare first)
                let ip =
                    req.headers["cf-connecting-ip"] ||
                    req.headers["x-forwarded-for"] ||
                    req.ip;

                if (typeof ip === "string" && ip.includes(",")) {
                    ip = ip.split(",")[0]!.trim();
                }

                if (typeof ip === "string" && ip.startsWith("::ffff:")) {
                    ip = ip.substring(7);
                }

                // timezone lookup (validate IP first to prevent SSRF)
                const { isIP } = await import("net");
                const ipReq = (typeof ip === "string" && isIP(ip))
                    ? await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(10_000) })
                    : null;
                const ipInfo = ipReq ? await ipReq.json() as any : null;

                if (
                    ipInfo?.success &&
                    ipInfo?.timezone &&
                    typeof ipInfo.timezone.offset === "number"
                ) {
                    utc_offset = ipInfo.timezone.offset;
                } else if (account.country === "JP") {
                    utc_offset = 32400; // JST +09:00 fallback
                }

                Object.assign(updateValues, {
                    mii_name,
                    mii_data,
                    ...(mii_bday ? { mii_bday } : {}),
                    ...(nnid ? { nnid } : {}),
                    utc_offset,
                    last_data_update: mysqlNow(),
                });

                console.log(`PNID Data + UTC updated for PID ${token.pid}`);
            } else {
                updateValues.last_data_update = mysqlNow();
            }
        } catch (err) {
            console.warn("Mii/IP update failed:", err);
            updateValues.last_data_update = mysqlNow();
        }
    }

    // apply DB updates
    if (Object.keys(updateValues).length > 0) {
        await db("account")
            .where({
                pid: token.pid,
                serial_number: token.serial_number,
                access_key: token.access_key,
            })
            .update(updateValues);

        Object.assign(account, updateValues);
    }

    // render (always correct values)
    res.render("index.ejs", {
        pid: token.pid,
        country: account.country,
        region: getRegion(account.country),
        tz_name: account.tv_provider_tz,
        tv_provider_id: account.tv_provider_id,
        utc_offset: account.utc_offset,
        lang: lang,
    });
});



router.get("/manual", (_req: Request, res: Response) => {
    res.sendFile(join(__dirname, "..", "..", "pages", "manual.html"));
});

export { router as vinoRoute };
