import express, { type Request, type Response, type Router } from "express";
import multer from "multer";
import { env } from "../../env.ts";
import { BskyClient } from "../../utils/bsky.ts";
import { parseServiceToken } from "../../utils/serviceToken.ts";
import { db } from "../../utils/db.ts";
import { encrypt, decrypt } from "../../utils/crypto.ts";
import { logger } from "../../utils/logger.ts";

const isDev = ["dev", "stg"].includes(
    (env.VINO_JP_CONFIG_ENV ?? "dev").toLowerCase()
);

function buildSocialPost(
    maxLength: number,
    topicTag: string | null,
    body: string | null,
    type: number
): string {
    const MIN_TAG_LEN = 40;
    const MAX_BODY_LEN = 200;
    const MAX_TWEET_LEN = maxLength;

    topicTag = topicTag || "a TV program";
    body = body || "";

    const prefix = type === 1
        ? 'Posted while watching "'
        : type === 2
            ? 'Made a memo while watching "'
            : type === 3
                ? 'Made a doodle while watching "'
                : '';
    const suffix = " #NintendoTVii"; // always the same now

    let tweetText: string;

    if (type === 1 || type === 3) {
        // Cap body length first
        if (body.length > MAX_BODY_LEN) {
            body = body.slice(0, MAX_BODY_LEN - 1) + "…";
        }

        // Compute available length for topicTag considering prefix + body + 2 quotes + suffix
        const fixedLen = prefix.length + body.length + 2 + suffix.length; // 2 quotes for topic and body
        let availableTagLen = MAX_TWEET_LEN - fixedLen;

        if (availableTagLen < MIN_TAG_LEN) {
            availableTagLen = MIN_TAG_LEN; // force minimum
        }

        if (topicTag.length > availableTagLen) {
            topicTag = topicTag.slice(0, availableTagLen - 1) + "…";
        }

        tweetText = `${prefix}${topicTag}": "${body}"${suffix}`;
    } else {
        // No body — topic can take almost everything
        const fixedLen = prefix.length + 2 + suffix.length; // 2 quotes
        let availableTagLen = MAX_TWEET_LEN - fixedLen;

        if (topicTag.length > availableTagLen) {
            topicTag = topicTag.slice(0, availableTagLen - 1) + "…";
        }

        tweetText = `${prefix}${topicTag}"${suffix}`;
    }

    return tweetText;
}

const router: Router = express.Router();

const upload = multer();

import {
    S3Client,
    ObjectCannedACL,
    PutObjectCommand,
} from "@aws-sdk/client-s3";
import { redis } from "../../utils/db.ts";
import * as cheerio from "cheerio";

// Create S3 client for MinIO
const s3 = new S3Client({
    endpoint: env.VINO_JP_MINIO_PUBLIC_URL, // MinIO URL (http://localhost:9000)
    region: "us-east-1", // MinIO ignores, but AWS SDK requires it
    credentials: {
        accessKeyId: env.VINO_JP_MINIO_ACCESS_KEY,
        secretAccessKey: env.VINO_JP_MINIO_SECRET_KEY,
    },
    forcePathStyle: true, // REQUIRED for MinIO
});

router.post(
    "/BSLoginCheck",
    upload.none(),
    async (_req: Request, res: Response): Promise<any> => {
        try {
            //Just checks if the account exists
            //Session is created and put on DB once the account actually gets created and inserted.
            const data = _req.body;
            const identifier = data.username;
            const passwd = data.password;

            if (!identifier || !passwd) {
                res.status(400).send({
                    error: "Identifier and password are required.",
                });
                return;
            }

            const bsky = new BskyClient();

            const check = await bsky.login(identifier, passwd);

            if (!check) {
                return res.status(400).json({ error: "Invalid account." });
            }

            const info = await bsky.agent.getProfile({ actor: check.did });

            res.status(200).json({
                status: "verified",
                active: check.active,
                handle: check.handle,
                displayName: info.data.displayName,
            });
        } catch (error) {
            logger.error("/BSLoginCheck error: %s", error);
            res.status(500).json({ error: "Internal server error." });
        }
    }
);

