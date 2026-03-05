/**
 * G-Guide (bangumi.org) scraper for JP EPG data.
 *
 * Scrapes the official 番組表.Gガイド website for rich program data
 * including thumbnails, cast/talent info, and proper genre categories.
 *
 * Endpoints used:
 *   EPG grid:  https://bangumi.org/epg/td?broad=dt&area={area}&ggdate=today&ggtime=now
 *              https://bangumi.org/epg/bs?ggdate=today&ggtime=now
 *              https://bangumi.org/epg/cs?ggdate=today&ggtime=now
 *   Detail:    https://bangumi.org/tv_events/{eventId}?overwrite_area={area}
 */

import * as cheerio from "cheerio";
import Redis from "ioredis";
import { env } from "../env.ts";
import { logger } from "./logger.ts";

const redis = new Redis();

// ── Configuration ────────────────────────────────────────────
const GGUIDE_BASE = "https://bangumi.org";
const GGUIDE_AREA = env.VINO_JP_GGUIDE_AREA ?? "23"; // Tokyo
const GGUIDE_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** How long (seconds) to cache the EPG grid scrape in Redis */
const GRID_CACHE_TTL = 30 * 60; // 30 minutes
/** How long (seconds) to cache program detail pages in Redis */
const DETAIL_CACHE_TTL = 24 * 60 * 60; // 24 hours
/** How long (seconds) to keep a channel list */
const CHANNEL_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days

// ── Types ────────────────────────────────────────────────────
export interface GGuideChannel {
    /** Column index on the grid (1-based) */
    lineIndex: number;
    /** Channel number (e.g. "1", "4", "161") */
    number: string;
    /** Display name (e.g. "NHK総合") */
    name: string;
    /** Full name (untruncated) – resolved later from detail pages */
    fullName: string | null;
    /** Broadcast type: dt (terrestrial), bs, cs */
    broad: "dt" | "bs" | "cs";
    /** Stable ID we generate: gguide-{broad}-{number} */
    id: string;
    /** Logo URL if discovered */
    logo: string | null;
}

export interface GGuideProgram {
    /** Our channel id: gguide-{broad}-{number} */
    channelId: string;
    /** Start time as epoch seconds */
    startUtc: number;
    /** End time as epoch seconds */
    endUtc: number;
    /** JST formatted "YYYY-MM-DD HH:mm:ss" */
    startJst: string;
    endJst: string;
    /** Program title */
    title: string;
    /** Short description from grid */
    description: string | null;
    /** Genre CSS class → mapped to genre name */
    genre: string | null;
    /** Genre class from grid (gc-anime, gc-drama, etc.) */
    genreClass: string | null;
    /** bangumi.org event ID (for detail page) */
    eventId: string | null;
    /** contentsId from data-content JSON */
    contentsId: number | null;
    /** programId (season-level) */
    programId: string | null;
    /** Stable listing ID */
    listingId: string;
}

export interface GGuideProgramDetail {
    /** Program thumbnail URL */
    image: string | null;
    /** Proper genre text (e.g. "ニュース／報道") */
    genre: string | null;
    /** Season/series title */
    masterTitle: string | null;
    /** Full description */
    description: string | null;
    /** Full letter body (longer description) */
    letterBody: string | null;
    /** Channel + time text (e.g. "3月5日 木曜 21:00 -22:00 NHK総合1・東京") */
    scheduleText: string | null;
    /** Cast list */
    cast: GGuideCastMember[];
    /** Season ID for grouping */
    seasonId: string | null;
}

export interface GGuideCastMember {
    name: string;
    talentId: string | null;
    role: string | null;
    image: string | null;
}

// ── Genre map from CSS classes ───────────────────────────────
const GENRE_CLASS_MAP: Record<string, string | null> = {
    "gc-anime": "アニメ",
    "gc-drama": "ドラマ",
    "gc-sports": "スポーツ",
    "gc-movie": "映画",
    "gc-music": "音楽",
    "gc-variety": "バラエティ",
    "gc-news": "ニュース",
    "gc-documentary": "ドキュメンタリー",
    "gc-hobby": "趣味",
    "gc-education": "教育",
    "gc-theater": "演劇",
    "gc-welfare": "福祉",
    "no_genre": null,
};

// ── Date/time helpers ────────────────────────────────────────

