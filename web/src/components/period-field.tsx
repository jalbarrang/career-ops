"use client";

import { useState } from "react";
import { CalendarDays, Keyboard, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { MONTH_LABELS, formatPeriod, parsePeriod } from "@/lib/cv-profile.mjs";

/**
 * Start / end date picker for a role's `period`, with a "currently working here"
 * toggle.
 *
 * The stored field stays a single string — the picker is a mode over it, not a
 * schema change — so everything downstream (the CV payload's `dates`, the PDF's
 * reverse-chronological guard, the importer's period classifier) is untouched.
 * What the picker writes follows the rules those consumers need: start date
 * first, a 4-digit year, English month abbreviations, an en dash, and no
 * trailing punctuation.
 *
 * An IMPORTED period is free text from someone's CV. When it does not parse
 * (a sentence, a stray list of clients) the picker stays out of the way and a
 * plain text box is shown instead, so a value it never understood is never
 * silently replaced by an empty one.
 */
type Draft = {
  startMonth: string;
  startYear: string;
  endMonth: string;
  endYear: string;
  present: boolean;
};

function draftFrom(value: string): Draft {
  const parsed = parsePeriod(value);
  return {
    startMonth: parsed?.start?.month ? String(parsed.start.month) : "",
    startYear: parsed?.start?.year ? String(parsed.start.year) : "",
    endMonth: parsed?.end?.month ? String(parsed.end.month) : "",
    endYear: parsed?.end?.year ? String(parsed.end.year) : "",
    present: Boolean(parsed?.present),
  };
}

const number = (value: string) => (value === "" ? null : Number(value));

export function PeriodField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const parsed = parsePeriod(value);
  // Empty is a valid state (a role with no dates), so it opens the picker.
  const [mode, setMode] = useState<"picker" | "raw">(value.trim() !== "" && parsed === null ? "raw" : "picker");
  const [draft, setDraft] = useState<Draft>(() => draftFrom(value));
  const [typed, setTyped] = useState(value);

  function commit(next: Draft) {
    setDraft(next);
    const formatted = formatPeriod({
      startMonth: number(next.startMonth),
      startYear: number(next.startYear),
      endMonth: next.present ? null : number(next.endMonth),
      endYear: next.present ? null : number(next.endYear),
      present: next.present,
    });
    // A half-typed year returns null; keep what is stored rather than blanking
    // it, so typing "2025" digit by digit never wipes the period on the way.
    if (formatted !== null) onChange(formatted);
  }

  const monthSelect = (key: "startMonth" | "endMonth", disabled = false) => (
    <select
      aria-label={key === "startMonth" ? "Start month" : "End month"}
      value={draft[key]}
      disabled={disabled}
      onChange={(event) => commit({ ...draft, [key]: event.target.value })}
      className={cn(
        "rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs text-foreground outline-none focus:border-brand/40",
        disabled && "opacity-50",
      )}
    >
      <option value="">—</option>
      {MONTH_LABELS.map((label, index) => (
        <option key={label} value={String(index + 1)}>
          {label}
        </option>
      ))}
    </select>
  );

  const yearInput = (key: "startYear" | "endYear", disabled = false) => (
    <input
      aria-label={key === "startYear" ? "Start year" : "End year"}
      value={draft[key]}
      disabled={disabled}
      inputMode="numeric"
      maxLength={4}
      placeholder="2025"
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/g, "").slice(0, 4);
        commit({ ...draft, [key]: digits });
      }}
      className={cn(
        "w-16 rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs text-foreground outline-none placeholder:text-faint focus:border-brand/40",
        disabled && "opacity-50",
      )}
    />
  );

  if (mode === "raw") {
    return (
      <div className="text-xs text-faint">
        <div className="flex items-center justify-between gap-2">
          <span>Period</span>
          <button
            type="button"
            onClick={() => {
              setDraft(draftFrom(typed));
              setMode("picker");
            }}
            className="inline-flex items-center gap-1 text-faint transition-colors hover:text-foreground"
          >
            <CalendarDays className="size-3" /> Use dates
          </button>
        </div>
        <input
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            onChange(event.target.value);
          }}
          placeholder="Mar 2025 – Sep 2026"
          className="mt-0.5 w-full rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs text-foreground outline-none placeholder:text-faint focus:border-brand/40"
        />
        <p className="mt-0.5">
          Kept as typed — this value is not a date range the picker could read. Start date first, with a year, if you want it to count for ordering.
        </p>
      </div>
    );
  }

  const formatted = formatPeriod({
    startMonth: number(draft.startMonth),
    startYear: number(draft.startYear),
    endMonth: draft.present ? null : number(draft.endMonth),
    endYear: draft.present ? null : number(draft.endYear),
    present: draft.present,
  });

  return (
    <div className="text-xs text-faint">
      <div className="flex items-center justify-between gap-2">
        <span>Period</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setTyped(value);
              setMode("raw");
            }}
            className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
          >
            <Keyboard className="size-3" /> Type it
          </button>
          {value.trim() !== "" && (
            <button
              type="button"
              onClick={() => {
                const cleared = { startMonth: "", startYear: "", endMonth: "", endYear: "", present: false };
                setDraft(cleared);
                onChange("");
              }}
              aria-label="Clear the dates"
              className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
            >
              <Trash2 className="size-3" /> Clear
            </button>
          )}
        </div>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex items-center gap-1">
          <span className="text-faint">Start</span>
          {monthSelect("startMonth")}
          {yearInput("startYear")}
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="text-faint">End</span>
          {monthSelect("endMonth", draft.present)}
          {yearInput("endYear", draft.present)}
        </span>
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={draft.present}
            onChange={(event) => commit({ ...draft, present: event.target.checked })}
            className="accent-[var(--color-brand)]"
          />
          I currently work here
        </label>
      </div>

      <p className="mt-0.5 text-faint">
        {formatted ? (
          <>
            Saves as <span className="text-foreground">{formatted}</span>
            {formatted.length > 40 && <span className="ml-1 text-amber-600 dark:text-amber-400">· over 40 characters, the importer may not read it as dates</span>}
          </>
        ) : (
          "Add a start year to save a period."
        )}
      </p>
    </div>
  );
}
