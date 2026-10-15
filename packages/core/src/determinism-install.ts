// Imported first by the CLI's bundle entry (docs/AUTHORING.md §7.4, §9): installs
// the determinism shim before any project module is evaluated, and the browser's
// `FontFace` and `document.fonts` for projects that load their own font files.
import { installDeterminism } from './determinism.js';
import { installFontFace } from './font-face.js';

installDeterminism();
installFontFace();
