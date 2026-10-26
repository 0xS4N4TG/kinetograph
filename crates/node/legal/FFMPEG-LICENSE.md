# The `bin/ffmpeg` program is GPL

This package holds two separate works under different licences.

1. **The addon** (`kinetograph.*.node`) is licensed under the PolyForm Small Business License 1.0.0 (`LICENSE.md`). It
   links an FFmpeg that is built as **LGPL 2.1 or later**, without libx264 or libx265. See `THIRD-PARTY-NOTICES.md` and
   `COPYING.LGPLv2.1`.
2. **The program** `bin/ffmpeg` (`bin/ffmpeg.exe` on Windows) is a stand-alone FFmpeg executable built with
   `--enable-gpl` together with **libx264**, **libx265** and **libvpx**. It is licensed under the **GNU General Public
   License, version 2 or (at your option) any later version**. The licence text is in `COPYING.GPLv2`.

The two do not form one program. The addon never links the executable or any GPL code: when a render asks for an
encoder the linked FFmpeg lacks (H.264 by libx264, H.265 by libx265), the addon starts `bin/ffmpeg` as a child process
and sends it raw pictures on a pipe. The PolyForm licence therefore does not apply to `bin/ffmpeg`, and the GPL does
not apply to the addon.

## Source and rebuilding

The executable is built from unmodified upstream sources by `scripts/build-ffmpeg-gpl.sh` in
<https://github.com/0xS4N4TG/kinetograph>. The exact tags and commits are at the top of that script and are written to
`bin/SOURCES.txt`, which ships beside the executable:

- FFmpeg 9.0.1, tag `n9.0.1` of <https://github.com/FFmpeg/FFmpeg>
- x264, a commit of the `stable` branch of <https://code.videolan.org/videolan/x264>
- x265 4.2 from <https://bitbucket.org/multicoreware/x265_git>
- libvpx 1.15.0 (BSD-3-Clause) from <https://github.com/webmproject/libvpx>

You may replace `bin/ffmpeg` with your own build, or point `KINETOGRAPH_FFMPEG` at any `ffmpeg` of your choice; the
addon uses whichever it finds first. If you cannot get the corresponding source of this exact binary from the links
above, open an issue at <https://github.com/0xS4N4TG/kinetograph/issues> and it will be provided.

Patents: H.264 and H.265 are covered by patent pools. The GPL and this notice grant no patent licence for them; arranging
one, if you need it, is your responsibility.
