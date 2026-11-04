<script lang="ts">
  import { Moon, Sun } from "@lucide/svelte";
  import { Button } from "@/components/ui/button";
  import { cn } from "@/lib/cn";
  import { themeStore } from "@/lib/theme.svelte";
  import { m } from "@/lib/paraglide/messages";

  let { class: klass, showLabel = false }: { class?: string; showLabel?: boolean } = $props();

  const dark = $derived(themeStore.theme === "dark");
</script>

<Button
  variant="ghost"
  size={showLabel ? "default" : "icon"}
  type="button"
  onclick={() => themeStore.toggle()}
  aria-label={m.shell_dark_mode()}
  aria-pressed={dark}
  title={dark ? m.shell_switch_to_light() : m.shell_switch_to_dark()}
  class={cn("text-muted", showLabel && "w-full justify-start px-2 text-xs", klass)}
>
  {#if dark}
    <Sun class="size-4" />
  {:else}
    <Moon class="size-4" />
  {/if}
  {#if showLabel}<span>{m.shell_dark_mode()}</span>{/if}
</Button>
