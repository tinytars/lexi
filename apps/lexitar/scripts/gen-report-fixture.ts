// Generates the synthetic documents the model benchmark runs on — a lab report and a clinical note
// — as a PDF and as page images, and commits both.
//
// Two forms because the benchmark must score the SAME document on a model that takes a PDF natively
// and on one that can only see images (src/lib/pdf-pages-for-model.ts decides which in the app).
// Scoring different documents on the two would confound the model with the fixture.
//
// Synthetic by construction: the names, dates and values below are invented, and this repo is
// public. Nothing here is derived from a real patient, and no fixture may ever be.
//
// The committed output is what the benchmark reads, so this runs rarely and by hand — a browser is
// not a test dependency:
//
//   npm run fixture:report
import "./load-creds";
import { chromium, type Browser } from "playwright";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// A4 at 96 dpi, and the width the app renders pages at (src/lib/pdf-pages-for-model.ts). The scale
// factor is what makes the screenshot land on that width, so both forms show the same page at the
// same size the model sees in production.
const PAGE_WIDTH_CSS = 794;
const PAGE_HEIGHT_CSS = 1123;
const PAGE_WIDTH_PX = 1568;
const SCALE = PAGE_WIDTH_PX / PAGE_WIDTH_CSS;
const JPEG_QUALITY = 80;

const FIXTURES = join(import.meta.dirname, "..", "tests", "fixtures");

const STYLE = `
  @page { size: A4; margin: 0; }
  body { margin: 0; font: 13px/1.45 "DejaVu Sans", Arial, sans-serif; color: #111; }
  .page { width: ${PAGE_WIDTH_CSS}px; height: ${PAGE_HEIGHT_CSS}px; box-sizing: border-box; padding: 48px 56px; background: #fff; }
  h1 { font-size: 19px; margin: 0 0 2px; letter-spacing: .02em; }
  .sub { color: #555; font-size: 12px; margin-bottom: 18px; }
  h2 { font-size: 14px; margin: 22px 0 6px; border-bottom: 1px solid #999; padding-bottom: 3px; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th { text-align: left; font-weight: 600; border-bottom: 1px solid #bbb; padding: 4px 6px; }
  td { padding: 3px 6px; border-bottom: 1px solid #eee; }
  td.n { text-align: right; font-variant-numeric: tabular-nums; }
  .flag { color: #b00; font-weight: 600; }
  p { margin: 6px 0; }
  .foot { margin-top: 26px; font-size: 11px; color: #666; }
`;

const HEADER = `
  <h1>MERIDIAN VALLEY DIAGNOSTICS — SYNTHETIC TEST DOCUMENT</h1>
  <div class="sub">Patient: TESTCASE, Alex (fictional) &middot; DOB 1980-03-11 &middot; Sex M
    &middot; MRN SYN-000-114 &middot; Collected 2026-02-14 &middot; Reported 2026-02-16</div>
`;

const FOOTER = `<div class="foot">Synthetic document generated for benchmarking. Not a real patient,
  not a real laboratory, not for clinical use.</div>`;

const LAB_ROWS: [string, string, string, string][] = [
  ["Total protein", "68", "g/L", "64–83"],
  ["Albumin", "41", "g/L", "35–50"],
  ["Glucose, fasting", "6.4", "mmol/L", "3.9–5.6"],
  ["Haemoglobin A1c", "42", "mmol/mol", "20–41"],
  ["Ferritin", "312", "µg/L", "30–400"],
  ["Creatinine", "94", "µmol/L", "62–106"],
  ["eGFR (CKD-EPI)", "88", "mL/min/1.73m²", "> 90"],
  ["Total cholesterol", "5.8", "mmol/L", "< 5.2"],
  ["LDL cholesterol", "3.9", "mmol/L", "< 3.0"],
  ["HDL cholesterol", "1.1", "mmol/L", "> 1.0"],
  ["Triglycerides", "2.1", "mmol/L", "< 1.7"],
  ["25-OH vitamin D", "48", "nmol/L", "50–125"],
  ["TSH", "2.4", "mIU/L", "0.4–4.0"],
  ["ALT", "46", "U/L", "10–40"],
  ["C-reactive protein", "4.8", "mg/L", "< 5.0"],
];

