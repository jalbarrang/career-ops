// Font families are declared as @font-face in app.css (SvelteKit has no
// next/font/local), which is also where the `--font-*` variables are set.
//
// Only the display family is exposed here: it is applied as a CLASS in 13
// components, and `.className` is the shape those call sites already use. Body
// text comes from `--font-sans` on `:root`, so it needs no per-element class.
export const instrumentSerif = { className: "font-serif" } as const;
