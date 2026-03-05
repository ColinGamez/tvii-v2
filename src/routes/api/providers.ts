import express, { type Request, type Response, type Router } from "express";
import { z } from "zod";
import { env } from "../../env.ts";
import * as cheerio from "cheerio";
import { db } from "../../utils/db.ts";
import { parseServiceToken } from "../../utils/serviceToken.ts";
import { fetchWithProxy, postWithProxy } from "../../utils/fetchWithProxy.ts";
import { logger } from "../../utils/logger.ts";
import Redis from "ioredis";
import * as gguide from "../../utils/gguide.ts";

const redis = new Redis();

const router: Router = express.Router();

interface Provider {
    type: "antenna" | "cable" | "satellite" | "other";
    name: string;
    lineup_id: string;
    tz_name: string;
}


interface ListingsCookieOptions {
    provider_id: string;
    tz_name: string;
    country: string;
    forceRefresh?: boolean;
}

async function getListingsCookie({
    provider_id,
    tz_name,
    country,
    forceRefresh = false
}: ListingsCookieOptions) {
    // We use colons (:) to create the "folder" hierarchy in Redis GUIs
    const cacheKey = `provider:${country}:${provider_id}:cookie:${tz_name}`;

    // 1. Try to get cached cookie from Redis
    if (!forceRefresh) {
        const cached = await redis.get(cacheKey);
        if (cached) {
            return cached;
        }
    }

    const url = `${env.VINO_JP_TV_LINEUPS_SET_BASE_URL}/${provider_id}?tz=${encodeURIComponent(tz_name)}`;

    // Note: ensure fetchWithProxy is imported/available
    const resp = await fetchWithProxy(url, undefined, false);

    if (resp.status !== 307 && resp.status !== 302) {
        throw new Error(`Unexpected status code: ${resp.status}`);
    }

    const setCookie = resp.headers.get("set-cookie");
    if (!setCookie) {
        throw new Error("No Set-Cookie header found");
    }

    // 2. Cache in Redis
    // "EX" sets expiration in seconds. 21 days = 1,814,400 seconds.
    const TTL = 21 * 24 * 60 * 60;
    await redis.set(cacheKey, setCookie, "EX", TTL);

    return setCookie;
}

// ── JP G-Guide helpers ───────────────────────────────────────
async function getJpGGuideChannels(): Promise<Channel[]> {
    if (!env.VINO_JP_GGUIDE_ENABLED) return [];
    const ggChannels = await gguide.getChannels();
    const result: Channel[] = [];

    for (const [id, ch] of ggChannels) {
        result.push({
            id: ch.id,
            station: ch.id,
            callsign: ch.name,
            number: ch.number,
            name: ch.name,
            logo: ch.logo,
            url: ch.id,
        });
    }

    // Sort: dt first, then bs, then cs; within each group by number
    const broadOrder: Record<string, number> = { dt: 0, bs: 1, cs: 2 };
    result.sort((a, b) => {
        const aBroad = a.id.split("-")[1] ?? "zz";
        const bBroad = b.id.split("-")[1] ?? "zz";
        const orderDiff = (broadOrder[aBroad] ?? 9) - (broadOrder[bBroad] ?? 9);
        if (orderDiff !== 0) return orderDiff;
        return parseInt(a.number) - parseInt(b.number);
    });

    return result;
}

function jstNow(): number {
    return Math.floor(Date.now() / 1000);
}

/**
 * Infer a TVii showTypeID from JP channel name + program title.
 * The single-char ID drives genre badge color in the client's getProgramGenre().
 *   "M" = Movie, "O" = Sports, "Y" = News, "A" = Animated/Anime,
 *   "W" = Music, "D" = Documentary, "6" = Comedy/Variety,
 *   "1" = Series/Drama (default)
 */
