// NOTICE:
// The Discord dashboard uses Discord Voice's direct Ogg Opus demux path, but
// prism-media eagerly resolves its undeclared optional `ffmpeg-static` module
// while esbuild bundles the shared transformer graph.
// Source/context: prism-media 1.3.5 `src/core/FFmpeg.js:125-128`.
// Remove this alias when prism-media no longer requires optional FFmpeg modules
// during bundling, or when the dashboard intentionally ships a transcoder.
module.exports = undefined
