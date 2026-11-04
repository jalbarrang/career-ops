<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { GrainGradientUniforms, ShaderMount, ShaderMountUniforms } from "@paper-design/shaders";

  // The career-ops-docs home signature: an animated grain-gradient glow. Deferred
  // to browser idle, skipped on reduced-motion, mounted client-side only → zero
  // LCP cost. Renders grain in the corners (transparent center) so the dot-grid
  // shows through.
  //
  // The Next app reached this through @paper-design/shaders-react's <GrainGradient>,
  // which is a thin React wrapper around the vanilla ShaderMount that
  // @paper-design/shaders exports. The port drives ShaderMount directly with the
  // same uniforms the wrapper assembled (see uniforms() below), and imports the
  // module dynamically so it never enters the SSR bundle.
  const DARK_COLORS = ["#D5742E", "#9c2f05", "#7A2A0000"] as const;
  const LIGHT_COLORS = ["#f6c89a", "#e8a35f", "#D5742E00"] as const;

  type ShaderKit = typeof import("@paper-design/shaders");

  let show = $state(false);
  let dark = $state(true);
  let host = $state<HTMLDivElement | null>(null);

  // Imperative handles stay PLAIN lets, not $state: the mount effect below writes
  // them, and a reactive instance it also reads would re-run its own teardown into
  // a create/dispose loop. `ready` is the one reactive flag it publishes.
  let kit: ShaderKit | null = null;
  let shader: ShaderMount | null = null;
  let noise: HTMLImageElement | undefined;
  let ready = $state(false);

  /** Load the shader module once. Dynamic so it never reaches the SSR bundle. */
  async function loadKit(): Promise<ShaderKit> {
    if (!kit) kit = await import("@paper-design/shaders");
    return kit;
  }

  /** Shader uniforms — the same object the React <GrainGradient> built from props.
   *  The intersection is what the constructor wants: its own uniform shape plus the
   *  index signature ShaderMountUniforms carries (an interface alone does not
   *  satisfy an index-signature parameter). */
  function uniforms(k: ShaderKit, isDark: boolean): GrainGradientUniforms & ShaderMountUniforms {
    const colors = isDark ? [...DARK_COLORS] : [...LIGHT_COLORS];
    // "corners" is one of the object-family shapes, so the wrapper seeded its
    // sizing props from defaultObjectSizing (the alternative is the pattern default).
    const sizing = k.defaultObjectSizing;
    return {
      // Own uniforms
      u_colorBack: k.getShaderColorFromString("#00000000"),
      u_colors: colors.map((c) => k.getShaderColorFromString(c)),
      u_colorsCount: colors.length,
      u_softness: 1,
      u_intensity: isDark ? 0.42 : 0.26,
      u_noise: 0.32,
      u_noiseTexture: noise,
      u_shape: k.GrainGradientShapes.corners,
      // Sizing uniforms
      u_fit: k.ShaderFitOptions[sizing.fit],
      u_scale: sizing.scale,
      u_rotation: sizing.rotation,
      u_offsetX: sizing.offsetX,
      u_offsetY: sizing.offsetY,
      u_originX: sizing.originX,
      u_originY: sizing.originY,
      u_worldWidth: sizing.worldWidth,
      u_worldHeight: sizing.worldHeight,
    };
  }

  onMount(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const readTheme = () => (dark = document.documentElement.classList.contains("dark"));
    readTheme();
    window.addEventListener("themechange", readTheme);

    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (typeof w.requestIdleCallback === "function") {
      w.requestIdleCallback(() => (show = true), { timeout: 2000 });
    } else {
      timer = setTimeout(() => (show = true), 400);
    }

    return () => {
      window.removeEventListener("themechange", readTheme);
      if (timer) clearTimeout(timer);
    };
  });

  // Mount once the placeholder div exists (i.e. after the idle callback flipped
  // `show`) and tear it down on unmount, disposing the WebGL context.
  $effect(() => {
    const el = host;
    if (!el) return;

    let cancelled = false;
    void (async () => {
      try {
        const k = await loadKit();
        // The grain texture is a tiny inline PNG; decode it first so the noise is
        // there on the first frame (the React wrapper awaits the same decode).
        noise = k.getShaderNoiseTexture();
        await noise?.decode().catch(() => {});
        if (cancelled) return;
        shader = new k.ShaderMount(
          el,
          k.grainGradientFragmentShader,
          uniforms(k, untrack(() => dark)),
          undefined,
          0.45,
          undefined,
          1,
          1920 * 1080,
        );
        ready = true;
      } catch {
        // No WebGL (or the module failed to load): the hero just renders without
        // the glow, the same end state a reduced-motion visitor gets.
        ready = false;
      }
    })();

    return () => {
      cancelled = true;
      shader?.dispose();
      shader = null;
      ready = false;
    };
  });

  // Theme toggle: swap the palette on the live mount instead of re-creating it.
  $effect(() => {
    const isDark = dark;
    if (!ready || !kit || !shader) return;
    shader.setUniforms(uniforms(kit, isDark));
  });
</script>

{#if show}
  <div bind:this={host} class="absolute inset-0 z-0 animate-fade-in-delayed"></div>
{/if}