function inferJpGenreId(channelName: string, title: string, category: string | null): string {
    const ch = (channelName || "").toLowerCase();
    const t = (title || "").toLowerCase();
    const cat = (category || "").toLowerCase();

    // Movie channels / movie keywords
    if (/シネマ|映画|ムービー|movie|cinema|ＦＯＸムービー|スターチャンネル|イマジカ/.test(ch) ||
        /映画|劇場版|ロードショー/.test(t)) {
        return "M";
    }

    // Sports channels / keywords
    if (/sport|スポーツ|ゴルフ|j\s*sports|gaora|サッカー|スカサカ|fighting|サムライ|グランプリ|ジータス|スカイa|exスポーツ|foxスポーツ/.test(ch) ||
        /野球|サッカー|ゴルフ|テニス|ラグビー|バスケ|格闘|ボクシング|相撲|五輪|オリンピック/.test(t)) {
        return "O";
    }

    // Anime / animation channels
    if (/アニメ|アニマックス|キッズ|カートゥーン|animax|anime/.test(ch) ||
        /アニメ/.test(t)) {
        return "A";
    }

    // News channels
    if (/ニュース|news|ＣＮＮ|ＢＢＣ|日経/.test(ch) ||
        /ニュース|報道|news/.test(t)) {
        return "Y";
    }

    // Music channels
    if (/ミュージック|music|ＭＴＶ|スペースシャワー|歌謡/.test(ch) ||
        /音楽|ライブ|コンサート/.test(t)) {
        return "W";
    }

    // Documentary / history / science
    if (/ディスカバリー|discovery|ナショジオ|ヒストリー|history|ナショナル/.test(ch) ||
        /ドキュメンタリー|ドキュメント/.test(t)) {
        return "D";
    }

    // Variety / comedy / entertainment
    if (/バラエティ|エンタメ|エンターテイメント/.test(ch) ||
        /バラエティ|お笑い|コント/.test(t)) {
        return "6";
    }

    // Drama (explicit)
    if (/ドラマ|韓流|時代劇|ＡＸＮ/.test(ch) ||
        /ドラマ/.test(t)) {
        return "1";
    }

    // Default: series
    return "1";
}

router.get("/countries/:country/:zipcode", async (req: Request, res: Response) => {
    const { zipcode, country } = req.params;
    const endpoint = `provider:${country}:zipcode:${zipcode}`;

    function removeTVMedia(providers: Provider[]) {
        return providers.filter(function (p) {
            return !p.name || !p.name.startsWith("TV Media");
        });
    }

    try {
        // ── JP shortcut ──────────────────────────────────────
        if (country === "JP") {
            const jpProviders: Provider[] = [];
            if (env.VINO_JP_GGUIDE_ENABLED) {
                jpProviders.push({
                    type: "other",
                    name: "G-Guide Japan",
                    lineup_id: "gguide",
                    tz_name: "Asia/Tokyo",
                });
            }
            // Fallback: if G-Guide disabled, still offer it
            if (jpProviders.length === 0) {
                jpProviders.push({
                    type: "other",
                    name: "G-Guide Japan",
                    lineup_id: "gguide",
                    tz_name: "Asia/Tokyo",
                });
            }
            return res.status(200).json({
                hasError: 0,
                zipcode,
                data: jpProviders,
            });
        }

        // 1️⃣ Redis cache lookup
        const cached = await redis.get(endpoint);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);

                // always clean before returning
                if (parsed?.data && Array.isArray(parsed.data)) {
                    parsed.data = removeTVMedia(parsed.data);
                }

                return res.status(200).json(parsed);

            } catch {
                await redis.del(endpoint);
            }
        }

        if (country !== "US" && country !== "CA") {
            throw new Error("HTTP error!");
        }

        const args = new URLSearchParams();
        args.append("postalCode", String(zipcode).trim());

        const searchRespRaw = await postWithProxy(
            env.VINO_JP_TV_LINEUPS_URL,
            args
        );

        if (!searchRespRaw.ok) {
            throw new Error("Invalid zip code???");
        }

        const searchResp = await searchRespRaw.text();
        const $ = cheerio.load(searchResp);

        const container = $("#lineupSelector>.panel-body>.lineup-results>div").first();
        if (!container.length) {
            throw new Error("Could not find providers");
        }

        const providers: Provider[] = [];

        const typeMap: Record<string, Provider["type"]> = {
            "Over the Air TV Listings": "antenna",
            "Cable TV Listings": "cable",
            "Satellite TV Listings": "satellite",
            "Other TV Listings": "other",
        };

        container.find("h2.p").each((_, h2) => {
            const headingText = $(h2).text().trim();
            const type = typeMap[headingText] || "other";

            let ul = $(h2).next("ul.list-unstyled");

            while (ul.length) {
                ul.find("li a").each((_, a) => {
                    const name = $(a).text().trim();
                    const href = $(a).attr("href") || "";

                    const url = new URL(href);

                    const lineup_id = url.pathname.split("/set/")[1];
                    const tz = url.searchParams.get("tz");

                    providers.push({
                        type,
                        name,
                        lineup_id: String(lineup_id),
                        tz_name: String(tz),
                    });
                });

                ul = ul.next("ul.list-unstyled");
                const nextHeading = ul.prevAll("h2.p").first();
                if (nextHeading.length && nextHeading[0] !== h2) break;
            }
        });

        // always clean before caching
        const cleanedProviders = removeTVMedia(providers);

        const result = {
            hasError: 0,
            zipcode,
            data: cleanedProviders,
        };

        // 2️⃣ Store in Redis (7 days)
        await redis.set(
            endpoint,
            JSON.stringify(result),
            "EX",
            60 * 60 * 24 * 7
        );

        return res.status(200).json(result);

    } catch (err) {
        console.error(`Error in ${endpoint}:`, err);
        return res.status(500).json({
            zipcode,
            hasError: 1,
            error: { code: 500, message: "Internal Server Error" },
        });
    }
});