router.get(
    "/getUserData/:pid",
    async (req: Request, res: Response): Promise<any> => {
        try {
            const pid = req.params.pid!;
            if (!pid) return res.status(400).json({ error: "Missing pid" });

            const account = await db("account")
                .where({ pid })
                .first();

            if (!account) {
                return res.status(404).json({ error: "Account not found" });
            }

            const postCountRow = await db("posts")
                .where({ pid })
                .count("* as count")
                .first();

            const post_count = Number(postCountRow?.count || 0);

            // ============================
            // 3️⃣ GET MII USER ID (cache)
            // ============================
            const miiCacheKey = `user:${pid}:cached_data`;
            let user_id: string | null = null;
            let latest_post_id: string | null = null;

            const cachedUserData = await redis.get(miiCacheKey);

            if (cachedUserData) {
                user_id = JSON.parse(cachedUserData).user_id;
                latest_post_id = JSON.parse(cachedUserData).latest_post_id;
            } else {
                try {
                    const miiResp = await fetch(
                        `https://mii-unsecure.ariankordi.net/mii_data/?pid=${pid}&api_id=1`,
                        { signal: AbortSignal.timeout(10_000) }
                    );

                    if (miiResp.ok) {
                        const miiData = await miiResp.json() as any;
                        user_id = miiData?.user_id || null;
                    }

                } catch (err) {
                    logger.error("Mii fetch error: %s", err);
                }

                try {
                    const juxtResp = await fetch(
                        `https://juxt.pretendo.network/users/${pid}`,
                        { signal: AbortSignal.timeout(10_000) }
                    );

                    if (juxtResp.ok) {
                        const html = await juxtResp.text();
                        const $ = cheerio.load(html);

                        // first post wrapper
                        const postWrapper = $(".posts-wrapper").first();

                        if (postWrapper.length) {
                            latest_post_id = postWrapper.attr("id") || null;
                        }
                    }

                    await redis.set(
                        miiCacheKey,
                        JSON.stringify({ user_id, latest_post_id }),
                        "EX",
                        60 * 60 // 1 hour
                    );
                } catch (err) {
                    logger.error("Juxt scrape error: %s", err);
                }
            }

            // TypeScript needed the "as string" for some reason
            if (env.VINO_JP_STAFF_PIDS.includes(pid as string)) {
                user_id = "??????????"
            }

            // Fallback: use stored nnid if external API didn't resolve user_id
            if (!user_id && account.nnid) {
                user_id = account.nnid;
            }

            return res.json({
                mii_name: account.mii_name,
                mii_data: account.mii_data,
                user_id,
                latest_post_id,
                post_count
            });

        } catch (error) {
            logger.error("/getUserData error: %s", error);
            return res.status(500).json({ error: "Internal server error." });
        }
    }
);

