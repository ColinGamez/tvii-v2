/**
 * Kodi JSON-RPC integration for PVR channel switching.
 *
 * When the user presses "Tune In" on TVii, this module switches the
 * active Kodi PVR channel via JSON-RPC over HTTP.  Channel matching
 * is done through a static name-map from G-Guide Japanese channel
 * names to the romanised labels used in the user's Kodi m3u playlist.
 *
 * Kodi JSON-RPC docs:
 *   https://kodi.wiki/view/JSON-RPC_API
 */

import { env } from "../env.ts";
import { logger } from "./logger.ts";
import * as gguide from "./gguide.ts";

// ── Types ────────────────────────────────────────────────────
export interface KodiChannel {
    channelid: number;
    channelnumber: number;
    label: string;
    /** Label with resolution suffix stripped */
    cleanLabel: string;
}

interface KodiJsonRpcResponse<T = unknown> {
    id: number;
    jsonrpc: string;
    result?: T;
    error?: { code: number; message: string };
}

interface KodiPvrChannelsResult {
    channels: { channelid: number; channelnumber: number; channel: string; label: string }[];
    limits: { end: number; start: number; total: number };
}

// ── Cache ────────────────────────────────────────────────────
let cachedKodiChannels: KodiChannel[] | null = null;
let lastFetch = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── G-Guide → Kodi channel mapping ──────────────────────────
//
// Two-level approach:
//   1. ID_MAP: keyed by G-Guide channel ID (most reliable, handles
//      truncated names and full-width characters).
//   2. NAME_MAP: regex against normalized channel name (fallback).
//
// The G-Guide grid truncates names to ~4-5 chars and sometimes uses
// full-width alphanumerics (ＮＨＫ, ＢＳ).  ID-based mapping avoids
// that problem entirely for known channels.

/** Normalise full-width ASCII (Ａ→A, ＢＳ→BS,　→ space, etc.) */
function normalizeFullWidth(s: string): string {
    return s
        .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/\u3000/g, " ")
        .trim();
}

/**
 * Direct mapping from G-Guide channel ID to Kodi channel label substring.
 * This bypasses name matching entirely.
 */
