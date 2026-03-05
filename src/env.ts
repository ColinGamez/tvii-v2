import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// ── helpers ──────────────────────────────────────────────────
// In dev / xmltv-enabled mode many external-service vars are not needed.
const isDev = ["dev", "stg"].includes(
  (process.env.VINO_JP_CONFIG_ENV ?? "dev").toLowerCase()
);
const xmltvOn =
  (process.env.VINO_JP_XMLTV_ENABLED ?? "false").toLowerCase() === "true";
const relaxed = isDev || xmltvOn;

/** Returns a z.string() that is optional and defaults to `fallback` when relaxed. */
const optStr = (fallback = "") =>
  relaxed
    ? z.string().optional().default(fallback)
    : z.string().min(1);

const optUrl = (fallback = "") =>
  relaxed
    ? z.string().optional().default(fallback)
    : z.string().url();

const optPort = (fallback = 9000) =>
  relaxed
    ? z.coerce.number().int().min(0).max(65535).optional().default(fallback)
    : z.coerce.number().int().min(1).max(65535);

// Type-safe environment variables
export const env = createEnv({
  server: {
    VINO_JP_CONFIG_PORT: z.coerce.number().min(1).max(65535),
    VINO_JP_CONFIG_ENV: z.enum(["dev", "stg", "prod"]),
    VINO_JP_TOKEN_SECRET: z.string().min(1),
    VINO_JP_SITE_URL: z.string().min(1),
    VINO_JP_CONFIG_DB_HOST: z.string().min(1),
    VINO_JP_CONFIG_DB_PORT: z.coerce.number().int().min(1).max(65535),
    VINO_JP_CONFIG_DB_USERNAME: z.string().min(1),
    VINO_JP_CONFIG_DB_PASSWORD: z.string(), // may be empty for local root
    VINO_JP_CONFIG_DB_NAME: z.string().min(1),
    VINO_JP_CONFIG_WHITELIST_DB_NAME: z.string().min(1),

    // These are optional in dev / xmltv mode
    VINO_JP_CONFIG_DC_WEBHOOK_URL: optUrl("https://placeholder.invalid"),
    VINO_JP_CONFIG_BSKY_AES_KEY: optStr("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="), // 32-byte base64
    VINO_JP_MINIO_PUBLIC_URL: optStr("http://localhost:9000"),
    VINO_JP_MINIO_PORT: optPort(9000),
    VINO_JP_MINIO_ENDPOINT: optStr("localhost"),
    VINO_JP_MINIO_ACCESS_KEY: optStr("minioadmin"),
    VINO_JP_MINIO_SECRET_KEY: optStr("minioadmin"),
    VINO_JP_MINIO_BUCKET: optStr("tvii"),

    VINO_JP_TV_CDN_URL: optStr(""),
    VINO_JP_TV_LISTINGS_URL: optStr(""),
    VINO_JP_TV_LINEUPS_URL: optStr(""),
    VINO_JP_TV_LINEUPS_SET_BASE_URL: optStr(""),
    VINO_JP_TV_PROGRAM_DETAILS_BASE_URL: optStr(""),
    VINO_JP_TV_SEASON_CAST_URL: optStr(""),

    // yoinked from google's ai on having an array as an .env var :/
    VINO_JP_STAFF_PIDS: z
      .string()
      .optional()
      .default("0")
      .transform((str) => str.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))),

    // ── JP XMLTV EPG ─────────────────────────────────────────
    VINO_JP_XMLTV_ENABLED: z
      .string()
      .optional()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    VINO_JP_XMLTV_PATH: z.string().optional().default("./data/jp_merged_epg.xml.gz"),
    VINO_JP_XMLTV_LINEUP_PATH: z.string().optional().default("./data/japan.json"),
    VINO_JP_XMLTV_TZ: z.string().optional().default("Asia/Tokyo"),
    VINO_JP_XMLTV_REFRESH_MINUTES: z.coerce.number().int().min(1).optional().default(30),
    VINO_JP_XMLTV_ADULT_FILTER: z
      .string()
      .optional()
      .default("true")
      .transform((v) => v.toLowerCase() === "true"),

    // ── JP G-Guide (bangumi.org) EPG ─────────────────────────
    VINO_JP_GGUIDE_ENABLED: z
      .string()
      .optional()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    VINO_JP_GGUIDE_AREA: z.string().optional().default("23"), // Tokyo = 23

    // ── Kodi PVR integration (channel switching) ─────────────
    VINO_JP_KODI_ENABLED: z
      .string()
      .optional()
      .default("false")
      .transform((v) => v.toLowerCase() === "true"),
    VINO_JP_KODI_URL: z.string().optional().default("http://localhost:8080"),
    VINO_JP_KODI_USER: z.string().optional().default("kodi"),
    VINO_JP_KODI_PASSWORD: z.string().optional().default(""),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: false, // we handle empty strings via defaults above
});
