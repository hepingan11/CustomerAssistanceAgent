chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(["settings"], (result) => {
    if (result.settings) return;
    chrome.storage.sync.set({
      settings: {
        enabled: false,
        apiBaseUrl: "http://localhost:8000",
        apiKey: "dev-api-key",
        containerSelector: "",
        messageSelector: "",
        textSelector: "",
        senderSelector: "",
        timeSelector: ""
      }
    });
  });
});
