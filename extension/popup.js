const button = document.getElementById("allow");
const status = document.getElementById("status");

button.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://")) {
    status.textContent = "HTTPSのサイトを開いてください";
    return;
  }
  const origin = new URL(tab.url).origin;
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  status.textContent = granted ? `${origin} を許可しました` : "許可されませんでした";
});
