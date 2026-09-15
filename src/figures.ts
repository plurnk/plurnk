// Figures the status line and the loop summary share: counts read at a glance, spend to the
// hundredth of a cent.

// 582300 → "582k", 1234567 → "1.2M"; below a thousand, the number itself.
export const abbreviatedCount = (value: number | null | undefined): string => value === null || value === undefined ? "?"
    : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : value >= 1000 ? `${Math.round(value / 1000)}k`
    : String(value);

// "3333.3333" → "3,333.3333", "0.024" → "0.0240".
export const money = (usd: string): string => Number(usd).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
