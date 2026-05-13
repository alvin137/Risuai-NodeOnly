// Browser-standard secure context flag.
// True for HTTPS and `http://localhost` / `http://127.0.0.1`; false for any
// other HTTP origin. Mirrors the gate used by `navigator.clipboard`,
// Service Workers, and other Permission-restricted Web APIs.
export const isSecureContext: boolean =
    typeof window !== 'undefined' && window.isSecureContext;
