// W11 — primary navigation. The app is a static SPA, so "routing" is a single
// active-tab signal mirrored to location.hash for reload / deep-link / back-button.
// No router dependency.

import { PRODUCT_NAME } from "./brand";

// W23 — Import / Export moved out of the tab bar into header buttons (Modal overlays).
export type Tab = "chat" | "doctor" | "markers" | "labs" | "appointment" | "ai";

// W37 — each tab carries a short, patient-facing blurb (the tab-level half of the unified
// description system; the subsection-level half is SectionMeta.blurb in report-sections.ts).
// Rendered once in App.svelte atop every tab's content — for Assistant (no subsections) the tab
// blurb IS its description.
export const TABS: { id: Tab; label: string; icon: string; blurb: string }[] = [
  { id: "chat", label: "Chat", icon: "💬", blurb: "Ask about your health data in plain language — it can surface trends and questions, and help you get ready for a doctor visit." },
  { id: "labs", label: "Labs", icon: "🧪", blurb: "Your test results and reports — the raw markers and documents behind your record." },
  { id: "doctor", label: "Patient", icon: "🩺", blurb: "Your health record — profile, results, treatments, and reports: the facts you and your doctor work from." },
  { id: "appointment", label: "Appointment", icon: "📅", blurb: "Get ready for a doctor visit — questions to ask and terms to know." },
  { id: "ai", label: "Investigator", icon: "🤖", blurb: `${PRODUCT_NAME}'s read of your data — analysis, studies, and possible next steps to discuss with your care team. Not medical advice.` },
];

export const DEFAULT_TAB: Tab = "chat";

const VALID = new Set<Tab>(TABS.map((t) => t.id));

export function isTab(v: string): v is Tab {
  return VALID.has(v as Tab);
}