const abnormal = new Set(["Glucose, fasting", "Haemoglobin A1c", "LDL cholesterol", "Triglycerides", "25-OH vitamin D", "ALT", "Total cholesterol"]);

const REPORT_HTML = `<!doctype html><meta charset="utf-8"><style>${STYLE}</style><div class="page">
  ${HEADER}
  <h2>Comprehensive metabolic and lipid panel</h2>
  <table>
    <tr><th>Analyte</th><th>Result</th><th>Unit</th><th>Reference interval</th></tr>
    ${LAB_ROWS.map(
      ([name, value, unit, ref]) =>
        `<tr><td>${name}</td><td class="n ${abnormal.has(name) ? "flag" : ""}">${value}</td><td>${unit}</td><td>${ref}</td></tr>`,
    ).join("")}
  </table>
  <h2>Imaging — coronary CT angiography, 2026-02-09</h2>
  <p>Coronary artery calcium score 212 (Agatston), 78th percentile for age and sex. Mixed plaque in
  the proximal LAD with an estimated 30&ndash;40% diameter stenosis. Right coronary artery and left
  circumflex without haemodynamically significant disease. No anomalous origin.</p>
  <p><strong>Comparison:</strong> prior calcium score 168 on 2024-01-22 &mdash; interval progression.</p>
  <h2>Impression</h2>
  <p>1. Impaired fasting glucose with HbA1c in the prediabetic range.<br>
     2. Mixed dyslipidaemia, LDL above target for calculated risk.<br>
     3. Subclinical coronary atherosclerosis, progressive by calcium score.<br>
     4. Vitamin D insufficiency. Mildly elevated ALT, unexplained.</p>
  ${FOOTER}
</div>`;

const NOTE_HTML = `<!doctype html><meta charset="utf-8"><style>${STYLE}</style><div class="page">
  ${HEADER}
  <h2>Clinic note — internal medicine follow-up, 2026-02-20</h2>
  <p>Forty-six year old man seen for review of the February panel and the coronary CT. He reports
  three months of mid-afternoon fatigue, unchanged exercise tolerance, and no chest pain, dyspnoea
  or palpitations. Sleep averages six hours. Alcohol two units most evenings.</p>
  <p>Medication: none regular. Supplements: creatine monohydrate 5 g daily, colecalciferol 1000 IU
  daily, started after the previous panel.</p>
  <p>Examination unremarkable. BP 132/84 seated, repeat 128/80. BMI 27.4.</p>
  <p>Discussed the calcium score and its progression at length, including what a percentile does and
  does not say about individual risk. Agreed to a twelve-week trial of dietary change and a stepped
  walking programme before revisiting lipid-lowering therapy, with a repeat lipid panel and ALT at
  the end of it. Advised reducing alcohol, which also bears on the transaminase.</p>
  <p>Follow-up in twelve weeks, sooner for any exertional symptom.</p>
  ${FOOTER}
</div>`;

async function emit(browser: Browser, name: string, html: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: PAGE_WIDTH_CSS, height: PAGE_HEIGHT_CSS }, deviceScaleFactor: SCALE });
  await page.setContent(html, { waitUntil: "load" });
  await writeFile(join(FIXTURES, `${name}.pdf`), await page.pdf({ width: `${PAGE_WIDTH_CSS}px`, height: `${PAGE_HEIGHT_CSS}px`, printBackground: true }));
  // Page images come from the same HTML rather than from the PDF just written: rasterising the PDF
  // would need a canvas Node does not have, and the app's own renderer is browser-side. Same engine,
  // same page box, same width the app renders at — so the two forms differ in container, not content.
  await writeFile(join(FIXTURES, `${name}-p1.jpg`), await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY }));
  await page.close();
}

const browser = await chromium.launch();
await emit(browser, "synthetic-report", REPORT_HTML);
await emit(browser, "synthetic-note", NOTE_HTML);
await browser.close();
process.stdout.write(`wrote synthetic-report{.pdf,-p1.jpg} and synthetic-note{.pdf,-p1.jpg} to ${FIXTURES}\n`);