/**
 * Year-offset compensation.
 *
 * The system clock may be set to a different year (e.g. 2026) while
 * bangumi.org returns real-world dates (e.g. 2025).  We detect this
 * on the first grid scrape and shift all programme timestamps to
 * match the system clock so the Wii U's time window queries work.
 */
let dateOffsetSeconds: number | null = null;

/** Called once with the raw date from the first programme to compute the shift. */
function ensureDateOffset(realYYYYMMDD: string): void {
    if (dateOffsetSeconds !== null) return;
    const realYear = parseInt(realYYYYMMDD.slice(0, 4), 10);
    const systemYear = parseInt(todayJstStr().slice(0, 4), 10);

    if (realYear === systemYear) {
        dateOffsetSeconds = 0;
        return;
    }

    // Build the same month-day in both years and compute offset
    const md = realYYYYMMDD.slice(4); // MMDD
    const realEpoch =
        new Date(`${realYear}-${md.slice(0, 2)}-${md.slice(2, 4)}T00:00:00+09:00`).getTime() / 1000;
    const sysEpoch =
        new Date(`${systemYear}-${md.slice(0, 2)}-${md.slice(2, 4)}T00:00:00+09:00`).getTime() / 1000;

    dateOffsetSeconds = sysEpoch - realEpoch;
    logger.info(
        "G-Guide: date offset = %d s  (real year %d → system year %d)",
        dateOffsetSeconds,
        realYear,
        systemYear,
    );
}

/** Return the real-world JST today string (YYYYMMDD) for bangumi.org URLs. */
function realTodayJst(): string {
    if (dateOffsetSeconds !== null && dateOffsetSeconds !== 0) {
        // Subtract the offset to get the real-world "now"
        const realNow = new Date(Date.now() - dateOffsetSeconds * 1000);
        const parts = new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(realNow);
        const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
        return `${get("year")}${get("month")}${get("day")}`;
    }
    return todayJstStr();          // no offset known yet; fall back to system date
}

/**
 * Parse bangumi.org time format "202503050500" → epoch seconds (JST input),
 * shifted to the system clock's year so the Wii U's queries match.
 * Format: YYYYMMDDHHmm (12 chars) or YYYYMMDDHHmmss (14 chars)
 */
function parseGGuideTime(raw: string): number {
    if (!raw || raw.length < 12) return 0;
    const yyyy = raw.slice(0, 4);
    const MM = raw.slice(4, 6);
    const dd = raw.slice(6, 8);
    const hh = raw.slice(8, 10);
    const mm = raw.slice(10, 12);
    const ss = raw.length >= 14 ? raw.slice(12, 14) : "00";
    // These are JST times
    const iso = `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}+09:00`;
    const epoch = Math.floor(new Date(iso).getTime() / 1000);

    // Shift to match system clock year
    return epoch + (dateOffsetSeconds ?? 0);
}

