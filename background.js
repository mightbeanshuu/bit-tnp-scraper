// Reserved for future background tasks (e.g. multi-page crawling).
// Currently the popup handles downloads directly.
chrome.runtime.onInstalled.addListener(() => {
  console.log("BIT TNP Scraper installed.");
});
