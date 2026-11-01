// Sends a dropped reference to the studio server (packages/studio/src/panels/brief-routes.ts).

export interface StoredRef {
  /** plan/refs/<name>, relative to the project. */
  src: string;
  /** For a video: plan/refs/<name>.sheet.png. */
  sheet?: string;
}

/** The secret from the address the studio opened; the api module keeps the same one for the tab. */
function studioToken(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('token') ?? sessionStorage.getItem('studio-token');
  } catch {
    return null;
  }
}

const withToken = (path: string): string => {
  const token = studioToken();
  return token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path;
};

/** The address of a stored reference file, for an <img>. */
export const refUrl = (path: string): string => withToken(`/api/panels/brief/ref?path=${encodeURIComponent(path)}`);

export async function uploadRef(file: File): Promise<StoredRef> {
  const token = studioToken();
  const response = await fetch(withToken(`/api/panels/brief/ref?name=${encodeURIComponent(file.name)}`), {
    method: 'PUT',
    headers: token ? { 'X-Studio-Token': token } : {},
    body: file,
  });
  const body = (await response.json().catch(() => null)) as (StoredRef & { error?: { message?: string } }) | null;
  if (!response.ok || !body?.src) throw new Error(body?.error?.message ?? `${response.status} ${response.statusText}`);
  return { src: body.src, ...(body.sheet ? { sheet: body.sheet } : {}) };
}
