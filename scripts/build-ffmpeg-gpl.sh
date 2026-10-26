#!/usr/bin/env bash
# Builds the GPL `ffmpeg` program that ships beside the addon, in the platform packages (bin/ffmpeg).
#
#   scripts/build-ffmpeg-gpl.sh PREFIX
#
# Installs PREFIX/bin/ffmpeg[.exe] (a static executable) and PREFIX/SOURCES.txt (the exact source refs).
#
# Licence: this program is GPL-2.0-or-later (--enable-gpl, with libx264 and libx265, which are GPL). It is a separate
# executable that the addon runs as a child process for the encoders its own LGPL-only ffmpeg (scripts/build-ffmpeg.sh)
# lacks; nothing GPL is ever linked into the PolyForm-licensed addon. This is how Remotion ships its ffmpeg too.
# It has x264 (H.264), x265 (H.265, 8/10/12 bit) and libvpx (VP8, VP9), and only the other components the addon's
# pipe-in, file-out use needs (rawvideo in; mp4, mov, webm, matroska out; AAC, PCM; scale and format filters).
#
# Windows builds with MinGW-w64 gcc from MSYS2 (put /mingw64/bin on the PATH, install mingw-w64-x86_64-{gcc,cmake,nasm}),
# not MSVC: this is a stand-alone program, so its C runtime does not have to match Rust's, and x265 and libvpx build
# with gcc where they do not with MSVC.
set -euo pipefail

FFMPEG_REF=n9.0.1             # the same ffmpeg as the LGPL build
X264_REF=b35605ace3ddf7c1a5d67a2eb553f034aef41d55   # tip of the `stable` branch (x264 0.165) on 2026-10-26; GPL-2.0+
X265_REF=4.2                  # GPL-2.0+
LIBVPX_REF=v1.15.0            # BSD-3-Clause

PREFIX=${1:?usage: build-ffmpeg-gpl.sh PREFIX}
mkdir -p "$PREFIX"
PREFIX=$(cd "$PREFIX" && pwd)
WORK=${FFMPEG_WORK:-$PREFIX/../ffmpeg-gpl-work}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux) OS=linux ;;
  MINGW* | MSYS* | CYGWIN*) OS=windows ;;
  *) echo "unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
if [ "$OS" = windows ]; then export PATH="/mingw64/bin:$PATH"; fi
JOBS=$( (nproc || sysctl -n hw.ncpu || echo 4) 2>/dev/null | head -1)
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"

clone() { # url ref dir (a tag or branch)
  rm -rf "$3"
  git -c advice.detachedHead=false -c core.autocrlf=false clone --quiet --depth=1 -b "$2" "$1" "$3"
}
clone_commit() { # url sha dir
  rm -rf "$3"
  mkdir -p "$3"
  git -C "$3" init --quiet
  git -C "$3" remote add origin "$1"
  git -C "$3" -c core.autocrlf=false fetch --quiet --depth=1 origin "$2"
  git -C "$3" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
}
quiet() { # logfile command... : run, show the tail of the log on failure
  local log=$1
  shift
  "$@" >"$log" 2>&1 || { tail -40 "$log"; exit 1; }
}

# --- x264: static, no CLI. x86 needs nasm. -------------------------------------------------------------------------
if [ ! -f "$PREFIX/lib/libx264.a" ]; then
clone_commit https://code.videolan.org/videolan/x264.git "$X264_REF" "$WORK/x264"
(
  cd "$WORK/x264"
  quiet "$WORK/x264-configure.log" ./configure --prefix="$PREFIX" --enable-static --enable-pic --disable-cli \
    --disable-opencl --bit-depth=all --chroma-format=all
  quiet "$WORK/x264-make.log" make -j"$JOBS"
  quiet "$WORK/x264-install.log" make install
)
fi

# --- x265: 8, 10 and 12 bit in one static library (the encoder's multi-lib build). ---------------------------------
if [ ! -f "$PREFIX/lib/libx265.a" ]; then
clone https://bitbucket.org/multicoreware/x265_git.git "$X265_REF" "$WORK/x265"
(
  cd "$WORK/x265"
  GEN=("Unix Makefiles")
  if [ "$OS" = windows ]; then GEN=("MSYS Makefiles"); fi
  # CMake 4 refuses the old minimum version x265's lists declare.
  COMMON=(-G "${GEN[@]}" -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DENABLE_SHARED=OFF -DENABLE_CLI=OFF
    -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_BUILD_TYPE=Release -DENABLE_LIBNUMA=OFF)
  mkdir 12bit 10bit 8bit
  (cd 12bit && quiet "$WORK/x265-12-cmake.log" cmake ../source "${COMMON[@]}" -DHIGH_BIT_DEPTH=ON -DEXPORT_C_API=OFF \
    -DMAIN12=ON && quiet "$WORK/x265-12-make.log" make -j"$JOBS")
  (cd 10bit && quiet "$WORK/x265-10-cmake.log" cmake ../source "${COMMON[@]}" -DHIGH_BIT_DEPTH=ON -DEXPORT_C_API=OFF \
    && quiet "$WORK/x265-10-make.log" make -j"$JOBS")
  ln -sf ../10bit/libx265.a 8bit/libx265_main10.a
  ln -sf ../12bit/libx265.a 8bit/libx265_main12.a
  (cd 8bit && quiet "$WORK/x265-8-cmake.log" cmake ../source "${COMMON[@]}" -DEXTRA_LIB="x265_main10.a;x265_main12.a" \
    -DEXTRA_LINK_FLAGS=-L. -DLINKED_10BIT=ON -DLINKED_12BIT=ON -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    && quiet "$WORK/x265-8-make.log" make -j"$JOBS")
  # The 8-bit libx265.a holds only its own objects; fold the 10 and 12 bit libraries in with a small archive script,
  # so that the one file installed is the complete encoder.
  (
    cd 8bit
    mv libx265.a libx265_main.a
    if [ "$OS" = macos ]; then
      libtool -static -o libx265.a libx265_main.a libx265_main10.a libx265_main12.a
    else
      printf 'CREATE libx265.a\nADDLIB libx265_main.a\nADDLIB libx265_main10.a\nADDLIB libx265_main12.a\nSAVE\nEND\n' | ar -M
    fi
    quiet "$WORK/x265-install.log" make install
    # make install copies libx265.a from its build rule; put the merged one in place.
    cp libx265.a "$PREFIX/lib/libx265.a"
  )
  # The pkg-config file names the GNU C++ runtime; macOS has libc++.
  if [ "$OS" = macos ]; then sed -i '' 's/-lstdc++/-lc++/g' "$PREFIX/lib/pkgconfig/x265.pc"; fi
)
fi

