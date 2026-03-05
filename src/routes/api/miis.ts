import express, { type Request, type Response, type Router } from "express";
import NodeCache from "node-cache";
import { logger } from "../../utils/logger.ts";

const router: Router = express.Router();

const cache = new NodeCache({
    stdTTL: 168 * 60 * 60, // 7 days
    checkperiod: 60 * 60, // cleanup every hour
    maxKeys: 500, // cap memory usage
});

// Allowlist of params forwarded to the external Mii API
const MII_ALLOWED_PARAMS = ["width", "expression", "data", "type", "texResolution", "resourceType"];

router.get("/", async (req: Request, res: Response) => {
    try {
        // Filter query params to allowlisted keys only
        const filtered = new URLSearchParams();
        for (const key of MII_ALLOWED_PARAMS) {
            const val = req.query[key];
            if (typeof val === "string") filtered.set(key, val);
        }
        const query = filtered.toString();

        const cached = cache.get<Buffer>(query);
        if (cached) {
            res.contentType("image/png");
            return res.send(cached);
        }

        const url =
            `https://mii-unsecure.ariankordi.net/miis/image.png?verifyCRC16=1&${query}`;

        const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });

        if (!response.ok) {
            return res.status(response.status).send("Image fetch failed");
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        cache.set(query, buffer);
        res.contentType("image/png");
        res.send(buffer);

    } catch (err) {
        logger.error("Mii image fetch error: %s", err);
        res.status(500).send("Failed to fetch image");
    }
});

export { router as miis };
