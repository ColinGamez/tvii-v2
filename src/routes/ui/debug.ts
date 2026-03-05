import express, { type Request, type Response, type Router } from "express";
import { join } from "path";
import { env } from "../../env.ts";
import { parseServiceToken } from "../../utils/serviceToken.ts";

const router: Router = express.Router();

// Serves the first debug HTML page
router.get("/01", (_req: Request, res: Response) => {
    res.sendFile(
        join(__dirname, "..", "..", "..", "pages", "debug", "debug1.html")
    );
});

router.get("/02", (_req: Request, res: Response) => {
    res.sendFile(
        join(__dirname, "..", "..", "..", "pages", "debug", "debug2.html")
    );
});

// Dev-only: parse service token and return the fields for diagnostics
if (env.VINO_JP_CONFIG_ENV === "dev") {
    router.get("/token", (req: Request, res: Response) => {
        const token = parseServiceToken(req);
        res.status(200).json({
            raw_header_present: !!req.headers["x-nintendo-service-token"],
            parsed: {
                ok: token.ok,
                pid: token.pid,
                country: token.country,
                version: token.version,
                serial_number: token.serial_number ? "***" : undefined,
                access_key: token.access_key ? "***" : undefined,
            },
            env: env.VINO_JP_CONFIG_ENV,
        });
    });
}

export { router as vinoDebug };
