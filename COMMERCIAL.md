# Commercial licence

Kinetograph is licensed under the [PolyForm Small Business License 1.0.0](LICENSE.md). It is free to use, change and
distribute for:

- individuals,
- non-profit organisations,
- companies with fewer than 100 people (employees and contractors together) **and** less than 1,000,000 USD (2019,
  adjusted for inflation) revenue in the prior tax year, counting every organisation that controls the company, is
  controlled by it, or is under common control with it.

Any other company needs a commercial licence before using Kinetograph for its benefit. To get one, email
[sanatasgsih@gmail.com](mailto:sanatasgsih@gmail.com) or open an issue on the repository.

The vendored crates in `vendor/` keep their own licences (MIT, Apache-2.0 or MPL-2.0); see `vendor/README.md`.
Third-party dependencies are under their own licences too. The FFmpeg build that `render` links may include GPL
components (`libx264`); check your build before distributing binaries.