interface Channel {
    id: string;
    station: string;
    callsign: string;
    number: string;
    name: string;
    logo: string | null;
    url: string;
}

async function getChannelListByProviderID(
    country: string,
    provider_id: string,
    tz_name: string
) {
    const key = `provider:${country}:${provider_id}:chlist`;

    function filterBrokenChannels(list: Channel[]) {
        //ATM, Sorpresa returns a Too Many Redirects error
        return list.filter(ch => ch.url !== "sorpresa/2107");
    }

    const cached = await redis.get(key);
    if (cached) {
        try {
            const parsed = JSON.parse(cached);
            const cleaned = filterBrokenChannels(parsed);
            return cleaned;
        } catch {
            // corrupted cache
            await redis.del(key);
        }
    }

    try {
        const guidecookie = await getListingsCookie({
            provider_id,
            tz_name,
            country,
            forceRefresh: false
        });

        const searchRespRaw = await fetchWithProxy(
            env.VINO_JP_TV_LISTINGS_URL,
            { Cookie: guidecookie }
        );

        if (!searchRespRaw.ok) {
            throw new Error("Could not find providers");
        }

        const searchResp = await searchRespRaw.text();
        const $ = cheerio.load(searchResp);

        const container = $("#tv-listings-grid .channel_cell");
        if (!container.length) {
            throw new Error("Could not find channels");
        }

        const channels: Channel[] = [];

        container.each((_, el) => {
            const div = $(el);

            const id = div.attr("id") || "";
            const station = div.attr("data-station") || "";

            let name = div.attr("title") || "";
            name = name.replace(/\s*\(\d+\)$/, "");

            let logo = div.find(".channel-logo img").attr("src") || null;
            if (logo) {
                if (logo.endsWith("tv-grid-icon.png")) {
                    logo = null;
                } else if (logo.startsWith("//" + env.VINO_JP_TV_CDN_URL)) {
                    logo = logo.replace("//" + env.VINO_JP_TV_CDN_URL, "");
                }
            }

            const callsign = div.find(".channel-callsign").text().trim() || "";
            const number = div.find(".channel-number").text().trim() || "";
            const urlRaw = div.find(".channel-wrapper>a").first().attr("href") || "";

            const match = urlRaw.match(/\/stations\/(.+)$/);
            if (!match) return;

            const stationPath = match[1];

            channels.push({
                id,
                station,
                callsign,
                url: stationPath!,
                number,
                name,
                logo
            });
        });

        //Store the real response always
        //The filtering is dynamic, as we might not need it in the future.
        await redis.set(
            key,
            JSON.stringify(channels),
            "EX",
            60 * 60 * 24 * 7
        );

        return filterBrokenChannels(channels);

    } catch (err) {
        console.error(`Error in ${key}:`, err);
        return null;
    }
}

interface Program {
    start: string;
    end: string;
    duration: number;       // minutes
    showName: string;
    episodeTitle: string | null;
    description: string | null;
    showType: string;
    showTypeID: string;
    rating: string | null;
    year: string | null;
    listingId: string;
    url: string | null;
    guests: string | null;
    showId: string;
    seriesId: string;
    showPicture: string | null;
    isLive: boolean;
    isNew: boolean;
    isCC: boolean;
    teamInfo: {
        league: string;
        team1: string;
        team2: string;
        location: string;
        sportEvent: string;
    } | null;
}

async function getChannelScheduleByNumber(
    provider_id: string,
    tz_name: string,
    country: string,
    channel_num: string,
    date: string
) {
    // fetch channels
    const channels = await getChannelListByProviderID(
        String(country),
        String(provider_id),
        String(tz_name)
    ) as any;

    if (!channels || !channels.length) {
        throw new Error("No channels / fetching error");
    }

    // find channel by number
    const channel = channels.find(function (c: any) {
        return String(c.number) === String(channel_num);
    });

    if (!channel || !channel.url) {
        throw new Error("Channel not found for number: " + channel_num);
    }

    return await getChannelScheduleByPath(
        provider_id,
        tz_name,
        country,
        channel.url,
        date
    );
}


