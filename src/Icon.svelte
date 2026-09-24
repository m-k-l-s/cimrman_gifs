<script lang="ts">
let { name, filled = false }: {
  name: 'copy' | 'download' | 'share' | 'info' | 'settings' | 'pin' | 'autoplay' | 'pause';
  filled?: boolean;
} = $props();
</script>

<svg
  width="18"
  height="18"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if name === 'copy'}
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" transform="translate(1 1)" />
  {:else if name === 'download'}
    <path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" />
  {:else if name === 'share'}
    <path d="M12 15V3m-4 4 4-4 4 4M5 11v10h14V11" />
  {:else if name === 'info'}
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v6m0-10h.01" />
  {:else if name === 'settings'}
    <path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10" />
    <circle cx="9" cy="6" r="2" />
    <circle cx="15" cy="12" r="2" />
    <circle cx="9" cy="18" r="2" />
  {:else if name === 'pin'}
    <path d="M8 3h8l-1 7 3 3v2H6v-2l3-3z" fill={filled ? 'currentColor' : 'none'} />
    <path d="M12 15v6" />
  {:else if name === 'autoplay'}
    <path d="M20 7a9 9 0 1 0 1 8M20 3v4h-4" />
    <path d="m10 8 6 4-6 4z" fill="currentColor" stroke="none" />
  {:else if name === 'pause'}
    <path d="M8 5v14M16 5v14" stroke-width="3" />
  {/if}
</svg>
