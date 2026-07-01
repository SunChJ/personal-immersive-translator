// Runs in the page's MAIN world (see manifest.json), not the extension's isolated
// world, because only main-world code can intercept the page's own pushState/
// replaceState calls — the mechanism SPA routers use to change the URL without
// a native popstate event. Dispatches a DOM event that content-observers.js
// listens for from the isolated world.
(function () {
  if (window.__pitRoutePatched) {
    return;
  }
  window.__pitRoutePatched = true;

  ["pushState", "replaceState"].forEach((methodName) => {
    const original = history[methodName];
    history[methodName] = function (...args) {
      const result = original.apply(this, args);
      window.dispatchEvent(new Event("pit:route-change"));
      return result;
    };
  });
})();
