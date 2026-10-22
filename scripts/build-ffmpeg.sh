#!/usr/bin/env bash
# Builds the static, LGPL-only ffmpeg that the published @kinetograph/native addon links.
#
#   scripts/build-ffmpeg.sh PREFIX
#
# Installs headers, static libraries and pkg-config files into PREFIX. Then build the addon with
#
#   PKG_CONFIG_PATH=PREFIX/lib/pkgconfig npm run build:release -w @kinetograph/native -- --features ffmpeg-static      (macOS, Linux)
#   FFMPEG_DIR=PREFIX                    npm run build:release -w @kinetograph/native -- --features ffmpeg-static      (Windows)
#
# Licence: no --enable-gpl, --enable-version3 or --enable-nonfree anywhere, so libavcodec and the rest are LGPL 2.1+
# and the PolyForm-licensed addon may link them statically. That rules out libx264 and libx265 (GPL). H.264 comes from
#   macOS    VideoToolbox (the system's) and libopenh264 (BSD, built here from source)
#   Linux    libopenh264, and NVENC (the NVIDIA driver's library, loaded at run time, nothing linked)
#   Windows  Media Foundation (h264_mf, system DLLs) and NVENC
# The script ends by checking ffmpeg's own licence line.
set -euo pipefail

FFMPEG_REF=n9.0.1             # ffmpeg-sys-next 9.0.x targets ffmpeg 9.0
OPENH264_REF=v2.6.0           # BSD-2-Clause
NVCODEC_REF=n13.0.19.1        # ffnvcodec headers, MIT; ffmpeg 9.0 wants API 13.0

PREFIX=${1:?usage: build-ffmpeg.sh PREFIX}
mkdir -p "$PREFIX"
PREFIX=$(cd "$PREFIX" && pwd)
WORK=${FFMPEG_WORK:-$PREFIX/../ffmpeg-work}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  MINGW* | MSYS* | CYGWIN*) OS=windows ;;
  *) echo "unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
JOBS=$( (nproc || sysctl -n hw.ncpu || echo 4) 2>/dev/null | head -1)
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

clone() { # url ref dir
  rm -rf "$3"
  git -c advice.detachedHead=false -c core.autocrlf=false clone --quiet --depth=1 -b "$2" "$1" "$3"
}

CONFIG=(
  --prefix="$PREFIX"
  --enable-static --disable-shared --enable-pic
  --disable-autodetect --disable-programs --disable-doc --disable-debug
  --enable-stripping
)

# NVENC: the header-only ffnvcodec; the encoder opens the driver's library when it is used (no link dependency).
if [ "$OS" = linux ] || [ "$OS" = windows ]; then
  clone https://github.com/FFmpeg/nv-codec-headers "$NVCODEC_REF" "$WORK/nv-codec-headers"
  make -C "$WORK/nv-codec-headers" PREFIX="$PREFIX" install >/dev/null
  CONFIG+=(--enable-ffnvcodec --enable-nvenc)
fi

# libopenh264: a static library from source (Ubuntu and Debian ship only the shared one, which would then be a run-time
# dependency). x86 needs nasm.
if [ "$OS" = macos ] || [ "$OS" = linux ]; then
  if [ ! -f "$PREFIX/lib/libopenh264.a" ]; then
    clone https://github.com/cisco/openh264 "$OPENH264_REF" "$WORK/openh264"
    # CFLAGS/CXXFLAGS from the environment: openh264's makefiles append to them. -fPIC because the static library ends
    # up inside a shared object.
    CFLAGS="-fPIC -O2" CXXFLAGS="-fPIC -O2" \
      make -C "$WORK/openh264" -j"$JOBS" PREFIX="$PREFIX" BUILDTYPE=Release install-static >/dev/null
  fi
  # openh264.pc names the GNU C++ runtime; macOS has libc++.
  if [ "$OS" = macos ]; then sed -i '' 's/-lstdc++/-lc++/g' "$PREFIX/lib/pkgconfig/openh264.pc"; fi
  CONFIG+=(--enable-libopenh264 --pkg-config-flags=--static)
fi

case "$OS" in
  macos) CONFIG+=(--enable-videotoolbox --enable-zlib) ;;
  linux) CONFIG+=(--enable-zlib) ;;
  windows)
    # MSVC's cl and link (run this from a shell where vcvars has been loaded) and Media Foundation for h264_mf.
    CONFIG+=(--toolchain=msvc --enable-mediafoundation)
    ;;
esac

clone https://github.com/FFmpeg/FFmpeg "$FFMPEG_REF" "$WORK/ffmpeg"
cd "$WORK/ffmpeg"
./configure "${CONFIG[@]}" --extra-cflags=-w >"$WORK/configure.log" 2>&1 || { tail -50 "$WORK/configure.log"; exit 1; }
make -j"$JOBS" >"$WORK/make.log" 2>&1 || { tail -50 "$WORK/make.log"; exit 1; }
make install >/dev/null

# MSVC's linker looks for avcodec.lib, ffmpeg's static archive is libavcodec.a.
if [ "$OS" = windows ]; then
  for f in "$PREFIX"/lib/lib*.a; do
    b=$(basename "$f" .a)
    cp "$f" "$PREFIX/lib/${b#lib}.lib"
  done
fi

# The licence check: LGPL, and none of the GPL or non-free pieces.
echo "--- $(grep '#define FFMPEG_LICENSE' config.h)"
grep -q '#define FFMPEG_LICENSE "LGPL version 2.1 or later"' config.h
grep -q '#define CONFIG_GPL 0' config.h
grep -q '#define CONFIG_NONFREE 0' config.h
grep -q '#define CONFIG_VERSION3 0' config.h
! grep -q '#define CONFIG_LIBX26[45] 1' config.h
echo "ffmpeg $FFMPEG_REF (LGPL-only, static) installed in $PREFIX"
