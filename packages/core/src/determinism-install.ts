// Imported first by the CLI's bundle entry (docs/AUTHORING.md §7.4, §9): installs
// the determinism shim before any project module is evaluated.
import { installDeterminism } from './determinism.js';

installDeterminism();