const ID_MAP: Record<string, string> = {
    // ── Terrestrial (DT, area 23 = Tokyo) ───────────────────
    "gguide-dt-1":   "NHK G (Tokyo)",
    "gguide-dt-2":   "JOAB-DTV",          // NHK Eテレ
    "gguide-dt-3":   "",                   // テレ玉 (Tele Saitama) — not in IPTV
    "gguide-dt-4":   "Nippon TV",          // 日テレ
    "gguide-dt-5":   "TV Asahi",           // テレビ朝日
    "gguide-dt-6":   "TBS",               // TBS
    "gguide-dt-7":   "TV Tokyo",           // テレ東
    "gguide-dt-8":   "Fuji TV",            // フジテレビ (NOT Fuji TV NEXT)
    "gguide-dt-9":   "Tokyo MX",           // TOKYO MX

    // ── BS ───────────────────────────────────────────────────
    "gguide-bs-1":   "NHK BS",
    "gguide-bs-3":   "NHK BSP4K",         // NHK BSプレミアム
    "gguide-bs-4":   "BS Nippon TV",       // BS日テレ
    "gguide-bs-5":   "BS Asahi",           // BS朝日
    "gguide-bs-6":   "BS TBS",            // BS-TBS
    "gguide-bs-7":   "BS TV Tokyo",        // BSテレ東
    "gguide-bs-8":   "WOWOW Live",         // WOWOWライブ (WP now merged)
    "gguide-bs-9":   "WOWOW Cinema",       // WOWOWシネマ
    "gguide-bs-10":  "BS Fuji TV",         // BSフジ (BS10)
    "gguide-bs-11":  "",                   // BS11 — not in IPTV
    "gguide-bs-12":  "",                   // BS12 TwellV — not in IPTV
    "gguide-bs-14":  "",                   // 放送大学テレビ
    "gguide-bs-15":  "",                   // 放送大学テレビ (duplicate)
    "gguide-bs-16":  "Green Channel",
    "gguide-bs-17":  "",                   // BSアニマックス
    "gguide-bs-18":  "J Sports 1",         // J SPORTS 1
    "gguide-bs-19":  "J Sports 2",         // J SPORTS 2
    "gguide-bs-20":  "J Sports 3",         // J SPORTS 3
    "gguide-bs-21":  "J Sports 4",         // J SPORTS 4
    "gguide-bs-22":  "Fishing Vision",     // BS釣りビジョン
    "gguide-bs-23":  "WOWOW Prime",        // WOWOWプラス (WOWOW Prime in Kodi)
    "gguide-bs-24":  "Nihon Eiga Senmon",  // 日本映画専門ch
    "gguide-bs-25":  "Disney Channel Japan",// ディズニーch
    "gguide-bs-26":  "",                   // J:COM BS
    "gguide-bs-27":  "",                   // BSよしもと

    // ── CS (110° CS, service IDs) ────────────────────────────
    "gguide-cs-55":  "Shop Channel",       // ショップチャンネル
    "gguide-cs-161": "QVC Japan",
    "gguide-cs-218": "Toei Channel",       // 東映チャンネル (truncated "東映チャ")
    "gguide-cs-219": "Eisei Gekijo",       // 衛星劇場
    "gguide-cs-250": "Sky A",              // スカイA
    "gguide-cs-254": "Gaora Sports",       // GAORA (truncated "GAOR")
    "gguide-cs-257": "Nittele G Plus",     // 日テレジータス (truncated "日テレジ")
    "gguide-cs-262": "Golf Network",       // ゴルフネットワーク (truncated "ゴルフネ")
    "gguide-cs-290": "TAKARAZUKA SKY STAGE",
    "gguide-cs-292": "Jidaigeki Senmon",   // 時代劇専門 (truncated "時代劇専")
    "gguide-cs-293": "Family Gekijo",      // ファミリー劇場 (truncated "ファミリ")
    "gguide-cs-294": "Home Drama Channel", // ホームドラマ (truncated "ホームド")
    "gguide-cs-300": "",                   // 日テレプラス (Nittele Plus — not in IPTV distinctly)
    "gguide-cs-305": "Channel Ginga",      // チャンネル銀河 (truncated "チャンネ")
    "gguide-cs-307": "Fuji TV NEXT",       // フジテレビNEXT
    "gguide-cs-312": "Dlife",
    "gguide-cs-321": "Music Japan TV",     // Music On! TV
    "gguide-cs-322": "Space Shower TV",    // スペースシャワーTV (truncated "スペース")
    "gguide-cs-323": "MTV Japan",          // MTV HD
    "gguide-cs-325": "",                   // MUSIC ON! TV HD (duplicate)
    "gguide-cs-329": "Kayo Pops",          // 歌謡ポップス (truncated "歌謡ポッ")
    "gguide-cs-330": "Kids Station",       // キッズステーション (truncated "キッズス")
    "gguide-cs-339": "Disney Channel Japan",// ディズニージュニア / Disney
    "gguide-cs-340": "",                   // ディスカバリー — not in IPTV under this name
    "gguide-cs-342": "History Channel",    // ヒストリーチャンネル (truncated "ヒストリ")
    "gguide-cs-343": "National Geographic Japan", // ナショナルジオグラフィック (truncated "ナショナ")
    "gguide-cs-349": "",                   // 日テレNEWS24 — not in IPTV
    "gguide-cs-351": "",                   // TBSチャンネル — not in IPTV
    "gguide-cs-800": "",                   // スポーツライブ+
    "gguide-cs-801": "",                   // スカチャン
};

/**
 * Name-based fallback regex mapping.
 * Only used when the ID_MAP doesn't have an entry.
 * Patterns are tested against the normalised (full-width → half-width) G-Guide name.
 */
