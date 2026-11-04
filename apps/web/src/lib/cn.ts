import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Class joiner with Tailwind conflict resolution — same util as career-ops-docs. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * shadcn-svelte's element-ref helper. Its components accept `bind:this` and
 * forward it to the element they render; this is the prop shape they expect.
 */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
  ref?: U | null;
};

/**
 * `child` (singular) is bits-ui's "render this element as the given snippet" prop.
 * Both it and `children` are rendered through snippets, never spread as
 * attributes, so shadcn strips them from the props it forwards.
 */
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, "child"> : T;

/**
 * `children` is rendered through a snippet in Svelte 5, never forwarded as an
 * attribute — shadcn uses this to keep it out of the spread props.
 */
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, "children"> : T;

/** For components that accept either mounting style (bits-ui wrappers). */
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
