import { reactive } from 'vue';
import type { TemplateItem } from '../types/store';

const STORAGE_KEY = 'cf-manager:favorites';

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set<string>();
  }
}

const state = reactive({ favs: load() });

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(state.favs)));
  } catch {
    /* ignore quota / private mode errors */
  }
}

export function favKey(item: TemplateItem): string {
  return `${item.sourceId}::${item.template.id}`;
}

export function isFav(item: TemplateItem): boolean {
  return state.favs.has(favKey(item));
}

export function toggleFav(item: TemplateItem): boolean {
  const k = favKey(item);
  if (state.favs.has(k)) state.favs.delete(k);
  else state.favs.add(k);
  persist();
  return state.favs.has(k);
}

export function favCount(): number {
  return state.favs.size;
}
