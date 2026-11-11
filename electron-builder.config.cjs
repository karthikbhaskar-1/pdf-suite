// electron-builder configuration. Run through `npm run desktop:build`.
//
// Code signing: no certificate is configured here (ADR-005). signAndEditExecutable stays on so the exe metadata
// (product name, version) is written. Signed releases come from the SignPath pipeline in .github/workflows/release.yml.

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.pdfsuite.app',
  productName: 'PDF Suite',
  copyright: 'Copyright (c) The PDF Suite authors',
  directories: { output: 'release' },
  // The default name; only the zip target uses it (nsis and portable set their own below). The zip is a folder that starts at once
  // (no self-extraction): unzip it anywhere and run "PDF Suite.exe".
  artifactName: 'PDF-Suite-Portable-${version}-${arch}.${ext}',
  // The app loads only electron-dist (main and preload need just electron and Node built-ins) and dist (Vite has bundled pdfjs-dist,
  // mupdf, react and the rest into it, including the MuPDF WASM file and the pdf.js worker as hashed assets). So no node_modules
  // folder is packed: '!**/node_modules/**' drops pdfjs-dist, mupdf, react-dom and the optional @napi-rs/canvas from the asar.
  files: ['electron-dist/**/*', 'dist/**/*', 'package.json', '!**/node_modules/**'],
  // The licence and third-party notices sit next to the exe (AGPL and the bundled components' licences require them).
  extraFiles: ['LICENSE', 'THIRD-PARTY-NOTICES.md'],
  // Copied to process.resourcesPath so the packaged app can load the window icon.
  extraResources: ['build/icon.ico'],
  asar: true,
  npmRebuild: false,
  // No auto-publishing. Releases are uploaded by hand until electron-updater is added.
  publish: null,
  fileAssociations: [
    {
      ext: 'pdf',
      name: 'PDF document',
      description: 'PDF document',
      role: 'Viewer',
      mimeType: 'application/pdf',
    },
  ],
  win: {
    icon: 'build/icon.ico',
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
      { target: 'zip', arch: ['x64'] },
    ],
    signAndEditExecutable: true,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: 'PDF Suite',
    uninstallDisplayName: 'PDF Suite',
    artifactName: 'PDF-Suite-Setup-${version}-${arch}.${ext}',
  },
  portable: {
    artifactName: 'PDF-Suite-Portable-${version}-${arch}.${ext}',
  },
};

module.exports = config;