# --- libvpx: VP8 and VP9, static. -----------------------------------------------------------------------------------
if [ ! -f "$PREFIX/lib/libvpx.a" ]; then
clone https://github.com/webmproject/libvpx "$LIBVPX_REF" "$WORK/libvpx"
(
  cd "$WORK/libvpx"
  EXTRA=()
  if [ "$OS" = windows ]; then EXTRA+=(--target=x86_64-win64-gcc); fi
  quiet "$WORK/libvpx-configure.log" ./configure --prefix="$PREFIX" --enable-pic --enable-static --disable-shared \
    --enable-vp9-highbitdepth --disable-examples --disable-tools --disable-docs --disable-unit-tests ${EXTRA[@]+"${EXTRA[@]}"}
  quiet "$WORK/libvpx-make.log" make -j"$JOBS"
  quiet "$WORK/libvpx-install.log" make install
)
fi

# --- ffmpeg: the program. ------------------------------------------------------------------------------------------
CONFIG=(
  --prefix="$PREFIX"
  --enable-gpl --enable-libx264 --enable-libx265 --enable-libvpx
  --enable-static --disable-shared --enable-pic
  --disable-autodetect --disable-doc --disable-debug --enable-stripping
  --disable-ffplay --disable-ffprobe
  --pkg-config-flags=--static
  # Only what raw pictures in, a video (and AAC or PCM sound) out, needs.
  --disable-everything
  --enable-protocol=file,pipe
  --enable-demuxer=rawvideo,wav,mov,matroska
  --enable-decoder=rawvideo,pcm_s16le,pcm_f32le
  --enable-muxer=mp4,mov,webm,matroska,wav,null
  --enable-encoder=libx264,libx265,libvpx_vp8,libvpx_vp9,aac,pcm_s16le
  --enable-parser=h264,hevc,vp8,vp9,aac
  --enable-bsf=aac_adtstoasc,extract_extradata,vp9_superframe,null
  --enable-filter=scale,format,null,anull,aresample,aformat,fps,setpts,asetpts,trim,atrim
)
case "$OS" in
  macos) CONFIG+=(--enable-zlib) ;;
  linux) CONFIG+=(--enable-zlib --extra-ldflags="-static-libstdc++ -static-libgcc") ;;
  windows) CONFIG+=(--arch=x86_64 --target-os=mingw32 --extra-ldflags="-static -static-libgcc -static-libstdc++") ;;
esac

clone https://github.com/FFmpeg/FFmpeg "$FFMPEG_REF" "$WORK/ffmpeg"
cd "$WORK/ffmpeg"
./configure "${CONFIG[@]}" --extra-cflags=-w >"$WORK/configure.log" 2>&1 || { tail -50 "$WORK/configure.log"; exit 1; }
quiet "$WORK/make.log" make -j"$JOBS"
quiet "$WORK/install.log" make install

# The checks: GPL, the three encoders in, and no non-free parts. A program that is not these must not be shipped.
echo "--- $(grep '#define FFMPEG_LICENSE' config.h)"
grep -q '#define FFMPEG_LICENSE "GPL version 2 or later"' config.h
grep -q '#define CONFIG_NONFREE 0' config.h
grep -q '#define CONFIG_VERSION3 0' config.h
EXE="$PREFIX/bin/ffmpeg"
if [ "$OS" = windows ]; then EXE="$PREFIX/bin/ffmpeg.exe"; fi
test -x "$EXE"
ENCODERS=$("$EXE" -hide_banner -encoders)
for e in libx264 libx265 libvpx-vp9; do
  echo "$ENCODERS" | grep -q " $e " || { echo "$e is missing from $EXE" >&2; exit 1; }
done

{
  echo "Sources of the GPL ffmpeg program built by scripts/build-ffmpeg-gpl.sh"
  echo "ffmpeg  https://github.com/FFmpeg/FFmpeg  tag $FFMPEG_REF  commit $(git -C "$WORK/ffmpeg" rev-parse HEAD)"
  echo "x264    https://code.videolan.org/videolan/x264.git  commit $X264_REF"
  echo "x265    https://bitbucket.org/multicoreware/x265_git.git  tag $X265_REF  commit $(git -C "$WORK/x265" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "libvpx  https://github.com/webmproject/libvpx  tag $LIBVPX_REF  commit $(git -C "$WORK/libvpx" rev-parse HEAD 2>/dev/null || echo unknown)"
  "$EXE" -hide_banner -version | head -3
} >"$PREFIX/SOURCES.txt"
echo "GPL ffmpeg $FFMPEG_REF installed at $EXE"
