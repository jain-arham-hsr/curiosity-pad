// The only Chrome-extension-specific code the UI touches. When the same UI
// ships as the Android PWA, these become no-ops or PWA equivalents.

export const hasExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

// Chrome cannot show the microphone prompt inside a side panel, so permission
// is granted once from a normal tab; the side panel then inherits it.
export function openMicSetup() {
  if (hasExtension) chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
}
