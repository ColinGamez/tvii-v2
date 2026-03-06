import express, { type Application, type Request, type Response, type NextFunction } from "express";
import { env } from "./src/env.ts";
import { access } from "./src/middleware/access.ts";
import { join } from "path";
import { exports } from "./src/routes/exports.ts";
import { logger } from "./src/utils/logger.ts";
import { db, db_whitelist, redis } from "./src/utils/db.ts";

const app: Application = express();
const port: number = env.VINO_JP_CONFIG_PORT;

app.set("trust proxy", 1); // trust first proxy (nginx)

// Request logging (dev)
app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        logger.info("%s %s -> %d (%dms)", req.method, req.url, res.statusCode, Date.now() - start);
    });
    next();
});

// Health check — unauthenticated, lightweight (before auth middleware)
app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
});

// Middleware
app.use(access);
app.use(express.json({ limit: "2mb" }));

// Prevent Wii U browser from aggressively caching JS/CSS
app.use((req, res, next) => {
    if (req.path.endsWith(".js") || req.path.endsWith(".css")) {
        res.set("Cache-Control", "no-cache, no-store, must-revalidate");
        res.set("Pragma", "no-cache");
        res.set("Expires", "0");
    }
    next();
});

app.set("view engine", "ejs");

app.set("views", __dirname + "/pages");

app.use(express.static(join(__dirname, "static"))); // Serves our static files

app.disable("X-Powered-By");

// Auto imports routes instead of import of bunch manually
for (let i = 0; i < exports.length; i++) {
    const route = exports[i];
    app.use(route!.path, route!.route);
    logger.success(
        `Successfully imported '${route!.name}' routes at '${route!.path}'!`
    );
}


// Global error handler — catches unhandled errors in route handlers
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error("Unhandled error: %s", err.message);
    if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
    }
});

process.on("unhandledRejection", (reason) => {
    logger.error("Unhandled rejection: %O", reason);
});

// Starts the HTTP server (nginx handles TLS termination for Wii U compatibility)
const server = app.listen(port, () => {
    logger.info("Server is running on port: %d!", port);
});

// ── Graceful shutdown ────────────────────────────────────────
function shutdown(signal: string) {
    logger.info("Received %s — shutting down gracefully…", signal);
    server.close(async () => {
        try { await redis.quit(); } catch { /* already closed */ }
        try { await db.destroy(); } catch { /* already closed */ }
        try { await db_whitelist.destroy(); } catch { /* already closed */ }
        logger.info("Cleanup complete. Exiting.");
        process.exit(0);
    });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
