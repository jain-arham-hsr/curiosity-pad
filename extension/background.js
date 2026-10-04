// Service worker: opens the side panel from the toolbar icon, and handles the
// right-click "Add to Question Trail" capture. Captures go straight into the
// same local database the side panel reads.

import * as store from './app/store.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'selection', title: 'Add to Question Trail', contexts: ['selection'] });
  chrome.contextMenus.create({ id: 'page', title: 'Add this page to Question Trail', contexts: ['page'] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // Must happen before any await: opening the panel needs the click's user gesture.
  if (tab?.windowId != null) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  capture(info, tab).catch((err) => console.error('Capture failed', err));
});

// The menu's own selectionText flattens line breaks, so read the selection
// from the page itself when we can (not possible on chrome:// pages).
async function selectedText(tab, info) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId ?? 0] },
      func: () => window.getSelection()?.toString() ?? '',
    });
    return result?.result ?? '';
  } catch {
    return '';
  }
}

const tidy = (text) => text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function capture(info, tab) {
  const source = tab?.url ? { url: tab.url, title: tab.title ?? '' } : null;
  const body = info.menuItemId === 'selection'
    ? tidy((await selectedText(tab, info)) || info.selectionText || '')
    : (tab?.title || tab?.url || '');
  if (!body) return;

  const trailId = await store.captureTrail();
  await store.addNode(trailId, { kind: 'text', body, source });
  store.announceCapture(trailId);

  if (tab?.id != null) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '+1' });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 1500);
  }
}
