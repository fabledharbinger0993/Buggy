function extractPage() {
  const title = document.title || "Untitled";
  const bodyText = document.body ? document.body.innerText.slice(0, 200000) : "";
  const links = Array.from(document.querySelectorAll("a[href]"))
    .map((a) => a.href)
    .filter((href) => href.startsWith("http://") || href.startsWith("https://"));

  return {
    title,
    text: bodyText,
    links: Array.from(new Set(links)),
    url: location.href
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "EXTRACT_PAGE") {
    sendResponse(extractPage());
  }
});