const NAME_MAP: [RegExp, string[]][] = [
    // ── Terrestrial ─────────────────────────────────────────
    [/NHK総合/,                              ["NHK G (Tokyo)", "NHK G (Osaka)", "NHK G"]],
    [/NHK.*Eテレ|NHKEテレ|JOAB/i,            ["JOAB-DTV"]],
    [/日本テレビ|^日テレ$/,                    ["Nippon TV"]],
    [/テレビ朝日|^テレ朝$/,                    ["TV Asahi"]],
    [/^TBS$|^TBSテレビ$/,                     ["TBS"]],
    [/テレビ東京|^テレ東$/,                    ["TV Tokyo"]],
    [/^フジテレビ$/,                          ["Fuji TV"]],
    [/TOKYO\s*MX|東京MX/i,                    ["Tokyo MX"]],
    [/サンテレビ/,                            ["Sun TV"]],
    [/ABCテレビ/,                             ["ABC"]],
    [/^MBS$|MBSテレビ/,                       ["MBS"]],
    [/関西テレビ/,                            ["Kansai TV"]],
    [/読売テレビ|よみうり/,                    ["YTV"]],
    [/テレビ大阪/,                            ["TV Osaka"]],

    // ── BS ───────────────────────────────────────────────────
    [/^NHK\s*BS$/,                            ["NHK BS"]],
    [/NHK\s*BSプレミアム|NHK\s*BSP/,           ["NHK BSP4K"]],
    [/BS日テレ/,                              ["BS Nippon TV"]],
    [/BS朝日/,                                ["BS Asahi"]],
    [/^BS-?TBS$/,                             ["BS TBS"]],
    [/BSテレ東|BSジャパン/,                    ["BS TV Tokyo"]],
    [/BSフジ|BS10/,                           ["BS Fuji TV"]],
    [/BS松竹東急/,                            ["BS Shochiku Tokyu"]],
    [/WOWOWプライム/,                         ["WOWOW Prime"]],
    [/WOWOWライブ/,                           ["WOWOW Live"]],
    [/WOWOWシネマ/,                           ["WOWOW Cinema"]],
    [/WOWOWプラス/,                           ["WOWOW Prime"]],

    // ── CS / Specialty ──────────────────────────────────────
    [/J\s*SPORTS\s*1/i,                       ["J Sports 1"]],
    [/J\s*SPORTS\s*2/i,                       ["J Sports 2"]],
    [/J\s*SPORTS\s*3/i,                       ["J Sports 3"]],
    [/J\s*SPORTS\s*4/i,                       ["J Sports 4"]],
    [/ディズニ/,                              ["Disney Channel Japan"]],
    [/ヒストリ/,                              ["History Channel"]],
    [/ナショナ/,                              ["National Geographic Japan"]],
    [/^MTV/i,                                 ["MTV Japan"]],
    [/スペース.*シャワー|^スペース$/,           ["Space Shower TV"]],
    [/MUSIC ON|ミュージ/i,                    ["Music Japan TV"]],
    [/歌謡ポ/,                                ["Kayo Pops"]],
    [/キッズス/,                              ["Kids Station"]],
    [/日テレジ/,                              ["Nittele G Plus"]],
    [/GAORA?/i,                               ["Gaora Sports"]],
    [/ゴルフネ/,                              ["Golf Network"]],
    [/東映チャ/,                              ["Toei Channel"]],
    [/衛星劇場/,                              ["Eisei Gekijo"]],
    [/ファミリ.*劇|^ファミリ$/,               ["Family Gekijo"]],
    [/ホームド/,                              ["Home Drama Channel"]],
    [/時代劇専/,                              ["Jidaigeki Senmon"]],
    [/日本映画専/,                            ["Nihon Eiga Senmon"]],
    [/チャンネル?銀河|^チャンネ$/,             ["Channel Ginga"]],
    [/宝塚|TAKA/i,                            ["TAKARAZUKA SKY STAGE"]],
    [/釣りビジョン|BS釣り/,                    ["Fishing Vision"]],
    [/グリーンチャ/,                          ["Green Channel"]],
    [/ショップチ/,                            ["Shop Channel"]],
    [/^QVC/i,                                 ["QVC Japan"]],
    [/フジテレビNEXT|^フジテレ$/,             ["Fuji TV NEXT"]],
    [/TBSニュース|TBSニ/,                     ["TBS News"]],
    [/スカイ・?A|スカチャン/,                  ["Sky A"]],
    [/ウェザーニュース|ウェザーニューズ/,       ["Weathernews"]],
    [/CGNTV/i,                                ["CGNTV Japan"]],
    [/Dlife/i,                                ["Dlife"]],
    [/GSTV/i,                                 ["GSTV"]],
];

// ── Helpers ──────────────────────────────────────────────────

/** Strip resolution suffix like "(544p)", "(1080p)", "[Not 24/7]" etc. */
function cleanLabel(raw: string): string {
    return raw
        .replace(/\s*\([\d]+p\)/g, "")
        .replace(/\s*\[.*?\]/g, "")
        .trim();
}

