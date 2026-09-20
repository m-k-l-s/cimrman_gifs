<script lang="ts">
let { name }: { name: 'copy' | 'download' | 'share' | 'more' | 'info' } = $props();
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
  {:else}
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  {/if}
</svg>
