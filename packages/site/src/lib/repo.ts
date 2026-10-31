import { GITHUB } from '@/sections/links';

const API = GITHUB.replace('https://github.com/', 'https://api.github.com/repos/');

export type RepoCounts = { stars: number; forks: number };

/** The repository's star and fork counts from GitHub's API; undefined when the request fails. */
export async function repoCounts(): Promise<RepoCounts | undefined> {
  try {
    const r = await fetch(API);
    if (!r.ok) return undefined;
    const d = await r.json();
    return { stars: d.stargazers_count, forks: d.forks_count };
  } catch {
    return undefined;
  }
}
