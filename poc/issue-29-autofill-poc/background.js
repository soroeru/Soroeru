// PoC: クリックで検証ページ（R / R2）を開くだけの service worker。
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("poc.html") });
});
