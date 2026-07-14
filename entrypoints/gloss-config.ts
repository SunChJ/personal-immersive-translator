export default defineUnlistedScript(() => {
  globalThis.GLOSS_BROWSER_TARGET = import.meta.env.BROWSER;
  globalThis.GLOSS_PAIRING_TOKEN = "";
});
