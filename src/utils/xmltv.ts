/**
 * XMLTV parser for JP EPG data.
 *
 * Reads .xml or .xml.gz files containing XMLTV-format channel/programme data,
 * caches parsed results in memory, and exposes query helpers.
 */

import { readFileSync } from "fs";
import { gunzipSync } from "zlib";
import { env } from "../env.ts";
import { logger } from "./logger.ts";

// ── Types ────────────────────────────────────────────────────
export interface XmltvChannel {
    id: string;
    name: string;
    icon: string | null;
}

export interface XmltvProgramme {
    channelId: string;
    startUtc: number;   // epoch seconds
    endUtc: number;     // epoch seconds
    startJst: string;   // "YYYY-MM-DD HH:mm:ss"
    endJst: string;     // "YYYY-MM-DD HH:mm:ss"
    title: string;
    subTitle: string | null;
    description: string | null;
    category: string | null;
    rating: string | null;
    /** Stable listing ID built from channelId + start epoch */
    listingId: string;
}

// ── Cache state ──────────────────────────────────────────────
let cachedChannels: Map<string, XmltvChannel> = new Map();
let cachedProgrammes: XmltvProgramme[] = [];
let lastRefresh = 0;
let refreshIntervalMs = (env.VINO_JP_XMLTV_REFRESH_MINUTES ?? 30) * 60 * 1000;

// ── Date helpers ─────────────────────────────────────────────

/**
 * Parse XMLTV timestamp like "20260228070000 +0900" into epoch seconds.
 * Also supports formats without the space: "20260228070000+0900"
 */
function parseXmltvTime(raw: string): number {
    // Normalise: strip spaces between digits and offset
    const m = raw.trim().match(
        /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?$/
    );
    if (!m) return 0;

    const [, yyyy, MM, dd, hh, mm, ss, offsetStr] = m;
    // Build an ISO-like string so Date.parse works
    let iso = `${yyyy}-${MM}-${dd}T${hh}:${mm}:${ss}`;
    if (offsetStr) {
        iso += offsetStr.slice(0, 3) + ":" + offsetStr.slice(3);
    } else {
        // Default to JST
        iso += "+09:00";
    }
    return Math.floor(new Date(iso).getTime() / 1000);
}

