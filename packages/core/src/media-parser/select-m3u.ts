// The defaults for choosing among the streams of an M3U playlist, which are the `parseMedia` options
// `selectM3uStream` and `selectM3uAssociatedPlaylists`. Playlists themselves are not parsed here (they are fetched
// over the network); the functions are exported so that a project passing them bundles.

import type { M3uAssociatedPlaylist, SelectM3uAssociatedPlaylistsFn, SelectM3uStreamFn } from './types.js';

/** The first stream. */
export const defaultSelectM3uStreamFn: SelectM3uStreamFn = ({ streams }) => Promise.resolve(streams[0]!.id);

/** The only playlist there is, else the ones marked as default. */
export const defaultSelectM3uAssociatedPlaylists: SelectM3uAssociatedPlaylistsFn = ({ associatedPlaylists }) =>
  associatedPlaylists.length === 1
    ? associatedPlaylists
    : associatedPlaylists.filter((playlist: M3uAssociatedPlaylist) => playlist.default);