/** Build Basic auth header */
function authHeader(): string {
    const user = env.VINO_JP_KODI_USER ?? "kodi";
    const pass = env.VINO_JP_KODI_PASSWORD ?? "";
    return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/** Send a JSON-RPC request to Kodi */
async function rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${env.VINO_JP_KODI_URL ?? "http://localhost:8080"}/jsonrpc`;
    const body = {
        jsonrpc: "2.0",
        id: 1,
        method,
        params: params ?? {},
    };

    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: authHeader(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
        throw new Error(`Kodi JSON-RPC ${method}: HTTP ${resp.status} ${resp.statusText}`);
    }

    const json = (await resp.json()) as KodiJsonRpcResponse<T>;
    if (json.error) {
        throw new Error(`Kodi JSON-RPC ${method}: ${json.error.message} (code ${json.error.code})`);
    }
    return json.result as T;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Fetch all PVR channels from Kodi and cache them.
 */
export async function getKodiChannels(forceRefresh = false): Promise<KodiChannel[]> {
    const now = Date.now();
    if (!forceRefresh && cachedKodiChannels && now - lastFetch < CACHE_TTL_MS) {
        return cachedKodiChannels;
    }

    try {
        const data = await rpc<KodiPvrChannelsResult>("PVR.GetChannels", {
            channelgroupid: "alltv",
            properties: ["channelnumber", "channel"],
        });

        cachedKodiChannels = (data.channels ?? []).map((ch) => ({
            channelid: ch.channelid,
            channelnumber: ch.channelnumber,
            label: ch.label,
            cleanLabel: cleanLabel(ch.label),
        }));
        lastFetch = now;
        logger.info(`[kodi] Fetched ${cachedKodiChannels.length} PVR channels`);
    } catch (err) {
        logger.error(`[kodi] Failed to fetch channels: ${err}`);
        if (cachedKodiChannels) return cachedKodiChannels; // stale is better than nothing
        throw err;
    }

    return cachedKodiChannels;
}

/**
 * Find a Kodi channel that matches the given G-Guide channel.
 * Tries ID_MAP first, then NAME_MAP, then direct substring match.
 * Returns the Kodi channelid, or null if no match.
 */
export async function findKodiChannel(gguideId: string, gguideName: string): Promise<KodiChannel | null> {
    const channels = await getKodiChannels();

    // Helper: find a Kodi channel whose cleanLabel matches the search string.
    // Exact > starts-with > includes.
    function findByLabel(search: string): KodiChannel | null {
        const lower = search.toLowerCase();
        // Exact match
        let m = channels.find((ch) => ch.cleanLabel.toLowerCase() === lower);
        if (m) return m;
        // Starts-with (avoids "Fuji TV" matching "Fuji TV NEXT")
        m = channels.find((ch) => {
            const cl = ch.cleanLabel.toLowerCase();
            return cl.startsWith(lower) && (cl.length === lower.length || cl[lower.length] === " " || cl[lower.length] === "(");
        });
        if (m) return m;
        // Includes
        m = channels.find((ch) => ch.cleanLabel.toLowerCase().includes(lower));
        return m ?? null;
    }

    // 1. Try the ID_MAP (most reliable)
    if (gguideId in ID_MAP) {
        const label = ID_MAP[gguideId]!;
        if (label === "") return null; // Explicitly marked as not available
        const match = findByLabel(label);
        if (match) return match;
    }

    // 2. Try the NAME_MAP with normalised name
    const normName = normalizeFullWidth(gguideName);
    for (const [pattern, candidates] of NAME_MAP) {
        if (!pattern.test(normName)) continue;
        for (const candidate of candidates) {
            const match = findByLabel(candidate);
            if (match) return match;
        }
    }

    // 3. Fallback: direct substring match
    const lowerNorm = normName.toLowerCase();
    const direct = channels.find((ch) => ch.cleanLabel.toLowerCase().includes(lowerNorm));
    if (direct) return direct;

    return null;
}

/**
 * Switch Kodi to the given PVR channel by Kodi channelid.
 */
export async function switchToChannel(channelid: number): Promise<void> {
    await rpc("Player.Open", {
        item: { channelid },
    });
    logger.info(`[kodi] Switched to channelid ${channelid}`);
}

/**
 * High-level: resolve a G-Guide channel ID to a Kodi channel and switch.
 * Returns the matched Kodi channel info, or null if no match.
 */
export async function tuneToGGuideChannel(gguideChannelId: string): Promise<KodiChannel | null> {
    // Look up the G-Guide channel to get its Japanese name
    const channels = await gguide.getChannels();
    const ggCh = channels.get(gguideChannelId);
    if (!ggCh) {
        logger.warn(`[kodi] G-Guide channel not found: ${gguideChannelId}`);
        return null;
    }

    const name = ggCh.fullName || ggCh.name;
    logger.info(`[kodi] Tune request: ${gguideChannelId} → "${name}"`);

    const kodiCh = await findKodiChannel(gguideChannelId, name);
    if (!kodiCh) {
        logger.warn(`[kodi] No Kodi channel match for "${name}"`);
        return null;
    }

    logger.info(`[kodi] Matched → "${kodiCh.label}" (channelid=${kodiCh.channelid})`);
    await switchToChannel(kodiCh.channelid);
    return kodiCh;
}

/**
 * Check whether Kodi integration is enabled and reachable.
 */
export async function isKodiAvailable(): Promise<boolean> {
    if (!env.VINO_JP_KODI_ENABLED) return false;
    try {
        await rpc("JSONRPC.Ping");
        return true;
    } catch {
        return false;
    }
}

/**
 * Get the mapping debug info: all G-Guide channels with their Kodi matches.
 */
export async function getChannelMapping(): Promise<
    { gguideId: string; gguideName: string; broad: string; kodiMatch: KodiChannel | null }[]
> {
    const ggChannels = await gguide.getChannels();
    const result: { gguideId: string; gguideName: string; broad: string; kodiMatch: KodiChannel | null }[] = [];

    for (const [id, ch] of ggChannels) {
        const name = ch.fullName || ch.name;
        const kodiCh = await findKodiChannel(id, name);
        result.push({
            gguideId: id,
            gguideName: name,
            broad: ch.broad,
            kodiMatch: kodiCh,
        });
    }

    return result;
}