/** epoch seconds -> JST "YYYY-MM-DD HH:mm:ss" */
function epochToJst(epoch: number): string {
    const d = new Date(epoch * 1000);
    // Format in Asia/Tokyo
    const parts = new Intl.DateTimeFormat("sv-SE", {
        timeZone: env.VINO_JP_XMLTV_TZ ?? "Asia/Tokyo",
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

// ── Minimal XML helpers (no dependency on cheerio for this) ──
// We use simple regex-based extraction since XMLTV is well-structured.

function extractChannels(xml: string): Map<string, XmltvChannel> {
    const map = new Map<string, XmltvChannel>();
    const channelRe = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi;
    let cm: RegExpExecArray | null;

    while ((cm = channelRe.exec(xml)) !== null) {
        const id = cm[1]!;
        const body = cm[2]!;

        // display-name – pick first
        const nameMatch = body.match(/<display-name[^>]*>([^<]+)<\/display-name>/i);
        const name = nameMatch ? nameMatch[1]!.trim() : id;

        // icon
        const iconMatch = body.match(/<icon\s+src="([^"]+)"/i);
        const icon = iconMatch ? iconMatch[1]! : null;

        map.set(id, { id, name, icon });
    }
    return map;
}

function extractProgrammes(xml: string): XmltvProgramme[] {
    const list: XmltvProgramme[] = [];
    const progRe =
        /<programme\s+start="([^"]+)"\s+stop="([^"]+)"\s+channel="([^"]+)"[^>]*>([\s\S]*?)<\/programme>/gi;
    let pm: RegExpExecArray | null;

    while ((pm = progRe.exec(xml)) !== null) {
        const startRaw = pm[1]!;
        const stopRaw = pm[2]!;
        const channelId = pm[3]!;
        const body = pm[4]!;

        const startUtc = parseXmltvTime(startRaw);
        const endUtc = parseXmltvTime(stopRaw);
        if (!startUtc || !endUtc) continue;

        const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
        const title = titleMatch ? titleMatch[1]!.trim() : "Unknown";

        const subMatch = body.match(/<sub-title[^>]*>([^<]+)<\/sub-title>/i);
        const subTitle = subMatch ? subMatch[1]!.trim() : null;

        const descMatch = body.match(/<desc[^>]*>([^<]+)<\/desc>/i);
        const description = descMatch ? descMatch[1]!.trim() : null;

        const catMatch = body.match(/<category[^>]*>([^<]+)<\/category>/i);
        const category = catMatch ? catMatch[1]!.trim() : null;

        const ratingMatch = body.match(/<rating[^>]*>[\s\S]*?<value>([^<]+)<\/value>[\s\S]*?<\/rating>/i);
        const rating = ratingMatch ? ratingMatch[1]!.trim() : null;

        const listingId = `xmltv-${channelId}-${startUtc}`;

        list.push({
            channelId,
            startUtc,
            endUtc,
            startJst: epochToJst(startUtc),
            endJst: epochToJst(endUtc),
            title,
            subTitle,
            description,
            category,
            rating,
            listingId,
        });
    }
    return list;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Read and decompress a single XMLTV file (supports .gz and plain .xml).
 */
function readXmltvFile(filePath: string): string {
    const raw = readFileSync(filePath.trim());
    return filePath.trim().endsWith(".gz")
        ? gunzipSync(raw).toString("utf-8")
        : raw.toString("utf-8");
}

function ensureFresh(): void {
    const now = Date.now();
    if (now - lastRefresh < refreshIntervalMs && cachedChannels.size > 0) return;

    // Support comma-separated list of file paths
    const pathSpec = env.VINO_JP_XMLTV_PATH ?? "./data/jp_merged_epg.xml.gz";
    const filePaths = pathSpec.split(",").map((p) => p.trim()).filter(Boolean);
    logger.info("XMLTV: (re)loading EPG from %d file(s): %s", filePaths.length, filePaths.join(", "));

    try {
        const mergedChannels: Map<string, XmltvChannel> = new Map();
        let mergedProgrammes: XmltvProgramme[] = [];

        for (const fp of filePaths) {
            const xml = readXmltvFile(fp);
            const channels = extractChannels(xml);
            const programmes = extractProgrammes(xml);

            // Merge channels (later files overwrite earlier for duplicates)
            for (const [id, ch] of channels) {
                if (!mergedChannels.has(id)) {
                    mergedChannels.set(id, ch);
                }
            }

            mergedProgrammes = mergedProgrammes.concat(programmes);
            logger.info("XMLTV:   %s → %d channels, %d programmes", fp, channels.size, programmes.length);
        }

        // Deduplicate programmes (same channel + same start time = duplicate)
        const seen = new Set<string>();
        mergedProgrammes = mergedProgrammes.filter((p) => {
            const key = `${p.channelId}|${p.startUtc}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Sort by start time
        mergedProgrammes.sort((a, b) => a.startUtc - b.startUtc);

        cachedChannels = mergedChannels;
        cachedProgrammes = mergedProgrammes;
        lastRefresh = now;

        logger.success(
            "XMLTV: loaded %d channels, %d programmes (from %d files)",
            cachedChannels.size,
            cachedProgrammes.length,
            filePaths.length,
        );
    } catch (err: any) {
        logger.error("XMLTV: failed to load EPG – %s", err.message);
        // Don't wipe existing cache on reload failure
    }
}

/** Returns all channels from the XMLTV file */
export function getChannels(): Map<string, XmltvChannel> {
    ensureFresh();
    return cachedChannels;
}

/**
 * Returns programmes for a specific channel within a UTC time window.
 * startUtc / endUtc are epoch seconds.
 */
export function getPrograms(
    channelId: string,
    startUtc: number,
    endUtc: number
): XmltvProgramme[] {
    ensureFresh();
    return cachedProgrammes.filter(
        (p) =>
            p.channelId === channelId &&
            p.endUtc > startUtc &&
            p.startUtc < endUtc
    );
}

/** Find a specific programme by its listingId */
export function findByListingId(listingId: string): XmltvProgramme | undefined {
    ensureFresh();
    return cachedProgrammes.find((p) => p.listingId === listingId);
}

/** All programmes (for broad searches) */
export function getAllPrograms(): XmltvProgramme[] {
    ensureFresh();
    return cachedProgrammes;
}
