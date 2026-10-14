# Kinetograph

Kinetograph is a placeholder name.

A programmatic video engine: agents write TypeScript, a Rust core renders it on the GPU, no browser anywhere. It keeps
Remotion's API for visuals and the Web Audio API for sound, and puts a GPU compositor underneath them.

**Status:** Phase 1 is done: a Rust workspace with a GPU compositor (shape, text, image and group layers; all 16 W3C
blend modes; blur), PNG output, and a CLI with `still` and `bench`. Scenes are JSON for now; the TypeScript runtime comes
in later phases (see the [roadmap](docs/HANDOFF.md)).

- [Technical handoff](docs/HANDOFF.md)
- [Research notes](docs/RESEARCH.md)
- [Scene format](docs/SCENE.md)

## Build and run

Use the rustup toolchain (stable, edition 2024). It needs a GPU that wgpu supports (Metal on macOS); no window or
display is required.

```sh
# If Homebrew's rustc is first on PATH and fails to start, put rustup's first:
export PATH="$HOME/.cargo/bin:/opt/homebrew/opt/rustup/bin:$PATH"

cargo build --release

# Render frame 30 of the example scene to a PNG (add --json for machine-readable output)
./target/release/kinetograph still examples/papercut-card.json 30 -o out/card.png

# Time one frame: two warm-up renders, then K runs; per-stage mean/min/max in ms
./target/release/kinetograph bench examples/papercut-card.json --frame 30 --runs 10
```

Checks: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`. The golden-image tests compare
against PNGs in `crates/core/tests/golden/` made on an Apple M4; regenerate them with
`UPDATE_GOLDEN=1 cargo test --test golden` after checking the difference by eye. The example images are regenerated with
`cargo run -p kinetograph-core --example gen_test_image` and `--example gen_papercut_assets`.

`docs/reference/rajz-reference.mp4` is not in the repo. It is a third-party video and must be placed there locally
to run the reference comparisons.

## License

Licensed under either of Apache License 2.0 or MIT license at your option.

- [LICENSE-APACHE](LICENSE-APACHE)
- [LICENSE-MIT](LICENSE-MIT)