async function getChannelScheduleByPath(
    provider_id: string,
    tz_name: string,
    country: string,
    channel_path_id: string,
    date: string
) {
    const key = `schedules:${channel_path_id}:${tz_name}:${date}`;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`Invalid date format: ${date}. Must be YYYY-MM-DD`);
    }

    // 1️⃣ Redis cache lookup
    const cached = await redis.get(key);
    if (cached) {
        try {
            return JSON.parse(cached);
        } catch {
            // corrupted cache, remove
            await redis.del(key);
        }
    }

    try {
        // Only the cookie uses provider_id + tz_name
        const guidecookie = await getListingsCookie({
            provider_id,
            tz_name,
            country,
            forceRefresh: false
        });

        const searchRespRaw = await fetchWithProxy(
            `${env.VINO_JP_TV_LISTINGS_URL}/stations/${channel_path_id}/${date}`,
            { Cookie: guidecookie }
        );

        if (!searchRespRaw.ok) {
            throw new Error("Could not find providers");
        }

        const searchResp = await searchRespRaw.text();
        const $ = cheerio.load(searchResp);

        const container = $(".station-listings");
        if (!container.length) {
            throw new Error("Could not find schedule data");
        }

        const programs: Program[] = [];

        $(".list-group-item").each((_, el) => {
            const div = $(el);

            const startStr = div.attr("data-st") || "";
            const durationStr = div.attr("data-duration") || "0";
            const duration = parseInt(durationStr, 10);

            const startDate = new Date(startStr.replace(" ", "T"));
            const endDate = new Date(startDate.getTime() + duration * 60 * 1000);

            function formatLocal(d: Date) {
                const yyyy = d.getFullYear();
                const mm = ("0" + (d.getMonth() + 1)).slice(-2);
                const dd = ("0" + d.getDate()).slice(-2);
                const hh = ("0" + d.getHours()).slice(-2);
                const mi = ("0" + d.getMinutes()).slice(-2);
                const ss = ("0" + d.getSeconds()).slice(-2);
                return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}`;
            }

            const start = formatLocal(startDate);
            const end = formatLocal(endDate);

            let showName = div.attr("data-showname") || "";
            let episodeTitle = div.attr("data-episodetitle") || null;

            if ((showName == "Movie" || showName == "Cinéma") && episodeTitle) {
                showName = episodeTitle;
                episodeTitle = null;
            }

            const description = div.find(".col-xs-8.col-sm-11>p:nth-child(2)").text() || null;
            const showTypeID = div.attr("data-showtypeid") || "";
            const showType = div.attr("data-showtype") || "";
            const listingid = div.attr("data-listingid") || "";
            const showid = div.attr("data-showid") || "";
            const seriesid = div.attr("data-seriesid") || "";
            const rating = div.attr("data-rating") || null;
            const year = div.attr("data-year") || null;
            const showPicture = div.attr("data-showpicture") || null;
            const guests = div.attr("data-guest") || null;
            const isLive = div.attr("data-live") === "1";
            const isNew = div.attr("data-new_show") === "1";
            const isCC = div.attr("data-captioned") === "1";
            const url = div.find("a").first().attr("href") || null;

            const league = div.attr("data-league") || "";
            const team1 = div.attr("data-team1") || "";
            const team2 = div.attr("data-team2") || "";
            const location = div.attr("data-location") || "";
            const sportEvent = div.attr("data-sport_event") || "";

            const hasTeamInfo = league || team1 || team2 || location || sportEvent;
            const teamInfo = hasTeamInfo
                ? { league, team1, team2, location, sportEvent }
                : null;

            programs.push({
                start,
                end,
                duration,
                showName,
                showTypeID,
                episodeTitle,
                description,
                showType,
                rating,
                guests,
                listingId: listingid,
                seriesId: seriesid,
                showId: showid,
                year,
                url,
                showPicture,
                isLive,
                isCC,
                isNew,
                teamInfo,
            });
        });

        //36 hours (guide can update dates later?)
        await redis.set(
            key,
            JSON.stringify(programs),
            "EX",
            60 * 60 * 36
        );

        return programs;
    } catch (err) {
        console.error(`Error in ${key}:`, err);
        return null;
    }
}


function makeProgramKey(program_url: string) {
    try {
        const { pathname } = new URL(program_url);
        // pathname example:
        // /movie/incredibles-2/14444720
        // /series/watson/5790200

        const parts = pathname.split("/").filter(Boolean);
        // ["movie", "incredibles-2", "14444720"]

        const type = parts[0]; // movie | series
        const rest = parts.slice(1).join("/"); // incredibles-2/14444720

        if (!type || !rest) return null;

        return `programs:${type}:${rest}`;
    } catch {
        return null;
    }
}

function getSeriesIdFromKey(key: string | null) {
    if (!key) return null;

    // must be series
    if (key.indexOf("programs:series:") !== 0) return null;

    var parts = key.split("/");
    var id = parts[parts.length - 1];

    return /^\d+$/.test(id!) ? id : null;
}

async function getShowDetails
    (
        program_url: string,
        provider_id: string,
        tz_name: string,
        country: string
    ) {
    const key = makeProgramKey(program_url) as any;
    const seriesId = getSeriesIdFromKey(key) as any;

    // 1️⃣ Redis cache lookup
    const cached = await redis.get(key);
    if (cached) {
        try {
            return JSON.parse(cached);
        } catch {
            // corrupted cache, remove
            await redis.del(key);
        }
    }

    try {
        // Only the cookie uses provider_id + tz_name
        const guidecookie = await getListingsCookie({
            provider_id,
            tz_name,
            country,
            forceRefresh: false
        });

        const searchRespRaw = await fetchWithProxy(
            //program_url already contains the tvpassport stuff!
            program_url,
            { Cookie: guidecookie }
        );

        if (!searchRespRaw.ok) {
            throw new Error("Could not find parent program details");
        }

        const searchResp = await searchRespRaw.text();
        const $ = cheerio.load(searchResp);

        const container = $(".container");
        if (!container.length) {
            throw new Error("Could not find program container for data");
        }

        let details = {
            image: container.find(".program-card .img-responsive").attr("src") || null,
            name: container.find(".program-details>h1.h4>a").first().text().trim() || null,
            year: container.find(".program-details .time-spanned").first().text().trim() || null,
            genre: container.find(".program-details .genre").first().text().trim() || null,
            description: container.find(".program-details p").last().text().trim() || null,
            cast: [] as any
        };

        //will only continue IF its a series (call get actor endpoint)
        if (seriesId) {
            try {
                const args = new URLSearchParams();
                args.append("seriesID", seriesId);

                const castRespRaw = await postWithProxy(
                    env.VINO_JP_TV_SEASON_CAST_URL,
                    args
                );

                if (!castRespRaw.ok) {
                    throw new Error("Could not fetch series cast");
                }

                const castResp = await castRespRaw.json() as any;
                const castHtml = castResp.cast_data;
                const $$ = cheerio.load(castHtml);

                // adjust selector if needed depending on returned HTML
                $$(".cast-member").each((_, el) => {
                    const member = $$(el);
                    const linkEl = member.find(".cast-name a");

                    details.cast.push({
                        img: member.find("img").attr("src") || null,
                        name: linkEl.text().trim() || null,
                        url: linkEl.attr("href") || null
                    });
                });

            } catch (err) {
                console.error("Series cast fetch failed, fallback to page cast:", err);
            }
        } else {
            //Then we are requesting movie details, movies seem to have cast members built in
            $(".cast-member").each((_, el) => {
                const member = $(el);
                const linkEl = member.find(".cast-name a");

                details.cast.push({
                    img: member.find("img").attr("src") || null,
                    name: linkEl.text().trim() || null,
                    url: linkEl.attr("href") || null
                });
            });
        }


        // 2️⃣ Store in Redis (7 days)
        await redis.set(
            key,
            JSON.stringify(details),
            "EX",
            60 * 60 * 24 * 7
        );

        return details;
    } catch (err) {
        console.error(`Error in ${key}:`, err);
        return null;
    }
}


router.get("/lineup/:country/:provider_id", async (req: Request, res: Response) => {
    const provider_id = String(req.params.provider_id);
    const country = String(req.params.country);

    let { start, duration, limit, offset, tz_name } = req.query as any;

    try {
        // ── JP G-Guide lineup ────────────────────────────────
        if (country === "JP" && provider_id === "gguide") {
            const durationMinutes = parseInt(duration, 10) || 120;
            const limitChannels = parseInt(limit, 10) || 60;
            const offsetChannels = parseInt(offset, 10) || 0;

            let startDate: Date;
            if (start) {
                const raw = String(start).replace(" ", "T");
                if (!/[Z+-]\d/.test(raw.slice(-6))) {
                    startDate = new Date(raw + "+09:00");
                } else {
                    startDate = new Date(raw);
                }
            } else {
                startDate = new Date();
            }
            if (isNaN(startDate.getTime())) throw new Error("Invalid start date");

            const windowStartUtc = Math.floor(startDate.getTime() / 1000);
            const windowEndUtc = windowStartUtc + durationMinutes * 60;

            const allChannels = await getJpGGuideChannels();

            const allWithPrograms = (await Promise.all(
                allChannels.map(async (channel) => {
                    const progs = await gguide.getPrograms(channel.id, windowStartUtc, windowEndUtc);
                    if (!progs.length) return null;

                    const programs = progs.map((p) => ({
                        start: p.startJst,
                        end: p.endJst,
                        duration: Math.round((p.endUtc - p.startUtc) / 60),
                        showName: p.title,
                        episodeTitle: null as string | null,
                        description: p.description,
                        showType: p.genre ?? "Series",
                        showTypeID: gguide.genreToShowTypeId(p.genreClass, p.genre, p.title),
                        rating: null as string | null,
                        year: null as string | null,
                        listingId: p.listingId,
                        url: null as string | null,
                        guests: null as string | null,
                        showId: p.listingId,
                        seriesId: p.channelId,
                        showPicture: null as string | null,
                        isLive: p.startUtc <= jstNow() && p.endUtc > jstNow(),
                        isNew: false,
                        isCC: false,
                        teamInfo: null,
                    }));

                    return { channel, programs };
                })
            )).filter(Boolean);

            const lineupResults = allWithPrograms.slice(offsetChannels, offsetChannels + limitChannels);

            return res.status(200).json({
                provider_id,
                hasError: 0,
                start: startDate.toISOString().slice(0, 19).replace("T", " "),
                duration: durationMinutes,
                limit: limitChannels,
                offset: offsetChannels,
                total: allWithPrograms.length,
                data: lineupResults,
            });
        }

        if (country !== "US" && country !== "CA") {
            throw new Error("Country not allowed");
        }

        const token = parseServiceToken(req);

        if (!token.ok) {
            throw new Error("Invalid service token!");
        }

        // parse query params
        const durationMinutes = parseInt(duration, 10) || 120;
        const limitChannels = parseInt(limit, 10) || 60;
        const offsetChannels = parseInt(offset, 10) || 0;

        // parse start as a local date in tz_name
        // start is expected as "YYYY-MM-DD HH:mm:ss"
        const startDate = new Date((start || "").replace(" ", "T"));
        if (isNaN(startDate.getTime())) throw new Error("Invalid start date");

        // window end
        const windowEnd = new Date(startDate.getTime() + durationMinutes * 60 * 1000);
        // get all channels
        const allChannels = await getChannelListByProviderID(country, provider_id, tz_name) as any;

        const channelsPage = allChannels.slice(offsetChannels, offsetChannels + limitChannels);

        const lineupResults = await Promise.all(
            channelsPage.map(async (channel: Channel) => {

                const tagSchedule = (list: any[], date: string) =>
                    list.map(p => ({ ...p, scheduleDate: date }));

                const mainDateStr = startDate.toISOString().slice(0, 10);

                let schedule = await getChannelScheduleByPath(
                    provider_id,
                    tz_name,
                    country,
                    channel.url,
                    mainDateStr
                ) as any[];

                schedule = schedule ? tagSchedule(schedule, mainDateStr) : [];

                // fetch previous day if needed
                if (
                    schedule.length &&
                    new Date(schedule[0].start.replace(" ", "T")) > startDate
                ) {
                    const prevDateStr = new Date(
                        startDate.getTime() - 24 * 60 * 60 * 1000
                    ).toISOString().slice(0, 10);

                    const prevSchedule = await getChannelScheduleByPath(
                        provider_id,
                        tz_name,
                        country,
                        channel.url,
                        prevDateStr
                    ) as any[];

                    if (prevSchedule?.length) {
                        schedule = tagSchedule(prevSchedule, prevDateStr).concat(schedule);
                    }
                }

                // fetch next day if needed
                if (
                    schedule.length &&
                    new Date(schedule[schedule.length - 1].end.replace(" ", "T")) < windowEnd
                ) {
                    const nextDateStr = new Date(
                        startDate.getTime() + 24 * 60 * 60 * 1000
                    ).toISOString().slice(0, 10);

                    const nextSchedule = await getChannelScheduleByPath(
                        provider_id,
                        tz_name,
                        country,
                        channel.url,
                        nextDateStr
                    ) as any[];

                    if (nextSchedule?.length) {
                        schedule = schedule.concat(
                            tagSchedule(nextSchedule, nextDateStr)
                        );
                    }
                }

                // dedupe
                const seen = new Set<string>();
                schedule = schedule.filter((p: any) => {
                    const key = p.start + "|" + p.end;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });

                // filter by window
                const filteredPrograms = schedule.filter((p: any) => {
                    const pStart = new Date(p.start.replace(" ", "T"));
                    const pEnd = new Date(p.end.replace(" ", "T"));
                    return pEnd > startDate && pStart < windowEnd;
                });

                if (filteredPrograms.length) {
                    return { channel, programs: filteredPrograms };
                }

                return null;
            })
        );

        const lineup = lineupResults.filter(Boolean);

        return res.status(200).json({
            provider_id,
            hasError: 0,
            start: startDate.toISOString().slice(0, 19).replace("T", " "),
            duration: durationMinutes,
            limit: limitChannels,
            offset: offsetChannels,
            total: allChannels.length,
            data: lineup
        });
    } catch (err: any) {
        console.error(err);
        return res.status(500).json({
            provider_id,
            hasError: 1,
            error: { code: 500, message: err.message || "Internal Server Error" }
        });
    }
});

router.get("/info", async (req: Request, res: Response) => {
    const { date, listingId, channelNum, tz_name, country, provider_id } = req.query as any;

    try {
        // ── JP G-Guide info ──────────────────────────────────
        if (country === "JP" && provider_id === "gguide" && listingId) {
            const prog = await gguide.findByListingId(String(listingId));
            if (!prog) {
                return res.status(404).json({
                    hasError: 1,
                    error: { code: 404, message: "Listing not found" },
                });
            }

            // Find channel
            const allCh = await getJpGGuideChannels();
            const channel = allCh.find((c) => c.id === prog.channelId) ?? {
                id: prog.channelId,
                station: prog.channelId,
                callsign: prog.channelId,
                number: "0",
                name: prog.channelId,
                logo: null,
                url: prog.channelId,
            };

            const program = {
                start: prog.startJst,
                end: prog.endJst,
                duration: Math.round((prog.endUtc - prog.startUtc) / 60),
                showName: prog.title,
                episodeTitle: null as string | null,
                description: prog.description,
                showType: prog.genre ?? "Series",
                showTypeID: gguide.genreToShowTypeId(prog.genreClass, prog.genre, prog.title),
                rating: null as string | null,
                year: null as string | null,
                listingId: prog.listingId,
                url: null as string | null,
                guests: null as string | null,
                showId: prog.listingId,
                seriesId: prog.channelId,
                showPicture: null as string | null,
                isLive: prog.startUtc <= jstNow() && prog.endUtc > jstNow(),
                isNew: false,
                isCC: false,
                teamInfo: null,
            };

            // Fetch rich detail from the program's detail page
            let extra_program: any = null;
            if (prog.eventId) {
                const detail = await gguide.getProgramDetail(prog);
                if (detail) {
                    // Proxy the image through our CDN if it's an external URL
                    let proxyImage = detail.image;
                    if (proxyImage && /^https?:\/\//i.test(proxyImage)) {
                        const encoded = Buffer.from(proxyImage).toString("base64url");
                        proxyImage = `ext/${encoded}`;
                    }

                    // Format cast to match US/CA format
                    const castFormatted = detail.cast.map((c) => {
                        let castImg = c.image;
                        if (castImg && /^https?:\/\//i.test(castImg)) {
                            const enc = Buffer.from(castImg).toString("base64url");
                            castImg = `ext/${enc}`;
                        }
                        return {
                            img: castImg,
                            name: c.role ? `${c.name} (${c.role})` : c.name,
                            url: c.talentId ? `https://bangumi.org/talents/${c.talentId}` : null,
                        };
                    });

                    extra_program = {
                        image: proxyImage,
                        name: detail.masterTitle || prog.title,
                        year: null,
                        genre: detail.genre || prog.genre,
                        description: detail.letterBody || detail.description || prog.description,
                        cast: castFormatted,
                    };

                    // Also update the program's showPicture with the proxied image
                    if (proxyImage) {
                        program.showPicture = proxyImage;
                    }
                }
            }

            return res.status(200).json({
                hasError: 0,
                data: { channel, program, extra_program },
            });
        }

        if (country !== "US" && country !== "CA") {
            throw new Error("Country not allowed");
        }

        if (!date || !listingId || !channelNum || !provider_id || !tz_name) {
            throw new Error("Missing required parameters");
        }

        // validate date format YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            throw new Error("Invalid date format, must be YYYY-MM-DD");
        }

        const token = parseServiceToken(req);
        if (!token.ok) {
            throw new Error("Invalid service token!");
        }

        // fetch schedule for ONE channel on ONE day
        const schedule = await getChannelScheduleByNumber(
            String(provider_id),
            String(tz_name),
            String(country),
            String(channelNum),
            String(date)
        ) as any[];

        if (!schedule || !schedule.length) {
            return res.status(404).json({
                hasError: 1,
                error: { code: 404, message: "No schedule found" }
            });
        }

        // find matching listing
        const program = schedule.find(p =>
            String(p.listingId) === String(listingId)
        );

        if (!program) {
            return res.status(404).json({
                hasError: 1,
                error: { code: 404, message: "Listing not found" }
            });
        }

        // fetch channels
        const channels = await getChannelListByProviderID(
            String(country),
            String(provider_id),
            String(tz_name)
        ) as any;

        if (!channels || !channels.length) {
            throw new Error("No channels / fetching error");
        }

        // find channel by url === channelId
        const channel = channels.find(
            (c: any) => String(c.number) === String(channelNum)
        );

        if (!channel) {
            return res.status(404).json({
                hasError: 1,
                error: { code: 404, message: "Channel not found" }
            });
        }

        let extra_program = null;


        if (program.url) {
            try {
                extra_program = await getShowDetails(program.url, String(country),
                    String(provider_id),
                    String(tz_name))
            } catch (e) {

            }
        }

        return res.status(200).json({
            hasError: 0,
            data: {
                channel,
                program,
                extra_program
            }
        });

    } catch (err: any) {
        console.error(err);
        return res.status(500).json({
            hasError: 1,
            error: { code: 500, message: err.message || "Internal Server Error" }
        });
    }
});


