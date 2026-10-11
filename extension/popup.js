const status = document.getElementById("status");
const reconnectButton = document.getElementById("reconnect");
const statusBadge = document.getElementById("status-badge");

function updateStatusUI(connected) {
  if (connected) {
    statusBadge.textContent = "CONNECTED";
    statusBadge.className = "status-badge status-connected";
    reconnectButton.style.display = "none";
    status.textContent = "アプリに接続しました。開示台帳のサイトを操作できます。";
  } else {
    statusBadge.textContent = "DISCONNECTED";
    statusBadge.className = "status-badge status-disconnected";
    reconnectButton.style.display = "block";
    status.textContent = "接続されていません。Soroeruアプリが起動していることを確認してください。";
  }
}

// Initial connection check
chrome.storage.local.get(["chromeBridgeConnected"], (res) => {
  const connected = !!res.chromeBridgeConnected;
  updateStatusUI(connected);
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
          status.textContent = "アプリに接続しました。開示台帳のサイトを操作できます。";
        } else {
          status.textContent = "接続できませんでした。Soroeruアプリが起動しており、接続セットアップが完了していることを確認してください。";
        }
      });
    }, 300);
  });
});

// Side Panel (Issue #558): the primary UI. It must be opened from this user gesture.
document.getElementById("open-panel").addEventListener("click", () => {
  chrome.windows.getCurrent((win) => {
    chrome.sidePanel.open({ windowId: win.id }, () => window.close());
  });
});
