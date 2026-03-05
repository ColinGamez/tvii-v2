import express, { type Request, type Response } from "express";
import { logger } from "../../utils/logger.ts";

const router = express.Router();

/**
 * Empathy (Yeah!) stub — Miiverse forwarding is handled server-side
 * via social.ts now. This endpoint exists only so the client doesn't
 * get a 404 if it sends a request here.
 */
router.post(
    "/:postid/empathies",
    async (_req: Request, res: Response): Promise<any> => {
        try {
            logger.info("OLV empathy stub hit for post %s", _req.params.postid);
            return res.status(200).json({ status: "ok" });
        } catch (error) {
            logger.error("OLV empathy stub error: %s", (error as Error).message);
            return res.status(500).json({
                error: "Internal server error",
            });
        }
    }
);

export { router as miiverse };
