// The only Chrome-extension-specific code the UI touches. When the same UI
// ships as the Android PWA, these become no-ops or PWA equivalents.

export const hasExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

// Chrome cannot show the microphone prompt inside a side panel, so permission
// is granted once from a normal tab; the side panel then inherits it.
export function openMicSetup() {
  if (hasExtension) chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
}

// The page the user is reading: the active tab of the window the panel is in.
export async function currentPage() {
  if (!hasExtension) return null;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url || !/^https?:/.test(tab.url)) return null;
  return { url: tab.url, title: tab.title ?? '' };
}