router.post(
    "/postsAlt",
    upload.none(),
    async (req: Request, res: Response): Promise<any> => {
        try {
            const token = parseServiceToken(req);

            const account = await db("account")
                .where({
                    pid: token.pid,
                    serial_number: token.serial_number,
                    access_key: token.access_key,
                })
                .first();

            if (!account) {
                return res.status(200).json({ status: "no_account_yet" });
            }

            const userSettings = await db("settings")
                .where({ pid: account.pid })
                .first();

            let bskyAgent = null;
            let resumedSession = null;

            if (!userSettings) {
                return res.status(400).json({
                    status: "error",
                    error: "Could not get user settings.",
                });
            }

            //Check for bsky errors (because bsky is good)
            //Only if user did link bsky to their account
            if (userSettings.bsky_auth_session_json != null) {
                const session = JSON.parse(
                    decrypt(userSettings.bsky_auth_session_json)
                );
                bskyAgent = new BskyClient();

                try {
                    // First try resuming the saved session
                    resumedSession =
                        await bskyAgent.agent.resumeSession(session);
                } catch (resumeErr) {
                    logger.warn(
                        "could not resume bsky session (will try to create new session): %s",
                        resumeErr
                    );

                    try {
                        // Fallback: decrypt stored credentials
                        const username = userSettings.bsky_username;
                        const password = decrypt(
                            userSettings.bsky_password_hashed
                        );

                        // Login fresh
                        resumedSession = await bskyAgent.login(
                            username,
                            password
                        );

                        // Save the new session back to DB (encrypted)
                        await db("settings")
                            .where({ pid: account.pid })
                            .update({
                                bsky_auth_session_json: encrypt(
                                    JSON.stringify(resumedSession)
                                ),
                            });
                    } catch (loginErr) {
                        logger.warn(
                            "could not login with bsky stored credentials (changed pass/no app password): %s",
                            loginErr
                        );

                        // If both fail, return JSON response immediately
                        return res.status(401).json({
                            status: "bsky_credentials_expired",
                            error: "Bluesky auth failed. Please log in again from Menu>Settings.",
                        });
                    }
                }
            }
            //If no bsky linked skip

            const postForm = req.body;
            const searchKeys = [].concat(postForm.search_key || []);

            const feelingId = parseInt(postForm.feeling_id, 10);
            const safeFeelingId = isNaN(feelingId) ? 0 : feelingId;

            const isSpoiler = parseInt(postForm.is_spoiler, 10);
            const safeIsSpoiler = isNaN(isSpoiler) ? 0 : isSpoiler;

            const hasBody = postForm.body && postForm.body.trim().length > 0;
            const hasPainting =
                postForm.painting && postForm.painting.trim().length > 0;

            const hasScreenshot =
                postForm.screenshot && postForm.screenshot.trim().length > 0;

            if (!hasBody && !hasPainting) {
                return res.status(400).json({
                    status: "error",
                    error: "Post must have a body or a painting.",
                });
            }

            let memoCdnKey = null;
            let paintingBuffer = null;

            let screenshotCdnKey = null;
            let screenshotBuffer = null;

            if (hasPainting) {
                try {
                    const base64Image = postForm.painting.replace(
                        /^data:image\/png;base64,/,
                        ""
                    );
                    paintingBuffer = Buffer.from(base64Image, "base64");

                    memoCdnKey = `${token.pid}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}_memo.png`;
                    const bucketName = env.VINO_JP_MINIO_BUCKET;

                    const uploadParams = {
                        Bucket: bucketName,
                        Key: memoCdnKey,
                        Body: paintingBuffer,
                        ContentType: "image/png",
                        ACL: "public-read" as ObjectCannedACL,
                    };

                    await s3.send(new PutObjectCommand(uploadParams));
                    logger.success(
                        "PostAlt Memo PNG Uploaded %s to %s",
                        memoCdnKey,
                        bucketName
                    );
                } catch (err) {
                    logger.error(
                        "PostAlt Error uploading PNG (memo): %s",
                        err
                    );
                    return res.status(500).json({
                        status: "error",
                        error: "Could not upload painting to CDN.",
                    });
                }
            }

            if (hasScreenshot) {
                try {
                    const base64Image = postForm.screenshot.replace(
                        /^data:image\/png;base64,/,
                        ""
                    );
                    screenshotBuffer = Buffer.from(base64Image, "base64");

                    screenshotCdnKey = `${token.pid}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}_ss.png`;
                    const bucketName = env.VINO_JP_MINIO_BUCKET;

                    const uploadParams = {
                        Bucket: bucketName,
                        Key: screenshotCdnKey,
                        Body: screenshotBuffer,
                        ContentType: "image/png",
                        ACL: "public-read" as ObjectCannedACL,
                    };

                    await s3.send(new PutObjectCommand(uploadParams));
                    logger.success(
                        "PostAlt Screenshot PNG Uploaded %s to %s",
                        screenshotCdnKey,
                        bucketName
                    );
                } catch (err) {
                    logger.error(
                        "PostAlt Error uploading PNG (screenshot): %s",
                        err
                    );
                    return res.status(500).json({
                        status: "error",
                        error: "Could not upload screenshot to CDN.",
                    });
                }
            }

            const post = await db("posts").insert({
                pid: account.pid,
                create_time: new Date(),
                search_keys: JSON.stringify(searchKeys),
                body: hasBody ? postForm.body : null,
                painting: memoCdnKey,
                screenshot: screenshotCdnKey,
                feeling_id: safeFeelingId,
                is_spoiler: safeIsSpoiler,
                topic_tag:
                    postForm.topic_tag && postForm.topic_tag.length
                        ? postForm.topic_tag
                        : "",
            });

            if (post && post.length > 0) {
                const postIdForLink = post[0];

                const getFeelingQueryFromNumber = (
                    feeling_id: number
                ): string => {
                    switch (feeling_id) {
                        case 1:
                            return "smile_open_mouth";
                        case 2:
                            return "like_wink_left";
                        case 3:
                            return "surprise_open_mouth";
                        case 4:
                            return "frustrated";
                        case 5:
                            return "sorrow";
                        default:
                            return "normal";
                    }
                };

                try {
                    const webhookUrl = env.VINO_JP_CONFIG_DC_WEBHOOK_URL;

                    if (!webhookUrl || webhookUrl === "https://placeholder.invalid") {
                        throw new Error("No webhook URL configured — skipping");
                    }

                    const miiName = account.mii_name || "Unknown Mii";
                    const miiImage = `https://mii-unsecure.ariankordi.net/miis/image.png?verifyCRC16=0&width=128&expression=${getFeelingQueryFromNumber(feelingId)}&data=${encodeURIComponent(account.mii_data)}&type=face`;

                    const isSpoilerPost = safeIsSpoiler === 1;

                    let embed: any;

                    if (isSpoilerPost) {
                        embed = {
                            author: { name: miiName, icon_url: miiImage },
                            title: postForm.topic_tag || "Untitled Topic",
                            url: `https://projectrose.cafe/tvii/olv/topic/${encodeURIComponent(postForm.topic_tag)}`,
                            description: `**[Spoiler, View in browser](https://projectrose.cafe/tvii/olv/post/${encodeURIComponent(postIdForLink!)})**`,
                            color: 0xe756d4,
                            timestamp: new Date().toISOString(),
                        };
                    } else {
                        let description = hasBody ? postForm.body : "";
                        description += `\n\n[View in browser](https://projectrose.cafe/tvii/olv/post/${encodeURIComponent(postIdForLink!)})`;

                        embed = {
                            author: { name: miiName, icon_url: miiImage },
                            title: postForm.topic_tag || "Untitled Topic",
                            url: `https://projectrose.cafe/tvii/olv/topic/${encodeURIComponent(postForm.topic_tag)}`,
                            description,
                            color: 0xe756d4,
                            timestamp: new Date().toISOString(),
                        };

                        if (memoCdnKey) {
                            embed.image = {
                                url: `https://cdn.projectrose.cafe/tvii-jp-d1/${memoCdnKey}`,
                            };
                        } else if (screenshotCdnKey) {
                            embed.image = {
                                url: `https://cdn.projectrose.cafe/tvii-jp-d1/${screenshotCdnKey}`,
                            };
                        }
                    }

                    await fetch(webhookUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ embeds: [embed] }),
                        signal: AbortSignal.timeout(5_000),
                    });
                } catch (err) {
                    logger.error("Failed to send Discord webhook: %s", err);
                }

                // Social posting logic
                if (hasBody && !hasPainting && !hasScreenshot) {
                    const bText = buildSocialPost(
                        300,
                        postForm.topic_tag,
                        postForm.body,
                        1
                    );

                    //Bsky
                    if (bskyAgent && resumedSession) {
                        try {
                            const bskyResult = await bskyAgent.sendPost(bText);
                            logger.success("bsky text upload: %s", bskyResult);
                        } catch (e) {
                            logger.error("bsky text upload error: %s", e);
                        }
                    }
                } else if (hasBody && hasScreenshot && screenshotBuffer) {
                    const bText = buildSocialPost(
                        300,
                        postForm.topic_tag,
                        postForm.body,
                        3
                    );
                    if (bskyAgent && resumedSession) {
                        try {
                            const bskyResult =
                                await bskyAgent.sendPostWithImage(
                                    bText,
                                    "User doodle from Nintendo TVii while watching " +
                                    postForm.topic_tag,
                                    screenshotBuffer
                                );
                            logger.success("bsky doodle upload: %s", bskyResult);
                        } catch (e) {
                            logger.error("bsky doodle upload error: %s", e);
                        }
                    }
                } else if (!hasBody && hasPainting && paintingBuffer) {
                    const bText = buildSocialPost(
                        300,
                        postForm.topic_tag,
                        null,
                        2
                    );

                    if (bskyAgent && resumedSession) {
                        try {
                            const bskyResult =
                                await bskyAgent.sendPostWithImage(
                                    bText,
                                    "User drawing from Nintendo TVii while watching " +
                                    postForm.topic_tag,
                                    paintingBuffer
                                );
                            logger.success("bsky memo upload: %s", bskyResult);
                        } catch (e) {
                            logger.error("bsky memo upload error: %s", e);
                        }
                    }
                }

                // ─── Roseverse / OLV Crosspost ─────────────────────────
                const olvApiUrl = req.headers["x-olv-api-url"] as string | undefined;
                const olvServiceToken = req.headers["x-olv-servicetoken"] as string | undefined;
                let olvParamPack = req.headers["x-olv-parampack"] as string | undefined;
                const olvUserAgent = req.headers["x-olv-useragent"] as string | undefined;

                if (olvApiUrl && olvServiceToken) {
                    try {
                        // Decode parampack to extract title_id for community lookup
                        let olvTitleId = "";
                        if (olvParamPack) {
                            try {
                                const decoded = Buffer.from(olvParamPack, "base64").toString("utf-8");
                                const match = decoded.match(/\\title_id\\(\d+)/);
                                if (match) {
                                    olvTitleId = match[1];

                                    // Convert decimal title_id to 16-char hex (how communities are stored)
                                    // Wii U sends decimal "1407581310496778" but Roseverse stores hex "000500301001300A"
                                    const titleIdNum = BigInt(olvTitleId);
                                    const titleIdHex = titleIdNum.toString(16).toUpperCase().padStart(16, "0");
                                    const fixedDecoded = decoded.replace(
                                        `\\title_id\\${olvTitleId}`,
                                        `\\title_id\\${titleIdHex}`
                                    );
                                    olvParamPack = Buffer.from(fixedDecoded).toString("base64");
                                    logger.info("[Roseverse] title_id: %s -> hex %s", olvTitleId, titleIdHex);
                                }
                            } catch (_) {}
                        }

                        const olvForm = new URLSearchParams();
                        if (hasBody) olvForm.append("body", postForm.body);
                        if (hasPainting && postForm.painting) {
                            olvForm.append("painting", postForm.painting);
                        }
                        if (postForm.topic_tag && postForm.topic_tag.length) {
                            olvForm.append("topic_tag", postForm.topic_tag);
                        }
                        olvForm.append("feeling_id", String(safeFeelingId));
                        olvForm.append("is_autopost", "0");
                        olvForm.append("is_spoiler", String(safeIsSpoiler));
                        olvForm.append("is_app_jumpable", "0");
                        if (postForm.olv_language_id) {
                            olvForm.append("language_id", postForm.olv_language_id);
                        } else {
                            olvForm.append("language_id", "1");
                        }
                        for (const sk of searchKeys) {
                            olvForm.append("search_key", sk);
                        }

                        // Log full details to file for debugging (dev only — avoids leaking tokens)
                        if (isDev) {
                            const debugInfo = [
                                `=== Roseverse Crosspost ${new Date().toISOString()} ===`,
                                `URL: ${olvApiUrl}/v1/posts`,
                                `ServiceToken: ${olvServiceToken.substring(0, 20)}...`,
                                `ParamPack (decoded): title_id=${olvTitleId}`,
                                `ParamPack (raw b64): ${(olvParamPack || "").substring(0, 80)}...`,
                                `UserAgent: ${olvUserAgent || "(default)"}`,
                                `Form body: ${olvForm.toString()}`,
                                `---`,
                            ].join("\n");
                            const fs = await import("fs");
                            await fs.promises.appendFile("roseverse_debug.log", debugInfo + "\n");
                        }

                        const olvResp = await fetch(`${olvApiUrl}/v1/posts`, {
                            method: "POST",
                            headers: {
                                "X-Nintendo-ServiceToken": olvServiceToken,
                                "X-Nintendo-ParamPack": olvParamPack || "",
                                "Content-Type": "application/x-www-form-urlencoded",
                                "User-Agent": olvUserAgent || "WiiU/POLV-5.0.3/353",
                            },
                            body: olvForm.toString(),
                            signal: AbortSignal.timeout(15_000),
                        });

                        const olvBody = await olvResp.text();
                        // Append response to debug log (dev only)
                        if (isDev) {
                            const fs = await import("fs");
                            await fs.promises.appendFile("roseverse_debug.log",
                                `Response ${olvResp.status}:\n${olvBody}\n\n`);
                        }
                        logger.info("[Roseverse] POST -> %d (title_id=%s)", olvResp.status, olvTitleId);

                        if (olvResp.status !== 200) {
                            logger.warn("[Roseverse] Error response: %s", olvBody);
                        }
                    } catch (err) {
                        logger.error("[Roseverse] Crosspost error: %s", err);
                    }
                }
                // ─── End Roseverse Crosspost ────────────────────────────

                res.status(200).json({
                    status: "success",
                    post_id: postIdForLink,
                });
            } else {
                logger.error("Post Insert failed");
                res.status(500).json({
                    status: "error",
                    error: "Post did not insert properly to DB.",
                });
            }
        } catch (error) {
            logger.error("/postsAlt error: %s", error);
            res.status(500).json({
                status: "error",
                error: "Internal server error.",
            });
        }
    }
);

