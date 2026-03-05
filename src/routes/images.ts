import express, { type Request, type Response, type Router } from "express";
import sharp from "sharp";
import NodeCache from "node-cache";
import { env } from "../env";
import { logger } from "../utils/logger.ts";

const router: Router = express.Router();

// Allowed domains for the external image proxy (SSRF protection)
const ALLOWED_IMAGE_DOMAINS = new Set([
    "tvpassport.com",
    "www.tvpassport.com",
    "cdn.tvpassport.com",
    "images.tvpassport.com",
    "m.media-amazon.com",
    "image.tmdb.org",
    "tmsimg.com",
    "cdn.projectrose.cafe",
]);

/** Check if a URL's hostname is in the allowlist (including subdomains) */
function isAllowedImageDomain(url: string): boolean {
    try {
        const hostname = new URL(url).hostname.toLowerCase();
        if (ALLOWED_IMAGE_DOMAINS.has(hostname)) return true;
        // Check if it's a subdomain of an allowed domain
        for (const allowed of ALLOWED_IMAGE_DOMAINS) {
            if (hostname.endsWith("." + allowed)) return true;
        }
        return false;
    } catch {
        return false;
    }
}

const imageCache = new NodeCache({
    stdTTL: 60 * 60 * 24 * 7, // 7 days
    checkperiod: 60 * 60, // check expired items every hour
    maxKeys: 500, // cap memory usage
});

router.get("/cdn/:imageId", async (req: Request, res: Response): Promise<any> => {
    try {
        const { imageId } = req.params;
        const width = req.query["width"]
            ? parseInt(req.query["width"] as string, 10)
            : undefined;
        const height = req.query["height"]
            ? parseInt(req.query["height"] as string, 10)
            : undefined;

        const cacheKey = `${imageId}-${width || "auto"}x${height || "auto"}`;
        const cachedImage = imageCache.get<Buffer>(cacheKey);

        if (cachedImage) {
            res.set("Content-Type", "image/png");
            return res.status(200).send(cachedImage);
        }

        const imageUrl = `https://cdn.projectrose.cafe/tvii-jp-d1/${imageId}`;
        const response = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });

        if (!response.ok) {
            return res.status(404).json({ error: "Image not found" });
        }

        // Always convert ArrayBuffer -> Buffer safely
        const arrayBuffer = await response.arrayBuffer();
        let buffer: Buffer = Buffer.from(new Uint8Array(arrayBuffer));

        // Resize if requested
        if (width || height) {
            buffer = await sharp(buffer)
                .resize(width, height, {
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .toBuffer();
        }

        // Cache it
        imageCache.set(cacheKey, buffer);

        res.set("Content-Type", "image/png");
        return res.status(200).send(buffer);
    } catch (err) {
        logger.error("Image proxy error: %s", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

router.get(/^\/cdn\/tvp\/(.+)$/, async (req: Request, res: Response) => {
    try {
        // Strip any leading slashes from captured path
        const imagePath = req.params[0].replace(/^\/+/, "");

        const width = req.query.width
            ? parseInt(req.query.width as string, 10)
            : undefined;

        const height = req.query.height
            ? parseInt(req.query.height as string, 10)
            : undefined;

        // External URL proxy: /cdn/tvp/ext/<base64url-encoded-url>
        const extMatch = imagePath.match(/^ext\/(.+)$/);
        let imageUrl: string;
        let fetchOptions: any;

        if (extMatch) {
            try {
                imageUrl = Buffer.from(extMatch[1], "base64url").toString("utf-8");
            } catch {
                return res.status(400).json({ error: "Invalid encoded URL" });
            }
            if (!/^https?:\/\//i.test(imageUrl)) {
                return res.status(400).json({ error: "Only HTTP(S) URLs allowed" });
            }
            if (!isAllowedImageDomain(imageUrl)) {
                return res.status(403).json({ error: "Domain not allowed" });
            }
            fetchOptions = {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                    "Accept": "image/avif,image/webp,image/apng,image/png,image/*,*/*;q=0.8",
                },
            };
        } else {
            imageUrl = `https://${env.VINO_JP_TV_CDN_URL}/${imagePath}`;
            fetchOptions = {
                tls: { rejectUnauthorized: false },
                headers: {
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept": "image/avif,image/webp,image/apng,image/png,image/*,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Referer": "https://www.tvpassport.com/",
                    "Sec-Fetch-Dest": "image",
                    "Sec-Fetch-Mode": "no-cors",
                    "Sec-Fetch-Site": "cross-site",
                },
            };
        }

        const cacheKey = `tvp-${imagePath}-${width || "auto"}x${height || "auto"}`;
        const cachedImage = imageCache.get<Buffer>(cacheKey);

        if (cachedImage) {
            res.set("Content-Type", "image/png");
            return res.status(200).send(cachedImage);
        }

        const response = await fetch(imageUrl, { ...fetchOptions, signal: AbortSignal.timeout(10_000) });

        if (!response.ok) {
            return res.status(404).json({ error: "Image not found" });
        }

        const arrayBuffer = await response.arrayBuffer();

        let buffer: Buffer = Buffer.from(arrayBuffer);

        // Resize if requested
        if (width || height) {
            buffer = await sharp(buffer)
                .resize(width, height, {
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .png()
                .toBuffer();
        }

        imageCache.set(cacheKey, buffer);

        res.set("Content-Type", "image/png");
        return res.status(200).send(buffer);
    } catch (err) {
        logger.error("TVPassport image proxy error: %s", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});

export { router as images };
