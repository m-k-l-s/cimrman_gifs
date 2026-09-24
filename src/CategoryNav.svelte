<script lang="ts">
import { tick } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';
import { slide } from 'svelte/transition';
import type { Category } from './catalog';
import { groupCategories } from './categories';
import Icon from './Icon.svelte';
import { defaultPins, writePins } from './pins';

let { categories, counts, category, pins = $bindable(), total, ready, onselect }: {
  categories: Category[];
  counts: ReadonlyMap<string, number>;
  category: string;
  pins: string[];
  total: number;
  ready: boolean;
  onselect: (id: string) => void;
} = $props();
let temporarySlot = $state<{ id: string; index: number }>();
let animatePins = $state(false);
const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
const compact = new MediaQuery('(max-width: 600px), (pointer: coarse)');
let nav: HTMLElement;
let scroller: HTMLDivElement;
let rail: HTMLDivElement;
let menu: HTMLElement;
let trigger: HTMLButtonElement;
let overflowing = $state(false);
let canPrevious = $state(false);
let canNext = $state(false);
const groups = $derived(groupCategories(
  compact.current ? categories.filter(item => !pins.includes(item.id)) : categories,
  counts,
));
const active = $derived(categories.find(item => item.id === category));
const selectedLabel = $derived(
  !ready ? 'Pořady' : active?.label ?? (category ? 'Neznámý pořad' : 'Oblíbené'),
);
const pinned = $derived(pins.flatMap(id => categories.filter(item => item.id === id)));
const bar = $derived.by(() => {
  const items = [...pinned];
  if (active && !pins.includes(active.id)) {
    items.splice(temporarySlot?.id === active.id ? temporarySlot.index : items.length, 0, active);
  }
  return items;
});

function measureRail(): void {
  overflowing = rail.scrollWidth > scroller.clientWidth + 1;
  canPrevious = rail.scrollLeft > 1;
  canNext = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1;
}

$effect(() => {
  if (compact.current || !bar.length) {
    overflowing = false;
    return;
  }
  const observer = new ResizeObserver(measureRail);
  for (const element of [scroller, rail, ...rail.children]) observer.observe(element);
  measureRail();
  return () => observer.disconnect();
});

function scrollRail(direction: number): void {
  rail.scrollBy({
    left: direction * rail.clientWidth * 0.8,
    behavior: reducedMotion.current ? 'instant' : 'smooth',
  });
}

function reveal(target: HTMLElement): void {
  if (compact.current || !rail.contains(target)) return;
  const item = target.closest<HTMLElement>('.category-item') ?? target;
  const bounds = item.getBoundingClientRect();
  const viewport = rail.getBoundingClientRect();
  if (bounds.left < viewport.left + 4) rail.scrollLeft += bounds.left - viewport.left - 4;
  else if (bounds.right > viewport.right - 14) {
    rail.scrollLeft += bounds.right - viewport.right + 14;
  }
}

async function updatePins(next: string[], focused: HTMLElement): Promise<void> {
  const menuPin = focused.closest('[popover]') ? focused.dataset.pin : undefined;
  animatePins = true;
  const beforeActive = new Set(
    bar.slice(0, bar.findIndex(item => item.id === category))
      .map(item => item.id),
  );
  temporarySlot = active && !next.includes(category)
    ? { id: category, index: next.filter(id => beforeActive.has(id)).length }
    : undefined;
  pins = next;
  writePins(pins);
  await tick();
  if (menuPin) {
    const replacement = [...menu.querySelectorAll<HTMLButtonElement>('[data-pin]')]
      .find(button => button.dataset.pin === menuPin);
    replacement?.focus({ preventScroll: true });
    replacement?.scrollIntoView({
      block: 'nearest',
      behavior: reducedMotion.current ? 'instant' : 'smooth',
    });
    return;
  }
  const removed = focused.closest('.category-item')
    && !bar.some(item => item.id === focused.dataset.pin);
  if (focused.isConnected && !removed) {
    focused.focus({ preventScroll: true });
    if (!focused.closest('[popover]')) reveal(focused);
  } else {
    trigger.focus({ preventScroll: true });
    reveal(trigger);
  }
}