router.get("/postsAlt", async (req: Request, res: Response): Promise<any> => {
    try {
        const { limit, search_key, lastPostId } = req.query;

        if (!search_key || typeof search_key !== "string") {
            return res.status(400).json({
                status: "error",
                error: "A single search_key is required",
            });
        }

        const safeLimit = Math.min(parseInt(limit as string, 10) || 50, 200);

        // Build base query
        let query = db("posts")
            .innerJoin("account", "posts.pid", "account.pid")
            .whereRaw("JSON_VALID(posts.search_keys)")
            .andWhereRaw("JSON_CONTAINS(posts.search_keys, ?)", [
                JSON.stringify(search_key),
            ]);

        // Keyset pagination
        if (lastPostId) {
            query = query.andWhere("posts.post_id", "<", lastPostId);
        }

        const posts = await query
            .orderBy("posts.create_time", "desc")
            .limit(safeLimit)
            .leftJoin("empathies", "posts.post_id", "empathies.post_id")
            .leftJoin(
                { empathy_account: "account" },
                "empathies.pid",
                "empathy_account.pid"
            )
            .groupBy("posts.post_id")
            .select(
                "posts.post_id",
                "posts.pid",
                "posts.create_time",
                "posts.body",
                "posts.painting",
                "posts.screenshot",
                "posts.feeling_id",
                "posts.is_spoiler",
                "posts.search_keys",
                "posts.topic_tag",
                "account.mii_data",
                "account.mii_name",
                db.raw(`
                    COALESCE(
                        JSON_ARRAYAGG(
                            JSON_OBJECT(
                                'pid', empathy_account.pid,
                                'mii_name', empathy_account.mii_name,
                                'mii_data', empathy_account.mii_data
                            )
                        ),
                        JSON_ARRAY()
                    ) AS empathy_givers
                `)
            );

        const output = posts.map((post: any) => {
            let rawEmpathies = post.empathy_givers;
            let empathies: {
                pid: number | null;
                mii_name: string | null;
                mii_data: string | null;
            }[];
            if (!rawEmpathies) {
                empathies = [];
            } else if (typeof rawEmpathies === "string") {
                try { empathies = JSON.parse(rawEmpathies); } catch { empathies = []; }
            } else {
                empathies = rawEmpathies;
            }

            return {
                post_id: post.post_id,
                pid: post.pid,
                create_time: post.create_time,
                body: post.body || null,
                painting: post.painting || null,
                screenshot: post.screenshot || null,
                feeling_id: post.feeling_id,
                is_spoiler: post.is_spoiler,
                topic_tag: post.topic_tag,
                mii_name: post.mii_name,
                mii_data: post.mii_data,
                empathies: empathies.filter(e => e.pid !== null),
            };
        });

        return res.status(200).json(output);
    } catch (error) {
        logger.error("/postsAlt GET error: %s", error);
        return res.status(500).json({
            status: "error",
            error: "Internal server error.",
        });
    }
});