/** epoch seconds → JST "YYYY-MM-DD HH:mm:ss" */
function epochToJst(epoch: number): string {
    const d = new Date(epoch * 1000);
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Formatted date for URL: "today", "20260305", etc. */
function todayJstStr(): string {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}${get("month")}${get("day")}`;
}

// ── HTTP fetch helper ────────────────────────────────────────
async function gFetch(url: string): Promise<string> {
    const resp = await fetch(url, {
        headers: {
            "User-Agent": GGUIDE_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ja,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
        },
        redirect: "follow",
    });
    if (!resp.ok) {
        throw new Error(`G-Guide fetch ${url} → ${resp.status}`);
    }
    return resp.text();
}

// ── Grid scraper ─────────────────────────────────────────────

/** Build the URL for an EPG grid page */
function gridUrl(broad: "dt" | "bs" | "cs", ggdate: string = "today"): string {
    if (broad === "dt") {
        return `${GGUIDE_BASE}/epg/td?broad=dt&area=${GGUIDE_AREA}&ggdate=${ggdate}&ggtime=now`;
    }
    // BS and CS don't need area
    return `${GGUIDE_BASE}/epg/${broad}?ggdate=${ggdate}&ggtime=now`;
}

interface GridScrapeResult {
    channels: GGuideChannel[];
    programs: GGuideProgram[];
}

/**
 * Scrape a single EPG grid page and extract channels + programs.
 */
function parseGrid(html: string, broad: "dt" | "bs" | "cs"): GridScrapeResult {
    const $ = cheerio.load(html);
    const channels: GGuideChannel[] = [];
    const programs: GGuideProgram[] = [];

    // ── Extract channel headers ──
    // Channel columns: <li class="js_channel topmost"><p>1 NHK総合1..</p></li>
    const chHeaders: string[] = [];
    $("#ch_area li.js_channel.topmost").each((_, el) => {
        const text = $(el).find("p").text().trim();
        chHeaders.push(text);
    });

    // Build channel objects from headers
    for (let i = 0; i < chHeaders.length; i++) {
        const raw = chHeaders[i]!;
        // Format: "1 NHK総合1.." or "161 QVC" — number then name
        const m = raw.match(/^(\d+)\s+(.+)$/);
        const number = m ? m[1]! : String(i + 1);
        let name = m ? m[2]! : raw;
        // Remove trailing dots (truncation indicator)
        name = name.replace(/\.{2,}$/, "").trim();
        // Remove trailing "1" that indicates sub-channel (e.g. "TBS1" → "TBS")
        // But keep it if the channel is entirely numeric+letter like "BS11"
        const cleanName = name.replace(/(\D)1$/, "$1").trim();

        const id = `gguide-${broad}-${number}`;
        channels.push({
            lineIndex: i + 1,
            number,
            name: cleanName || name,
            fullName: null,
            broad,
            id,
            logo: null,
        });
    }

    // ── Extract programs from each column ──
    // Each column: <ul id="program_line_N"> with <li s="..." e="..." pid="..." se-id="...">
    for (let colIdx = 0; colIdx < channels.length; colIdx++) {
        const channel = channels[colIdx]!;
        const lineId = `program_line_${colIdx + 1}`;
        const column = $(`#${lineId}`);

        column.find("li[s][e]").each((_, el) => {
            const $li = $(el);
            const startRaw = $li.attr("s") ?? "";
            const endRaw = $li.attr("e") ?? "";

            // On the very first programme we see, detect real-world
            // vs system-clock year offset so timestamps are shifted.
            if (startRaw.length >= 8) ensureDateOffset(startRaw.slice(0, 8));

            const startUtc = parseGGuideTime(startRaw);
            const endUtc = parseGGuideTime(endRaw);
            if (!startUtc || !endUtc) return;

            // Title
            const title = $li.find(".program_title").text().trim() || "不明";

            // Description (short, from grid)
            const desc = $li.find(".program_detail").text().trim() || null;

            // Genre from program_time class (e.g. "program_time gc-anime")
            const timeDiv = $li.find(".program_time");
            const timeClass = timeDiv.attr("class") ?? "";
            let genreClass: string | null = null;
            for (const cls of Object.keys(GENRE_CLASS_MAP)) {
                if (timeClass.includes(cls)) {
                    genreClass = cls;
                    break;
                }
            }
            const genre = genreClass ? GENRE_CLASS_MAP[genreClass] ?? null : null;

            // Event ID from href: /tv_events/{eventId}?overwrite_area=23
            const href = $li.find("a.title_link").attr("href") ?? "";
            const eventMatch = href.match(/\/tv_events\/([^?]+)/);
            const eventId = eventMatch ? eventMatch[1]! : null;

            // data-content JSON for contentsId, programId
            const dataContent = $li.find("a.title_link").attr("data-content") ?? "";
            let contentsId: number | null = null;
            let programId: string | null = null;
            try {
                const dc = JSON.parse(dataContent);
                contentsId = dc.contentsId ?? null;
                programId = dc.programId ? String(dc.programId) : null;
            } catch {
                // data-content might have HTML entities; try decoding
                try {
                    const decoded = dataContent
                        .replace(/&quot;/g, '"')
                        .replace(/&amp;/g, "&")
                        .replace(/&lt;/g, "<")
                        .replace(/&gt;/g, ">");
                    const dc = JSON.parse(decoded);
                    contentsId = dc.contentsId ?? null;
                    programId = dc.programId ? String(dc.programId) : null;
                } catch {
                    // skip
                }
            }

            const listingId = `gguide-${channel.id}-${startUtc}`;

            programs.push({
                channelId: channel.id,
                startUtc,
                endUtc,
                startJst: epochToJst(startUtc),
                endJst: epochToJst(endUtc),
                title,
                description: desc,
                genre,
                genreClass,
                eventId,
                contentsId,
                programId,
                listingId,
            });
        });
    }

    return { channels, programs };
}

