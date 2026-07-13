const button = document.getElementById("allow");
const status = document.getElementById("status");
const reconnectButton = document.getElementById("reconnect");
const statusBadge = document.getElementById("status-badge");

function updateStatusUI(connected) {
  if (connected) {
    statusBadge.textContent = "CONNECTED";
    statusBadge.className = "status-badge status-connected";
    reconnectButton.style.display = "none";
  } else {
    statusBadge.textContent = "DISCONNECTED";
    statusBadge.className = "status-badge status-disconnected";
    reconnectButton.style.display = "block";
  }
}

// Initial connection check
chrome.storage.local.get(["chromeBridgeConnected"], (res) => {
  const connected = !!res.chromeBridgeConnected;
  updateStatusUI(connected);
});

// Allow origin button
button.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.startsWith("https://")) {
    status.textContent = "HTTPSのサイトを開いてください。";
    return;
  }
  const origin = new URL(tab.url).origin;
  try {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    status.textContent = granted ? `${origin} を許可しました。` : "許可されませんでした。";
  } catch (err) {
    status.textContent = "エラーが発生しました: " + err.message;
  }
});

// Reconnect button
reconnectButton.addEventListener("click", () => {
  status.textContent = "再接続を試みています...";
  chrome.runtime.sendMessage({ command: "reconnect" }, () => {
    // Wait slightly for connection handshake to execute or fail
    setTimeout(() => {
      chrome.storage.local.get(["chromeBridgeConnected"], (res) => {
        const connected = !!res.chromeBridgeConnected;
        updateStatusUI(connected);
        if (connected) {
          status.textContent = "アプリに接続しました。";
        } else {
          status.textContent = "接続できませんでした。Soroeruアプリが起動しており、接続セットアップが完了していることを確認してください。";
        }
      });
    }, 300);
  });
});
