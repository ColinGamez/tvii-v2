/**
 * JP channel lineup mapping.
 *
 * Reads a lineup mapping file (JSON or Markdown table) and produces a
 * canonical Map<channelId, LineupEntry>.
 * Only channels present in this mapping are exposed to JP users.
 * An adult-content keyword blacklist is also applied.
 */

import { readFileSync, existsSync } from "fs";
import { env } from "../env.ts";
import { logger } from "./logger.ts";

// ── Types ────────────────────────────────────────────────────
export interface LineupEntry {
    channelId: string;
    number: string;
    name: string;
    logo: string | null;
    group: string | null;
}

// ── Adult keyword blacklist ──────────────────────────────────
const ADULT_KEYWORDS = [
    // English
    "AV",
    "adult",
    "porn",
    "XXX",
    "18+",
    "playboy",
    // Japanese
    "アダルト",
    "成人",
    "エロ",
    "風俗",
    "R-18",
    "R18",
    "パラダイステレビ",
    "レインボーチャンネル",
    "チェリーボム",
    "ミッドナイト・ブルー",
    "バニラスカイチャンネル",
    "プレイボーイ",
    "フラミンゴ",
    "ダイナマイトTV",
    "刺激ストロング",
    "ヌーヴェルパラダイス",
    "Splash",
    "Zaptv",
    "kmpチャンネル",
    "ｋｍｐチャンネル",
    "パワープラッツ",
    "VENUS",
    "Ｖ☆パラダイス",
];

function isAdult(name: string, id: string): boolean {
    const combined = `${id} ${name}`.toLowerCase();
    return ADULT_KEYWORDS.some((kw) => combined.includes(kw.toLowerCase()));
}

// ── Cache ────────────────────────────────────────────────────
let lineupMap: Map<string, LineupEntry> = new Map();
let loaded = false;

// ── Parsers ──────────────────────────────────────────────────

/** Parse a JSON file: expects array of {channelId, number, name, logo?, group?} */
function parseJson(raw: string): LineupEntry[] {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error("Lineup JSON must be an array");
    return arr.map((e: any) => ({
        channelId: String(e.channelId ?? e.channel_id ?? e.id ?? ""),
        number: String(e.number ?? e.num ?? ""),
        name: String(e.name ?? ""),
        logo: e.logo ?? null,
        group: e.group ?? null,
    }));
}

/**
 * Parse a Markdown table.
 * Expected columns (header names are flexible):
 *   | # | Channel ID | Name | Logo | Group |
 * At minimum columns 1-3 are required.
 */
function parseMarkdown(raw: string): LineupEntry[] {
    const lines = raw.split(/\r?\n/).filter((l) => l.includes("|"));
    if (lines.length < 3) return []; // header + separator + at least 1 row

    // detect column indices from header
    const headerCells = lines[0]!.split("|").map((c) => c.trim().toLowerCase());
    const numIdx = headerCells.findIndex((c) => c === "#" || c === "number" || c === "num");
    const idIdx = headerCells.findIndex((c) => c.includes("channel") && c.includes("id") || c === "id" || c === "channelid");
    const nameIdx = headerCells.findIndex((c) => c === "name");
    const logoIdx = headerCells.findIndex((c) => c === "logo");
    const groupIdx = headerCells.findIndex((c) => c === "group");

    if (numIdx < 0 || idIdx < 0 || nameIdx < 0) {
        logger.warn("jpLineup: Markdown table missing required columns (# / Channel ID / Name)");
        return [];
    }

    const entries: LineupEntry[] = [];
    // skip header + separator (first two lines)
    for (let i = 2; i < lines.length; i++) {
        const cells = lines[i]!.split("|").map((c) => c.trim());
        const channelId = cells[idIdx] ?? "";
        if (!channelId) continue;

        entries.push({
            channelId,
            number: cells[numIdx] ?? String(i - 1),
            name: cells[nameIdx] ?? channelId,
            logo: logoIdx >= 0 ? cells[logoIdx] || null : null,
            group: groupIdx >= 0 ? cells[groupIdx] || null : null,
        });
    }
    return entries;
}

// ── Public API ───────────────────────────────────────────────

function ensureLoaded(): void {
    if (loaded) return;

    const filePath = env.VINO_JP_XMLTV_LINEUP_PATH ?? "./data/japan.json";

    if (!existsSync(filePath)) {
        logger.warn("jpLineup: lineup file not found at %s – JP channels will be empty", filePath);
        loaded = true;
        return;
    }

    logger.info("jpLineup: loading lineup from %s", filePath);
    const raw = readFileSync(filePath, "utf-8");

    let entries: LineupEntry[];
    if (filePath.endsWith(".json")) {
        entries = parseJson(raw);
    } else {
        entries = parseMarkdown(raw);
    }

    const applyFilter = env.VINO_JP_XMLTV_ADULT_FILTER !== false;

    for (const e of entries) {
        if (applyFilter && isAdult(e.name, e.channelId)) {
            logger.warn("jpLineup: filtered adult channel %s (%s)", e.channelId, e.name);
            continue;
        }
        lineupMap.set(e.channelId, e);
    }

    loaded = true;
    logger.success("jpLineup: %d channels in lineup", lineupMap.size);
}

/** Returns the full lineup map (channelId -> LineupEntry) */
export function getLineup(): Map<string, LineupEntry> {
    ensureLoaded();
    return lineupMap;
}

/** Check whether a given channel ID is in the lineup (and not adult-filtered) */
export function isInLineup(channelId: string): boolean {
    ensureLoaded();
    return lineupMap.has(channelId);
}

/** Force reload (for hot-reload during dev) */
export function reloadLineup(): void {
    loaded = false;
    lineupMap = new Map();
    ensureLoaded();
}