router.get("/countries/:country/:provider_id/channels", async (req: Request, res: Response) => {
    const { provider_id, country } = req.params;
    let { tz_name } = req.query as any;

    try {
        // ── JP G-Guide channels ──────────────────────────────
        if (country === "JP" && provider_id === "gguide") {
            const channels = await getJpGGuideChannels();
            return res.status(200).json({
                hasError: 0,
                provider_id,
                data: channels,
            });
        }

        const channels = await getChannelListByProviderID(String(country), String(provider_id), String(tz_name));
        if (!channels) throw new Error("No channels/fetching error")

        const result = {
            hasError: 0,
            provider_id,
            data: channels,
        };
        return res.status(200).json(result);
    } catch (err) {
        return res.status(500).json({
            provider_id,
            hasError: 1,
            error: { code: 500, message: "Internal Server Error" },
        });
    }
});


// ══════════════════════════════════════════════════════════════
//  Kodi PVR integration – tune-in via JSON-RPC
// ══════════════════════════════════════════════════════════════
import * as kodi from "../../utils/kodi.ts";

/**
 * POST /kodi/tune
 * Body: { "channelId": "gguide-dt-1" }
 *
 * Switches the Kodi PVR player to the channel that matches the
 * given G-Guide channel ID.  Returns the matched Kodi channel
 * info on success.
 */