// ── Detail page scraper ──────────────────────────────────────

/**
 * Scrape a program detail page to get rich metadata.
 */
async function scrapeDetail(eventId: string): Promise<GGuideProgramDetail | null> {
    const cacheKey = `gguide:detail:${eventId}`;
    const cached = await redis.get(cacheKey);
    if (cached) {
        try {
            return JSON.parse(cached);
        } catch {
            await redis.del(cacheKey);
        }
    }

    try {
        const url = `${GGUIDE_BASE}/tv_events/${eventId}?overwrite_area=${GGUIDE_AREA}`;
        const html = await gFetch(url);
        const $ = cheerio.load(html);

        // Image: <img class="top_img" src="...">
        const image = $("img.top_img").attr("src") || null;

        // Genre: <p class="genre nomal">ニュース／報道</p>
        const genreEl = $("p.genre");
        const genre = genreEl.text().trim().replace(/^\s*\S+\s*/, "").trim() || null;
        // The genre text has an <img> before it, so strip leading whitespace after removing img text

        // Master title: <h1 class="master_title">ニュースウオッチ9</h1>
        const masterTitle = $("h1.master_title").text().trim() || null;

        // Description: <p class="description"> in the main content
        const description = $("section.detail p.description").first().text().trim() || null;

        // Letter body: <p class="letter_body">
        const letterBody = $("p.letter_body").text().trim() || null;

        // Schedule text: <div class="schedule"><p>3月5日 木曜 21:00 <span>-</span>22:00 NHK総合1・東京</p>
        const scheduleText = $("div.schedule p").text().trim().replace(/\s+/g, " ") || null;

        // Season ID from canonical URL or share links
        let seasonId: string | null = null;
        const canonical = $("link[rel='canonical']").attr("href") ?? "";
        const seasonMatch = canonical.match(/season_id=(\d+)/);
        if (seasonMatch) {
            seasonId = seasonMatch[1]!;
        } else {
            // Try from share links
            $("a[href*='season_id=']").each((_, el) => {
                const h = $(el).attr("href") ?? "";
                const m = h.match(/season_id=(\d+)/);
                if (m) seasonId = m[1]!;
            });
        }

        // Cast from heading section
        const cast: GGuideCastMember[] = [];

        // First: structured cast from the heading "出演者"
        $("h3.heading").each((_, el) => {
            const headingText = $(el).text().trim();
            if (headingText !== "出演者") return;

            // The cast is in the next <p> sibling
            const castP = $(el).parent().find("p").first();
            const castHtml = castP.html() ?? "";

            // Parse talent links: <a href='https://bangumi.org/talents/319237'>広内仁</a>
            // And role prefixes: 【キャスター】
            let currentRole: string | null = null;
            const parts = castHtml.split(/(<a[^>]*>.*?<\/a>|【[^】]+】)/g);
            for (const part of parts) {
                const roleMatch = part.match(/【([^】]+)】/);
                if (roleMatch) {
                    currentRole = roleMatch[1]!;
                    continue;
                }
                const linkMatch = part.match(/href=['"]https?:\/\/bangumi\.org\/talents\/(\d+)['"][^>]*>([^<]+)<\/a>/);
                if (linkMatch) {
                    cast.push({
                        name: linkMatch[2]!.trim(),
                        talentId: linkMatch[1]!,
                        role: currentRole,
                        image: null,
                    });
                }
            }
        });

        // Second: images from talent_panel
        $("ul.talent_panel li").each((_, el) => {
            const $li = $(el);
            const dataContent = $li.find("a.js-logging").attr("data-content") ?? "";
            let talentId: string | null = null;
            let talentName: string | null = null;

            try {
                const dc = JSON.parse(dataContent.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
                talentId = dc.talentId ? String(dc.talentId) : null;
                talentName = dc.name || null;
            } catch { /* skip */ }

            const img = $li.find("img.parts_program_image").attr("src") || null;
            // Don't include the noimage placeholder
            const hasRealImage = img && !img.includes("noimage");

            // Match with existing cast entry to add image
            if (talentId) {
                const existing = cast.find((c) => c.talentId === talentId);
                if (existing && hasRealImage) {
                    existing.image = img;
                } else if (!existing && talentName) {
                    cast.push({
                        name: talentName,
                        talentId,
                        role: null,
                        image: hasRealImage ? img : null,
                    });
                }
            }
        });

        const detail: GGuideProgramDetail = {
            image,
            genre,
            masterTitle,
            description,
            letterBody,
            scheduleText,
            cast,
            seasonId,
        };

        // Cache in Redis
        await redis.set(cacheKey, JSON.stringify(detail), "EX", DETAIL_CACHE_TTL);

        return detail;
    } catch (err: any) {
        logger.error("G-Guide detail scrape failed for %s: %s", eventId, err.message);
        return null;
    }
}

// ── In-memory cache ──────────────────────────────────────────
let cachedChannels: Map<string, GGuideChannel> = new Map();
let cachedPrograms: GGuideProgram[] = [];
let lastGridRefresh = 0;
const gridRefreshMs = (env.VINO_JP_XMLTV_REFRESH_MINUTES ?? 30) * 60 * 1000;

// ── Grid refresh logic ───────────────────────────────────────

/**
 * Scrape all three grid types (dt, bs, cs) and merge into a single
 * channel list + program list.
 */
async function refreshGrids(): Promise<void> {
    const now = Date.now();
    if (now - lastGridRefresh < gridRefreshMs && cachedChannels.size > 0) return;

    logger.info("G-Guide: refreshing EPG grids...");

    const broadTypes: ("dt" | "bs" | "cs")[] = ["dt", "bs", "cs"];
    const allChannels: Map<string, GGuideChannel> = new Map();
    let allPrograms: GGuideProgram[] = [];

    // Scrape today's grid for each broadcast type
    for (const broad of broadTypes) {
        const url = gridUrl(broad, "today");
        const cacheKey = `gguide:grid:${broad}:${todayJstStr()}`;

        let html: string | null = null;

        // Check Redis first
        const cachedHtml = await redis.get(cacheKey);
        if (cachedHtml) {
            html = cachedHtml;
        } else {
            try {
                html = await gFetch(url);
                // Cache raw HTML in Redis
                await redis.set(cacheKey, html, "EX", GRID_CACHE_TTL);
            } catch (err: any) {
                logger.error("G-Guide: failed to fetch %s grid: %s", broad, err.message);
                continue;
            }
        }

        const { channels, programs } = parseGrid(html, broad);

        for (const ch of channels) {
            allChannels.set(ch.id, ch);
        }
        allPrograms = allPrograms.concat(programs);

        logger.info("G-Guide:   %s → %d channels, %d programs", broad, channels.length, programs.length);
    }

    // Also try to scrape tomorrow's grid to get more future schedule
    for (const broad of broadTypes) {
        // Use real-world tomorrow (not system tomorrow) for the URL,
        // since bangumi.org only has real-world dates.
        const realToday = realTodayJst();                               // e.g. "20250305"
        const realTodayDate = new Date(
            `${realToday.slice(0, 4)}-${realToday.slice(4, 6)}-${realToday.slice(6, 8)}T12:00:00+09:00`,
        );
        const realTomorrowDate = new Date(realTodayDate.getTime() + 24 * 60 * 60 * 1000);
        const rParts = new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(realTomorrowDate);
        const rGet = (t: string) => rParts.find((p) => p.type === t)?.value ?? "";
        const tomorrowStr = `${rGet("year")}${rGet("month")}${rGet("day")}`;

        // Cache key uses system date for tomorrow so it stays consistent
        const sysTomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const sParts = new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(sysTomorrow);
        const sGet = (t: string) => sParts.find((p) => p.type === t)?.value ?? "";
        const sysTomorrowStr = `${sGet("year")}${sGet("month")}${sGet("day")}`;

        const url = gridUrl(broad, tomorrowStr);
        const cacheKey = `gguide:grid:${broad}:${sysTomorrowStr}`;

        let html: string | null = null;
        const cachedHtml = await redis.get(cacheKey);
        if (cachedHtml) {
            html = cachedHtml;
        } else {
            try {
                html = await gFetch(url);
                await redis.set(cacheKey, html, "EX", GRID_CACHE_TTL);
            } catch (err: any) {
                // Tomorrow might not be available yet – that's OK
                logger.warn("G-Guide: tomorrow's %s grid not available: %s", broad, err.message);
                continue;
            }
        }

        const { programs } = parseGrid(html, broad);
        allPrograms = allPrograms.concat(programs);
        logger.info("G-Guide:   %s (tomorrow) → %d programs", broad, programs.length);
    }

    // Deduplicate programs (same channel + same start time)
    const seen = new Set<string>();
    allPrograms = allPrograms.filter((p) => {
        const key = `${p.channelId}|${p.startUtc}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Sort by start time
    allPrograms.sort((a, b) => a.startUtc - b.startUtc);

    cachedChannels = allChannels;
    cachedPrograms = allPrograms;
    lastGridRefresh = now;

    logger.success(
        "G-Guide: loaded %d channels, %d programs (today + tomorrow)",
        cachedChannels.size,
        cachedPrograms.length,
    );
}

// ── Public API (drop-in replacement for xmltv.ts) ────────────

/**
 * Returns all channels scraped from G-Guide.
 * Keys are our generated IDs: gguide-{broad}-{number}
 */
export async function getChannels(): Promise<Map<string, GGuideChannel>> {
    await refreshGrids();
    return cachedChannels;
}

/**
 * Returns programs for a specific channel within a UTC time window.
 */
export async function getPrograms(
    channelId: string,
    startUtc: number,
    endUtc: number,
): Promise<GGuideProgram[]> {
    await refreshGrids();
    return cachedPrograms.filter(
        (p) =>
            p.channelId === channelId &&
            p.endUtc > startUtc &&
            p.startUtc < endUtc,
    );
}

/** Find a program by its listingId */
export async function findByListingId(listingId: string): Promise<GGuideProgram | undefined> {
    await refreshGrids();
    return cachedPrograms.find((p) => p.listingId === listingId);
}

/** All programs (for broad searches) */
export async function getAllPrograms(): Promise<GGuideProgram[]> {
    await refreshGrids();
    return cachedPrograms;
}

/**
 * Fetch rich detail for a program (image, cast, genre).
 * Uses the eventId from the program to scrape the detail page.
 * Returns null if no eventId or scrape fails.
 */
export async function getProgramDetail(program: GGuideProgram): Promise<GGuideProgramDetail | null> {
    if (!program.eventId) return null;
    return scrapeDetail(program.eventId);
}

/**
 * Fetch detail by eventId directly.
 */
export async function getDetailByEventId(eventId: string): Promise<GGuideProgramDetail | null> {
    return scrapeDetail(eventId);
}

/**
 * Map a G-Guide genre class to a TVii showTypeID.
 *   "M" = Movie, "O" = Sports, "Y" = News, "A" = Animated/Anime,
 *   "W" = Music, "D" = Documentary, "6" = Comedy/Variety,
 *   "1" = Series/Drama (default)
 */
export function genreToShowTypeId(genreClass: string | null, genre: string | null, title: string = ""): string {
    // First try the CSS genre class from the grid
    if (genreClass) {
        switch (genreClass) {
            case "gc-anime": return "A";
            case "gc-movie": return "M";
            case "gc-sports": return "O";
            case "gc-music": return "W";
            case "gc-drama": return "1";
        }
    }

    // Then try the genre text from detail page
    const g = (genre ?? "").toLowerCase();
    if (/映画/.test(g)) return "M";
    if (/スポーツ/.test(g)) return "O";
    if (/ニュース|報道/.test(g)) return "Y";
    if (/アニメ/.test(g)) return "A";
    if (/音楽/.test(g)) return "W";
    if (/ドキュメンタリー|教養/.test(g)) return "D";
    if (/バラエティ|趣味|娯楽/.test(g)) return "6";
    if (/ドラマ/.test(g)) return "1";

    // Fallback: infer from title
    const t = title.toLowerCase();
    if (/アニメ/.test(t)) return "A";
    if (/映画|劇場版|ロードショー/.test(t)) return "M";
    if (/野球|サッカー|ゴルフ|テニス|スポーツ/.test(t)) return "O";
    if (/ニュース|報道|news/.test(t)) return "Y";
    if (/音楽|ライブ|コンサート/.test(t)) return "W";

    return "1"; // Default: Series/Drama
}

/**
 * Force a grid refresh on next call.
 */
export function invalidateCache(): void {
    lastGridRefresh = 0;
    dateOffsetSeconds = null;   // recalculate on next scrape
}
