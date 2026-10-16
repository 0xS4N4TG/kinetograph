// `@remotion/timeline-utils/audio-waveform-worker` is the script the published package runs in a Web Worker to load
// waveform peaks off the main thread. Peaks are loaded in the same thread here (waveform.ts), so there is nothing to
// run; the module exists so that an import of it bundles.

export {};