router.post("/kodi/tune", async (req: Request, res: Response) => {
    if (!env.VINO_JP_KODI_ENABLED) {
        return res.status(503).json({ error: "Kodi integration not enabled" });
    }

    const { channelId } = req.body as { channelId?: string };
    if (!channelId) {
        return res.status(400).json({ error: "channelId is required" });
    }

    try {
        const matched = await kodi.tuneToGGuideChannel(channelId);
        if (!matched) {
            return res.status(404).json({
                error: "no_match",
                message: `No Kodi channel found for ${channelId}`,
            });
        }
        return res.status(200).json({
            ok: true,
            kodi: {
                channelid: matched.channelid,
                label: matched.label,
            },
        });
    } catch (err: any) {
        logger.error(`[kodi/tune] ${err?.message ?? err}`);
        return res.status(502).json({
            error: "kodi_error",
            message: err?.message ?? "Failed to communicate with Kodi",
        });
    }
});

/**
 * GET /kodi/channels
 * Debug endpoint: returns all Kodi PVR channels.
 */
router.get("/kodi/channels", async (_req: Request, res: Response) => {
    if (!env.VINO_JP_KODI_ENABLED) {
        return res.status(503).json({ error: "Kodi integration not enabled" });
    }
    try {
        const channels = await kodi.getKodiChannels(true);
        return res.status(200).json({ total: channels.length, channels });
    } catch (err: any) {
        return res.status(502).json({ error: err?.message ?? "Failed to fetch Kodi channels" });
    }
});

/**
 * GET /kodi/mapping
 * Debug endpoint: shows how G-Guide channels map to Kodi channels.
 */
router.get("/kodi/mapping", async (_req: Request, res: Response) => {
    if (!env.VINO_JP_KODI_ENABLED) {
        return res.status(503).json({ error: "Kodi integration not enabled" });
    }
    try {
        const mapping = await kodi.getChannelMapping();
        const matched = mapping.filter((m) => m.kodiMatch !== null).length;
        return res.status(200).json({
            total: mapping.length,
            matched,
            unmatched: mapping.length - matched,
            channels: mapping,
        });
    } catch (err: any) {
        return res.status(502).json({ error: err?.message ?? "Failed to build mapping" });
    }
});


export { router as providers };
