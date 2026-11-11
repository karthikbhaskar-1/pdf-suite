import type { PdfSuiteApi } from './contract';

declare global {
  interface Window {
    /** Set by the preload script in the desktop app only. */
    pdfSuite?: PdfSuiteApi;
    /** Set by the preload only when the app runs in test mode (PDFSUITE_E2E=1). */
    __pdfSuiteTestMode?: boolean;
  }
}

export {};
