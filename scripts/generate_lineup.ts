/**
 * Auto-generate data/japan.json from XMLTV EPG .xml.gz files.
 *
 * Usage:  bun run scripts/generate_lineup.ts [file1.xml.gz] [file2.xml.gz ...]
 *
 * If no files are given, defaults to data/epg_ripper_JP1.xml.gz + data/epg_ripper_JP2.xml.gz
 *
 * Output: data/japan.json — a JSON array of lineup entries suitable for jpLineup.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";

// ── Adult keyword blacklist (same as jpLineup.ts) ────────────
const ADULT_KEYWORDS = [
    "AV", "adult", "porn", "XXX", "18+", "playboy",
    "アダルト", "成人", "エロ", "風俗", "R-18", "R18",
    "パラダイステレビ", "レインボーチャンネル", "チェリーボム",
    "ミッドナイト・ブルー", "バニラスカイチャンネル", "プレイボーイ",
    "フラミンゴ", "ダイナマイトTV", "刺激ストロング", "ヌーヴェルパラダイス",
    "Splash", "Zaptv", "kmpチャンネル", "ｋｍｐチャンネル",
    "パワープラッツ", "VENUS", "Ｖ☆パラダイス",
];

function isAdult(name: string, id: string): boolean {
    const combined = `${id} ${name}`;
    return ADULT_KEYWORDS.some((kw) => combined.toLowerCase().includes(kw.toLowerCase()));
}

// ── Channel grouping heuristics ──────────────────────────────
function guessGroup(name: string, id: string): string {
    const t = `${id} ${name}`;

    // Sports
    if (/sport|スポーツ|サッカー|サムライ|ゴルフ|GAORA|J\.SPORTS|スカイA|日テレジータス|EXスポーツ|スカサカ|釣りビジョン|競馬|競輪|SPEED|ＳＰＥＥＤチャンネル|ＪＬＣ|グリーンチャンネル|南関東/i.test(t)) return "スポーツ";

    // Anime / Kids
    if (/アニメ|アニマ|キッズ|ディズニー|カートゥーン|AT-X|ＡＴ－Ｘ|ジュニア/i.test(t)) return "アニメ・キッズ";

    // Movies / Drama
    if (/映画|シネマ|ムービー|ドラマ|劇場|時代劇|東映|WOWOW|ＷＯＷ|スターチャンネル|ファミリー劇場|ホームドラマ|衛星劇場|チャンネル銀河|チャンネルＮＥＣＯ|イマジカ|FOX|ＦＯＸ|AXN|ＡＸＮ|ミステリー|スーパー！ドラマ/i.test(t)) return "映画・ドラマ";

    // Music
    if (/音楽|ミュージック|スペースシャワー|MTV|歌謡|ダンス|MUSIC|クラシカ|TAKARAZUKA|ＴＡＫＡＲＡＺＵＫＡ/i.test(t)) return "音楽";

    // News / Info
    if (/ニュース|NEWS|CNN|ＣＮＮ|日経|CNBC|BBC|ＢＢＣ|天気|ＳＯＲＡ|ＢＳスカパー|放送大学|ビジネス・ブレーク/i.test(t)) return "ニュース・情報";

    // Shopping
    if (/ショップ|QVC|ＱＶＣ|セレクト|ジュエリー|ジャパネット|ベターライフ/i.test(t)) return "ショッピング";

    // Korean / Asian
    if (/韓流|韓国|KBS|ＫＢＳ|KNTV|ＫＮＴＶ|Mnet|Ｍｎｅｔ|アジア|DATV/i.test(t)) return "韓流・アジア";

    // Documentary / Education
    if (/ディスカバリー|ナショナル|ナショジオ|ヒストリー|アニマルプラネット|鉄道|旅|囲碁|将棋|寄席/i.test(t)) return "ドキュメンタリー";

    // Variety / Entertainment
    if (/エンタメ|エンタ|バラエティ|パチンコ|パチスロ|MONDO|アクション|アイドル|Kawaiian|Ｐｉｇｏｏ/i.test(t)) return "バラエティ";

    // Terrestrial / BS
    if (/NHK|ＮＨＫ|日テレ(?!ジータス|プラス|Ｇ)|テレビ朝日|テレビ東京|TBS(?!チャンネル|ニュース)|ＴＢＳ(?!チャンネル|ニュース)|フジテレビ(?!NEXT|ＮＥＸ|ONE|ＯＮＥ|TWO|ＴＷＯ)|BS\d|ＢＳ\d|BS-|ＢＳ-|BS日テレ|ＢＳ日テレ|BS朝日|ＢＳ朝日|BSテレ東|ＢＳテレ東|BSフジ|ＢＳフジ|TOKYO.MX|ＴＯＫＹＯ|BS11|BS12|BSよしもと|J:COM/i.test(t)) return "地上波・BS";

    // Satellite / other
    if (/フジテレビ|テレ朝チャンネル|日テレプラス|TBSチャンネル|ＴＢＳチャンネル|TBSニュース|ＴＢＳニュース|フェニックス|中国テレビ|ＣＣＴ|ＴＶグローボ|ライブ/i.test(t)) return "CS放送";

    return "その他";
}

// ── Dedup heuristic: prefer HD/4K variant ────────────────────
// Some channels exist in both SD and HD. We keep both but note is_hd.
function isHdVariant(id: string): boolean {
    return /HD|ＨＤ|4K|４Ｋ|8K/i.test(id);
}

// ── Main ─────────────────────────────────────────────────────
const defaultFiles = [
    "data/epg_ripper_JP1.xml.gz",
    "data/epg_ripper_JP2.xml.gz",
];

const files = process.argv.length > 2 ? process.argv.slice(2) : defaultFiles;

interface ChannelInfo {
    id: string;
    name: string;
    icon: string | null;
    progCount: number;
}

const allChannels = new Map<string, ChannelInfo>();

for (const file of files) {
    console.log(`Reading ${file}...`);
    const buf = readFileSync(file);
    const xml = file.endsWith(".gz")
        ? gunzipSync(buf).toString("utf-8")
        : buf.toString("utf-8");

    // Extract channels
    const channelRe = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = channelRe.exec(xml)) !== null) {
        const id = cm[1]!;
        const body = cm[2]!;
        const nameMatch = body.match(/<display-name[^>]*>([^<]+)<\/display-name>/i);
        const name = nameMatch ? nameMatch[1]!.trim() : id;
        const iconMatch = body.match(/<icon\s+src="([^"]+)"/i);
        const icon = iconMatch ? iconMatch[1]! : null;

        if (!allChannels.has(id)) {
            allChannels.set(id, { id, name, icon, progCount: 0 });
        }
    }

    // Count programmes per channel
    const progRe = /<programme[^>]+channel="([^"]+)"/gi;
    let pm: RegExpExecArray | null;
    while ((pm = progRe.exec(xml)) !== null) {
        const ch = allChannels.get(pm[1]!);
        if (ch) ch.progCount++;
    }
}

console.log(`\nTotal channels found: ${allChannels.size}`);

// Filter adult channels
const filtered: ChannelInfo[] = [];
const adultFiltered: string[] = [];
for (const ch of allChannels.values()) {
    if (isAdult(ch.name, ch.id)) {
        adultFiltered.push(`${ch.id} (${ch.name})`);
    } else {
        filtered.push(ch);
    }
}

console.log(`Adult channels filtered: ${adultFiltered.length}`);
adultFiltered.forEach((x) => console.log(`  ✗ ${x}`));
console.log(`Channels remaining: ${filtered.length}\n`);

// Sort: by group, then by name
filtered.sort((a, b) => {
    const ga = guessGroup(a.name, a.id);
    const gb = guessGroup(b.name, b.id);
    if (ga !== gb) return ga.localeCompare(gb);
    return a.name.localeCompare(b.name);
});

// Build lineup JSON
const lineup = filtered.map((ch, idx) => ({
    channelId: ch.id,
    number: String(idx + 1),
    name: ch.name,
    logo: ch.icon,
    group: guessGroup(ch.name, ch.id),
}));

// Write output
const outPath = "data/japan.json";
writeFileSync(outPath, JSON.stringify(lineup, null, 2), "utf-8");
console.log(`Wrote ${lineup.length} channels to ${outPath}`);

// Print summary by group
const groups = new Map<string, number>();
for (const e of lineup) {
    groups.set(e.group, (groups.get(e.group) ?? 0) + 1);
}
console.log("\nChannels by group:");
for (const [group, count] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${group}: ${count}`);
}
