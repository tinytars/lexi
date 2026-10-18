// W84 — rewrites an answer for the ear before it is synthesized: a neural voice reads "mg/dL" as
// letters and "70–99" as "seventy dash ninety-nine". Only a unit that follows a number is expanded,
// so prose that merely contains the letters is left alone.

const UNITS: [string, string][] = [
  ["µIU/mL", "micro-international units per milliliter"],
  ["uIU/mL", "micro-international units per milliliter"],
  ["mIU/mL", "milli-international units per milliliter"],
  ["mg/dL", "milligrams per deciliter"],
  ["g/dL", "grams per deciliter"],
  ["ng/dL", "nanograms per deciliter"],
  ["ng/mL", "nanograms per milliliter"],
  ["pg/mL", "picograms per milliliter"],
  ["µg/dL", "micrograms per deciliter"],
  ["mcg/dL", "micrograms per deciliter"],
  ["mmol/mol", "millimoles per mole"],
  ["mmol/L", "millimoles per liter"],
  ["µmol/L", "micromoles per liter"],
  ["umol/L", "micromoles per liter"],
  ["nmol/L", "nanomoles per liter"],
  ["pmol/L", "picomoles per liter"],
  ["mEq/L", "milliequivalents per liter"],
  ["U/L", "units per liter"],
  ["mL", "milliliters"],
  ["mcg", "micrograms"],
  ["µg", "micrograms"],
  ["mg", "milligrams"],
  ["kg", "kilograms"],
  ["lb", "pounds"],
  ["IU", "international units"],
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const UNIT_RE = new RegExp(`(\\d)\\s?(${UNITS.map(([u]) => escape(u)).join("|")})(?![\\p{L}\\d])`, "gu");
const UNIT_WORDS = new Map(UNITS);

function month(mm: string): string | null {
  return MONTHS[Number(mm) - 1] ?? null;
}

function sayLine(line: string): string {
  const said = line
    .replace(/^\s*•\s*/, "")
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mm, d) => (month(mm) ? `${month(mm)} ${Number(d)}, ${y}` : m))
    .replace(/\b(\d{4})-(\d{2})\b/g, (m, y, mm) => (month(mm) ? `${month(mm)} ${y}` : m))
    .replace(/(\d)\s?[–-]\s?(?=\d)/g, "$1 to ")
    .replace(/~\s*/g, "about ")
    .replace(/≥\s*/g, "at least ")
    .replace(/≤\s*/g, "at most ")
    .replace(/<\s*(?=\d)/g, "below ")
    .replace(/>\s*(?=\d)/g, "above ")
    .replace(UNIT_RE, (_, digit, unit) => `${digit} ${UNIT_WORDS.get(unit)}`)
    .trimEnd();
  return said && !/[.!?:;]$/.test(said) ? `${said}.` : said;
}

export function speechText(text: string): string {
  return text.split("\n").map(sayLine).join("\n");
}
