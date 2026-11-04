import { BarChart3, CalendarClock, Compass, FileText, LayoutDashboard, ListChecks, Radar, Send, Settings } from "@lucide/svelte";
import type { Component } from "svelte";
import { m } from "@/lib/paraglide/messages";

// Single source of truth for the app's primary destinations — shared by the
// desktop sidebar and the mobile nav so they can never drift.
//
// Labels are FUNCTIONS, not strings: the active locale is decided per request
// (Paraglide's cookie strategy), so a label evaluated once at module load would
// freeze the language the server happened to boot with.
export type NavItem = {
  href: string;
  label: () => string;
  icon: Component<{ class?: string }>;
  chip?: () => string;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: () => m.nav_today(), icon: LayoutDashboard },
  { href: "/explore", label: () => m.nav_explore(), icon: Compass, chip: () => m.nav_badge_new() },
  { href: "/scheduled-scans", label: () => m.nav_scheduled_scans(), icon: CalendarClock },
  { href: "/pipeline", label: () => m.nav_pipeline(), icon: ListChecks },
  { href: "/followups", label: () => m.nav_followups(), icon: Send },
  { href: "/portals", label: () => m.nav_portals(), icon: Radar },
  { href: "/analytics", label: () => m.nav_analytics(), icon: BarChart3 },
  { href: "/cv", label: () => m.nav_cv(), icon: FileText },
  { href: "/config", label: () => m.nav_config(), icon: Settings },
];

export function isActivePath(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}
