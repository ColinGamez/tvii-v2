// All NN-allowed countries grouped by region
export const NN_COUNTRIES = {
    JPN: [
        "JP", "KR", "TW", "HK", "MO", "CN", "SG", "MY",
    ],

    USA: [
        "AI", "AG", "AR", "AW", "BS", "BB", "BZ", "BO", "BR", "VG", "CA", "KY", "CL", "CO", "CR",
        "DM", "DO", "EC", "SV", "GF", "GD", "GP", "GT", "GY", "HT", "HN", "JM", "MQ", "MX", "MS",
        "AN", "NI", "PA", "PY", "PE", "KN", "LC", "VC", "SR", "TT", "TC", "US", "UY", "VI", "VE",
        "BM"
    ],

    EUR: [
        "AL", "AU", "AT", "BE", "BA", "BW", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR",
        "HU", "IS", "IE", "IT", "LV", "LS", "LI", "LT", "LU", "MK", "MT", "ME", "MZ", "NA", "NL", "NZ",
        "NO", "PL", "PT", "RO", "RU", "RS", "SK", "SI", "ZA", "ES", "SZ", "SE", "CH", "TR", "GB", "ZM",
        "ZW", "AZ", "MR", "ML", "NE", "TD", "SD", "ER", "DJ", "SO", "AD", "GI", "GG", "IM", "JE", "MC",
        "AE", "SA", "SM", "VA"
    ],
};

export function getRegion(country: string): "USA" | "EUR" | "JPN" {
    const c = country.toUpperCase();

    if (NN_COUNTRIES.JPN.includes(c)) return "JPN";
    if (NN_COUNTRIES.USA.includes(c)) return "USA";
    return "EUR";
}

/** Extract the real client IP from a request (Cloudflare → X-Forwarded-For → req.ip). */
export function getClientIp(req: { headers: Record<string, any>; ip?: string }): string | undefined {
    let ip: string | undefined =
        req.headers["cf-connecting-ip"] as string ||
        req.headers["x-forwarded-for"] as string ||
        req.ip;

    if (typeof ip === "string" && ip.includes(",")) {
        ip = ip.split(",")[0]!.trim();
    }

    if (typeof ip === "string" && ip.startsWith("::ffff:")) {
        ip = ip.substring(7);
    }

    return ip;
}