router.post(
    "/postsAlt/:postId/empathies",
    async (req: Request, res: Response): Promise<any> => {
        try {
            const token = parseServiceToken(req);
            const postId = Number(req.params["postId"]);

            const post = await db("posts").where({ post_id: postId }).first();

            if (!post) {
                return res.status(404).json({ error: "Post not found." });
            }

            const account = await db("account")
                .where({
                    pid: token.pid,
                    serial_number: token.serial_number,
                    access_key: token.access_key,
                })
                .first();

            if (!account) {
                return res.status(401).json({ status: "no_account_yet" });
            }

            const existing = await db("empathies")
                .where({ pid: account.pid, post_id: postId })
                .first();

            if (existing) {
                //what the miiverse yeah endpoint does anyway
                return res.status(200).json({ status: "success" });
            }

            await db("empathies").insert({
                pid: account.pid,
                post_id: postId,
                create_time: new Date(),
            });

            res.status(200).json({ status: "success" });
        } catch (e) {
            logger.error("error yeah-ing post");
            res.status(500).json({ status: "error" });
        }
    }
);

router.delete(
    "/postsAlt/:postId/empathies",
    async (req: Request, res: Response): Promise<any> => {
        try {
            const token = parseServiceToken(req);

            const postId = Number(req.params["postId"]);

            const post = await db("posts").where({ post_id: postId }).first();

            if (!post) {
                return res.status(404).json({ error: "Post not found." });
            }

            const account = await db("account")
                .where({
                    pid: token.pid,
                    serial_number: token.serial_number,
                    access_key: token.access_key,
                })
                .first();

            if (!account) {
                return res.status(401).json({ status: "no_account_yet" });
            }

            const existing = await db("empathies")
                .where({ pid: account.pid, post_id: postId })
                .first();

            if (!existing) {
                return res.status(404).json({ status: "empathy_not_found" });
            }

            await db("empathies")
                .where({ pid: account.pid, post_id: postId })
                .del();

            res.status(200).json({ status: "success" });
        } catch (e) {
            logger.error("error un-yeah-ing post");
            res.status(500).json({ status: "error" });
        }
    }
);

export { router as socials };
