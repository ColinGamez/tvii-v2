import express, { type Application } from "express";
import { env } from "./src/env.ts";
import { access } from "./src/middleware/access.ts";
import { join } from "path";
import { exports } from "./src/routes/exports.ts";
import { logger } from "./src/utils/logger.ts";

const app: Application = express();
const port: number = env.VINO_JP_CONFIG_PORT;

// Request logging (dev)
app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
        logger.info("%s %s -> %d (%dms)", req.method, req.url, res.statusCode, Date.now() - start);
    });
    next();
});

// Middleware
app.use(access);
app.use(express.json());

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


// Starts the HTTP server (nginx handles TLS termination for Wii U compatibility)
app.listen(port, () => {
    logger.info("Server is running on port: %d!", port);
});