function togglePin(id: string, control: HTMLButtonElement): void {
  const index = bar.findIndex(item => item.id === id);
  const next = pins.filter(pin => pin !== id);
  if (!pins.includes(id)) next.splice(index < 0 ? next.length : index, 0, id);
  void updatePins(next, control);
}

async function choose(id: string): Promise<void> {
  onselect(id);
  menu.hidePopover();
  await tick();
  const selected = compact.current || !id
    ? trigger
    : [...nav.querySelectorAll<HTMLButtonElement>('.category-button')]
      .find(button => button.dataset.category === id);
  selected?.focus({ preventScroll: true });
  if (selected) reveal(selected);
}

function placeMenu(): void {
  const bounds = trigger.getBoundingClientRect();
  const width = Math.min(360, innerWidth - 24);
  const left = Math.max(12, Math.min(bounds.left, innerWidth - width - 12));
  const top = Math.max(12, Math.min(bounds.bottom + 6, innerHeight - 96));
  menu.style.inset = `${top}px auto auto ${left}px`;
  menu.style.maxHeight = `${Math.min(520, innerHeight - top - 12)}px`;
}
</script>

<svelte:window
  onresize={() => {
    if (menu?.matches(':popover-open')) placeMenu();
  }}
/>

{#snippet pinButton(item: Category, compact = false)}
  {@const pinned = pins.includes(item.id)}
  <button
    class="pin-toggle"
    class:compact
    data-pin={item.id}
    aria-pressed={pinned}
    aria-label={`${pinned ? 'Odepnout' : 'Připnout'} pořad: ${item.label}`}
    title={pinned ? 'Odepnout z lišty' : 'Připnout na lištu'}
    onclick={(event) => togglePin(item.id, event.currentTarget)}
  >
    <span class="pin-symbol"><Icon name="pin" filled={pinned} /></span>
    {#if !compact}<span>{pinned ? 'Odepnout' : 'Připnout'}</span>{/if}
  </button>
{/snippet}

{#snippet categoryGroup(items: Category[], id: string, label: string)}
  {#if items.length}
    <section class="category-group" data-group={id} aria-labelledby={`group-${id}`}>
      <h3 id={`group-${id}`}>{label}</h3>
      <ul>
        {#each items as item (item.id)}
          <li>
            <button
              class="category-choice"
              data-category={item.id}
              aria-pressed={category === item.id}
              aria-label={`Zvolit pořad: ${item.label}`}
              aria-describedby={`category-count-${id}-${item.id}`}
              onclick={() => choose(item.id)}
            >
              <span>{item.label}</span>
              <span class="category-count" id={`category-count-${id}-${item.id}`}>
                {#if category === item.id}<Icon name="check" />{/if}
                {counts.get(item.id) ?? 0}<span class="sr-only"> gifů</span>
              </span>
            </button>
            {@render pinButton(item)}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/snippet}

<nav
  class="category-nav"
  aria-label="Pořady"
  bind:this={nav}
  onfocusin={(event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement && !target.closest('[popover]')
      && target.matches(':focus-visible')
    ) reveal(target);
  }}
>
  <div class="category-scroll" class:empty={!bar.length} bind:this={scroller}>
    {#if overflowing}
      <button
        class="rail-scroll prev quiet"
        aria-label="Předchozí pořady"
        title="Posunout doleva"
        disabled={!canPrevious}
        onclick={() => scrollRail(-1)}
      >
        <Icon name="chevron" />
      </button>
    {/if}
    <div class="category-rail" bind:this={rail} onscroll={measureRail}>
      {#each bar as item (item.id)}
        <div
          class="category-item"
          class:active={category === item.id}
          transition:slide={{ axis: 'x', duration: animatePins && !reducedMotion.current ? 160 : 0 }}
        >
          <button
            class="category-button"
            data-category={item.id}
            aria-pressed={category === item.id}
            title={`${item.label}: ${counts.get(item.id) ?? 0} gifů`}
            onclick={() => onselect(item.id)}
          >
            {item.label}
          </button>
          {@render pinButton(item, true)}
        </div>
      {/each}
    </div>
    {#if overflowing}
      <button
        class="rail-scroll next quiet"
        aria-label="Další připnuté pořady"
        title="Posunout doprava"
        disabled={!canNext}
        onclick={() => scrollRail(1)}
      >
        <Icon name="chevron" />
      </button>
    {/if}
  </div>
  <button
    id="category"
    bind:this={trigger}
    popovertarget="category-menu"
    aria-label={compact.current ? `Vybrat pořad: ${selectedLabel}` : 'Další pořady'}
    title={compact.current ? selectedLabel : 'Další pořady'}
    disabled={!ready}
  >
    <span class="picker-label">{compact.current ? selectedLabel : 'Další'}</span>
    <span class="picker-chevron"><Icon name="chevron" /></span>
  </button>
  <div
    id="category-menu"
    popover="auto"
    role="dialog"
    aria-label="Pořady a připnuté položky"
    bind:this={menu}
    onbeforetoggle={(event) => {
      if (event.newState === 'open') placeMenu();
    }}
  >
    <div class="menu-heading">
      <h2>Pořady</h2>
      <button
        class="quiet"
        popovertarget="category-menu"
        popovertargetaction="hide"
        aria-label="Zavřít nabídku pořadů"
      >
        <Icon name="close" />
      </button>
    </div>
    <button
      class="category-choice favourite-categories"
      data-category=""
      aria-pressed={category === ''}
      aria-label="Zvolit pořad: Oblíbené"
      onclick={() => choose('')}
    >
      <span>Oblíbené</span><span class="category-count">
        {#if category === ''}<Icon name="check" />{/if}
        {total}
      </span>
    </button>
    {#if compact.current}{@render categoryGroup(pinned, 'pinned', 'Oblíbené')}{/if}
    {@render categoryGroup(groups.stories, 'stories', 'Filmy a seriály')}
    {@render categoryGroup(groups.other, 'other', 'Zábava a dětské pořady')}
    <button
      class="reset-pins quiet"
      onclick={(event) => updatePins(defaultPins(categories), event.currentTarget)}
    >
      Obnovit výchozí
    </button>
  </div>
</nav>

<style>
nav {
  display: flex;
  flex: 1;
  min-width: min(100%, 5.5rem);
  align-items: center;
  gap: 4px;
}
.category-scroll, .category-rail {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.category-rail {
  overflow-x: auto;
  scrollbar-width: thin;
  padding: 4px 14px 4px 4px;
  scroll-padding-inline: 4px 14px;
  mask-image: linear-gradient(to right, #000 calc(100% - 12px), transparent);
}
.category-scroll.empty {
  display: none;
}
.rail-scroll {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 28px;
  padding: 0;
}
.rail-scroll.prev :global(svg) {
  transform: rotate(90deg);
}
.rail-scroll.next :global(svg) {
  transform: rotate(-90deg);
}
.category-item {
  position: relative;
  display: flex;
  flex-shrink: 0;
  align-items: center;
  max-width: 100%;
  border: 1px solid transparent;
  border-radius: 5px;
  transition: background-color 140ms, border-color 140ms;
}
.category-button, #category {
  flex-shrink: 0;
  min-height: 36px;
  padding: 6px 10px;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--muted);
  background: transparent;
  font-size: 0.875rem;
  white-space: nowrap;
}
.category-item .category-button {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.category-item.active {
  border-color: var(--accent);
  background: var(--hover);
}
.category-button[aria-pressed="true"] {
  color: var(--accent);
}
nav :focus-visible {
  outline-offset: -2px;
}
.pin-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 0 0 6.5rem;
  min-height: 36px;
  padding: 4px 6px;
  border-color: transparent;
  background: transparent;
  color: var(--muted);
  font-size: 0.75rem;
  transition: color 140ms, background-color 140ms;
}
.pin-toggle[aria-pressed="true"] {
  color: var(--accent);
}
.pin-toggle.compact {
  position: absolute;
  z-index: 1;
  top: 50%;
  right: -12px;
  width: 24px;
  min-height: 24px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 1px 4px #0002;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-50%) scale(0.9);
  transition: opacity 120ms, transform 120ms, visibility 120ms;
}
.category-item:hover, .category-item:focus-within {
  z-index: 1;
}
.category-item:hover .pin-toggle, .category-item:focus-within .pin-toggle {
  opacity: 1;
  visibility: visible;
  transform: translateY(-50%) scale(1);
}
#category {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-color: var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  transition: background-color 160ms, border-color 160ms, color 160ms;
}
#category:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
}
nav:has(#category-menu:popover-open) #category {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
  color: var(--accent);
}
.picker-chevron {
  display: flex;
  flex-shrink: 0;
  transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
nav:has(#category-menu:popover-open) .picker-chevron {
  transform: rotate(180deg);
}
.picker-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.pin-symbol {
  display: flex;
  transform: rotate(0deg);
  transition: transform 160ms ease-out;
}
.pin-toggle[aria-pressed="true"] .pin-symbol {
  transform: rotate(35deg);
}
.pin-toggle:active .pin-symbol {
  transform: scale(0.85) rotate(15deg);
}
#category-menu {
  container-type: inline-size;
  inset: 64px 12px auto auto;
  width: min(360px, calc(100vw - 24px));
  max-height: calc(100dvh - 80px);
  margin: 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 12px 32px #0002, 0 2px 6px #0001;
  overscroll-behavior: contain;
  scroll-padding-block: 64px 8px;
  overflow-y: auto;
  scrollbar-width: thin;
  pointer-events: none;
  opacity: 0;
  transform: translateY(-6px) scale(0.98);
  transform-origin: top left;
  transition:
    opacity 160ms ease-out,
    transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1),
    display 200ms allow-discrete,
    overlay 200ms allow-discrete;
}
#category-menu:popover-open {
  pointer-events: auto;
  opacity: 1;
  transform: translateY(0) scale(1);
}
@starting-style {
  #category-menu:popover-open {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }
}
.menu-heading {
  position: sticky;
  top: -8px;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: -8px -8px 6px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}
.menu-heading button {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 32px;
  min-height: 32px;
  padding: 0;
  border-radius: 6px;
}
h2 {
  margin: 0;
  font-size: 0.875rem;
}
h3 {
  margin: 12px 8px 4px;
  font-size: 0.75rem;
  color: var(--muted);
  font-weight: 500;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 8px;
  transition: background-color 140ms;
}
li:hover, li:focus-within {
  background: var(--hover);
}
.category-group + .category-group {
  margin-top: 8px;
  border-top: 1px solid var(--border);
}
.category-choice {
  display: flex;
  flex: 1;
  min-width: 0;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 6px 8px;
  border-radius: 8px;
  border-color: transparent;
  background: transparent;
  text-align: start;
  line-height: 1.3;
  transition: background-color 140ms, color 140ms;
}
.category-choice[aria-pressed="true"] {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, var(--surface));
}
.category-choice > span:first-child {
  min-width: 0;
  overflow-wrap: anywhere;
}
.favourite-categories {
  width: 100%;
  margin-top: 6px;
}
.category-count {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  color: var(--muted);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
.category-choice[aria-pressed="true"] .category-count {
  color: inherit;
}
.reset-pins {
  width: 100%;
  margin-top: 10px;
  border-top-color: var(--border);
  border-radius: 0;
  font-size: 0.75rem;
}
@container (max-width: 16rem) {
  li {
    flex-wrap: wrap;
    row-gap: 0;
    padding-bottom: 6px;
  }
  .category-choice {
    flex-basis: 100%;
  }
  .pin-toggle {
    flex-basis: auto;
    margin-inline-start: auto;
  }
}
@media (max-width: 600px), (pointer: coarse) {
  nav {
    min-width: 0;
    padding: 0 4px;
  }
  .category-scroll {
    display: none;
  }
  #category {
    flex: 1;
    min-width: 0;
    min-height: 44px;
    padding-inline: 10px;
    font-size: 0.8125rem;
  }
  .pin-toggle {
    min-height: 44px;
  }
  .category-choice, .menu-heading button, .reset-pins {
    min-height: 44px;
  }
  .menu-heading button {
    width: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .category-item,
  .pin-toggle,
  .pin-toggle.compact,
  .pin-symbol,
  #category,
  .picker-chevron,
  #category-menu,
  li,
  .category-choice {
    transition: none;
  }
}
@media (forced-colors: active) {
  .category-item, .category-button, .pin-toggle, #category {
    border-color: ButtonText;
  }
}
</style>
